import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { type Clock, createTask, type Executor, ExecutorUnavailableError, JobPendingError, type JobResult, type JobSpec, runNowKey, type User } from "@rackbops/docket-core";
import { type ShopCheck, type SourceId, shopifySource, wantlistType } from "@rackbops/docket-types";
import { Ceilings } from "./ceilings.js";
import { IntakeJobIds } from "./intake.js";
import { TaskLocks } from "./locks.js";
import { Roster } from "./roster.js";
import { migrate, openDatabase } from "./schema.js";
import { SHOP_RUN_PREFIX, SHOP_TABLES, ShopChecks, stepShopCheck } from "./shop-checks.js";
import { SqliteStore } from "./store.js";
import { removeDir } from "./test-dirs.js";
import { executeBudget } from "./usage.js";

const NOW = new Date("2026-11-12T00:00:00.000Z");
let at = NOW;
const clock: Clock = { now: () => at };
afterEach(() => {
  at = NOW;
});
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

const opened: Database[] = [];
afterEach(() => {
  for (const d of opened.splice(0)) d.close();
});

async function setup() {
  const db = openDatabase(":memory:");
  opened.push(db);
  const store = new SqliteStore(db);
  const owner = await store.createUser({ discordId: null, displayName: "Rod", timeZone: "America/New_York", preferredHour: 9, admin: true, at: NOW.toISOString() });
  const checks = new ShopChecks(db, clock);
  const budget = executeBudget(new Ceilings(db), false);
  return { db, store, owner, checks, budget };
}

async function watch(store: SqliteStore, owner: User, source: SourceId = "shopify") {
  const { task } = await createTask(
    store,
    { userId: owner.id, admin: true },
    owner,
    { type: wantlistType({}), title: "Feast of Hemlock Vale", config: { source, target: "Feast of Hemlock Vale" }, schedule: { kind: "poll", every: 24, unit: "hour", start: new Date(NOW.getTime() + 3_600_000).toISOString() } },
    NOW,
  );
  return task;
}

