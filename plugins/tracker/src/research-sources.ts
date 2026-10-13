import type { Database } from "bun:sqlite";
import { DISPATCHER, hasFired, hasJobOut, type Store, type Task } from "@rackbops/docket-core";
import { type GatheredPage, MAX_GATHERED_CHARS, MAX_GATHERED_PAGES, MIN_PAGE_CHARS, type ResearchConfig, usesSentSources } from "@rackbops/docket-types";

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
 * How long a browser request waits for `ready` before its run starts anyway, on whatever pages are
 * in by then (or a little before its deadline, when sooner: `sourcesExpiry`): with no page in, that
 * run makes no model call and tells the owner (docket's "No pages were gathered"), and the request
 * ends.
 */
export const SOURCES_WAIT_DAYS = 14;
export const SOURCES_WAIT_MS = SOURCES_WAIT_DAYS * 24 * 60 * 60 * 1000;

/**
 * How long before its deadline a browser request's run starts when the deadline comes first:
 * docket's research run makes no call once it starts past the deadline, and the execute tick picks
 * a due run up within a minute or two, so a run queued at the deadline itself would always miss it.
 */
export const SOURCES_DEADLINE_MARGIN_MINUTES = 10;
const SOURCES_DEADLINE_MARGIN_MS = SOURCES_DEADLINE_MARGIN_MINUTES * 60 * 1000;

/**
 * When a browser request made at `now` runs if `ready` never comes: `SOURCES_WAIT_DAYS` out, or
 * `SOURCES_DEADLINE_MARGIN_MINUTES` before its deadline when that is sooner (never before `now`).
 * `byDeadline` says which.
 */
export function sourcesExpiry(now: Date, deadline: Date | null): { at: Date; byDeadline: boolean } {
  const wait = now.getTime() + SOURCES_WAIT_MS;
  if (!deadline || deadline.getTime() - SOURCES_DEADLINE_MARGIN_MS >= wait) return { at: new Date(wait), byDeadline: false };
  return { at: new Date(Math.max(now.getTime(), deadline.getTime() - SOURCES_DEADLINE_MARGIN_MS)), byDeadline: true };
}

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
 * Whether a browser request still waits for its pages: live, its run never moved (`sources/ready`
 * moves it, and docket's `reschedule` records that as the task's one `schedule_changed` -- no edit
 * changes a research request's schedule, and an hour or zone change moves only calendar and period
 * tasks), and no run of it ever started (none running, fired, finished, with a Job out at the
 * runner, or with any event of docket's dispatcher). The last is what freezes the pages once a run
 * has read them: the dispatcher writes its "started" event after marking a run `running` and before
 * the type's `prepare` reads the pages, and a run it puts back unsent (the runner unreachable, the
 * usage limit) goes back to `queued` with no Job out, but keeps that event. Pages taken after it
 * would change the next try's prompt under the same Job key, which the Executor refuses
 * (executor.ts). No column records it: the task's own history does.
 */
export async function waitingForPages(store: Store, task: Task): Promise<boolean> {
  if (!sentResearch(task) || (task.status !== "active" && task.status !== "paused")) return false;
  if ((await store.listTaskEvents(task.id)).some((e) => e.kind === "schedule_changed")) return false;
  for (const o of await store.listOccurrences({ taskId: task.id })) {
    if (o.status !== "queued" || hasFired(o) || (await hasJobOut(store, o))) return false;
    if ((await store.listEvents(o.id)).some((e) => e.agent === DISPATCHER)) return false;
  }
  return true;
}
