import { describe, expect, it } from "bun:test";
import { materialize, type Clock, type Schedule } from "@rackbops/docket-core";
import { TRACKER_TYPES as TASK_TYPES } from "./index.js";
import type { HostApi, HostMessage } from "../../../packages/api/contract.js";
import { TaskLocks } from "./locks.js";
import { HOST_CANNOT_MESSAGE, MAX_CONTENT, toHostMessage, wrapBareUrls } from "./notifier.js";
import { runNotifyTick, taskStore, tasksWithWork } from "./notify-lane.js";
import { admit } from "./people.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

const DUE = "2026-10-01T13:00:00.000Z";
const DISCORD = "111111111111111111";

function fakeClock(iso: string): Clock & { set(iso: string): void } {
  let now = new Date(iso);
  return { now: () => new Date(now), set: (s) => (now = new Date(s)) };
}

type DmBehaviour = (userId: string, message: HostMessage, n: number) => Promise<void>;

function fakeDm(behaviour: DmBehaviour = async () => {}) {
  const calls: { userId: string; message: HostMessage }[] = [];
  const dm: NonNullable<HostApi["dm"]> = async (userId, message) => {
    calls.push({ userId, message });
    await behaviour(userId, message, calls.length);
    return { guildId: null, channelId: "c1", messageId: `m${calls.length}` };
  };
  return { dm, calls };
}

function silentLog() {
  const warnings: string[] = [];
  return { warnings, log: { info() {}, warn: (m: string) => void warnings.push(m), error() {} } };
}

async function setup(schedule: Schedule = { kind: "once", at: DUE }, text = "water the plants") {
  const db = openDatabase(":memory:");
  const store = new SqliteStore(db);
  const clock = fakeClock("2026-10-01T12:00:00.000Z");
  const owner = await admit(store, DISCORD, clock.now());
  const task = await store.createTask({
    ownerId: owner.id,
    type: "reminder",
    title: text,
    config: { text },
    schedule,
    lane: "notify",
    capabilities: ["notify"],
    at: clock.now().toISOString(),
  });
  const occurrence = await materialize(store, task, owner, clock.now());
  if (!occurrence) throw new Error("nothing materialized");
  return { db, store, clock, owner, task, occurrence };
}