/** An Executor that answers each call from `answers` in turn: a result, or an error to throw. */
function fakeExecutor(answers: (JobResult | Error)[]) {
  const calls: { spec: JobSpec | null; key: string }[] = [];
  const executor: Executor = {
    async run(spec, _occurrenceId, key) {
      calls.push({ spec, key });
      const next = answers.shift();
      if (!next) throw new Error("no answer scripted");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { executor, calls };
}

const success = (out: unknown): JobResult => ({ kind: "success", result: "", structuredOutput: out, totalCostUsd: 0.02, durationMs: 5 });
const FLAGGED = { verdict: "flagged", reasons: ["ScamAdviser: very low trust score"], sources: ["https://www.scamadviser.com/check-website/tradingcardgame.us"] };

describe("ShopChecks", () => {
  it("asks once per shop, remembers each waiting watch, and reads a verdict back", async () => {
    const { checks } = await setup();
    await checks.request("tradingcardgame.us", { taskId: "t1", ownerId: "u1" });
    await checks.request("tradingcardgame.us", { taskId: "t2", ownerId: "u2" });
    await checks.request("tradingcardgame.us", { taskId: "t1", ownerId: "u1" });
    expect(checks.next()).toEqual({ domain: "tradingcardgame.us", ownerId: "u1", requestedAt: NOW.toISOString() });
    const check: ShopCheck = { domain: "tradingcardgame.us", verdict: "flagged", reasons: ["r"], sources: ["https://x.example/"], checkedAt: NOW.toISOString() };
    expect(checks.record(check)).toEqual(["t1", "t2"]);
    expect(checks.next()).toBeNull();
    expect((await checks.get(["tradingcardgame.us", "other.com"])).get("tradingcardgame.us")).toEqual(check);
    expect((await checks.get(["other.com"])).size).toBe(0);
    expect(checks.list().map((c) => c.domain)).toEqual(["tradingcardgame.us"]);
  });

  it("asks nothing for a shop whose verdict is fresh, and asks again once it is stale", async () => {
    const { checks } = await setup();
    checks.record({ domain: "good.com", verdict: "ok", reasons: [], sources: ["https://x.example/"], checkedAt: NOW.toISOString() });
    await checks.request("good.com", { taskId: "t1", ownerId: "u1" });
    expect(checks.next()).toBeNull();
    at = new Date("2027-05-13T00:00:00.000Z");
    await checks.request("good.com", { taskId: "t1", ownerId: "u1" });
    expect(checks.next()?.domain).toBe("good.com");
  });

  it("refuses a name that is not a shop's", async () => {
    const { checks } = await setup();
    await checks.request("10.0.0.1", { taskId: "t1", ownerId: "u1" });
    await checks.request("nas.local", { taskId: "t1", ownerId: "u1" });
    expect(checks.next()).toBeNull();
  });
});

describe("stepShopCheck", () => {
  async function wired(answers: (JobResult | Error)[]) {
    const s = await setup();
    const { executor, calls } = fakeExecutor(answers);
    const ids = new IntakeJobIds();
    const deps = { checks: s.checks, store: s.store, executor, ids, clock, locks: new TaskLocks(), budget: s.budget, log };
    return { ...s, deps, calls, ids };
  }

  it("runs one search, records the verdict, charges the owner and runs the waiting watch now", async () => {
    const w = await wired([success(FLAGGED)]);
    const t = await watch(w.store, w.owner);
    await w.checks.request("tradingcardgame.us", { taskId: t.id, ownerId: w.owner.id });
    expect(await stepShopCheck(w.deps)).toBe("recorded");
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]?.spec?.prompt).toContain("is tradingcardgame.us a legitimate website");
    expect(w.calls[0]?.spec?.allowedTools).toEqual(["WebSearch"]);
    expect((await w.checks.get(["tradingcardgame.us"])).get("tradingcardgame.us")?.verdict).toBe("flagged");
    const usage = await w.store.listUsage({ userId: w.owner.id });
    expect(usage.map((u) => [u.calls, u.taskId])).toEqual([[1, null]]);
    const queued = await w.store.listOccurrences({ taskId: t.id, status: "queued" });
    const now = queued.filter((o) => o.dedupeKey.startsWith(`now:${t.id}:${SHOP_RUN_PREFIX}`));
    expect(now).toHaveLength(1);
    expect(await stepShopCheck(w.deps)).toBe("idle");
  });

  it("queues no extra run when the watch already has one due now", async () => {
    const w = await wired([success(FLAGGED)]);
    const t = await watch(w.store, w.owner);
    await w.store.createOccurrence({ taskId: t.id, lane: t.lane, dueAt: NOW.toISOString(), dedupeKey: "due-now", at: NOW.toISOString() });
    await w.checks.request("tradingcardgame.us", { taskId: t.id, ownerId: w.owner.id });
    expect(await stepShopCheck(w.deps)).toBe("recorded");
    const queued = await w.store.listOccurrences({ taskId: t.id, status: "queued" });
    expect(queued.filter((o) => o.dedupeKey.startsWith("now:"))).toHaveLength(0);
  });

  it("does not count its run against the owner's own run-now allowance", async () => {
    const w = await wired([success(FLAGGED)]);
    const t = await watch(w.store, w.owner);
    await w.checks.request("tradingcardgame.us", { taskId: t.id, ownerId: w.owner.id });
    await stepShopCheck(w.deps);
    expect(await w.store.runsNowSince(w.owner.id, "2026-01-01T00:00:00Z")).toBe(0);
    await w.store.createOccurrence({ taskId: t.id, lane: t.lane, dueAt: NOW.toISOString(), dedupeKey: runNowKey(t.id, "mine"), at: NOW.toISOString() });
    expect(await w.store.runsNowSince(w.owner.id, "2026-01-01T00:00:00Z")).toBe(1);
  });

  it("waits while the Job is out, asking again without resubmitting", async () => {
    const w = await wired([new JobPendingError("city-hall job is queued"), success({ verdict: "ok", reasons: [], sources: ["https://www.trustpilot.com/review/good.com"] })]);
    await w.checks.request("good.com", { taskId: "t9", ownerId: w.owner.id });
    // The city-hall Executor records the remote id on submission; the fake stands in for it.
    w.ids.put("shop:good.com:" + NOW.toISOString(), "x", "remote-1", NOW.toISOString());
    expect(await stepShopCheck(w.deps)).toBe("pending");
    expect(await stepShopCheck(w.deps)).toBe("recorded");
    expect(w.calls.map((c) => c.spec === null)).toEqual([true, true]);
  });

  it("waits when city-hall is unreachable or the runner is at a usage limit", async () => {
    const w = await wired([new ExecutorUnavailableError("city-hall requeued the job after usage_limit"), new ExecutorUnavailableError("fetch failed")]);
    await w.checks.request("good.com", { taskId: "t9", ownerId: w.owner.id });
    expect(await stepShopCheck(w.deps)).toBe("pending");
    expect(await stepShopCheck(w.deps)).toBe("pending");
    expect(w.checks.next()?.domain).toBe("good.com");
  });

  it("records nothing when the check fails, so the listing stays held and the next look asks again", async () => {
    const w = await wired([
      { kind: "turn_cap", detail: "out of turns", durationMs: 1 },
      success({ verdict: "maybe" }),
      { kind: "usage_limit", detail: "limit", durationMs: 1 },
    ]);
    for (let i = 0; i < 3; i++) {
      at = new Date(NOW.getTime() + i * 60_000);
      await w.checks.request("bad.us", { taskId: "t9", ownerId: w.owner.id });
      expect(await stepShopCheck(w.deps)).toBe("failed");
      expect((await w.checks.get(["bad.us"])).size).toBe(0);
      expect(w.checks.next()).toBeNull();
    }
    // Two charged (a turn cap and a bad answer ran); a usage limit is not.
    expect((await w.store.listUsage({ userId: w.owner.id })).length).toBe(2);
  });
});

