import { describe, expect, it } from "bun:test";
import { budgetHold, charge, createTask, DEFAULT_BUDGET, type Executor, type JobResult, type JobSpec, type Notifier, type Usage, type User } from "@rackbops/docket-core";
import { research } from "@rackbops/docket-types";
import { makeFakeHost } from "../../../packages/testkit/index.js";
import pkg from "../package.json" with { type: "json" };
import { Ceilings, budgetPolicy, NOT_ENFORCED, setCeiling } from "./ceilings.js";
import { ExecuteLane } from "./execute-lane.js";
import { createPlugin } from "./index.js";
import { TaskLocks } from "./locks.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";
import {
  BUDGET_UNLIMITED_FORMAT,
  BUDGET_UNLIMITED_KEY,
  executeBudget,
  measure,
  parseBudgetUnlimited,
  UNLIMITED_BUDGET,
  usageReport,
  usageWindow,
} from "./usage.js";

/**
 * Budgets off for the alpha (roshne, 2026-10-02; rackbops-bot-plugins#82, plan 5.7): the switch,
 * the policy the execute lane gets either way, a run past both ceilings not held while it is on
 * (and still charged), and the pure usage report the admin's page renders.
 */

const AT = "2026-10-01T16:00:00.000Z";
const NOW = new Date(AT);

function fixture() {
  const db = openDatabase(":memory:");
  const store = new SqliteStore(db);
  const ceilings = new Ceilings(db);
  return { db, store, ceilings };
}

async function person(store: SqliteStore, admin: boolean, name: string): Promise<User> {
  return store.createUser({ discordId: null, displayName: name, timeZone: "America/New_York", preferredHour: 9, admin, at: AT });
}

function usage(userId: string, at: string, calls: number, costUsd: number, i = 0): Usage {
  return { id: `x${i}`, userId, taskId: "t1", occurrenceId: null, source: "run", key: null, calls, costUsd, at };
}

describe("TRACKER_BUDGET_UNLIMITED", () => {
  it("true or 1 is on; unset, empty, false or 0 is off; anything else refuses to load, and the manifest agrees", () => {
    for (const on of ["true", "1", " TRUE ", "True"]) expect(parseBudgetUnlimited(on)).toBe(true);
    for (const off of [undefined, "", " ", "false", "0", "FALSE"]) expect(parseBudgetUnlimited(off)).toBe(false);
    for (const bad of ["yes", "on", "2", "truthy"]) expect(() => parseBudgetUnlimited(bad)).toThrow(BUDGET_UNLIMITED_KEY);
    const declared = pkg.botPlugin.env.find((e) => e.key === BUDGET_UNLIMITED_KEY);
    expect(declared?.format).toBe(BUDGET_UNLIMITED_FORMAT);
    expect(declared?.secret).toBe(false);
    expect(declared?.required).toBe(false);
    const format = new RegExp(BUDGET_UNLIMITED_FORMAT);
    for (const ok of ["true", "1", " TRUE ", "false", "0", ""]) expect(format.test(ok)).toBe(true);
    for (const bad of ["yes", "2", "truthy"]) expect(format.test(bad)).toBe(false);
    expect(() => createPlugin(makeFakeHost({ name: "tracker", env: { [BUDGET_UNLIMITED_KEY]: "yes" } }))).toThrow(BUDGET_UNLIMITED_KEY);
  });

  it("off, the execute lane's policy is 0.13.0's: docket's defaults with each person's raise; on, no ceiling of either kind", async () => {
    const { store, ceilings } = fixture();
    const admin = await person(store, true, "Admin");
    const larry = await person(store, false, "Larry");
    const off = executeBudget(ceilings, false);
    expect(off.person).toEqual(DEFAULT_BUDGET.person);
    expect(off.global).toEqual(DEFAULT_BUDGET.global);
    expect(await off.personFor?.(larry)).toBeNull();
    ceilings.record(larry.id, { usd: 4, calls: 40 }, admin.id, AT);
    expect(await off.personFor?.(larry)).toEqual({ usd: 4, calls: 40 });

    expect(executeBudget(ceilings, true)).toBe(UNLIMITED_BUDGET);
    expect(UNLIMITED_BUDGET).toEqual({ person: { usd: null, calls: null }, global: { usd: null, calls: null } });
  });

  it("docket's budgetHold: past both ceilings, off holds (global first), on holds nobody", async () => {
    const { store, ceilings } = fixture();
    const admin = await person(store, true, "Admin");
    const larry = await person(store, false, "Larry");
    await charge(store, { userId: larry.id, taskId: "t1", source: "run", calls: 30, costUsd: 3, at: NOW });
    expect((await budgetHold(store, executeBudget(ceilings, false), larry, NOW))?.scope).toBe("person");
    await charge(store, { userId: admin.id, taskId: "t2", source: "run", calls: 100, costUsd: 12, at: NOW });
    expect((await budgetHold(store, executeBudget(ceilings, false), larry, NOW))?.scope).toBe("global");
    expect(await budgetHold(store, executeBudget(ceilings, true), larry, NOW)).toBeNull();
    expect(await budgetHold(store, executeBudget(ceilings, true), admin, NOW)).toBeNull();
  });
});

