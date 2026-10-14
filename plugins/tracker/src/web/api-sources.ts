import { type Occurrence, reschedule, ScheduleError, type Task, type User } from "@rackbops/docket-core";
import { type GatheredPage, gatheredPages } from "@rackbops/docket-types";
import { TASK_BUSY } from "../locks.js";
import { ownLiveTask } from "../manage.js";
import { awaitingFollowUp, MAX_SOURCES_CHARS, MAX_SOURCES_PER_POST, MAX_SOURCES_PER_TASK, sentResearch, waitingForPages } from "../research-sources.js";
import { type ApiAnswer, NOT_FOUND_MESSAGE, problem } from "./api-tasks.js";
import type { Writer } from "./editor.js";

/**
 * The task API's sources routes (tracker 0.28.0, rackbops-bot-plugins#125): how pages reach a
 * research request made with `sources: browser` (research.ts, research-sources.ts). The research
 * never opens BoardGameGeek or eBay; the owner's own browser does -- Claude in Chrome, when they ask
 * it to -- and posts each page's address, title and main text here. Then `ready` moves the queued
 * run to now, and the execute lane's next tick submits it with the pages quoted into its prompt.
 *
 * - `POST /tasks/<id>/sources`: `{"pages": [{url, title, text}, ...]}`, at most
 *   `MAX_SOURCES_PER_POST` a request. Each is cleaned on its own by docket-types' `gatheredPages`
 *   (an absolute http(s) address, a one-line title, the text capped at `MAX_PAGE_CHARS`), and a
 *   second page with the same address in one request is left out; a page whose address the request
 *   already holds replaces it. More than `MAX_SOURCES_PER_TASK` in all is a 409 that says how many it
 *   holds. A page whose text would take the request past `MAX_SOURCES_CHARS` in all is left out whole
 *   and counted apart (`overBudget`), not with the unusable ones (`rejected`); when that leaves none
 *   stored, a 409.
 * - `POST /tasks/<id>/sources/ready`: `{}`. Needs at least one page in (else 409), then moves the
 *   run to now through docket-core's `reschedule`, as an edit moves one. That move is what ends the
 *   waiting (research-sources.ts's `waitingForPages`), so neither route takes the request after it,
 *   nor once a run of it has started.
 *
 * A fuller pass (0.29.0, docket-types 0.9.0): a research request whose first answer listed pages
 * its run could not open waits in phase `awaiting-pages` on one queued follow-up at its expiry
 * (`awaitingPages`; docket sends only `web` requests there), and both routes take it as they take a
 * browser request waiting for its first pages. Its `ready` -- only while that follow-up is unfired
 * with no Job out and no try of it started (a try put back with its Job still pending is `queued`
 * again, and deleting it would orphan that Job and run the second pass twice), else a 409 -- moves
 * the once task to now with `reschedule` and then deletes the follow-up, as docket's contract
 * orders it: core's `reschedule` never cancels a follow-up, and one left in place would run the
 * second pass again at the expiry, while a move that fails leaves the wait as it was.
 *
 * Only the token owner's own live research request on browser pages: anyone else's, an unknown id,
 * or a deleted or finished one answers the API's same 404; a web request, or one no longer waiting,
 * a 409. Both run in the surface's one queue and under the task's lock (locks.ts), so neither lands
 * while the execute tick holds the task (that is a 409 `busy` at once): the tick starts a run only
 * of a task it holds, so the check that the request still waits and the write after it cannot
 * straddle a run's start, and the pages a run reads are the ones every later try of it reads.
 */

