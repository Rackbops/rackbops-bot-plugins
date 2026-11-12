import type { Database } from "bun:sqlite";
import {
  type BudgetPolicy,
  budgetHold,
  charge,
  type Clock,
  type Executor,
  ExecutorUnavailableError,
  FOLLOW_UP_PREFIX,
  hasFired,
  JobPendingError,
  runNowKey,
  type Store,
} from "@rackbops/docket-core";
import { parseShopCheck, type ShopCheck, type ShopVerdict, type ShopVet, shopDomain, shopJob } from "@rackbops/docket-types";
import type { PluginLog } from "../../../packages/api/contract.js";
import { type JobIdRecords, requeuedAfter } from "./executor.js";
import type { TaskLocks } from "./locks.js";

/**
 * The shop list (docket#120, plan item 162): before a Shopify watch tells a listing, its shop must
 * have a fresh verdict from one web search, "is <shop> a legitimate website" (docket-types'
 * `shop-vet`, which holds the rules). This file keeps the list, the checks asked for, and the
 * watches waiting on them, and runs one check at a time on the execute tick.
 *
 * The checks run outside the task system, as the intake's turns do: a Job at city-hall under its own
 * key (`shop:<domain>:<asked at>`), with its id in memory (a restart sends it again), charged to the
 * owner of the watch that asked first. No task is made, so no person sees a check in their lists.
 *
 * The tables are not a numbered migration, like the gift tables (gift-store.ts): made `IF NOT EXISTS`
 * on every open, so `PRAGMA user_version` stays at 13 and a tracker from before them still starts
 * after a rollback (it never reads them). Additive only.
 * - `shop_checks`: one verdict per shop; names no person.
 * - `shop_check_requests`: a check asked for and not done yet, and whose watch asked first.
 * - `shop_check_waiters`: the watches holding listings from that shop, run again once its verdict lands.
 * Forget-me deletes a person's requests and waiters (roster.ts); their shops' verdicts stay, naming no one.
 */

export const SHOP_TABLES = ["shop_check_waiters", "shop_check_requests"] as const;

/** The request id a shop check's run of a waiting watch starts with (`runNowKey`). */
export const SHOP_RUN_PREFIX = "shop-";