describe("the execute lane with budgets off", () => {
  async function laneWorld(unlimited: boolean) {
    const { store, ceilings } = fixture();
    const admin = await person(store, true, "Admin");
    const larry = await person(store, false, "Larry");
    await createTask(store, { userId: larry.id, admin: false }, larry, { type: research, title: "Q", config: { question: "What is Q?" }, schedule: { kind: "once", at: AT } }, NOW);
    // Past Larry's default (20 calls, 2 USD) and everyone's (100 calls, 10 USD) already today.
    await charge(store, { userId: larry.id, taskId: "t9", source: "run", calls: 25, costUsd: 3, at: NOW });
    await charge(store, { userId: admin.id, taskId: "t8", source: "run", calls: 80, costUsd: 8, at: NOW });
    const dms: string[] = [];
    const notifier: Notifier = {
      sendDm: async (_to, message) => {
        dms.push(message.text ?? "");
        return { messageId: `m${dms.length}` };
      },
    };
    const specs: (JobSpec | null)[] = [];
    const executor: Executor = {
      async run(spec): Promise<JobResult> {
        specs.push(spec);
        return { kind: "error", detail: "a failed run still reached the model", totalCostUsd: 0.4, durationMs: 1 };
      },
    };
    const lane = new ExecuteLane({ store, clock: { now: () => NOW }, types: { research } as never, notifier, executor, locks: new TaskLocks(), budget: executeBudget(ceilings, unlimited) });
    return { store, larry, lane, dms, specs };
  }

  it("off: the run past both ceilings is held and the admins are told (unchanged)", async () => {
    const w = await laneWorld(false);
    await w.lane.tick();
    expect(w.specs).toEqual([]);
    expect(w.dms.some((t) => t.includes("Everyone together has reached today's limit"))).toBe(true);
    expect((await w.store.listUsage({ userId: w.larry.id })).map((u) => u.calls)).toEqual([25]);
  });

  it("on: the same run goes, with the Job's own caps as they were, and is charged to the usage table; nobody is told of a ceiling", async () => {
    const w = await laneWorld(true);
    await w.lane.tick();
    expect(w.specs).toHaveLength(1);
    expect(w.specs[0]).toMatchObject({ maxTurns: 15, maxBudgetUsd: 1 });
    expect(w.dms.filter((t) => t.includes("reached today's limit"))).toEqual([]);
    const charged = await w.store.listUsage({ userId: w.larry.id });
    expect(charged.map((u) => [u.calls, u.costUsd])).toEqual([
      [25, 3],
      [1, 0.4],
    ]);
  });
});

describe("a ceiling change while budgets are off", () => {
  it("is recorded as before and its answer says it is not enforced", async () => {
    const { store, ceilings } = fixture();
    const admin = await person(store, true, "Admin");
    const larry = await person(store, false, "Larry");
    const d = { store, ceilings, clock: { now: () => NOW }, log: { info() {}, warn() {}, error() {} } };
    const off = await setCeiling(d, admin, larry.id, { reset: false, usd: "4", calls: "40" });
    expect(off.ok && off.text).toBe("Larry's ceiling is now 4.00 USD and 40 model calls a day, until an admin changes it.");
    const on = await setCeiling({ ...d, budgetUnlimited: true }, admin, larry.id, { reset: false, usd: "5", calls: "50" });
    expect(on.ok && on.text).toBe(`Larry's ceiling is now 5.00 USD and 50 model calls a day, until an admin changes it. ${NOT_ENFORCED}`);
    expect(ceilings.history(larry.id).map((c) => c.usd)).toEqual([5, 4]);
    expect(budgetPolicy(ceilings).personFor?.(larry)).toEqual({ usd: 5, calls: 50 });
  });
});