describe("runNotifyTick", () => {
  const deliveries = async (s: Awaited<ReturnType<typeof setup>>, occurrenceId = s.occurrence.id) =>
    (await s.store.listDeliveries({ occurrenceId })).map((d) => ({ userId: d.userId, status: d.status, attempts: d.attempts, deferrals: d.deferrals, retryAt: d.retryAt, messageId: d.messageId, error: d.error }));

  it("sends nothing before the reminder is due, then DMs the owner's Discord id once it is, recorded in docket's deliveries", async () => {
    const s = await setup();
    const { dm, calls } = fakeDm();
    const { log } = silentLog();
    const deps = { store: s.store, clock: s.clock, types: TASK_TYPES, dm, log };

    expect(await runNotifyTick(deps)).toEqual({ kind: "ran", result: { ran: 0, failed: 0, skipped: 0 } });
    expect(calls).toHaveLength(0);

    s.clock.set(DUE);
    expect(await runNotifyTick(deps)).toEqual({ kind: "ran", result: { ran: 1, failed: 0, skipped: 0 } });
    expect(calls).toEqual([
      {
        userId: DISCORD,
        message: {
          content: "water the plants",
          buttons: [
            { customId: `tracker:d.o.${s.occurrence.id}`, label: "Done", style: "success" },
            { customId: `tracker:s.o.${s.occurrence.id}`, label: "Snooze 1h", style: "secondary" },
            { customId: `tracker:r.o.${s.occurrence.id}`, label: "Reply", style: "secondary" },
          ],
        },
      },
    ]);
    const after = await s.store.getOccurrence(s.occurrence.id);
    expect(after?.status).toBe("done");
    expect(after?.record?.outcome.notify?.text).toBe("water the plants");
    // docket 0.4.0 writes who got a run into its deliveries, never into the shared event log.
    expect((await s.store.listEvents(s.occurrence.id)).filter((e) => e.type === "delivered")).toEqual([]);
    expect(await deliveries(s)).toEqual([{ userId: s.owner.id, status: "sent", attempts: 0, deferrals: 0, retryAt: null, messageId: "m1", error: null }]);

    expect(await runNotifyTick(deps)).toEqual({ kind: "ran", result: { ran: 0, failed: 0, skipped: 0 } });
    expect(calls).toHaveLength(1);
  });

  it("maps the host's 'recipient cannot be messaged' to DeliveryFailedError(unreachable): failed for good at once, the run done, the next one queued", async () => {
    const s = await setup({ kind: "calendar", every: 1, unit: "day", start: "2026-10-01", hour: 9 });
    const { dm, calls } = fakeDm(async () => {
      throw new Error(HOST_CANNOT_MESSAGE);
    });
    const { log } = silentLog();
    s.clock.set(s.occurrence.dueAt);
    const deps = { store: s.store, clock: s.clock, types: TASK_TYPES, dm, log };
    expect(await runNotifyTick(deps)).toEqual({ kind: "ran", result: { ran: 1, failed: 0, skipped: 0 } });
    expect(calls).toHaveLength(1);
    // The type did not fail, so neither does the run; the failed send is on its delivery row.
    const run = await s.store.getOccurrence(s.occurrence.id);
    expect([run?.status, run?.error]).toEqual(["done", null]);
    expect(await deliveries(s)).toEqual([{ userId: s.owner.id, status: "failed", attempts: 1, deferrals: 0, retryAt: null, messageId: null, error: HOST_CANNOT_MESSAGE }]);
    const queued = await s.store.listOccurrences({ taskId: s.task.id, status: "queued" });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.dueAt > s.occurrence.dueAt).toBe(true);
    // Never retried: not a minute later, not an hour later.
    for (const at of ["2026-10-01T13:01:30.000Z", "2026-10-01T14:00:00.000Z"]) {
      s.clock.set(at);
      await runNotifyTick(deps);
    }
    expect(calls).toHaveLength(1);
  });

  it("an unknown Discord user (10013) is unreachable too: failed for good at once", async () => {
    const s = await setup();
    s.clock.set(DUE);
    const { dm, calls } = fakeDm(async () => {
      throw Object.assign(new Error("Unknown User"), { code: 10013 });
    });
    const { log } = silentLog();
    await runNotifyTick({ store: s.store, clock: s.clock, types: TASK_TYPES, dm, log });
    s.clock.set("2026-10-01T13:05:00.000Z");
    await runNotifyTick({ store: s.store, clock: s.clock, types: TASK_TYPES, dm, log });
    expect(calls).toHaveLength(1);
    expect((await deliveries(s)).map((d) => [d.status, d.retryAt])).toEqual([["failed", null]]);
  });

  for (const [what, error] of [
    ["an invalid id", new Error("userId is not a valid id")],
    ["an empty message", new Error("content is empty")],
    ["a message too long after link wrapping", new Error("content is longer than 2000 after link wrapping")],
  ] as const) {
    it(`the host refusing before sending (${what}) is a plain DeliveryFailedError: retried after 1 and 2 minutes, three sends in all`, async () => {
      const s = await setup();
      s.clock.set(DUE);
      const { dm, calls } = fakeDm(async () => {
        throw error;
      });
      const { log } = silentLog();
      const deps = { store: s.store, clock: s.clock, types: TASK_TYPES, dm, log };
      await runNotifyTick(deps);
      expect(await deliveries(s)).toEqual([{ userId: s.owner.id, status: "failed", attempts: 1, deferrals: 0, retryAt: "2026-10-01T13:01:00.000Z", messageId: null, error: error.message }]);
      s.clock.set("2026-10-01T13:00:59.000Z");
      await runNotifyTick(deps);
      expect(calls).toHaveLength(1);
      s.clock.set("2026-10-01T13:01:00.000Z");
      await runNotifyTick(deps);
      s.clock.set("2026-10-01T13:03:00.000Z");
      await runNotifyTick(deps);
      s.clock.set("2026-10-01T14:00:00.000Z");
      await runNotifyTick(deps);
      expect(calls).toHaveLength(3);
      expect((await deliveries(s)).map((d) => [d.status, d.attempts, d.retryAt])).toEqual([["failed", 3, null]]);
    });
  }

  it("an error that does not say whether Discord took the DM is unconfirmed: logged, never resent", async () => {
    const s = await setup({ kind: "calendar", every: 1, unit: "day", start: "2026-10-01", hour: 9 });
    const { dm, calls } = fakeDm(async () => {
      throw new Error("socket hang up");
    });
    const { log, warnings } = silentLog();
    s.clock.set(s.occurrence.dueAt);
    await runNotifyTick({ store: s.store, clock: s.clock, types: TASK_TYPES, dm, log });
    s.clock.set("2026-10-01T14:00:00.000Z");
    await runNotifyTick({ store: s.store, clock: s.clock, types: TASK_TYPES, dm, log });
    expect(calls).toHaveLength(1);
    expect((await s.store.getOccurrence(s.occurrence.id))?.status).toBe("done");
    expect((await deliveries(s)).map((d) => [d.status, d.error, d.retryAt])).toEqual([["unconfirmed", "socket hang up", null]]);
    expect(warnings.filter((w) => w.includes(`delivery of ${s.occurrence.id} to ${s.owner.id} is unconfirmed`))).toHaveLength(1);
  });

  it("a claim left open past ten minutes (a tick that died mid-send) is settled unconfirmed, never resent", async () => {
    const s = await setup();
    s.clock.set(DUE);
    await s.store.updateOccurrence(s.occurrence.id, {
      status: "done",
      finishedAt: DUE,
      record: { outcome: { notify: { text: "water the plants" } }, costUsd: null, firedAt: DUE, appliedAt: DUE, resumes: 0 },
    });
    await s.store.planDelivery(s.occurrence.id, s.owner.id, DUE);
    await s.store.claimDelivery(s.occurrence.id, s.owner.id, DUE);
    const { dm, calls } = fakeDm();
    const { log } = silentLog();
    s.clock.set("2026-10-01T13:09:00.000Z");
    await runNotifyTick({ store: s.store, clock: s.clock, types: TASK_TYPES, dm, log });
    expect((await deliveries(s)).map((d) => d.status)).toEqual(["claimed"]);
    s.clock.set("2026-10-01T13:11:00.000Z");
    await runNotifyTick({ store: s.store, clock: s.clock, types: TASK_TYPES, dm, log });
    expect(calls).toHaveLength(0);
    expect((await deliveries(s)).map((d) => [d.status, d.error])).toEqual([["unconfirmed", "claimed, never settled"]]);
  });

  it("an aborted signal sends nothing and leaves the due run queued for the next tick", async () => {
    const s = await setup();
    s.clock.set(DUE);
    const { dm, calls } = fakeDm();
    const { log } = silentLog();
    const deps = { store: s.store, clock: s.clock, types: TASK_TYPES, dm, log };
    const controller = new AbortController();
    controller.abort();
    expect(await runNotifyTick(deps, controller.signal)).toEqual({ kind: "aborted" });
    expect(calls).toHaveLength(0);
    expect((await s.store.getOccurrence(s.occurrence.id))?.status).toBe("queued");

    await runNotifyTick(deps, new AbortController().signal);
    expect(calls).toHaveLength(1);
  });

  it("an abort mid-tick stops the next task's run: it stays queued and unfired, with no delivery planned", async () => {
    const s = await setup();
    const other = await s.store.createTask({ ...s.task, config: { text: "second" }, title: "second", at: DUE });
    const second = await materialize(s.store, other, s.owner, s.clock.now());
    s.clock.set(DUE);
    const controller = new AbortController();
    const { dm, calls } = fakeDm(async () => controller.abort());
    const { log } = silentLog();
    const outcome = await runNotifyTick({ store: s.store, clock: s.clock, types: TASK_TYPES, dm, log }, controller.signal);
    expect(outcome).toEqual({ kind: "aborted" });
    expect(calls).toHaveLength(1);
    expect((await s.store.getOccurrence(s.occurrence.id))?.status).toBe("done");
    const left = await s.store.getOccurrence(second?.id ?? "");
    expect([left?.status, left?.record]).toEqual(["queued", null]);
    expect(await s.store.listDeliveries({ occurrenceId: second?.id ?? "" })).toEqual([]);
  });

  it("does nothing on a host without dm", async () => {
    const s = await setup();
    s.clock.set(DUE);
    const { log } = silentLog();
    expect(await runNotifyTick({ store: s.store, clock: s.clock, types: TASK_TYPES, dm: undefined, log })).toEqual({ kind: "no-dm" });
    expect((await s.store.getOccurrence(s.occurrence.id))?.status).toBe("queued");
  });

  it("cuts a message longer than Discord allows", async () => {
    const s = await setup(undefined, "x".repeat(MAX_CONTENT + 50));
    s.clock.set(DUE);
    const { dm, calls } = fakeDm();
    const { log } = silentLog();
    await runNotifyTick({ store: s.store, clock: s.clock, types: TASK_TYPES, dm, log });
    expect(calls[0]?.message.content).toHaveLength(MAX_CONTENT);
    expect(calls[0]?.message.content.endsWith("...")).toBe(true);
  });

  it("a person without a valid Discord id cannot be messaged: failed for good at once, no host call", async () => {
    const s = await setup();
    await s.store.updateUser(s.owner.id, { discordId: "not-an-id" });
    s.clock.set(DUE);
    const { dm, calls } = fakeDm();
    const { log } = silentLog();
    await runNotifyTick({ store: s.store, clock: s.clock, types: TASK_TYPES, dm, log });
    expect(calls).toHaveLength(0);
    expect((await deliveries(s)).map((d) => [d.status, d.error, d.retryAt])).toEqual([["failed", `user ${s.owner.id} has no valid Discord id`, null]]);
  });

  it("a message with no text is refused locally, no host call", async () => {
    const s = await setup(undefined, "   ");
    s.clock.set(DUE);
    const { dm, calls } = fakeDm();
    const { log } = silentLog();
    await runNotifyTick({ store: s.store, clock: s.clock, types: TASK_TYPES, dm, log });
    expect(calls).toHaveLength(0);
    expect((await deliveries(s)).map((d) => [d.status, d.error])).toEqual([["failed", "the message has no text"]]);
  });

  it("a task's pass waits for its lock: a reply or an edit of that task holding it runs first, alone", async () => {
    const s = await setup();
    s.clock.set(DUE);
    const locks = new TaskLocks();
    const { dm, calls } = fakeDm();
    const { log } = silentLog();
    let release: () => void = () => {};
    const held = locks.run(s.task.id, () => new Promise<void>((r) => (release = r)));
    const tick = runNotifyTick({ store: s.store, locks, clock: s.clock, types: TASK_TYPES, dm, log });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveLength(0);
    expect((await s.store.getOccurrence(s.occurrence.id))?.status).toBe("queued");
    release();
    await held;
    await tick;
    expect(calls).toHaveLength(1);
    expect(locks.held(s.task.id)).toBe(false);
  });

  it("finds the tasks with work, and shows a pass only its own task's runs and deliveries", async () => {
    const s = await setup();
    const other = await s.store.createTask({ ...s.task, config: { text: "second" }, title: "second", at: DUE });
    const second = await materialize(s.store, other, s.owner, s.clock.now());
    s.clock.set(DUE);
    expect(await tasksWithWork(s.store, s.clock.now(), () => true)).toEqual([s.task.id, other.id]);
    expect(await tasksWithWork(s.store, s.clock.now(), (t) => t?.id === other.id)).toEqual([other.id]);
    await s.store.planDelivery(second?.id ?? "", s.owner.id, DUE);
    const view = taskStore(s.store, s.task.id);
    expect((await view.listOccurrences({ status: "queued" })).map((o) => o.id)).toEqual([s.occurrence.id]);
    expect(await view.listDeliveries({ dueBefore: DUE })).toEqual([]);
    expect((await taskStore(s.store, other.id).listDeliveries({ dueBefore: DUE })).map((d) => d.occurrenceId)).toEqual([second?.id ?? ""]);
  });

  it("cuts a long message so it fits after the host wraps its links, even when the cut splits one", () => {
    const text = `${"a ".repeat(990)}https://example.com/${"x".repeat(100)}`;
    const out = toHostMessage({ text });
    expect(out).not.toBeNull();
    expect(wrapBareUrls(out?.content ?? "").length).toBeLessThanOrEqual(MAX_CONTENT);
    expect(out?.content.endsWith("...")).toBe(true);
  });
});