/** Makes the shop tables when absent. Idempotent; run on every open (schema.ts `openDatabase`). */
export function ensureShopTables(db: Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS shop_checks (
    domain TEXT PRIMARY KEY,
    verdict TEXT NOT NULL,
    reasons TEXT NOT NULL,
    sources TEXT NOT NULL,
    checked_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shop_check_requests (
    domain TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    requested_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shop_check_waiters (
    domain TEXT NOT NULL,
    task_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    PRIMARY KEY (domain, task_id)
  );
  `);
}

const strings = (raw: string): string[] => {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

export interface ShopRequest {
  domain: string;
  ownerId: string;
  requestedAt: string;
}

/** The host's `ShopVet` over the database, and what the checker and the admin view read. */
export class ShopChecks implements ShopVet {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async get(domains: readonly string[]): Promise<Map<string, ShopCheck>> {
    const out = new Map<string, ShopCheck>();
    const q = this.db.query("SELECT domain, verdict, reasons, sources, checked_at FROM shop_checks WHERE domain = ?");
    for (const d of new Set(domains)) {
      const r = q.get(d) as { domain: string; verdict: string; reasons: string; sources: string; checked_at: string } | null;
      if (r) out.set(r.domain, { domain: r.domain, verdict: r.verdict as ShopVerdict, reasons: strings(r.reasons), sources: strings(r.sources), checkedAt: r.checked_at });
    }
    return out;
  }

  /** Asks for a check (once: a waiting one stays) and remembers the watch, to run it again after. */
  async request(domain: string, from: { taskId: string; ownerId: string }): Promise<void> {
    if (shopDomain(`https://${domain}/`) !== domain) return;
    const at = this.clock.now().toISOString();
    this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO shop_check_requests (domain, owner_id, requested_at) VALUES (?, ?, ?)").run(domain, from.ownerId, at);
      this.db.query("INSERT OR IGNORE INTO shop_check_waiters (domain, task_id, owner_id) VALUES (?, ?, ?)").run(domain, from.taskId, from.ownerId);
    })();
  }

  /** The oldest check waiting to run, or null. */
  next(): ShopRequest | null {
    const r = this.db.query("SELECT domain, owner_id, requested_at FROM shop_check_requests ORDER BY requested_at, domain LIMIT 1").get() as {
      domain: string;
      owner_id: string;
      requested_at: string;
    } | null;
    return r ? { domain: r.domain, ownerId: r.owner_id, requestedAt: r.requested_at } : null;
  }

  /** Stores a verdict, ends its request, and hands back the watches that waited for it. */
  record(check: ShopCheck): string[] {
    return this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO shop_checks (domain, verdict, reasons, sources, checked_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (domain) DO UPDATE SET verdict = excluded.verdict, reasons = excluded.reasons, sources = excluded.sources, checked_at = excluded.checked_at`,
        )
        .run(check.domain, check.verdict, JSON.stringify(check.reasons), JSON.stringify(check.sources), check.checkedAt);
      return this.endRequest(check.domain);
    })();
  }

  /** Ends a request with no verdict (the check failed): its listings stay held, and the next look asks again. */
  drop(domain: string): string[] {
    return this.db.transaction(() => this.endRequest(domain))();
  }

  private endRequest(domain: string): string[] {
    const waiters = (this.db.query("SELECT task_id FROM shop_check_waiters WHERE domain = ? ORDER BY task_id").all(domain) as { task_id: string }[]).map((r) => r.task_id);
    this.db.query("DELETE FROM shop_check_waiters WHERE domain = ?").run(domain);
    this.db.query("DELETE FROM shop_check_requests WHERE domain = ?").run(domain);
    return waiters;
  }

  /** Every shop checked, newest first, for the admin view. */
  list(limit = 200): ShopCheck[] {
    return (
      this.db.query("SELECT domain, verdict, reasons, sources, checked_at FROM shop_checks ORDER BY checked_at DESC, domain LIMIT ?").all(limit) as {
        domain: string;
        verdict: string;
        reasons: string;
        sources: string;
        checked_at: string;
      }[]
    ).map((r) => ({ domain: r.domain, verdict: r.verdict as ShopVerdict, reasons: strings(r.reasons), sources: strings(r.sources), checkedAt: r.checked_at }));
  }
}

export interface ShopCheckerDeps {
  checks: ShopChecks;
  store: Store;
  executor: Executor;
  ids: JobIdRecords & { forget(jobKey: string): void };
  clock: Clock;
  locks: TaskLocks;
  budget: BudgetPolicy;
  log: PluginLog;
}

export type ShopStep = "idle" | "pending" | "held" | "recorded" | "failed";

/**
 * One step of the oldest check: submit it, or ask city-hall about it, and on an answer record the
 * verdict (or drop the request when it failed) and run the waiting watches again now. A check whose
 * owner is at a budget ceiling waits; one city-hall put back after a usage limit waits too.
 */
export async function stepShopCheck(d: ShopCheckerDeps): Promise<ShopStep> {
  const req = d.checks.next();
  if (!req) return "idle";
  const key = `shop:${req.domain}:${req.requestedAt}`;
  const owner = await d.store.getUser(req.ownerId);
  if (!owner) {
    // The person was forgotten after asking: their request should be gone with them; drop it if not.
    d.checks.drop(req.domain);
    return "failed";
  }
  const submitted = d.ids.get(key) !== null;
  if (!submitted && (await budgetHold(d.store, d.budget, owner, d.clock.now()))) return "held";
  let result: Awaited<ReturnType<Executor["run"]>>;
  try {
    result = await d.executor.run(submitted ? null : shopJob(req.domain), key, key);
  } catch (err) {
    if (err instanceof JobPendingError) return "pending";
    if (err instanceof ExecutorUnavailableError) {
      // Unreachable, or put back after a usage limit: asked again on the next tick, never given up.
      if (requeuedAfter(err) !== null) d.log.info(`shop check ${req.domain}: waiting (${requeuedAfter(err)})`);
      return "pending";
    }
    d.ids.forget(key);
    d.checks.drop(req.domain);
    d.log.warn(`shop check ${req.domain} failed (${err instanceof Error ? err.name : "error"})`);
    return "failed";
  }
  d.ids.forget(key);
  // docket's rule: a usage limit or a refused credential is not charged.
  if (result.kind !== "usage_limit" && result.kind !== "auth_failed") {
    await charge(d.store, { userId: owner.id, taskId: null, source: "run", key, calls: 1, costUsd: result.totalCostUsd ?? null, at: d.clock.now() });
  }
  const check = result.kind === "success" ? parseShopCheck(result.structuredOutput, req.domain, d.clock.now()) : null;
  if (!check) {
    d.checks.drop(req.domain);
    d.log.warn(`shop check ${req.domain}: ${result.kind === "success" ? "no usable answer" : result.kind}; its listings stay held`);
    return "failed";
  }
  const waiting = d.checks.record(check);
  d.log.info(`shop check ${req.domain}: ${check.verdict}`);
  for (const taskId of waiting) await runAgain(d, taskId);
  return "recorded";
}

/** Queues a run of a waiting watch now, unless it is gone, not active, or already has a run due. */
async function runAgain(d: ShopCheckerDeps, taskId: string): Promise<void> {
  await d.locks.run(taskId, async () => {
    const task = await d.store.getTask(taskId);
    if (!task || task.status !== "active" || (task.type !== "wantlist" && task.type !== "wantjudge")) return;
    const now = d.clock.now();
    // As run-now's own rule (run-now.ts): not while a run is due now or a follow-up waits; the
    // schedule's next run, due later, stays where it is.
    const queued = await d.store.listOccurrences({ taskId, status: "queued" });
    if (queued.some((o) => !hasFired(o) && (Date.parse(o.dueAt) <= now.getTime() || o.dedupeKey.startsWith(FOLLOW_UP_PREFIX)))) return;
    const at = now.toISOString();
    // A run-now key, so the schedule keeps its place; its request id starts `shop-`, so it is not
    // counted against the owner's own run-now allowance (store.ts `runsNowSince`).
    await d.store.createOccurrence({ taskId, lane: task.lane, dueAt: at, dedupeKey: runNowKey(taskId, `${SHOP_RUN_PREFIX}${crypto.randomUUID()}`), at });
  });
}