describe("the usage report (pure)", () => {
  it("the window is 14 budget days ending today, each a day in New York, across the DST change", () => {
    const days = usageWindow(new Date("2026-11-03T16:00:00.000Z"));
    expect(days).toHaveLength(14);
    expect(days.map((d) => d.day)[0]).toBe("2026-10-21");
    expect(days.at(-1)?.day).toBe("2026-11-03");
    // 2026-11-01 is 25 hours long in New York.
    const fallBack = days.find((d) => d.day === "2026-11-01");
    expect(fallBack && Date.parse(fallBack.end) - Date.parse(fallBack.start)).toBe(25 * 3600_000);
    for (let i = 1; i < days.length; i++) expect(days[i]?.start).toBe(days[i - 1]?.end as string);
  });

  it("measure: the total, the ceiling it reached (calls first), and the calls charged once it had", () => {
    expect(measure([], { usd: 2, calls: 20 })).toEqual({ usd: 0, calls: 0, reached: null, past: 0 });
    const rows = Array.from({ length: 23 }, (_, i) => usage("u2", AT, 1, 0.05, i));
    expect(measure(rows, { usd: 2, calls: 20 })).toMatchObject({ calls: 23, reached: "calls", past: 3 });
    // Dollars: the run that crosses the line is not "after it"; the next is.
    const costly = [usage("u2", AT, 1, 1.5), usage("u2", AT, 1, 1.0), usage("u2", AT, 1, 0.2)];
    expect(measure(costly, { usd: 2, calls: 20 })).toMatchObject({ calls: 3, reached: "usd", past: 1 });
    expect(measure(costly, { usd: null, calls: null })).toMatchObject({ reached: null, past: 0 });
  });

  it("groups by budget day and person, newest day first, everyone against the global default, people against theirs", () => {
    const now = new Date("2026-10-02T16:00:00.000Z");
    const rows: Usage[] = [
      // 2026-10-01 in New York (03:59Z on the 2nd is still the 1st there).
      ...Array.from({ length: 21 }, (_, i) => usage("u2", "2026-10-02T03:59:00.000Z", 1, 0.01, i)),
      usage("u3", "2026-10-01T15:00:00.000Z", 1, 0.5, 30),
      // Today.
      usage("u3", "2026-10-02T15:00:00.000Z", 1, 2.25, 31),
      // Outside the window: ignored.
      usage("u2", "2026-09-01T15:00:00.000Z", 50, 9, 32),
    ];
    const r = usageReport(rows, now);
    expect(r.days).toHaveLength(14);
    expect(r.days.map((d) => d.day).slice(0, 3)).toEqual(["2026-10-02", "2026-10-01", "2026-09-30"]);
    const [today, yesterday, empty] = r.days;
    expect(today?.everyone).toMatchObject({ calls: 1, reached: null });
    expect(today?.everyone.usd).toBeCloseTo(2.25, 10);
    expect(today?.people).toEqual([{ userId: "u3", usd: 2.25, calls: 1, reached: "usd", past: 0 }]);
    expect(yesterday?.everyone).toMatchObject({ calls: 22, reached: null, past: 0 });
    expect(yesterday?.everyone.usd).toBeCloseTo(0.71, 10);
    expect(yesterday?.people.map((p) => [p.userId, p.calls, p.reached, p.past])).toEqual([
      ["u3", 1, null, 0],
      ["u2", 21, "calls", 1],
    ]);
    expect(empty).toEqual({ day: "2026-09-30", everyone: { usd: 0, calls: 0, reached: null, past: 0 }, people: [] });
    expect(r.person).toEqual(DEFAULT_BUDGET.person);
    expect(r.global).toEqual(DEFAULT_BUDGET.global);
  });
});
