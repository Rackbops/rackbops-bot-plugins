import type { Database } from "bun:sqlite";
import { DISPATCHER, FOLLOW_UP_PREFIX, hasFired, hasJobOut, type Occurrence, type Store, type Task } from "@rackbops/docket-core";
import { type BlockedPage, type GatheredPage, MAX_GATHERED_CHARS, MAX_GATHERED_PAGES, MIN_PAGE_CHARS, type ResearchConfig, researchState, usesSentSources } from "@rackbops/docket-types";

/**
 * Pages gathered for a research request by the person's own browser (docket-types 0.8.0's
 * `sources: "sent"`; tracker 0.28.0, rackbops-bot-plugins#125): the host's half. BoardGameGeek
 * refuses the runner's reads and declined API access, and eBay is never opened by the tracker
 * (Rod, 2026-10-05), so a request made with `/research sources: browser` waits for pages instead
 * of searching for them: the owner's browser -- Claude in Chrome, when they ask it to -- reads the
 * pages and posts them to the task API's `POST /tasks/<id>/sources` (web/api-sources.ts), then
 * `POST /tasks/<id>/sources/ready` moves the queued run to now. Each run of the request (the
 * research run and its reviewer) reads them here through docket's `ReadSources`, by task id.
 *
 * What is stored is never what was sent: each page goes through docket-types' own `gatheredPages`
 * first (an absolute http(s) address, a one-line title, the text without control characters, each
 * capped), and docket cleans what it reads again, whatever a host stores. One row per address per
 * request (`UNIQUE (task_id, url)`, schema migration 11): a page sent again replaces its row, in
 * its place. At most `MAX_GATHERED_PAGES` (10) per request, the most one run reads, and
 * `MAX_SOURCES_CHARS` of text in all: more is refused, not rolled over, since which pages matter is
 * the sender's call, not the oldest-first window an inbox keeps. A request that has ended --
 * answered, failed, deleted -- loses its pages at the execute tick's housekeeping (`purgeEnded`, so
 * only while the execute lane is configured); forget-me always erases them with the person's tasks.
 */

/** Pages one `POST /tasks/<id>/sources` may carry, and one request may hold: docket's own cap. */
export const MAX_SOURCES_PER_POST = MAX_GATHERED_PAGES;
export const MAX_SOURCES_PER_TASK = MAX_GATHERED_PAGES;

/**
 * Page text one request may hold in all, so that docket's read uses every page stored: docket keeps
 * `MAX_GATHERED_CHARS` (100,000) across a request's pages, oldest first, and stops at a page that
 * would get fewer than `MIN_PAGE_CHARS` (200) of what is left. With at most this much in all, every
 * page has more than that left before it and fits whole, so nothing stored is cut or dropped there.
 */
export const MAX_SOURCES_CHARS = MAX_GATHERED_CHARS - MIN_PAGE_CHARS;

/**
 * How long a request waits for its pages, and when that wait ends if `ready` never comes, are
 * docket-types' since 0.9.0 (`SOURCES_WAIT_DAYS`, `SOURCES_DEADLINE_MARGIN_MINUTES`,
 * `sourcesExpiry`): the same 14 days, or 10 minutes before a sooner deadline, that the tracker's own
 * copy here said in 0.28.0. A browser request's first run is queued then (research.ts), and docket
 * queues the fuller pass's wait the same way (`awaitingPages`).
 */

/**
 * What `add` did: stored (new and replaced rows, how many pages left out because their text would
 * take the request past `MAX_SOURCES_CHARS`, and how many pages and characters it holds now), or
 * refused as too many pages.
 */
export type Added = { ok: true; added: number; replaced: number; overBudget: number; held: number; chars: number } | { ok: false; held: number };

/** The `research_sources` table (schema migration 11). */
export class ResearchSources {
  constructor(private readonly db: Database) {}

