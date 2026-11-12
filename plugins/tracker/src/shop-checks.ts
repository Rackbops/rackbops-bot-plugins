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
import { parseShopCheck, type ShopCheck, type ShopVerdict, type ShopVet, shopDomain, shopJob, shopStanding } from "@rackbops/docket-types";
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

/** How many waiting checks one tick looks at: past one whose owner is at a budget ceiling, to the next. */
export const SHOP_WAITING_LOOKED_AT = 20;

/**
 * How long a check may wait on city-hall before it is given up (48 h, the executor's paused-runner cap,
 * PAUSED_CAP_MS): its listings stay held, and the watch's next look asks again under a new key.
 */
export const SHOP_CHECK_GIVE_UP_MS = 48 * 3_600_000;

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

  /**
   * Asks for a check (once: a waiting one stays) and remembers the watch, to run it again after. A shop
   * whose verdict landed since the look read the list is not asked again; the look's next run tells it.
   */
  async request(domain: string, from: { taskId: string; ownerId: string }): Promise<void> {
    if (shopDomain(`https://${domain}/`) !== domain) return;
    const now = this.clock.now();
    if (shopStanding((await this.get([domain])).get(domain), now) !== "check") return;
    const at = now.toISOString();
    this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO shop_check_requests (domain, owner_id, requested_at) VALUES (?, ?, ?)").run(domain, from.ownerId, at);
      this.db.query("INSERT OR IGNORE INTO shop_check_waiters (domain, task_id, owner_id) VALUES (?, ?, ?)").run(domain, from.taskId, from.ownerId);
    })();
  }

  /** The oldest check waiting to run, or null. */
  next(): ShopRequest | null {
    return this.waiting(1)[0] ?? null;
  }

  /** The checks waiting to run, oldest first. */
  waiting(limit = SHOP_WAITING_LOOKED_AT): ShopRequest[] {
    return (
      this.db.query("SELECT domain, owner_id, requested_at FROM shop_check_requests ORDER BY requested_at, domain LIMIT ?").all(limit) as {
        domain: string;
        owner_id: string;
        requested_at: string;
      }[]
    ).map((r) => ({ domain: r.domain, ownerId: r.owner_id, requestedAt: r.requested_at }));
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
 * One step of the shop checks, on the execute tick. Every check already sent is asked about; when none
 * is, the oldest whose owner is not at a budget ceiling is sent, so one person at a ceiling never holds
 * up another's checks. On an answer the verdict is recorded (or the request dropped when the check
 * failed) and the waiting watches run again now. One city-hall put back after a usage limit waits; one
 * waiting past `SHOP_CHECK_GIVE_UP_MS`, or past the executor's paused-runner cap, is given up.
 */
export async function stepShopCheck(d: ShopCheckerDeps): Promise<ShopStep> {
  const waiting = d.checks.waiting();
  if (waiting.length === 0) return "idle";
  const sent = waiting.filter((r) => d.ids.get(keyOf(r)) !== null);
  if (sent.length > 0) {
    let step: ShopStep = "pending";
    for (const r of sent) {
      const s = await stepOne(d, r);
      if (step === "pending") step = s;
    }
    return step;
  }
  for (const r of waiting) {
    const s = await stepOne(d, r);
    if (s !== "held") return s;
  }
  return "held";
}

const keyOf = (r: ShopRequest): string => `shop:${r.domain}:${r.requestedAt}`;

function giveUp(d: ShopCheckerDeps, req: ShopRequest, key: string, why: string): ShopStep {
  d.ids.forget(key);
  d.checks.drop(req.domain);
  d.log.warn(`shop check ${req.domain} given up (${why}); its listings stay held and the next look asks again`);
  return "failed";
}

async function stepOne(d: ShopCheckerDeps, req: ShopRequest): Promise<ShopStep> {
  const key = keyOf(req);
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
    if (err instanceof JobPendingError || err instanceof ExecutorUnavailableError) {
      // The executor's own give-up on a runner paused too long, said as a pending answer.
      if (err instanceof JobPendingError && err.message.includes("past the paused-runner cap")) return giveUp(d, req, key, "the runner stayed paused");
      if (d.clock.now().getTime() - Date.parse(req.requestedAt) > SHOP_CHECK_GIVE_UP_MS) return giveUp(d, req, key, "no answer in 48 h");
      // Waiting in city-hall's queue, unreachable, or put back after a usage limit: asked again next tick.
      if (err instanceof ExecutorUnavailableError && requeuedAfter(err) !== null) d.log.info(`shop check ${req.domain}: waiting (${requeuedAfter(err)})`);
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