/** Each raw page cleaned on its own (so one page's length never cuts another's), the first of each address kept. */
function cleanPages(raw: readonly unknown[]): GatheredPage[] {
  const out: GatheredPage[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const [p] = gatheredPages([item]);
    if (!p || seen.has(p.url)) continue;
    seen.add(p.url);
    out.push(p);
  }
  return out;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** The sources route's answer to a body `body` for task `id`. */
export async function sourcesAnswer(w: Writer, user: User, id: string, body: Record<string, unknown>): Promise<ApiAnswer> {
  const extra = Object.keys(body).find((k) => k !== "pages");
  if (extra !== undefined) return problem(400, "unknown_field", `\`${extra.slice(0, 40)}\` is not a field here: send {"pages": [...]}.`);
  const raw = body.pages;
  if (!Array.isArray(raw)) return problem(400, "invalid", '`pages` must be an array of pages: {"url", "title", "text"}.');
  if (raw.length === 0) return problem(400, "invalid", "`pages` is empty.");
  if (raw.length > MAX_SOURCES_PER_POST) return problem(400, "too_many", `At most ${MAX_SOURCES_PER_POST} pages a request.`);
  const pages = cleanPages(raw);
  const rejected = raw.length - pages.length;
  if (pages.length === 0) return problem(400, "invalid", "None of those pages could be used: each needs an absolute http(s) `url` and its `text`.");
  return w.queue(() =>
    w.d.locks.turn(
      id.trim(),
      async (): Promise<ApiAnswer> => {
        const task = await ownLiveTask(w.d, user, id);
        if (!task || task.type !== "research" || (task.status !== "active" && task.status !== "paused")) return problem(404, "not_found", NOT_FOUND_MESSAGE);
        const awaiting = (await awaitingFollowUp(w.d.store, task)) !== null;
        if (!sentResearch(task) && !awaiting) return problem(409, "conflict", "That research request searches the web itself: pages are sent in only to one made with `sources: browser`, or one waiting for pages for a fuller pass.");
        const sources = w.d.sources;
        if (!sources) return problem(503, "unavailable", "This bot cannot take pages just now; try again later.");
        if (!awaiting && !(await waitingForPages(w.d.store, task))) return problem(409, "conflict", "That research request has started: it takes no more pages.");
        const added = sources.add(task.id, pages, w.d.clock.now());
        if (!added.ok) {
          return problem(409, "too_many", `A request holds at most ${MAX_SOURCES_PER_TASK} pages, and this one holds ${added.held}: send at most ${MAX_SOURCES_PER_TASK - added.held} new ones (a page sent again replaces itself).`);
        }
        const budget = `a request holds at most ${MAX_SOURCES_CHARS.toLocaleString("en-US")} characters of page text in all, and this one holds ${added.chars.toLocaleString("en-US")}: send shorter text, or a page again with less to replace it`;
        const stored = added.added + added.replaced;
        if (stored === 0) return problem(409, "too_much_text", `None of those pages fit: ${budget}.`);
        const skipped = rejected > 0 ? ` ${rejected === 1 ? "1 was" : `${rejected} were`} left out: each needs an absolute http(s) address and its text, once.` : "";
        const over = added.overBudget > 0 ? ` ${added.overBudget === 1 ? "1 did" : `${added.overBudget} did`} not fit: ${budget}.` : "";
        const replaced = added.replaced > 0 ? ` (${added.replaced} replaced)` : "";
        return {
          status: 200,
          body: {
            accepted: stored,
            rejected,
            overBudget: added.overBudget,
            pages: added.held,
            message: `Took ${plural(stored, "page", "pages")}${replaced} for ${task.title}; it holds ${added.held}.${skipped}${over} Send ready when they are all in.`,
          },
        };
      },
      () => problem(409, "busy", TASK_BUSY),
    ),
  );
}

/** The ready route's answer for task `id`: the run moved to now, or why not. */
export async function sourcesReadyAnswer(w: Writer, user: User, id: string): Promise<ApiAnswer> {
  return w.queue(() =>
    w.d.locks.turn(
      id.trim(),
      async (): Promise<ApiAnswer> => {
        const task = await ownLiveTask(w.d, user, id);
        if (!task || task.type !== "research" || (task.status !== "active" && task.status !== "paused")) return problem(404, "not_found", NOT_FOUND_MESSAGE);
        const followUp = await awaitingFollowUp(w.d.store, task);
        if (!sentResearch(task) && !followUp) return problem(409, "conflict", "That research request searches the web itself: it does not wait for pages.");
        if (!followUp && !(await waitingForPages(w.d.store, task))) return problem(409, "conflict", "That research request is no longer waiting for pages.");
        if (task.status === "paused") return problem(409, "conflict", "That research request is paused: resume it, then send ready.");
        const held = w.d.sources?.count(task.id) ?? 0;
        if (held === 0) return problem(409, "conflict", "Send pages first: the request holds none.");
        const owner = await w.d.store.getUser(task.ownerId);
        if (!owner) return problem(404, "not_found", NOT_FOUND_MESSAGE);
        const now = w.d.clock.now();
        if (followUp) return fullerPass(w, user, task, owner, followUp, held, now);
        try {
          await reschedule(w.d.store, task, owner, { kind: "once", at: now.toISOString() }, user.id, now);
        } catch (err) {
          // A run sent out between the check and the move (docket refuses to move a `once` run then).
          if (err instanceof ScheduleError) return problem(409, "conflict", "That research request has started.");
          throw err;
        }
        return {
          status: 200,
          body: { pages: held, message: `Starting ${task.title} on ${held === 1 ? "1 page" : `${held} pages`} within a minute or two. A second run checks the answer before I DM it to you.` },
        };
      },
      () => problem(409, "busy", TASK_BUSY),
    ),
  );
}

/**
 * `ready` for a request waiting for a fuller pass (0.29.0), under the task's lock, `followUp` being
 * the row `awaitingFollowUp` just found (in phase `awaiting-pages`, queued, unfired, no Job out, no
 * try started). First moves the once task to now, then deletes that follow-up, as docket's contract
 * orders it: a move that throws or queues no run leaves the follow-up in place, so the request is
 * never left with nothing queued and still ends at its expiry. A follow-up that is somehow no longer
 * queued by then (none can be: the tick starts a run only of a task it holds) takes the new run back
 * out, so the second pass never runs twice.
 */
async function fullerPass(w: Writer, user: User, task: Task, owner: User, followUp: Occurrence, held: number, now: Date): Promise<ApiAnswer> {
  const store = w.d.store;
  let next: Occurrence | null;
  try {
    next = (await reschedule(store, task, owner, { kind: "once", at: now.toISOString() }, user.id, now)).next;
  } catch (err) {
    if (err instanceof ScheduleError) return problem(409, "conflict", "That research request has started.");
    throw err;
  }
  if (!next) return problem(409, "conflict", "That research request could not be started just now; try again later.");
  if (!(await store.deleteOccurrence(followUp.id))) {
    await store.deleteOccurrence(next.id);
    return problem(409, "conflict", "That research request has started.");
  }
  return {
    status: 200,
    body: { pages: held, message: `Starting a fuller pass of ${task.title} on ${held === 1 ? "1 page" : `${held} pages`} within a minute or two. A second run checks what it adds before I DM you the update.` },
  };
}
