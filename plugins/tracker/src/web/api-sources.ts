import { reschedule, ScheduleError, type User } from "@rackbops/docket-core";
import { gatheredPages } from "@rackbops/docket-types";
import { TASK_BUSY } from "../locks.js";
import { ownLiveTask } from "../manage.js";
import { MAX_SOURCES_PER_POST, MAX_SOURCES_PER_TASK, sentResearch, waitingForPages } from "../research-sources.js";
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
 *   `MAX_SOURCES_PER_POST` a request. Each is cleaned by docket-types' own `gatheredPages` (an
 *   absolute http(s) address, a one-line title, the text capped at `MAX_PAGE_CHARS`), which also
 *   drops a second page with the same address; a page whose address the request already holds
 *   replaces it. More than `MAX_SOURCES_PER_TASK` in all is a 409 that says how many it holds.
 * - `POST /tasks/<id>/sources/ready`: `{}`. Needs at least one page in (else 409), then moves the
 *   run to now through docket-core's `reschedule`, under the task's lock (locks.ts), as an edit
 *   moves one. That move is what ends the waiting (research-sources.ts's `waitingForPages`), so
 *   neither route takes the request after it, nor once a run of it has started.
 *
 * Only the token owner's own live research request on browser pages: anyone else's, an unknown id,
 * or a deleted or finished one answers the API's same 404; a web request, or one no longer waiting,
 * a 409. Both written in the surface's one queue, against the task as the store has it then.
 */

/** The sources route's answer to a body `body` for task `id`. */
export async function sourcesAnswer(w: Writer, user: User, id: string, body: Record<string, unknown>): Promise<ApiAnswer> {
  const extra = Object.keys(body).find((k) => k !== "pages");
  if (extra !== undefined) return problem(400, "unknown_field", `\`${extra.slice(0, 40)}\` is not a field here: send {"pages": [...]}.`);
  const raw = body.pages;
  if (!Array.isArray(raw)) return problem(400, "invalid", '`pages` must be an array of pages: {"url", "title", "text"}.');
  if (raw.length === 0) return problem(400, "invalid", "`pages` is empty.");
  if (raw.length > MAX_SOURCES_PER_POST) return problem(400, "too_many", `At most ${MAX_SOURCES_PER_POST} pages a request.`);
  const pages = gatheredPages(raw);
  const rejected = raw.length - pages.length;
  if (pages.length === 0) return problem(400, "invalid", "None of those pages could be used: each needs an absolute http(s) `url` and its `text`.");
  return w.queue(async (): Promise<ApiAnswer> => {
    const task = await ownLiveTask(w.d, user, id);
    if (!task || task.type !== "research" || (task.status !== "active" && task.status !== "paused")) return problem(404, "not_found", NOT_FOUND_MESSAGE);
    if (!sentResearch(task)) return problem(409, "conflict", "That research request searches the web itself: pages are sent in only to one made with `sources: browser`.");
    const sources = w.d.sources;
    if (!sources) return problem(503, "unavailable", "This bot cannot take pages just now; try again later.");
    if (!(await waitingForPages(w.d.store, task))) return problem(409, "conflict", "That research request has started: it takes no more pages.");
    const added = sources.add(task.id, pages, w.d.clock.now());
    if (!added.ok) {
      return problem(409, "too_many", `A request holds at most ${MAX_SOURCES_PER_TASK} pages, and this one holds ${added.held}: send at most ${MAX_SOURCES_PER_TASK - added.held} new ones (a page sent again replaces itself).`);
    }
    const skipped = rejected > 0 ? ` ${rejected === 1 ? "1 was" : `${rejected} were`} left out: each needs an absolute http(s) address and its text, once.` : "";
    const replaced = added.replaced > 0 ? ` (${added.replaced} replaced)` : "";
    return {
      status: 200,
      body: {
        accepted: pages.length,
        rejected,
        pages: added.held,
        message: `Took ${pages.length === 1 ? "1 page" : `${pages.length} pages`}${replaced} for ${task.title}; it holds ${added.held}.${skipped} Send ready when they are all in.`,
      },
    };
  });
}

/** The ready route's answer for task `id`: the run moved to now, or why not. */
export async function sourcesReadyAnswer(w: Writer, user: User, id: string): Promise<ApiAnswer> {
  return w.queue(() =>
    w.d.locks.turn(
      id.trim(),
      async (): Promise<ApiAnswer> => {
        const task = await ownLiveTask(w.d, user, id);
        if (!task || task.type !== "research" || (task.status !== "active" && task.status !== "paused")) return problem(404, "not_found", NOT_FOUND_MESSAGE);
        if (!sentResearch(task)) return problem(409, "conflict", "That research request searches the web itself: it does not wait for pages.");
        if (!(await waitingForPages(w.d.store, task))) return problem(409, "conflict", "That research request is no longer waiting for pages.");
        if (task.status === "paused") return problem(409, "conflict", "That research request is paused: resume it, then send ready.");
        const held = w.d.sources?.count(task.id) ?? 0;
        if (held === 0) return problem(409, "conflict", "Send pages first: the request holds none.");
        const owner = await w.d.store.getUser(task.ownerId);
        if (!owner) return problem(404, "not_found", NOT_FOUND_MESSAGE);
        const now = w.d.clock.now();
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
