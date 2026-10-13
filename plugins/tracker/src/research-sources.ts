import type { Database } from "bun:sqlite";
import { hasFired, hasJobOut, type Store, type Task } from "@rackbops/docket-core";
import { type GatheredPage, MAX_GATHERED_PAGES, type ResearchConfig, usesSentSources } from "@rackbops/docket-types";

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
 * its place. At most `MAX_GATHERED_PAGES` (10) per request, the most one run reads: more is
 * refused, not rolled over, since which ten matter is the sender's call, not the oldest-first
 * window an inbox keeps. A request that has ended -- answered, failed, deleted -- loses its pages
 * at the execute tick's housekeeping (`purgeEnded`); forget-me erases them with the person's tasks.
 */

/** Pages one `POST /tasks/<id>/sources` may carry, and one request may hold: docket's own cap. */
export const MAX_SOURCES_PER_POST = MAX_GATHERED_PAGES;
export const MAX_SOURCES_PER_TASK = MAX_GATHERED_PAGES;

/**
 * How long a browser request waits for its pages before its run starts anyway (or its deadline,
 * when sooner): with no page in, that run makes no model call and tells the owner (docket's
 * "No pages were gathered for it"), and the request ends.
 */
export const SOURCES_WAIT_DAYS = 14;
export const SOURCES_WAIT_MS = SOURCES_WAIT_DAYS * 24 * 60 * 60 * 1000;

/** What `add` did: stored (new and replaced rows, and how many the request holds now), or refused as too many. */
export type Added = { ok: true; added: number; replaced: number; held: number } | { ok: false; held: number };

/** The `research_sources` table (schema migration 11). */
export class ResearchSources {
  constructor(private readonly db: Database) {}

  /**
   * Stores `pages` (already cleaned: docket-types' `gatheredPages`) for the request `taskId`, in the
   * order given, in one transaction: a page whose address the request already holds replaces that
   * row; the rest are added, unless the request would then hold more than `MAX_SOURCES_PER_TASK`,
   * when nothing is stored and `held` says how many it holds.
   */
  add(taskId: string, pages: readonly GatheredPage[], now: Date): Added {
    const at = now.toISOString();
    return this.db.transaction((): Added => {
      const known = new Set((this.db.query("SELECT url FROM research_sources WHERE task_id = ?").all(taskId) as { url: string }[]).map((r) => r.url));
      const fresh = new Set(pages.map((p) => p.url).filter((u) => !known.has(u)));
      if (known.size + fresh.size > MAX_SOURCES_PER_TASK) return { ok: false, held: known.size };
      const upsert = this.db.query(
        "INSERT INTO research_sources (task_id, url, title, text, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (task_id, url) DO UPDATE SET title = excluded.title, text = excluded.text, at = excluded.at",
      );
      for (const p of pages) upsert.run(taskId, p.url, p.title, p.text, at);
      return { ok: true, added: fresh.size, replaced: pages.length - fresh.size, held: known.size + fresh.size };
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
 * tasks), and no run of it started (none running, fired, finished, or with a Job out at the
 * runner). No column records it: the task's own history does.
 */
export async function waitingForPages(store: Store, task: Task): Promise<boolean> {
  if (!sentResearch(task) || (task.status !== "active" && task.status !== "paused")) return false;
  if ((await store.listTaskEvents(task.id)).some((e) => e.kind === "schedule_changed")) return false;
  for (const o of await store.listOccurrences({ taskId: task.id })) {
    if (o.status !== "queued" || hasFired(o) || (await hasJobOut(store, o))) return false;
  }
  return true;
}