  /**
   * Stores `pages` (already cleaned: docket-types' `gatheredPages`, one per address) for the request
   * `taskId`, in the order given, in one transaction: a page whose address the request already holds
   * replaces that row; the rest are added, unless the request would then hold more than
   * `MAX_SOURCES_PER_TASK`, when nothing is stored and `held` says how many it holds. A page whose
   * text would take the request's total past `MAX_SOURCES_CHARS` (the text already stored, less the
   * row it replaces) is left out whole, not cut, and counted in `overBudget`; the ones after it are
   * still tried.
   */
  add(taskId: string, pages: readonly GatheredPage[], now: Date): Added {
    const at = now.toISOString();
    return this.db.transaction((): Added => {
      // Lengths as JavaScript counts them, as docket's budget does (SQLite's length() counts code points).
      const stored = new Map((this.db.query("SELECT url, text FROM research_sources WHERE task_id = ?").all(taskId) as { url: string; text: string }[]).map((r) => [r.url, r.text.length]));
      const fresh = new Set(pages.map((p) => p.url).filter((u) => !stored.has(u)));
      if (stored.size + fresh.size > MAX_SOURCES_PER_TASK) return { ok: false, held: stored.size };
      const upsert = this.db.query(
        "INSERT INTO research_sources (task_id, url, title, text, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (task_id, url) DO UPDATE SET title = excluded.title, text = excluded.text, at = excluded.at",
      );
      let chars = 0;
      for (const n of stored.values()) chars += n;
      let added = 0;
      let replaced = 0;
      let overBudget = 0;
      for (const p of pages) {
        const before = stored.get(p.url);
        const after = chars - (before ?? 0) + p.text.length;
        if (after > MAX_SOURCES_CHARS) {
          overBudget++;
          continue;
        }
        upsert.run(taskId, p.url, p.title, p.text, at);
        chars = after;
        stored.set(p.url, p.text.length);
        if (before === undefined) added++;
        else replaced++;
      }
      return { ok: true, added, replaced, overBudget, held: stored.size, chars };
    })();
  }

  /** docket's `ReadSources`: the request's pages, oldest first (a replaced page keeps its place). */
  read(taskId: string): GatheredPage[] {
    return this.db.query("SELECT url, title, text FROM research_sources WHERE task_id = ? ORDER BY seq").all(taskId) as GatheredPage[];
  }

  /** How many pages the request holds. */
  count(taskId: string): number {
    return Number((this.db.query("SELECT COUNT(*) AS n FROM research_sources WHERE task_id = ?").get(taskId) as { n: number }).n);
  }

  /**
   * Deletes the pages of every request that is no longer active or paused (answered, failed,
   * deleted, or gone). No run reads them again: a finished task never runs. Returns how many rows went.
   */
  purgeEnded(): number {
    return this.db.query("DELETE FROM research_sources WHERE task_id NOT IN (SELECT 't' || seq FROM tasks WHERE status IN ('active', 'paused'))").run().changes;
  }
}

/** Whether `task` is a research request on gathered pages (`sources: "sent"`, made with `sources: browser`). */
export function sentResearch(task: Task): boolean {
  return task.type === "research" && usesSentSources((task.config ?? {}) as ResearchConfig);
}

/**
 * Whether a browser request still waits for its first pages (0.28.0): live, its run never moved
 * (`sources/ready` moves it, and docket's `reschedule` records that as the task's one
 * `schedule_changed` -- no edit changes a research request's schedule, and an hour or zone change
 * moves only calendar and period tasks), and no run of it ever started (none running, fired,
 * finished, with a Job out at the runner, or with any event of docket's dispatcher). The last is
 * what freezes the pages once a run has read them: the dispatcher writes its "started" event after
 * marking a run `running` and before the type's `prepare` reads the pages, and a run it puts back
 * unsent (the runner unreachable, the usage limit) goes back to `queued` with no Job out, but keeps
 * that event. Pages taken after it would change the next try's prompt under the same Job key, which
 * the Executor refuses (executor.ts). No column records it: the task's own history does.
 */
