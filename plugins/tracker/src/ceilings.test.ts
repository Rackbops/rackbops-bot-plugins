import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { budgetHold, charge, createTask, DEFAULT_BUDGET, type Executor, type JobResult, type Notifier, type User } from "@rackbops/docket-core";
import { research } from "@rackbops/docket-types";
import { NOT_ADMIN } from "./access.js";
import { NO_SUCH_PERSON } from "./admin.js";
import { ExecuteLane } from "./execute-lane.js";
import { TaskLocks } from "./locks.js";
import { boundsOf, budgetNoticeKey, budgetPolicy, Ceilings, type CeilingChange, decideCeiling, describeLimits, isRaised, limitsOf, setCeiling, spentToday } from "./ceilings.js";
import { MIGRATIONS, migrate, openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

/**
 * A person's ceiling raised by an admin (plan 5.7, 5.10; rackbops-bot-plugins#82): the pure rules,
 * the append-only table, the admin act and its log line, docket's `budgetHold` reading the raise,
 * and migration 7 adding the table without touching anything already there.
 */

const AT = "2026-10-01T16:00:00.000Z";
const NOW = new Date(AT);

function change(usd: number | null, calls: number | null): CeilingChange {
  return { id: "c1", userId: "u2", usd, calls, setBy: "u1", at: AT };
}

describe("decideCeiling (pure)", () => {
  it("takes dollars to the cent and whole calls between the default and the global ceiling", () => {
    expect(decideCeiling({ reset: false, usd: "4", calls: "40" })).toEqual({ ok: true, limits: { usd: 4, calls: 40 } });
    expect(decideCeiling({ reset: false, usd: " 4.50 ", calls: " 40 " })).toEqual({ ok: true, limits: { usd: 4.5, calls: 40 } });
    // Both ends are allowed: the default itself (a reset, not a raise), and the global ceiling itself.
    expect(decideCeiling({ reset: false, usd: "2", calls: "20" })).toEqual({ ok: true, limits: null });
    expect(decideCeiling({ reset: false, usd: "2.00", calls: "20" })).toEqual({ ok: true, limits: null });
    // Only one number at the default is still a raise of the other.
    expect(decideCeiling({ reset: false, usd: "2", calls: "21" })).toEqual({ ok: true, limits: { usd: 2, calls: 21 } });
    expect(decideCeiling({ reset: false, usd: "2.01", calls: "20" })).toEqual({ ok: true, limits: { usd: 2.01, calls: 20 } });
    expect(decideCeiling({ reset: false, usd: "10", calls: "100" })).toEqual({ ok: true, limits: { usd: 10, calls: 100 } });
  });

  it("refuses below the default, above the global ceiling, and anything that is not a plain number", () => {
    const no = (usd: string, calls: string) => decideCeiling({ reset: false, usd, calls });
    expect(no("1.99", "40")).toEqual({ ok: false, error: "The dollars cannot go below the default, 2.00 USD." });
    expect(no("4", "19")).toEqual({ ok: false, error: "The model calls cannot go below the default, 20." });
    expect(no("10.01", "40")).toEqual({ ok: false, error: "The dollars cannot go above the global ceiling, 10.00 USD a day." });
    expect(no("4", "101")).toEqual({ ok: false, error: "The model calls cannot go above the global ceiling, 100 a day." });
    for (const bad of ["", "-1", "4.123", "1e1", "Infinity", "NaN", "4,5", "0x10"]) expect(no(bad, "40").ok).toBe(false);
    for (const bad of ["", "40.5", "-40", "4e1", "999999"]) expect(no("4", bad).ok).toBe(false);
  });

  it("a reset needs no numbers", () => {
    expect(decideCeiling({ reset: true })).toEqual({ ok: true, limits: null });
  });

  it("follows the policy it is given, and a null bound does not limit", () => {
    const bounds = boundsOf({ person: { usd: 1, calls: null }, global: { usd: null, calls: 50 } });
    expect(decideCeiling({ reset: false, usd: "500", calls: "0" }, bounds)).toEqual({ ok: true, limits: { usd: 500, calls: 0 } });
    expect(decideCeiling({ reset: false, usd: "0.5", calls: "0" }, bounds).ok).toBe(false);
    expect(decideCeiling({ reset: false, usd: "5", calls: "51" }, bounds).ok).toBe(false);
  });
});

describe("limitsOf, isRaised, describeLimits (pure)", () => {
  it("a person's ceiling is their newest change, or the default when there is none or it was a reset", () => {
    expect(limitsOf(null)).toEqual(DEFAULT_BUDGET.person);
    expect(limitsOf(change(null, null))).toEqual(DEFAULT_BUDGET.person);
    expect(limitsOf(change(4, 40))).toEqual({ usd: 4, calls: 40 });
    expect(isRaised(null)).toBe(false);
    expect(isRaised(change(null, null))).toBe(false);
    expect(isRaised(change(4, 40))).toBe(true);
    expect(describeLimits({ usd: 4, calls: 40 })).toBe("4.00 USD and 40 model calls a day");
    expect(describeLimits({ usd: null, calls: null })).toBe("no dollar ceiling and no call ceiling a day");
  });
});

function fixture() {
  const db = openDatabase(":memory:");
  const store = new SqliteStore(db);
  const ceilings = new Ceilings(db);
  const logs: string[] = [];
  const d = { store, ceilings, clock: { now: () => NOW }, log: { info: (m: string) => void logs.push(m), warn() {}, error() {} } };
  return { db, store, ceilings, d, logs };
}

async function person(store: SqliteStore, admin: boolean, name: string): Promise<User> {
  return store.createUser({ discordId: null, displayName: name, timeZone: "America/New_York", preferredHour: 9, admin, at: AT });
}

describe("Ceilings and setCeiling", () => {
  it("records each change append-only, newest first; the newest is the ceiling, and a reset goes back to the default", () => {
    const { ceilings } = fixture();
    expect(ceilings.latest("u2")).toBeNull();
    ceilings.record("u2", { usd: 4, calls: 40 }, "u1", AT);
    ceilings.record("u3", { usd: 3, calls: 30 }, "u1", AT);
    ceilings.record("u2", { usd: 6, calls: 60 }, "u1", "2026-10-02T16:00:00.000Z");
    expect(ceilings.personFor({ id: "u2" } as User)).toEqual({ usd: 6, calls: 60 });
    ceilings.record("u2", null, "u1", "2026-10-03T16:00:00.000Z");
    expect(ceilings.personFor({ id: "u2" } as User)).toBeNull();
    expect(ceilings.history("u2").map((c) => [c.id, c.usd, c.calls])).toEqual([
      ["c4", null, null],
      ["c3", 6, 60],
      ["c1", 4, 40],
    ]);
    expect(ceilings.personFor({ id: "u3" } as User)).toEqual({ usd: 3, calls: 30 });
  });

  it("the table refuses one value without the other", () => {
    const { db } = fixture();
    expect(() => db.query("INSERT INTO ceiling_changes (user_id, usd, calls, set_by, at) VALUES ('u2', 4, NULL, 'u1', ?)").run(AT)).toThrow();
  });

  it("only an admin, only a person on the list; each change is a row and a log line", async () => {
    const { store, ceilings, d, logs } = fixture();
    const admin = await person(store, true, "Admin");
    const larry = await person(store, false, "Larry");
    expect(await setCeiling(d, larry, larry.id, { reset: false, usd: "4", calls: "40" })).toEqual({ ok: false, error: NOT_ADMIN });
    expect(await setCeiling(d, admin, "u99", { reset: false, usd: "4", calls: "40" })).toEqual({ ok: false, error: NO_SUCH_PERSON });
    expect(await setCeiling(d, admin, "t1", { reset: false, usd: "4", calls: "40" })).toEqual({ ok: false, error: NO_SUCH_PERSON });
    expect(await setCeiling(d, admin, larry.id, { reset: false, usd: "40", calls: "40" })).toEqual({
      ok: false,
      error: "The dollars cannot go above the global ceiling, 10.00 USD a day.",
    });
    expect(ceilings.history(larry.id)).toEqual([]);
    expect(logs).toEqual([]);

    expect(await setCeiling(d, admin, larry.id, { reset: false, usd: "4", calls: "40" })).toEqual({
      ok: true,
      text: "Larry's ceiling is now 4.00 USD and 40 model calls a day, until an admin changes it.",
    });
    expect(ceilings.latest(larry.id)).toEqual({ id: "c1", userId: larry.id, usd: 4, calls: 40, setBy: admin.id, at: AT });
    expect(logs).toEqual([`${admin.id} set ${larry.id}'s daily ceiling to 4 USD / 40 calls (c1)`]);

    expect(await setCeiling(d, admin, larry.id, { reset: true })).toEqual({ ok: true, text: "Larry is back on the default ceiling: 2.00 USD and 20 model calls a day." });
    expect(logs.at(-1)).toBe(`${admin.id} set ${larry.id}'s daily ceiling to the default (c2)`);
    // A reset of someone already on the default writes nothing.
    expect(await setCeiling(d, admin, larry.id, { reset: true })).toEqual({ ok: true, text: "Larry is already on the default ceiling." });
    expect(ceilings.history(larry.id)).toHaveLength(2);
  });

  it("setting exactly the default is a reset: no raise is recorded, and a raised person goes back", async () => {
    const { store, ceilings, d, logs } = fixture();
    const admin = await person(store, true, "Admin");
    const larry = await person(store, false, "Larry");
    expect(await setCeiling(d, admin, larry.id, { reset: false, usd: "2", calls: "20" })).toEqual({ ok: true, text: "Larry is already on the default ceiling." });
    expect(ceilings.history(larry.id)).toEqual([]);
    await setCeiling(d, admin, larry.id, { reset: false, usd: "4", calls: "40" });
    expect(await setCeiling(d, admin, larry.id, { reset: false, usd: "2.00", calls: "20" })).toEqual({
      ok: true,
      text: "Larry is back on the default ceiling: 2.00 USD and 20 model calls a day.",
    });
    expect(ceilings.latest(larry.id)).toMatchObject({ usd: null, calls: null });
    expect(isRaised(ceilings.latest(larry.id))).toBe(false);
    expect(logs.at(-1)).toBe(`${admin.id} set ${larry.id}'s daily ceiling to the default (c2)`);
  });

  it("each change deletes that person's budget notice key for the change's budget day, and no other", async () => {
    const { db, store, ceilings } = fixture();
    // 2026-10-02T02:00Z is still 2026-10-01 in BUDGET_ZONE (America/New_York).
    const late = "2026-10-02T02:00:00.000Z";
    expect(budgetNoticeKey("u2", new Date(late))).toBe("budget:person:u2:2026-10-01");
    for (const key of ["budget:person:u2:2026-10-01", "budget:person:u2:2026-09-30", "budget:person:u3:2026-10-01", "budget:global:2026-10-01"]) {
      expect(await store.claimNotice(key, AT)).toBe(true);
    }
    ceilings.record("u2", { usd: 4, calls: 40 }, "u1", late);
    const keys = () => (db.query("SELECT key FROM notices ORDER BY key").all() as { key: string }[]).map((r) => r.key);
    expect(keys()).toEqual(["budget:global:2026-10-01", "budget:person:u2:2026-09-30", "budget:person:u3:2026-10-01"]);
    // A reset re-arms it too.
    expect(await store.claimNotice("budget:person:u2:2026-10-01", late)).toBe(true);
    ceilings.record("u2", null, "u1", late);
    expect(keys()).not.toContain("budget:person:u2:2026-10-01");
  });
});

describe("docket's budgetHold with the tracker's policy", () => {
  it("a raise lets a person past the default, stands the next day, and never past the global ceiling", async () => {
    const { store, ceilings } = fixture();
    const admin = await person(store, true, "Admin");
    const larry = await person(store, false, "Larry");
    const policy = budgetPolicy(ceilings);
    for (let i = 0; i < 20; i++) await charge(store, { userId: larry.id, taskId: "t1", source: "run", calls: 1, costUsd: 0.01, at: NOW });
    expect((await budgetHold(store, policy, larry, NOW))?.scope).toBe("person");
    ceilings.record(larry.id, { usd: 4, calls: 40 }, admin.id, AT);
    expect(await budgetHold(store, policy, larry, NOW)).toBeNull();
    const today = await spentToday(store, larry.id, NOW);
    expect(today.calls).toBe(20);
    expect(today.usd).toBeCloseTo(0.2, 10);

    // The next day: the raise stands.
    const tomorrow = new Date("2026-10-02T16:00:00.000Z");
    for (let i = 0; i < 39; i++) await charge(store, { userId: larry.id, taskId: "t1", source: "run", calls: 1, costUsd: 0.01, at: tomorrow });
    expect(await budgetHold(store, policy, larry, tomorrow)).toBeNull();
    await charge(store, { userId: larry.id, taskId: "t1", source: "run", calls: 1, costUsd: 0.01, at: tomorrow });
    expect(await budgetHold(store, policy, larry, tomorrow)).toMatchObject({ scope: "person", limit: "calls", limits: { usd: 4, calls: 40 } });

    // The global ceiling is checked first, whatever the raise.
    ceilings.record(larry.id, { usd: 10, calls: 100 }, admin.id, AT);
    const day3 = new Date("2026-10-03T16:00:00.000Z");
    await charge(store, { userId: admin.id, taskId: "t2", source: "run", calls: 100, costUsd: 1, at: day3 });
    expect((await budgetHold(store, policy, larry, day3))?.scope).toBe("global");
  });
});

describe("plan 5.7: a raise re-arms the ceiling notices (review of #113)", () => {
  it("met the default, raised the same day, met the raised ceiling: the person and the admin are told again", async () => {
    const { store, ceilings, d } = fixture();
    const admin = await person(store, true, "Admin");
    const larry = await person(store, false, "Larry");
    await createTask(store, { userId: larry.id, admin: false }, larry, { type: research, title: "Q", config: { question: "Q" }, schedule: { kind: "once", at: AT } }, NOW);
    const dms: { to: string; text: string }[] = [];
    const notifier: Notifier = {
      sendDm: async (to, message) => {
        dms.push({ to, text: message.text ?? "" });
        return { messageId: `m${dms.length}` };
      },
    };
    let runs = 0;
    const executor: Executor = {
      async run(): Promise<JobResult> {
        runs++;
        return { kind: "error", detail: "not reached in this test", durationMs: 1 };
      },
    };
    const lane = new ExecuteLane({ store, clock: d.clock, types: { research } as never, notifier, executor, locks: new TaskLocks(), budget: budgetPolicy(ceilings) });
    const spend = async (n: number) => {
      for (let i = 0; i < n; i++) await charge(store, { userId: larry.id, taskId: "t9", source: "run", calls: 1, costUsd: 0.01, at: NOW });
    };
    const told = () => dms.map((m) => [m.to, m.text.split("\n")[0]]);

    // At the default: held, and both notices go once.
    await spend(20);
    await lane.tick();
    await lane.tick();
    expect(runs).toBe(0);
    expect(told()).toEqual([
      [admin.id, "Larry has reached today's limit of 20 model calls (20 calls, about 0.20 USD)."],
      [larry.id, "You have reached today's limit of 20 model calls for tasks that use the model."],
    ]);

    // The admin raises it the same day; Larry meets the raised ceiling before the next tick.
    expect((await setCeiling(d, admin, larry.id, { reset: false, usd: "4", calls: "40" })).ok).toBe(true);
    await spend(20);
    await lane.tick();
    await lane.tick();
    expect(runs).toBe(0);
    expect(told().slice(2)).toEqual([
      [admin.id, "Larry has reached today's limit of 40 model calls (40 calls, about 0.40 USD)."],
      [larry.id, "You have reached today's limit of 40 model calls for tasks that use the model."],
    ]);

    // Back to the default while over it: held again, and told again, once.
    expect((await setCeiling(d, admin, larry.id, { reset: true })).ok).toBe(true);
    await lane.tick();
    await lane.tick();
    expect(dms).toHaveLength(6);
    expect(told().slice(4).map(([to]) => to)).toEqual([admin.id, larry.id]);
  });
});

describe("migration 7", () => {
  it("is purely additive: a database at 6 keeps every table, row and index as it was, and gains ceiling_changes", () => {
    const db = new Database(":memory:");
    for (let v = 0; v < 6; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v] as string);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
    db.exec(`INSERT INTO users (discord_id, display_name, time_zone, preferred_hour, admin, created_at) VALUES ('1', 'Larry', 'UTC', 9, 1, '${AT}')`);
    db.exec(`INSERT INTO usage (user_id, task_id, occurrence_id, source, calls, cost_usd, at, key) VALUES ('u1', 't1', 'o1', 'agent', 1, 0.3, '${AT}', 'k1')`);
    const schema = () => db.query("SELECT type, name, sql FROM sqlite_master WHERE name != 'sqlite_sequence' ORDER BY name").all() as { name: string }[];
    const rows = () => ({ users: db.query("SELECT * FROM users").all(), usage: db.query("SELECT * FROM usage").all() });
    const before = { schema: schema(), rows: rows() };

    expect(migrate(db)).toBe(6);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(7);
    const after = schema();
    expect(after.filter((s) => !s.name.startsWith("ceiling_changes"))).toEqual(before.schema);
    expect(after.filter((s) => s.name.startsWith("ceiling_changes")).map((s) => s.name)).toEqual(["ceiling_changes", "ceiling_changes_user"]);
    expect(rows()).toEqual(before.rows);
  });
});