describe("stepShopCheck, several waiting", () => {
  it("passes over a check whose owner is at a ceiling, so another person's runs", async () => {
    const s = await setup();
    const other = await s.store.createUser({ discordId: null, displayName: "Bea", timeZone: "UTC", preferredHour: 9, admin: false, at: NOW.toISOString() });
    const { executor, calls } = fakeExecutor([success(FLAGGED)]);
    // Rod is at his ceiling (0 calls a day); Bea is not.
    const budget = { ...s.budget, personFor: (u: User) => (u.id === s.owner.id ? { usd: null, calls: 0 } : null) };
    const deps = { checks: s.checks, store: s.store, executor, ids: new IntakeJobIds(), clock, locks: new TaskLocks(), budget, log };
    await s.checks.request("first.us", { taskId: "t1", ownerId: s.owner.id });
    at = new Date(NOW.getTime() + 60_000);
    await s.checks.request("second.us", { taskId: "t2", ownerId: other.id });
    expect(await stepShopCheck(deps)).toBe("recorded");
    expect(calls[0]?.spec?.prompt).toContain("is second.us a legitimate website");
    expect(s.checks.waiting().map((r) => r.domain)).toEqual(["first.us"]);
    expect(await stepShopCheck(deps)).toBe("held");
    expect(calls).toHaveLength(1);
  });

  it("gives a check up after 48 h without an answer, or when the executor gives up on a paused runner", async () => {
    const s = await setup();
    const { executor } = fakeExecutor([
      new JobPendingError("city-hall job is queued"),
      new ExecutorUnavailableError("city-hall requeued the job after usage_limit"),
      new JobPendingError("city-hall job is queued, past the paused-runner cap"),
    ]);
    const ids = new IntakeJobIds();
    const deps = { checks: s.checks, store: s.store, executor, ids, clock, locks: new TaskLocks(), budget: s.budget, log };
    await s.checks.request("slow.us", { taskId: "t1", ownerId: s.owner.id });
    ids.put(`shop:slow.us:${NOW.toISOString()}`, "x", "remote-1", NOW.toISOString());
    expect(await stepShopCheck(deps)).toBe("pending");
    at = new Date(NOW.getTime() + 48 * 3_600_000 + 1);
    expect(await stepShopCheck(deps)).toBe("failed");
    expect(s.checks.waiting()).toEqual([]);
    expect(ids.get(`shop:slow.us:${NOW.toISOString()}`)).toBeNull();
    // Asked again by the next look: a paused-cap answer gives it up at once.
    await s.checks.request("slow.us", { taskId: "t1", ownerId: s.owner.id });
    ids.put(`shop:slow.us:${at.toISOString()}`, "x", "remote-2", at.toISOString());
    expect(await stepShopCheck(deps)).toBe("failed");
    expect(s.checks.waiting()).toEqual([]);
    expect((await s.checks.get(["slow.us"])).size).toBe(0);
  });

  it("drops a check whose owner is gone, and one the executor threw on", async () => {
    const s = await setup();
    const { executor, calls } = fakeExecutor([new Error("bad spec")]);
    const deps = { checks: s.checks, store: s.store, executor, ids: new IntakeJobIds(), clock, locks: new TaskLocks(), budget: s.budget, log };
    await s.checks.request("gone.us", { taskId: "t1", ownerId: "nobody" });
    expect(await stepShopCheck(deps)).toBe("failed");
    expect(calls).toHaveLength(0);
    await s.checks.request("throws.us", { taskId: "t1", ownerId: s.owner.id });
    expect(await stepShopCheck(deps)).toBe("failed");
    expect(s.checks.waiting()).toEqual([]);
    expect((await s.store.listUsage({ userId: s.owner.id })).length).toBe(0);
  });
});