async function waitingForFirstPages(store: Store, task: Task): Promise<boolean> {
  if (!sentResearch(task) || (task.status !== "active" && task.status !== "paused")) return false;
  if ((await store.listTaskEvents(task.id)).some((e) => e.kind === "schedule_changed")) return false;
  for (const o of await store.listOccurrences({ taskId: task.id })) {
    if (o.status !== "queued" || hasFired(o) || (await hasJobOut(store, o))) return false;
    if ((await store.listEvents(o.id)).some((e) => e.agent === DISPATCHER)) return false;
  }
  return true;
}

/**
 * The queued follow-up a research request waits for its fuller pass on (docket-types 0.9.0, phase
 * `awaiting-pages`), or null when it does not wait so: live, in that phase, and its only queued or
 * running run is that one `followup:` row, unfired, with no Job out and no event of docket's
 * dispatcher (so no try of the second pass has started and read the pages), and no try of it has
 * failed (docket-types counts a retryable failure in `failures` and queues a fresh `followup:` retry
 * row, in the same phase; that row is the retry, with the auth backoff, not a wait). A try put back with its
 * Job still pending goes back to `queued` with that Job out (docket-core's dispatcher), which is why
 * the Job and the event are checked and not the status alone: `ready` deleting such a row would
 * orphan its Job and run the second pass twice. Any other row pending beside it -- the review run
 * that asked for it still finishing, or a run `ready` already queued -- means it does not wait.
 */
export async function awaitingFollowUp(store: Store, task: Task): Promise<Occurrence | null> {
  if (task.type !== "research" || (task.status !== "active" && task.status !== "paused")) return null;
  // `failures` 0: docket enters the wait with it reset, and a second-pass try that fails retryably
  // keeps the phase but counts it and queues a fresh follow-up, so a retry row never reads as a wait.
  const state = researchState(task.state);
  if (state.phase !== "awaiting-pages" || state.failures !== 0) return null;
  const pending = (await store.listOccurrences({ taskId: task.id })).filter((o) => o.status === "queued" || o.status === "running");
  const [o] = pending;
  if (!o || pending.length !== 1) return null;
  if (o.status !== "queued" || !o.dedupeKey.startsWith(FOLLOW_UP_PREFIX) || hasFired(o) || (await hasJobOut(store, o))) return null;
  if ((await store.listEvents(o.id)).some((e) => e.agent === DISPATCHER)) return null;
  return o;
}

/**
 * Whether a research request waits for pages for a fuller pass (0.29.0, docket-types 0.9.0; docket
 * sends only `sources: web` requests there, but nothing here assumes it): its first answer, which listed pages its run could not
 * open, was reviewed and DMed, and it waits on one queued follow-up at its expiry (up to 14 days,
 * `sourcesExpiry`), sending, running and charging nothing, until the owner's browser sends pages and
 * `ready` (web/api-sources.ts).
 */
export async function awaitingPages(store: Store, task: Task): Promise<boolean> {
  return (await awaitingFollowUp(store, task)) !== null;
}

/**
 * Whether a research request takes pages now: a browser request still waiting for its first ones
 * (0.28.0), or any request waiting for a fuller pass (`awaitingPages`, 0.29.0).
 */
export async function waitingForPages(store: Store, task: Task): Promise<boolean> {
  return (await waitingForFirstPages(store, task)) || (await awaitingPages(store, task));
}

/**
 * Whether a research request is, or was, in the fuller pass (0.29.0): its first answer listed pages
 * its run could not open, it waits or waited for pages, or its second pass answered. What the sources
 * routes say to a web request no longer waiting, rather than that it never takes pages.
 */
export function inFullerPass(task: Task): boolean {
  if (task.type !== "research") return false;
  const s = researchState(task.state);
  return s.phase === "awaiting-pages" || s.pass === 2 || (s.blocked?.length ?? 0) > 0;
}

/** The pages the request's first answer said its run could not open (docket-types' state), for the browser that gathers them. */
export function blockedPages(task: Task): BlockedPage[] {
  if (task.type !== "research") return [];
  return researchState(task.state).blocked ?? [];
}
