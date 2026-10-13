import { describe, expect, it } from "bun:test";
import { defineTaskType, ExecutorUnavailableError, materialize, type Clock, type TaskType } from "@rackbops/docket-core";
import type { HostApi, HostMessage } from "../../../packages/api/contract.js";
import type { TrackerDeps } from "./actions.js";
import { decidePause, DeliveryHealth, isRecipientPause, PAUSE_AFTER, PAUSE_DETAIL, pauseNames, recipientPauseDetail } from "./delivery-health.js";
import { TRACKER_TYPES } from "./index.js";
import { TaskLocks } from "./locks.js";
import { deleteTask, type Done, pauseTask, resumeTask } from "./manage.js";
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

describe("isRecipientPause and pauseNames (#167: a recipient's pause is theirs, the owner's and admins' to see)", () => {
  const legacy = `delivery to Bob paused: ${PAUSE_AFTER} DMs in a row could not be delivered`;

  it("a pause for a recipient is one, by id or, from before 0.6.0, by name; the owner's own pause and a resume are not", () => {
    expect(isRecipientPause({ kind: "paused", detail: recipientPauseDetail("u3") })).toBe(true);
    expect(isRecipientPause({ kind: "paused", detail: legacy })).toBe(true);
    expect(isRecipientPause({ kind: "paused", detail: PAUSE_DETAIL })).toBe(false);
    expect(isRecipientPause({ kind: "paused", detail: "paused by the owner" })).toBe(false);
    // Every detail a resume is written with (DeliveryHealth.release's callers, manage.ts), and a resume whatever its detail.
    for (const detail of ["delivery resumed", "resumed by the owner", "resumed: a recipient left the tracker", recipientPauseDetail("u3")]) {
      expect(isRecipientPause({ kind: "resumed", detail })).toBe(false);
    }
  });

  it("names the recipient it is for, by id only: never another id, and a row from before 0.6.0 names nobody", () => {
    expect(pauseNames(recipientPauseDetail("u3"), "u3")).toBe(true);
    expect(pauseNames(recipientPauseDetail("u3"), "u5")).toBe(false);
    expect(pauseNames(recipientPauseDetail("u3"), "u31")).toBe(false);
    expect(pauseNames(recipientPauseDetail("u31"), "u3")).toBe(false);
    expect(pauseNames(legacy, "u3")).toBe(false);
    // A pre-0.6.0 row whose stored display name holds a braced id names nobody, that id included.
    expect(pauseNames(`delivery to Zed {u4} paused: ${PAUSE_AFTER} DMs in a row could not be delivered`, "u4")).toBe(false);
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

  it("a DM that goes through after the pause leaves the pause and its count alone: only a resume ends it", async () => {
    const s = await setup();
    for (let i = 0; i < PAUSE_AFTER; i++) await s.health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z");
    // A DM already out when the pause landed (an invitation, say) goes through after it.
    s.health.recordSuccess(s.owner.id);
    expect(s.health.get(s.owner.id)).toMatchObject({ failures: PAUSE_AFTER, pausedAt: "2026-10-01T12:00:00.000Z" });
    expect(s.health.isPaused(s.owner.id)).toBe(true);
    expect((await s.store.getTask(s.task.id))?.status).toBe("paused");
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

describe("a resume racing an owner's delete (#168)", () => {
  /** The friend's failures paused the task for them; the owner's delete goes through `deps`. */
  async function pausedForFriend() {
    const s = await setup();
    await s.store.setRecipient(s.task.id, s.friend.id, "accepted", "2026-10-01T12:00:00.000Z");
    for (let i = 0; i < PAUSE_AFTER; i++) await s.health.recordFailure(s.friend.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z");
    expect((await s.store.getTask(s.task.id))?.status).toBe("paused");
    expect(s.health.pausesFor(s.task.id)).toEqual([s.friend.id]);
    const deps = (health: DeliveryHealth) => ({ store: s.store, health, clock: s.clock, locks: new TaskLocks() }) as unknown as TrackerDeps;
    /** What the delete must leave: archived, no `resumed` event, no run to come. */
    const deleted = async () => [
      (await s.store.getTask(s.task.id))?.status,
      (await s.store.listTaskEvents(s.task.id)).map((e) => e.kind),
      (await s.store.listOccurrences({ taskId: s.task.id, status: "queued" })).length,
    ];
    return { ...s, deps, deleted };
  }

  it("a delete landing between the resume's read of the task and its write stays deleted, with no new run", async () => {
    const s = await pausedForFriend();
    // `release`'s read of the task: the delete runs there, to its end, before its write.
    const landed: { owners?: Promise<Done> } = {};
    const store = Object.assign(Object.create(s.store) as SqliteStore, {
      getTask: async (id: string) => {
        const task = await s.store.getTask(id);
        landed.owners ??= deleteTask(d, s.owner, s.task.id);
        await landed.owners;
        return task;
      },
    });
    const health = new DeliveryHealth(s.db, store);
    const d = s.deps(health);
    expect((await health.resume(s.friend.id, s.clock.now()))?.tasks).toEqual([]);
    expect((await landed.owners)?.ok).toBe(true);
    expect(await s.deleted()).toEqual(["archived", ["paused", "archived"], 0]);
    expect(health.isPaused(s.friend.id)).toBe(false);
  });

  it("a delete landing just after the resume's write stands too: no next run is queued for it", async () => {
    const s = await pausedForFriend();
    // Right after `release` writes its `resumed` event: the delete runs there, to its end.
    const landed: { owners?: Promise<Done> } = {};
    const store = Object.assign(Object.create(s.store) as SqliteStore, {
      addTaskEvent: async (e: Parameters<SqliteStore["addTaskEvent"]>[0]) => {
        const event = await s.store.addTaskEvent(e);
        if (e.kind === "resumed") {
          landed.owners ??= deleteTask(d, s.owner, s.task.id);
          await landed.owners;
        }
        return event;
      },
    });
    const health = new DeliveryHealth(s.db, store);
    const d = s.deps(health);
    expect((await health.resume(s.friend.id, s.clock.now()))?.tasks).toEqual([s.task.id]);
    expect((await landed.owners)?.ok).toBe(true);
    expect(await s.deleted()).toEqual(["archived", ["paused", "resumed", "archived"], 0]);
  });

  it("a delete started with the person's resume, either first by a few microtasks, stays deleted and sends nothing more", async () => {
    const quiet = { info() {}, warn() {}, error() {} };
    for (const first of ["delete", "resume"] as const) {
      for (let ahead = 0; ahead <= (first === "delete" ? 10 : 4); ahead++) {
        const s = await pausedForFriend();
        const d = s.deps(s.health);
        const del = () => deleteTask(d, s.owner, s.task.id);
        const resume = () => s.health.resume(s.friend.id, s.clock.now());
        const [a, b] = first === "delete" ? [del, resume] : [resume, del];
        const started = a();
        for (let i = 0; i < ahead; i++) await Promise.resolve();
        await Promise.all([started, b()]);
        // A run the resume queued just before the delete stays queued: docket runs none of an
        // archived task's runs, so nothing goes out.
        const sent: string[] = [];
        s.clock.set("2026-10-03T13:00:00.000Z");
        await runNotifyTick({
          store: s.store,
          clock: s.clock,
          types: TRACKER_TYPES,
          dm: async (userId) => {
            sent.push(userId);
            return { guildId: null, channelId: "c", messageId: "m" };
          },
          log: quiet,
          health: s.health,
        });
        expect([first, ahead, (await s.deleted())[0], sent]).toEqual([first, ahead, "archived", []]);
      }
    }
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

  it("an unconfirmed send neither counts nor clears the count", async () => {
    const s = await setup();
    await s.health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z");
    // Neither a refusal nor a delivery: it may have gone out, so it is the error itself, unchanged.
    const timeout = new Error("request timed out");
    await expect(failingWith(s, timeout, s.health).sendDm(s.owner.id, { text: "hi" })).rejects.toBe(timeout);
    expect(s.health.get(s.owner.id)).toMatchObject({ failures: 1, pausedAt: null });
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

  it("a delivered DM whose count cannot be cleared still reports its message id, and the failure is logged", async () => {
    const s = await setup();
    const broken = new Error("database is locked");
    const health = Object.assign(Object.create(s.health) as DeliveryHealth, {
      recordSuccess: () => {
        throw broken;
      },
    });
    const calls: string[] = [];
    const errors: [string, unknown][] = [];
    const notifier = createDmNotifier({
      store: s.store,
      dm: async (userId) => {
        calls.push(userId);
        return { guildId: null, channelId: "c", messageId: "m1" };
      },
      clock: s.clock,
      log: { info() {}, warn() {}, error: (m: string, e?: unknown) => void errors.push([m, e]) },
      health,
    });
    // Resolving, not rejecting: docket settles the delivery sent, with its message id, not unconfirmed.
    expect(await notifier.sendDm(s.owner.id, { text: "hi" })).toEqual({ messageId: "m1" });
    expect(calls).toEqual([OWNER]);
    expect(errors).toEqual([[`could not clear the failure count of ${s.owner.id}`, broken]]);
  });
});

describe("the notify tick counting toward the pause", () => {
  it("a DM that goes through clears the count, so only refusals in a row pause, however far apart", async () => {
    const s = await setup();
    let refuse = true;
    const sent: string[] = [];
    const dm: NonNullable<HostApi["dm"]> = async (userId) => {
      if (refuse) throw new Error(HOST_CANNOT_MESSAGE);
      sent.push(userId);
      return { guildId: null, channelId: "c", messageId: `m${sent.length}` };
    };
    const log = { info() {}, warn() {}, error() {} };
    const deps = { store: s.store, clock: s.clock, types: TRACKER_TYPES, dm, log, health: s.health };
    // One tick a week: each fires the one run owed (after the first, a late one), so the refusals are weeks apart.
    let week = 0;
    const run = async (refused: boolean) => {
      refuse = refused;
      s.clock.set(new Date(Date.UTC(2026, 9, 1 + 7 * week++, 13)).toISOString());
      expect(await runNotifyTick(deps)).toEqual({ kind: "ran", result: { ran: 1, failed: 0, skipped: 0 } });
    };
    await run(true);
    await run(true);
    expect(s.health.get(s.owner.id)?.failures).toBe(PAUSE_AFTER - 1);
    await run(false);
    expect(sent).toEqual([OWNER]);
    await run(true);
    expect(s.health.get(s.owner.id)).toMatchObject({ failures: 1, pausedAt: null });
    expect((await s.store.getTask(s.task.id))?.status).toBe("active");
    // The count still pauses once the refusals are in a row again.
    await run(true);
    expect(s.health.isPaused(s.owner.id)).toBe(false);
    await run(true);
    expect(s.health.get(s.owner.id)?.failures).toBe(PAUSE_AFTER);
    expect(s.health.isPaused(s.owner.id)).toBe(true);
    expect((await s.store.getTask(s.task.id))?.status).toBe("paused");
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
    // The owner once had a DM refused: each of their copies below goes through and clears that.
    await health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z");
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
    expect(s.health.get(s.owner.id)).toMatchObject({ failures: 0, pausedAt: null });
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
  // The pause itself (`recordFailure`) and a held send's pass (`holdFor`, #168) alike.
  for (const via of ["recordFailure", "holdFor"] as const) {
    it(`go out after the lock is released, so a resume does not wait behind a slow owner DM (${via})`, async () => {
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
      const at = "2026-10-01T12:00:00.000Z";
      let pass: () => Promise<unknown>;
      if (via === "recordFailure") {
        for (let i = 0; i < PAUSE_AFTER - 1; i++) await health.recordFailure(s.friend.id, HOST_CANNOT_MESSAGE, at);
        pass = () => health.recordFailure(s.friend.id, HOST_CANNOT_MESSAGE, at);
      } else {
        // Paused, with the pass not yet run (a pause that stopped part way): the held send runs it.
        s.db
          .query("INSERT INTO delivery_health (user_id, failures, last_error, last_failed_at, paused_at) VALUES (?, ?, ?, ?, ?)")
          .run(s.friend.id, PAUSE_AFTER, HOST_CANNOT_MESSAGE, at, at);
        pass = () => health.holdFor(s.friend.id, at);
      }
      let passDone = false;
      const passing = pass().then(() => void (passDone = true));
      while (told.length === 0) await new Promise((r) => setTimeout(r, 1));
      // The owner's DM is still in flight; a resume on the lock finishes anyway.
      const resumed = await Promise.race([
        health.resume(s.friend.id, s.clock.now()),
        new Promise<"timed out">((r) => setTimeout(() => r("timed out"), 500)),
      ]);
      expect(resumed).not.toBe("timed out");
      expect(passDone).toBe(false);
      release();
      await passing;
      expect(told).toEqual([s.owner.id]);
    });
  }
});

describe("a send for a task already finished (#168: not held)", () => {
  // A run that completes its task, as a research answer does: the task is done before its copies go.
  const answer = defineTaskType({
    id: "answer",
    lane: "notify",
    capabilities: ["notify"],
    schedule: ["once"],
    async run() {
      return { notify: { text: "the answer" }, complete: true };
    },
  });

  it("is not paused with a paused person: their copy fails after docket's eight deferrals, about two hours on", async () => {
    const s = await setup();
    const told: string[] = [];
    const health = new DeliveryHealth(s.db, s.store, { tellOwner: async (owner) => void told.push(owner.id) });
    for (let i = 0; i < PAUSE_AFTER; i++) await health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z");
    // Made while they stay paused (on the web, say), with the friend receiving it.
    const task = await s.store.createTask({
      ownerId: s.owner.id,
      type: "answer",
      title: "answer",
      config: {},
      schedule: { kind: "once", at: "2026-10-01T12:30:00.000Z" },
      lane: "notify",
      capabilities: ["notify"],
      at: "2026-10-01T12:00:00.000Z",
    });
    await s.store.setRecipient(task.id, s.friend.id, "accepted", "2026-10-01T12:00:00.000Z");
    await materialize(s.store, task, s.owner, s.clock.now());
    const sent: string[] = [];
    const dm: NonNullable<HostApi["dm"]> = async (userId) => {
      sent.push(userId);
      return { guildId: null, channelId: "c", messageId: `m${sent.length}` };
    };
    const quiet = { info() {}, warn() {}, error() {} };
    const deps = { store: s.store, clock: s.clock, types: { ...TRACKER_TYPES, answer: answer as TaskType<unknown> }, dm, log: quiet, health };
    const first = Date.parse("2026-10-01T13:00:00.000Z");
    s.clock.set(new Date(first).toISOString());
    await runNotifyTick(deps);
    expect((await s.store.getTask(task.id))?.status).toBe("done");
    const [run] = await s.store.listOccurrences({ taskId: task.id });
    const copy = async () => (await s.store.listDeliveries({ occurrenceId: run?.id ?? "", userId: s.owner.id }))[0];
    expect([(await copy())?.status, (await copy())?.deferrals]).toEqual(["deferred", 1]);
    // One-minute ticks until it settles: docket's backoff (1, 2, 4, ... minutes, capped at 60).
    let minutes = 0;
    while ((await copy())?.status === "deferred" && minutes < 180) {
      minutes++;
      s.clock.set(new Date(first + minutes * 60_000).toISOString());
      await runNotifyTick(deps);
    }
    expect([(await copy())?.status, (await copy())?.deferrals, minutes]).toEqual(["failed", 8, 123]);
    // The friend's copy went; the task stayed done, never paused, and no owner was told.
    expect(sent).toEqual([FRIEND]);
    expect((await s.store.getTask(task.id))?.status).toBe("done");
    expect((await s.store.listTaskEvents(task.id)).map((e) => e.kind)).toEqual(["completed"]);
    expect(health.pausesFor(task.id)).toEqual([]);
    expect(told).toEqual([]);
  });
});

describe("a send held for a paused person (#168): every task that still DMs them pauses", () => {
  const quiet = { info() {}, warn() {}, error() {} };

  /** The setup with the friend receiving the task, a health that collects the owners' notices, and a tick that DMs anyone. */
  async function held() {
    const s = await setup();
    await s.store.setRecipient(s.task.id, s.friend.id, "accepted", "2026-10-01T12:00:00.000Z");
    const told: string[] = [];
    const health = new DeliveryHealth(s.db, s.store, { tellOwner: async (owner) => void told.push(owner.id) });
    const sent: string[] = [];
    const dm: NonNullable<HostApi["dm"]> = async (userId) => {
      sent.push(userId);
      return { guildId: null, channelId: "c", messageId: `m${sent.length}` };
    };
    const deps = { store: s.store, clock: s.clock, types: TRACKER_TYPES, dm, log: quiet, health };
    const notifier = createDmNotifier({ store: s.store, dm, clock: s.clock, log: quiet, health });
    /** Each copy of the task's runs: who, and how it stands. */
    const copies = async (taskId = s.task.id) => {
      const out: [string, string][] = [];
      for (const o of await s.store.listOccurrences({ taskId })) {
        for (const d of await s.store.listDeliveries({ occurrenceId: o.id })) out.push([d.userId, d.status]);
      }
      return out;
    };
    /** The friend's delivery paused as a crash part way would leave it: `paused_at` written, nothing paused yet. */
    const pausedAtOnly = () =>
      s.db
        .query("INSERT INTO delivery_health (user_id, failures, last_error, last_failed_at, paused_at) VALUES (?, ?, ?, ?, ?)")
        .run(s.friend.id, PAUSE_AFTER, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z", "2026-10-01T12:00:00.000Z");
    return { ...s, health, told, sent, deps, notifier, copies, pausedAtOnly };
  }

  for (const stopped of ["before any task", "between a task's row and its status"] as const) {
    it(`a pause that stopped part way (${stopped}) completes on the next held send, and the DM waits for the resume`, async () => {
      const s = await held();
      s.pausedAtOnly();
      if (stopped !== "before any task") s.db.query("INSERT INTO delivery_pauses (task_id, user_id, at) VALUES (?, ?, ?)").run(s.task.id, s.friend.id, "2026-10-01T12:00:00.000Z");
      expect((await s.store.getTask(s.task.id))?.status).toBe("active");
      s.clock.set("2026-10-01T13:00:00.000Z");
      await runNotifyTick(s.deps);
      // The owner's copy of the run went; the friend's waits, and the task waits with it.
      expect(s.sent).toEqual([OWNER]);
      expect((await s.store.getTask(s.task.id))?.status).toBe("paused");
      expect(s.health.pausesFor(s.task.id)).toEqual([s.friend.id]);
      expect((await s.store.listTaskEvents(s.task.id)).map((e) => [e.kind, e.detail])).toEqual([["paused", recipientPauseDetail(s.friend.id)]]);
      expect(s.told).toEqual([s.owner.id]);
      // Hours on, it is still owed, not failed.
      for (let hour = 14; hour <= 20; hour++) {
        s.clock.set(`2026-10-01T${hour}:00:00.000Z`);
        await runNotifyTick(s.deps);
      }
      expect(await s.copies()).toEqual([
        [s.owner.id, "sent"],
        [s.friend.id, "deferred"],
      ]);
      expect((await s.health.resume(s.friend.id, s.clock.now()))?.tasks).toEqual([s.task.id]);
      await runNotifyTick(s.deps);
      expect(s.sent).toEqual([OWNER, FRIEND]);
      expect(await s.copies()).toEqual([
        [s.owner.id, "sent"],
        [s.friend.id, "sent"],
      ]);
    });
  }

  it("a task its owner paused, then resumed by hand while a recipient is still paused, pauses again at its next send", async () => {
    const s = await held();
    const d = { store: s.store, health: s.health, clock: s.clock, locks: new TaskLocks() } as unknown as TrackerDeps;
    expect((await pauseTask(d, s.owner, s.task.id)).ok).toBe(true);
    // The friend's delivery pauses meanwhile; the owner's own pause is left alone.
    for (let i = 0; i < PAUSE_AFTER; i++) await s.health.recordFailure(s.friend.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z");
    expect(s.health.pausesFor(s.task.id)).toEqual([]);
    expect(s.told).toEqual([]);
    expect(await resumeTask(d, s.owner, s.task.id)).toEqual({ ok: true, text: `Resumed \`${s.task.id}\`.` });
    expect((await s.store.getTask(s.task.id))?.status).toBe("active");

    s.clock.set("2026-10-01T13:00:00.000Z");
    await runNotifyTick(s.deps);
    expect(s.sent).toEqual([OWNER]);
    expect((await s.store.getTask(s.task.id))?.status).toBe("paused");
    expect(s.health.pausesFor(s.task.id)).toEqual([s.friend.id]);
    expect(s.told).toEqual([s.owner.id]);
    expect(await s.copies()).toEqual([
      [s.owner.id, "sent"],
      [s.friend.id, "deferred"],
    ]);
  });

  it("the owner of a task paused for a recipient is told once, not on every held send", async () => {
    const s = await held();
    s.pausedAtOnly();
    s.clock.set("2026-10-01T13:00:00.000Z");
    await runNotifyTick(s.deps);
    expect(s.told).toEqual([s.owner.id]);
    // The friend's own task, made since (on the web, say): its run is a held send too.
    const theirs = await s.store.createTask({ ...s.task, ownerId: s.friend.id, title: "theirs", config: { text: "theirs" }, state: null, at: "2026-10-01T13:00:00.000Z" });
    await materialize(s.store, theirs, s.friend, s.clock.now());
    s.clock.set("2026-10-02T13:00:00.000Z");
    await runNotifyTick(s.deps);
    await expect(s.notifier.sendDm(s.friend.id, { text: "and another" })).rejects.toBeInstanceOf(ExecutorUnavailableError);
    expect((await s.store.getTask(theirs.id))?.status).toBe("paused");
    expect(s.health.pausesFor(theirs.id)).toEqual([s.friend.id]);
    expect(await s.copies(theirs.id)).toEqual([[s.friend.id, "deferred"]]);
    expect(s.told).toEqual([s.owner.id]);
  });

  it("a held send's pass and a resume, in either order, never leave a task paused for someone who is not", async () => {
    for (const order of ["hold-first", "resume-first"] as const) {
      const s = await held();
      s.pausedAtOnly();
      const now = s.clock.now();
      const both =
        order === "hold-first"
          ? [s.health.holdFor(s.friend.id, now.toISOString()), s.health.resume(s.friend.id, now)]
          : [s.health.resume(s.friend.id, now), s.health.holdFor(s.friend.id, now.toISOString())];
      await Promise.all(both);
      expect(s.health.isPaused(s.friend.id)).toBe(false);
      expect(s.health.pausesFor(s.task.id)).toEqual([]);
      expect((await s.store.getTask(s.task.id))?.status).toBe("active");
    }
  });

  it("a pass that fails is logged, and the send is still only deferred", async () => {
    const s = await held();
    s.pausedAtOnly();
    const broken = new Error("database is locked");
    const health = Object.assign(Object.create(s.health) as DeliveryHealth, {
      holdFor: async () => {
        throw broken;
      },
    });
    const errors: unknown[] = [];
    const notifier = createDmNotifier({
      store: s.store,
      dm: async () => {
        throw new Error("never called: the person is paused");
      },
      clock: s.clock,
      log: { info() {}, warn() {}, error: (_m: string, e?: unknown) => void errors.push(e) },
      health,
    });
    await expect(notifier.sendDm(s.friend.id, { text: "hi" })).rejects.toBeInstanceOf(ExecutorUnavailableError);
    expect(errors).toEqual([broken]);
  });

  // The pass reads the tasks, then writes each one's pause without that task's lock (locks.ts): an
  // owner's delete that lands in between stands, and the person's resume leaves it.
  for (const left of [false, true]) {
    const row = left ? " (and a row a pause stopped part way left on it goes)" : "";
    it(`an owner's deleteTask landing between a held send's read of the tasks and its write stands${row}; the recipient's resume leaves it`, async () => {
      const s = await held();
      s.pausedAtOnly();
      if (left) s.db.query("INSERT INTO delivery_pauses (task_id, user_id, at) VALUES (?, ?, ?)").run(s.task.id, s.friend.id, "2026-10-01T12:00:00.000Z");
      // The pass's first read after `listTasks` is a task's recipients: the delete runs there, to its end.
      const landed: { owners?: Promise<Done> } = {};
      const store = Object.assign(Object.create(s.store) as SqliteStore, {
        listRecipients: async (taskId: string) => {
          landed.owners ??= deleteTask(d, s.owner, s.task.id);
          await landed.owners;
          return s.store.listRecipients(taskId);
        },
      });
      const told: string[] = [];
      const health = new DeliveryHealth(s.db, store, { tellOwner: async (owner) => void told.push(owner.id) });
      const d = { store: s.store, health, clock: s.clock, locks: new TaskLocks() } as unknown as TrackerDeps;
      await health.holdFor(s.friend.id, s.clock.now().toISOString());
      expect((await landed.owners)?.ok).toBe(true);
      expect((await s.store.getTask(s.task.id))?.status).toBe("archived");
      expect(health.pausesFor(s.task.id)).toEqual([]);
      expect((await s.store.listTaskEvents(s.task.id)).map((e) => [e.kind, e.detail])).toEqual([["archived", "deleted by the owner"]]);
      expect(told).toEqual([]);
      // The friend comes back: the delete stands.
      await health.resume(s.friend.id, s.clock.now());
      expect((await s.store.getTask(s.task.id))?.status).toBe("archived");
    });
  }

  it("an owner's pauseTask started between a held send's read of the tasks and its write waits for the pass, on the one lock: it is refused, never a pause the recipient's resume undoes", async () => {
    const s = await held();
    s.pausedAtOnly();
    const landed: { owners?: Promise<Done> } = {};
    const store = Object.assign(Object.create(s.store) as SqliteStore, {
      listRecipients: async (taskId: string) => {
        // Started, not awaited: it waits for DeliveryHealth's lock, which the pass holds.
        landed.owners ??= pauseTask(d, s.owner, s.task.id);
        return s.store.listRecipients(taskId);
      },
    });
    const told: string[] = [];
    const health = new DeliveryHealth(s.db, store, { tellOwner: async (owner) => void told.push(owner.id) });
    const d = { store: s.store, health, clock: s.clock, locks: new TaskLocks() } as unknown as TrackerDeps;
    await health.holdFor(s.friend.id, s.clock.now().toISOString());
    // The pass paused it for the friend first: the owner hears so, as if they had come a moment later.
    expect(await landed.owners).toEqual({ ok: false, error: "That task is paused, not active." });
    expect((await s.store.getTask(s.task.id))?.status).toBe("paused");
    expect(health.pausesFor(s.task.id)).toEqual([s.friend.id]);
    expect((await s.store.listTaskEvents(s.task.id)).map((e) => [e.kind, e.detail])).toEqual([["paused", recipientPauseDetail(s.friend.id)]]);
    expect(told).toEqual([s.owner.id]);
  });

  // The same races at their natural timings: the owner's act and the pass started together, either
  // first by a few microtasks, and the act queued behind the owner's own resume, the order `enter`
  // gives a command. Whatever the order, what the owner did stands; a pause the pass got to first is
  // refused, and then the person's resume sets the task going.
  for (const act of ["deleteTask", "pauseTask"] as const) {
    const want = act === "deleteTask" ? "archived" : "paused";
    it(`an owner's ${act} started with a held send's pass, or queued behind the owner's own resume as \`enter\` runs it, is never undone by the recipient's resume`, async () => {
      type Race = (s: Awaited<ReturnType<typeof held>>, own: () => Promise<Done>, hold: () => Promise<void>) => Promise<Done>;
      const races: [string, Race][] = [];
      for (let ahead = 0; ahead <= 8; ahead++) {
        races.push([
          `started together, the owner's act ${ahead} microtask(s) ahead`,
          async (_s, own, hold) => {
            const first = own();
            for (let i = 0; i < ahead; i++) await Promise.resolve();
            return (await Promise.all([first, hold()]))[0];
          },
        ]);
      }
      for (let ahead = 0; ahead <= 4; ahead++) {
        races.push([
          `started together, the pass ${ahead} microtask(s) ahead`,
          async (_s, own, hold) => {
            const first = hold();
            for (let i = 0; i < ahead; i++) await Promise.resolve();
            return (await Promise.all([own(), first]))[0];
          },
        ]);
      }
      races.push([
        "queued behind the owner's own resume",
        async (s, own, hold) => (await Promise.all([s.health.resume(s.owner.id, s.clock.now()).then(own), hold()]))[0],
      ]);
      for (const [how, race] of races) {
        const s = await held();
        s.pausedAtOnly();
        const d = { store: s.store, health: s.health, clock: s.clock, locks: new TaskLocks() } as unknown as TrackerDeps;
        const done = await race(
          s,
          () => (act === "deleteTask" ? deleteTask : pauseTask)(d, s.owner, s.task.id),
          () => s.health.holdFor(s.friend.id, s.clock.now().toISOString()),
        );
        if (act === "deleteTask") expect([how, done.ok]).toEqual([how, true]);
        if (!done.ok) expect([how, done.error]).toEqual([how, "That task is paused, not active."]);
        await s.health.resume(s.friend.id, s.clock.now());
        expect([how, (await s.store.getTask(s.task.id))?.status]).toEqual([how, done.ok ? want : "active"]);
      }
    });
  }

  it("a pass that throws part way still tells the owners of the tasks it paused before, and the error still reaches the caller", async () => {
    for (const via of ["holdFor", "recordFailure"] as const) {
      const s = await held();
      const third = await admit(s.store, "333333333333333333", s.clock.now());
      const second = await s.store.createTask({ ...s.task, ownerId: third.id, title: "second", config: { text: "second" }, state: null, at: "2026-10-01T12:00:00.000Z" });
      await s.store.setRecipient(second.id, s.friend.id, "accepted", "2026-10-01T12:00:00.000Z");
      const broken = new Error("disk I/O error");
      const store = Object.assign(Object.create(s.store) as SqliteStore, {
        addTaskEvent: async (e: Parameters<SqliteStore["addTaskEvent"]>[0]) => {
          if (e.taskId === second.id) throw broken;
          return s.store.addTaskEvent(e);
        },
      });
      const told: string[] = [];
      const health = new DeliveryHealth(s.db, store, { tellOwner: async (owner) => void told.push(owner.id) });
      const at = "2026-10-01T12:00:00.000Z";
      if (via === "holdFor") {
        s.pausedAtOnly();
        await expect(health.holdFor(s.friend.id, at)).rejects.toBe(broken);
      } else {
        for (let i = 0; i < PAUSE_AFTER - 1; i++) await health.recordFailure(s.friend.id, HOST_CANNOT_MESSAGE, at);
        await expect(health.recordFailure(s.friend.id, HOST_CANNOT_MESSAGE, at)).rejects.toBe(broken);
      }
      // Both were paused before the throw (the second's event write is what threw): both are told.
      expect([via, told]).toEqual([via, [s.owner.id, third.id]]);
      expect([via, health.pausesFor(s.task.id), health.pausesFor(second.id)]).toEqual([via, [s.friend.id], [s.friend.id]]);
    }
  });

  it("a Store error just after a task's pause still tells its owner, once: the next pass finds the task paused and leaves it", async () => {
    const s = await held();
    s.pausedAtOnly();
    const broken = new Error("disk I/O error");
    let throws = 1;
    const store = Object.assign(Object.create(s.store) as SqliteStore, {
      addTaskEvent: async (e: Parameters<SqliteStore["addTaskEvent"]>[0]) => {
        if (throws-- > 0) throw broken;
        return s.store.addTaskEvent(e);
      },
    });
    const told: string[] = [];
    const health = new DeliveryHealth(s.db, store, { tellOwner: async (owner) => void told.push(owner.id) });
    await expect(health.holdFor(s.friend.id, "2026-10-01T12:00:00.000Z")).rejects.toBe(broken);
    expect((await s.store.getTask(s.task.id))?.status).toBe("paused");
    expect(health.pausesFor(s.task.id)).toEqual([s.friend.id]);
    expect(told).toEqual([s.owner.id]);
    await health.holdFor(s.friend.id, "2026-10-01T12:01:00.000Z");
    expect(told).toEqual([s.owner.id]);
  });

  it("a pass whose pause row cannot be written leaves the task active: the status and the row are one transaction", async () => {
    const s = await held();
    s.pausedAtOnly();
    s.db.run("CREATE TRIGGER refuse_pause BEFORE INSERT ON delivery_pauses BEGIN SELECT RAISE(ABORT, 'x'); END");
    await expect(s.health.holdFor(s.friend.id, "2026-10-01T12:00:00.000Z")).rejects.toThrow("x");
    expect((await s.store.getTask(s.task.id))?.status).toBe("active");
    expect(s.health.pausesFor(s.task.id)).toEqual([]);
    expect(s.told).toEqual([]);
  });
});
