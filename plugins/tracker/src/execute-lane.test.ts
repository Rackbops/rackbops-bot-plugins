import { afterEach, describe, expect, it } from "bun:test";
import { createTask, DISPATCHER, SUBMITTED_EVENT } from "@rackbops/docket-core";
import { research } from "@rackbops/docket-types";
import pkg from "../package.json" with { type: "json" };
import { onceJobOutRefusal, ONCE_JOB_OUT } from "./actions.js";
import { executeTasks, withLocks } from "./execute-lane.js";
import { CAPABILITY_FORMAT, CITY_HALL_URL_FORMAT } from "./executor.js";
import { TaskLocks } from "./locks.js";
import { admit } from "./people.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";
import { cleanup, LARRY, people, slash, world } from "./web/harness.js";

afterEach(cleanup);

const AT = "2026-10-01T12:00:00.000Z";

describe("the execute lane's tick (execute-lane.ts)", () => {
  it("withLocks takes every task's lock, in id order, and an edit of one of them waits for the whole tick", async () => {
    const locks = new TaskLocks();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let started: () => void = () => {};
    const holding = new Promise<void>((r) => (started = r));
    const tick = withLocks(locks, ["t2", "t10", "t1", "t2"], async () => {
      order.push("tick start");
      started();
      expect(locks.held("t1") && locks.held("t2") && locks.held("t10")).toBe(true);
      await gate;
      order.push("tick end");
    });
    await holding;
    const edit = locks.run("t2", async () => void order.push("edit"));
    const other = locks.run("t3", async () => void order.push("other task"));
    await other;
    release();
    await Promise.all([tick, edit]);
    expect(order).toEqual(["tick start", "other task", "tick end", "edit"]);
  });

  it("takes the tasks with an execute-lane run due or running, never a notify run or one not yet due", async () => {
    const store = new SqliteStore(openDatabase(":memory:"));
    await store.createOccurrence({ taskId: "t1", lane: "execute", dueAt: "2026-10-01T11:00:00.000Z", dedupeKey: "a", at: AT });
    await store.createOccurrence({ taskId: "t2", lane: "execute", dueAt: "2026-10-01T13:00:00.000Z", dedupeKey: "b", at: AT });
    await store.createOccurrence({ taskId: "t3", lane: "notify", dueAt: "2026-10-01T11:00:00.000Z", dedupeKey: "c", at: AT });
    const running = await store.createOccurrence({ taskId: "t4", lane: "execute", dueAt: "2026-10-01T13:00:00.000Z", dedupeKey: "d", at: AT });
    await store.updateOccurrence(running?.id ?? "", { status: "running" });
    expect(await executeTasks(store, new Date(AT))).toEqual(["t1", "t4"]);
  });

  it("never holds up the notify lane: a city-hall that never answers leaves the host's tick returning at once, and reminders go out", async () => {
    let calls = 0;
    const hanging = (async () => {
      calls++;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const started: Promise<void>[] = [];
    const w = await world({
      env: { TRACKER_CITY_HALL_URL: "https://city-hall.example.com", TRACKER_CITY_HALL_KEY: "k", TRACKER_CITY_HALL_CAPABILITY: "claude-cli:subscription" },
      cityHallFetch: hanging,
      executeStarted: (p) => void started.push(p),
    });
    await people(w.plugin);
    await slash(w.plugin, "research", LARRY, { strings: { question: "Q" } });
    await slash(w.plugin, "remind", LARRY, { strings: { text: "water the plants", when: "in 1 minute" } });
    w.clock.advance(2 * 60_000);
    const execute = w.plugin.ticks?.find((t) => t.name === "execute");
    const begun = Date.now();
    await execute?.run(new AbortController().signal);
    expect(Date.now() - begun).toBeLessThan(1000);
    expect(started).toHaveLength(1);
    // A second round while the first is still out starts nothing new.
    w.clock.advance(2 * 60_000);
    await execute?.run(new AbortController().signal);
    expect(started).toHaveLength(1);
    await w.plugin.ticks?.find((t) => t.name === "notify")?.run(new AbortController().signal);
    expect(w.sent.some((s) => String((s.message as { content: string }).content).includes("water the plants"))).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
  });
});

describe("a schedule edit while a run's Job is out (docket 0.5.0)", () => {
  it("refuses changing a once task's schedule while its run is out, and lets any other edit through", async () => {
    const store = new SqliteStore(openDatabase(":memory:"));
    const owner = await admit(store, "111111111111111111", new Date(AT));
    const { task, next } = await createTask(
      store,
      { userId: owner.id, admin: false },
      owner,
      { type: research, title: "Q", config: { question: "Q" }, schedule: { kind: "once", at: AT } },
      new Date(AT),
    );
    const d = { store };
    expect(await onceJobOutRefusal(d, task, { kind: "once", at: "2026-10-02T12:00:00.000Z" })).toBeNull();
    await store.addEvent({ occurrenceId: next?.id ?? "", agent: DISPATCHER, type: "status", text: SUBMITTED_EVENT, at: AT });
    expect(await onceJobOutRefusal(d, task, { kind: "once", at: "2026-10-02T12:00:00.000Z" })).toBe(ONCE_JOB_OUT);
    const weekly = { ...task, schedule: { kind: "calendar" as const, every: 1, unit: "week" as const, start: "2026-10-01" } };
    expect(await onceJobOutRefusal(d, weekly, { kind: "calendar", every: 2, unit: "week", start: "2026-10-01" })).toBeNull();
  });
});

describe("the manifest's formats are the parser's", () => {
  it("TRACKER_CITY_HALL_URL and TRACKER_CITY_HALL_CAPABILITY", () => {
    const format = (key: string) => pkg.botPlugin.env.find((e) => e.key === key)?.format;
    expect(format("TRACKER_CITY_HALL_URL")).toBe(CITY_HALL_URL_FORMAT);
    expect(format("TRACKER_CITY_HALL_CAPABILITY")).toBe(CAPABILITY_FORMAT);
    expect(pkg.botPlugin.env.filter((e) => e.secret).map((e) => e.key)).toEqual([
      "TRACKER_CITY_HALL_KEY",
      "TRACKER_CITY_HALL_ACCESS_CLIENT_ID",
      "TRACKER_CITY_HALL_ACCESS_CLIENT_SECRET",
    ]);
  });
});
