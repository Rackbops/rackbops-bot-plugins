import { describe, expect, it } from "bun:test";
import { ExecutorUnavailableError, materialize, type Clock } from "@rackbops/docket-core";
import type { HostApi, HostMessage } from "../../../packages/api/contract.js";
import { decidePause, DeliveryHealth, PAUSE_AFTER } from "./delivery-health.js";
import { TRACKER_TYPES } from "./index.js";
import { createDmNotifier, HOST_CANNOT_MESSAGE, isButtonRefusal } from "./notifier.js";
import { runNotifyTick } from "./notify-lane.js";
import { admit } from "./people.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

const OWNER = "111111111111111111";
const FRIEND = "222222222222222222";

function fakeClock(iso: string): Clock & { set(iso: string): void } {
  let now = new Date(iso);
  return { now: () => new Date(now), set: (s) => (now = new Date(s)) };
}

async function setup() {
  const db = openDatabase(":memory:");
  const store = new SqliteStore(db);
  const health = new DeliveryHealth(db, store);
  const clock = fakeClock("2026-10-01T12:00:00.000Z");
  const owner = await admit(store, OWNER, clock.now());
  const friend = await admit(store, FRIEND, clock.now());
  const task = await store.createTask({
    ownerId: owner.id,
    type: "reminder",
    title: "stretch",
    config: { text: "stretch" },
    schedule: { kind: "calendar", every: 1, unit: "day", start: "2026-10-01", hour: 9 },
    lane: "notify",
    capabilities: ["notify"],
    at: clock.now().toISOString(),
  });
  await materialize(store, task, owner, clock.now());
  return { db, store, health, clock, owner, friend, task };
}

describe("decidePause", () => {
  it(`pauses on the ${PAUSE_AFTER}th failure in a row, once`, () => {
    expect(decidePause(PAUSE_AFTER - 1, false)).toBe(false);
    expect(decidePause(PAUSE_AFTER, false)).toBe(true);
    expect(decidePause(PAUSE_AFTER + 1, true)).toBe(false);
  });
});