describe("a Shopify watch over the shop list", () => {
  it("holds a listing until its shop is checked, then tells it on the run the check queued", async () => {
    const s = await setup();
    const product = {
      id: "gid://shopify/p/1",
      title: "Arkham Horror The Feast of Hemlock Vale Campaign Expansion",
      variants: [{ id: "gid://shopify/ProductVariant/1", title: "Default Title", url: "https://good.com/p?variant=1", price: { amount: 7355, currency: "USD" }, availability: { available: true }, seller: { name: "Good" }, condition: ["new"] }],
    };
    const shopify = shopifySource(async () => ({ status: 200, body: { data: { alexandria: [{ data: { products: [product] } }] } } }));
    const type = wantlistType({ shopify }, { shops: s.checks });
    const t = await watch(s.store, s.owner);
    const ctx = (state: unknown) => ({
      task: t,
      occurrence: { id: "o1", taskId: t.id, dedupeKey: "k" } as never,
      owner: s.owner,
      recipients: [],
      config: t.config as never,
      state,
      now: NOW,
      ports: {},
      history: { events: [], replies: [], series: [] },
    });
    const first = await type.run?.(ctx(null));
    expect(first?.notify).toBeUndefined();
    expect(first?.summary).toContain("1 held for a shop check");
    const { executor } = fakeExecutor([success({ verdict: "ok", reasons: ["established store"], sources: ["https://www.trustpilot.com/review/good.com"] })]);
    await stepShopCheck({ checks: s.checks, store: s.store, executor, ids: new IntakeJobIds(), clock, locks: new TaskLocks(), budget: s.budget, log });
    const second = await type.run?.(ctx(first?.state));
    expect(second?.notify?.text).toContain("<https://good.com/p?variant=1>");
  });
});

describe("forget-me and rollback", () => {
  it("erases a person's requests and waiters, and keeps the shops' verdicts", async () => {
    const { db, store, owner, checks } = await setup();
    await checks.request("bad.us", { taskId: "t1", ownerId: owner.id });
    checks.record({ domain: "old.com", verdict: "ok", reasons: [], sources: [], checkedAt: NOW.toISOString() });
    await checks.request("bad.us", { taskId: "t1", ownerId: owner.id });
    new Roster(db).erase(owner.id);
    for (const table of SHOP_TABLES) expect((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    expect((await checks.get(["old.com"])).size).toBe(1);
    expect(await store.getUser(owner.id)).toBeNull();
  });

  it("adds its tables without a schema version, so an older tracker still opens the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "shops-upgrade-"));
    try {
      const path = join(dir, "tracker.sqlite");
      const old = new Database(path, { create: true });
      migrate(old);
      old.close();
      const db = openDatabase(path);
      try {
        expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(13);
        const names = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'shop_check%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
        expect(names).toEqual(["shop_check_requests", "shop_check_waiters", "shop_checks"]);
      } finally {
        db.close();
      }
    } finally {
      removeDir(dir);
    }
  });
});