describe("DeliveryHealth", () => {
  it("a DM that goes through clears the count, so only failures in a row pause", async () => {
    const s = await setup();
    await s.health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z");
    await s.health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:01:00.000Z");
    s.health.recordSuccess(s.owner.id);
    expect(s.health.get(s.owner.id)?.failures).toBe(0);
    const third = await s.health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:02:00.000Z");
    expect(third).toEqual({ failures: 1, paused: false });
    expect((await s.store.getTask(s.task.id))?.status).toBe("active");
  });

  it("pauses the person's active tasks on record, and resume sets back only what it paused", async () => {
    const s = await setup();
    const other = await s.store.createTask({ ...s.task, ownerId: s.owner.id, config: {}, state: null, at: "2026-10-01T12:00:00.000Z" });
    await s.store.updateTask(other.id, { status: "paused", at: "2026-10-01T12:00:00.000Z" }); // paused by something else
    for (let i = 0; i < PAUSE_AFTER; i++) await s.health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z");
    expect(s.health.isPaused(s.owner.id)).toBe(true);
    expect(s.health.pausesFor(s.task.id)).toEqual([s.owner.id]);
    expect(s.health.pausesFor(other.id)).toEqual([]);
    expect((await s.store.getTask(s.task.id))?.status).toBe("paused");
    expect((await s.store.listTaskEvents(s.task.id)).map((e) => e.kind)).toEqual(["paused"]);

    expect(await s.health.resume(s.friend.id, s.clock.now())).toBeNull();
    const resumed = await s.health.resume(s.owner.id, s.clock.now());
    expect(resumed?.tasks).toEqual([s.task.id]);
    expect((await s.store.getTask(s.task.id))?.status).toBe("active");
    expect((await s.store.getTask(other.id))?.status).toBe("paused");
    expect(s.health.get(s.owner.id)).toMatchObject({ failures: 0, pausedAt: null });
    expect(s.health.pausesFor(s.task.id)).toEqual([]);
  });

  it("a resume that lands while a pause is still writing waits for it: the rows and the task agree", async () => {
    for (const order of ["failure-first", "resume-first"] as const) {
      const s = await setup();
      for (let i = 0; i < PAUSE_AFTER - 1; i++) await s.health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z");
      const both =
        order === "failure-first"
          ? [s.health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z"), s.health.resume(s.owner.id, s.clock.now())]
          : [s.health.resume(s.owner.id, s.clock.now()), s.health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z")];
      await Promise.all(both);
      const status = (await s.store.getTask(s.task.id))?.status;
      const paused = s.health.isPaused(s.owner.id);
      expect(paused).toBe(order === "resume-first");
      expect(status).toBe(paused ? "paused" : "active");
      expect(s.health.pausesFor(s.task.id)).toEqual(paused ? [s.owner.id] : []);
    }
  });
});

describe("a paused task (docket 0.4.0 holds it: no run starts, its owed sends wait)", () => {
  const log = { info() {}, warn() {}, error() {} };
  const ok = (sent: string[]): NonNullable<HostApi["dm"]> => async (userId) => {
    sent.push(userId);
    return { guildId: null, channelId: "c", messageId: `m${sent.length}` };
  };

  it("does not run a due occurrence of a paused task", async () => {
    const s = await setup();
    await s.store.updateTask(s.task.id, { status: "paused", at: "2026-10-01T12:00:00.000Z" });
    const sent: string[] = [];
    s.clock.set("2026-10-01T13:00:00.000Z");
    await runNotifyTick({ store: s.store, clock: s.clock, types: TRACKER_TYPES, dm: ok(sent), log, health: s.health });
    expect(sent).toEqual([]);
    expect((await s.store.listOccurrences({ taskId: s.task.id })).map((o) => o.status)).toEqual(["queued"]);
  });

  it("holds a send owed when it paused, with a fresh round of three, and sends it on resume", async () => {
    const s = await setup();
    let refuse = true;
    const sent: string[] = [];
    const dm: NonNullable<HostApi["dm"]> = async (userId, message) => {
      if (refuse) throw new Error("content is empty"); // a plain failure: retried, never counted
      return ok(sent)(userId, message);
    };
    const deps = { store: s.store, clock: s.clock, types: TRACKER_TYPES, dm, log, health: s.health };
    s.clock.set("2026-10-01T13:00:00.000Z");
    await runNotifyTick(deps);
    s.clock.set("2026-10-01T13:01:00.000Z");
    await runNotifyTick(deps);
    const [run] = await s.store.listOccurrences({ taskId: s.task.id, status: "done" });
    const row = async () => (await s.store.listDeliveries({ occurrenceId: run?.id ?? "" }))[0];
    expect([(await row())?.status, (await row())?.attempts]).toEqual(["failed", 2]);
    expect(s.health.get(s.owner.id)?.failures ?? 0).toBe(0);

    await s.store.updateTask(s.task.id, { status: "paused", at: "2026-10-01T13:02:00.000Z" });
    refuse = false;
    s.clock.set("2026-10-01T13:10:00.000Z");
    await runNotifyTick(deps);
    expect(sent).toEqual([]);
    expect([(await row())?.status, (await row())?.attempts, (await row())?.retryAt !== null]).toEqual(["failed", 0, true]);

    await s.store.updateTask(s.task.id, { status: "active", at: "2026-10-01T13:11:00.000Z" });
    await runNotifyTick(deps);
    expect(sent).toEqual([OWNER]);
    expect((await row())?.status).toBe("sent");
  });
});

describe("the notifier's error for docket", () => {
  it("a paused person's send is ExecutorUnavailableError: deferred, nothing sent, nothing counted", async () => {
    const s = await setup();
    for (let i = 0; i < PAUSE_AFTER; i++) await s.health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z");
    const calls: string[] = [];
    const notifier = createDmNotifier({
      store: s.store,
      dm: async (userId) => {
        calls.push(userId);
        return { guildId: null, channelId: "c", messageId: "m" };
      },
      clock: s.clock,
      log: { info() {}, warn() {}, error() {} },
      health: s.health,
    });
    await expect(notifier.sendDm(s.owner.id, { text: "hi" })).rejects.toBeInstanceOf(ExecutorUnavailableError);
    expect(calls).toEqual([]);
    expect(s.health.get(s.owner.id)?.failures).toBe(PAUSE_AFTER);
  });
});

describe("the notifier counting toward the pause", () => {
  const failingWith = (s: Awaited<ReturnType<typeof setup>>, err: Error, health: DeliveryHealth, errors: unknown[] = []) =>
    createDmNotifier({
      store: s.store,
      dm: async () => {
        throw err;
      },
      clock: s.clock,
      log: { info() {}, warn() {}, error: (_m: string, e?: unknown) => void errors.push(e) },
      health,
    });

  it("an unknown user (10013) counts like a closed DM (50007); a refused message does not", async () => {
    const s = await setup();
    const gone = failingWith(s, Object.assign(new Error("Unknown User"), { code: 10013 }), s.health);
    await expect(gone.sendDm(s.owner.id, { text: "hi" })).rejects.toMatchObject({ unreachable: true });
    expect(s.health.get(s.owner.id)?.failures).toBe(1);
    const closed = failingWith(s, new Error(HOST_CANNOT_MESSAGE), s.health);
    await expect(closed.sendDm(s.owner.id, { text: "hi" })).rejects.toMatchObject({ unreachable: true });
    expect(s.health.get(s.owner.id)?.failures).toBe(2);
    const refused = failingWith(s, new Error("content is empty"), s.health);
    await expect(refused.sendDm(s.owner.id, { text: "hi" })).rejects.toMatchObject({ unreachable: false });
    expect(s.health.get(s.owner.id)?.failures).toBe(2);
  });

  it("a count that fails is logged, and the send's own error is still what docket gets", async () => {
    const s = await setup();
    const broken = new Error("database is locked");
    const health = Object.assign(Object.create(s.health) as DeliveryHealth, {
      recordFailure: async () => {
        throw broken;
      },
    });
    const errors: unknown[] = [];
    const notifier = failingWith(s, new Error(HOST_CANNOT_MESSAGE), health, errors);
    await expect(notifier.sendDm(s.owner.id, { text: "hi" })).rejects.toMatchObject({ message: HOST_CANNOT_MESSAGE, unreachable: true });
    expect(errors).toEqual([broken]);
  });
});

describe("a recipient's failures (plan 5.5: the task pauses and the owner is told)", () => {
  async function failingFriend() {
    const s = await setup();
    await s.store.setRecipient(s.task.id, s.friend.id, "accepted", "2026-10-01T12:00:00.000Z");
    const told: { owner: string; text: string }[] = [];
    const health = new DeliveryHealth(s.db, s.store, { tellOwner: async (owner, text) => void told.push({ owner: owner.id, text }) });
    const calls: string[] = [];
    const dm: NonNullable<HostApi["dm"]> = async (userId) => {
      calls.push(userId);
      if (userId === FRIEND) throw new Error(HOST_CANNOT_MESSAGE);
      return { guildId: null, channelId: "c", messageId: `m${calls.length}` };
    };
    const log = { info() {}, warn() {}, error() {} };
    const deps = { store: s.store, clock: s.clock, types: TRACKER_TYPES, dm, log, health };
    // docket 0.4.0 sends each person's copy on its own: the owner's goes, the friend's fails for
    // good at once (unreachable), and the run is done. One run, one count toward the pause.
    for (let day = 1; day <= PAUSE_AFTER; day++) {
      s.clock.set(`2026-10-0${day}T13:00:00.000Z`);
      expect(await runNotifyTick(deps)).toEqual({ kind: "ran", result: { ran: 1, failed: 0, skipped: 0 } });
      expect(s.health.get(s.friend.id)?.failures).toBe(day);
    }
    expect(calls.filter((c) => c === OWNER)).toHaveLength(PAUSE_AFTER);
    return { ...s, health, told, calls, deps };
  }

  it("pauses the task, tells the owner once, and resumes it when the recipient comes back", async () => {
    const s = await failingFriend();
    expect(s.health.isPaused(s.friend.id)).toBe(true);
    expect(s.health.get(s.owner.id)?.failures ?? 0).toBe(0);
    expect((await s.store.getTask(s.task.id))?.status).toBe("paused");
    expect(s.told).toHaveLength(1);
    expect(s.told[0]?.owner).toBe(s.owner.id);
    expect(s.told[0]?.text).toContain(`\`/task resume ${s.task.id}\``);
    s.clock.set("2026-10-04T13:00:00.000Z");
    expect(await runNotifyTick(s.deps)).toEqual({ kind: "ran", result: { ran: 0, failed: 0, skipped: 0 } });

    expect((await s.health.resume(s.friend.id, s.clock.now()))?.tasks).toEqual([s.task.id]);
    expect((await s.store.getTask(s.task.id))?.status).toBe("active");
    expect((await s.store.listRecipients(s.task.id)).map((r) => r.userId)).toEqual([s.friend.id]);
  });

  it("the owner can go on without them: the recipient is taken off, on record", async () => {
    const s = await failingFriend();
    const task = (await s.store.getTask(s.task.id))!;
    expect(await s.health.resumeTask(task, s.owner.id, s.clock.now())).toEqual([s.friend.id]);
    expect((await s.store.getTask(s.task.id))?.status).toBe("active");
    expect(await s.store.listRecipients(s.task.id)).toEqual([]);
    expect((await s.store.listTaskEvents(s.task.id)).map((e) => e.kind)).toEqual(["paused", "recipient_removed", "resumed"]);
    s.clock.set("2026-10-04T13:00:00.000Z");
    expect(await runNotifyTick(s.deps)).toEqual({ kind: "ran", result: { ran: 1, failed: 0, skipped: 0 } });
    expect(await s.health.resumeTask((await s.store.getTask(s.task.id))!, s.owner.id, s.clock.now())).toBeNull();
  });
});

describe("the tick that pauses a person", () => {
  it("holds their other due runs for the resume instead of failing them", async () => {
    const s = await setup();
    const second = await s.store.createTask({ ...s.task, title: "second", config: { text: "second" }, state: null, at: "2026-10-01T12:00:00.000Z" });
    await materialize(s.store, second, s.owner, s.clock.now());
    for (let i = 0; i < PAUSE_AFTER - 1; i++) await s.health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z");
    const calls: string[] = [];
    const dm: NonNullable<HostApi["dm"]> = async (userId) => {
      calls.push(userId);
      throw new Error(HOST_CANNOT_MESSAGE);
    };
    const log = { info() {}, warn() {}, error() {} };
    s.clock.set("2026-10-01T13:00:00.000Z");
    await runNotifyTick({ store: s.store, clock: s.clock, types: TRACKER_TYPES, dm, log, health: s.health });
    expect(calls).toHaveLength(1);
    const [first] = await s.store.listOccurrences({ taskId: s.task.id });
    const [held] = await s.store.listOccurrences({ taskId: second.id });
    // The run that failed is done, its copy failed for good; the other never started.
    expect(first?.status).toBe("done");
    expect((await s.store.listDeliveries({ occurrenceId: first?.id ?? "" })).map((d) => [d.status, d.retryAt])).toEqual([["failed", null]]);
    expect([held?.status, held?.record]).toEqual(["queued", null]);
    await s.health.resume(s.owner.id, s.clock.now());
    const sent: string[] = [];
    const ok: NonNullable<HostApi["dm"]> = async (userId) => {
      sent.push(userId);
      return { guildId: null, channelId: "c", messageId: "m" };
    };
    await runNotifyTick({ store: s.store, clock: s.clock, types: TRACKER_TYPES, dm: ok, log, health: s.health });
    expect(sent).toEqual([OWNER]);
    expect((await s.store.getOccurrence(held?.id ?? ""))?.status).toBe("done");
  });
});

describe("the notifier on a host that predates buttons", () => {
  it("sends again without buttons, under docket's same claim, once", async () => {
    const s = await setup();
    const calls: HostMessage[] = [];
    const warnings: string[] = [];
    const dm: NonNullable<HostApi["dm"]> = async (_userId, message) => {
      calls.push(message);
      if (message.buttons) throw new Error("interactive buttons are not supported yet");
      return { guildId: null, channelId: "c", messageId: "m1" };
    };
    s.clock.set("2026-10-01T13:00:00.000Z");
    const log = { info() {}, warn: (m: string) => void warnings.push(m), error() {} };
    const out = await runNotifyTick({ store: s.store, clock: s.clock, types: TRACKER_TYPES, dm, log, health: s.health });
    expect(out).toEqual({ kind: "ran", result: { ran: 1, failed: 0, skipped: 0 } });
    expect(calls.map((m) => m.buttons?.length ?? 0)).toEqual([3, 0]);
    expect(warnings.some((w) => w.includes("without buttons"))).toBe(true);
    const occurrence = (await s.store.listOccurrences({ taskId: s.task.id }))[0];
    expect((await s.store.listDeliveries({ occurrenceId: occurrence?.id ?? "" })).map((d) => [d.userId, d.status, d.messageId])).toEqual([[s.owner.id, "sent", "m1"]]);
  });
});

describe("isButtonRefusal", () => {
  it("matches only the host's own refusals, never an error that may have come after a send", () => {
    expect(isButtonRefusal(new Error("interactive buttons are not supported yet"))).toBe(true);
    expect(isButtonRefusal(new Error("button customId must start with \"tracker:\""))).toBe(true);
    expect(isButtonRefusal(new Error("buttons need this plugin to declare an interactions handler"))).toBe(true);
    expect(isButtonRefusal(Object.assign(new Error("Invalid Form Body: components[0] button"), { code: 50035 }))).toBe(false);
    expect(isButtonRefusal(new Error("request timed out while sending buttons"))).toBe(false);
    expect(isButtonRefusal("interactive buttons are not supported yet")).toBe(false);
  });
});

describe("owner notices", () => {
  it("go out after the lock is released, so a resume does not wait behind a slow owner DM", async () => {
    const s = await setup();
    await s.store.setRecipient(s.task.id, s.friend.id, "accepted", "2026-10-01T12:00:00.000Z");
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    const told: string[] = [];
    const health = new DeliveryHealth(s.db, s.store, {
      tellOwner: async (owner) => {
        told.push(owner.id);
        await slow;
      },
    });
    for (let i = 0; i < PAUSE_AFTER - 1; i++) await health.recordFailure(s.friend.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z");
    let failureDone = false;
    const failure = health.recordFailure(s.friend.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z").then((r) => {
      failureDone = true;
      return r;
    });
    while (told.length === 0) await new Promise((r) => setTimeout(r, 1));
    // The owner's DM is still in flight; a resume on the lock finishes anyway.
    const resumed = await Promise.race([
      health.resume(s.friend.id, s.clock.now()),
      new Promise<"timed out">((r) => setTimeout(() => r("timed out"), 500)),
    ]);
    expect(resumed).not.toBe("timed out");
    expect(failureDone).toBe(false);
    release();
    expect((await failure).paused).toBe(true);
    expect(told).toEqual([s.owner.id]);
  });
});
