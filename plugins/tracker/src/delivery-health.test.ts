import { describe, expect, it } from "bun:test";
import { materialize, type Clock } from "@rackbops/docket-core";
import type { HostApi, HostMessage } from "../../../packages/api/contract.js";
import { ClaimStore } from "./claims.js";
import { decidePause, DeliveryHealth, PAUSE_AFTER } from "./delivery-health.js";
import { TRACKER_TYPES } from "./index.js";
import { HOST_CANNOT_MESSAGE } from "./notifier.js";
import { laneStore, runNotifyTick } from "./notify-lane.js";
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
  const claims = new ClaimStore(db);
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
  return { db, store, claims, health, clock, owner, friend, task };
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

  it("pauses the person's active tasks on record, and resume sets back only those", async () => {
    const s = await setup();
    const other = await s.store.createTask({ ...s.task, ownerId: s.owner.id, config: {}, state: null, at: "2026-10-01T12:00:00.000Z" });
    await s.store.updateTask(other.id, { status: "done", at: "2026-10-01T12:00:00.000Z" });
    for (let i = 0; i < PAUSE_AFTER; i++) await s.health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z");
    expect(s.health.isPaused(s.owner.id)).toBe(true);
    expect(s.health.get(s.owner.id)?.pausedTasks).toEqual([s.task.id]);
    expect((await s.store.getTask(s.task.id))?.status).toBe("paused");
    expect((await s.store.listTaskEvents(s.task.id)).map((e) => e.kind)).toEqual(["paused"]);

    expect(await s.health.resume(s.friend.id, s.clock.now())).toBeNull();
    const resumed = await s.health.resume(s.owner.id, s.clock.now());
    expect(resumed?.tasks).toEqual([s.task.id]);
    expect((await s.store.getTask(s.task.id))?.status).toBe("active");
    expect((await s.store.getTask(other.id))?.status).toBe("done");
    expect(s.health.get(s.owner.id)).toMatchObject({ failures: 0, pausedAt: null, pausedTasks: [] });
  });
});

describe("the lane's view of the store", () => {
  it("does not run a due occurrence of a paused task, and leaves a paused recipient out", async () => {
    const s = await setup();
    await s.store.setRecipient(s.task.id, s.friend.id, "accepted", "2026-10-01T12:00:00.000Z");
    const view = laneStore(s.store, s.health);
    const due = { lane: "notify" as const, status: "queued" as const, dueBefore: "2026-10-02T00:00:00.000Z" };
    expect(await view.listOccurrences(due)).toHaveLength(1);
    expect(await view.listRecipients(s.task.id)).toHaveLength(1);

    for (let i = 0; i < PAUSE_AFTER; i++) await s.health.recordFailure(s.friend.id, HOST_CANNOT_MESSAGE, "2026-10-01T12:00:00.000Z");
    expect(await view.listRecipients(s.task.id)).toEqual([]);
    await s.store.updateTask(s.task.id, { status: "paused", at: "2026-10-01T12:00:00.000Z" });
    expect(await view.listOccurrences(due)).toEqual([]);
    // Anything but the lane's due query passes through.
    expect(await view.listOccurrences({ taskId: s.task.id })).toHaveLength(1);
  });

  it("a paused recipient no longer fails the owner's run", async () => {
    const s = await setup();
    await s.store.setRecipient(s.task.id, s.friend.id, "accepted", "2026-10-01T12:00:00.000Z");
    const calls: string[] = [];
    const dm: NonNullable<HostApi["dm"]> = async (userId) => {
      calls.push(userId);
      if (userId === FRIEND) throw new Error(HOST_CANNOT_MESSAGE);
      return { guildId: null, channelId: "c", messageId: `m${calls.length}` };
    };
    const log = { info() {}, warn() {}, error() {} };
    const deps = { store: s.store, claims: s.claims, clock: s.clock, types: TRACKER_TYPES, dm, log, health: s.health };
    for (let day = 1; day <= PAUSE_AFTER; day++) {
      s.clock.set(`2026-10-0${day}T13:00:00.000Z`);
      const out = await runNotifyTick(deps);
      expect(out).toEqual({ kind: "ran", result: { ran: 0, failed: 1, skipped: 0 } });
    }
    expect(s.health.isPaused(s.friend.id)).toBe(true);
    expect(s.health.get(s.owner.id)?.failures ?? 0).toBe(0);
    s.clock.set("2026-10-04T13:00:00.000Z");
    expect(await runNotifyTick(deps)).toEqual({ kind: "ran", result: { ran: 1, failed: 0, skipped: 0 } });
    expect(calls.at(-1)).toBe(OWNER);
  });
});

describe("the notifier on a host that predates buttons", () => {
  it("sends again without buttons, under the same claim, once", async () => {
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
    const out = await runNotifyTick({ store: s.store, claims: s.claims, clock: s.clock, types: TRACKER_TYPES, dm, log, health: s.health });
    expect(out).toEqual({ kind: "ran", result: { ran: 1, failed: 0, skipped: 0 } });
    expect(calls.map((m) => m.buttons?.length ?? 0)).toEqual([3, 0]);
    expect(warnings.some((w) => w.includes("without buttons"))).toBe(true);
    const occurrence = (await s.store.listOccurrences({ taskId: s.task.id }))[0];
    expect(s.claims.get(occurrence?.id ?? "", s.owner.id)).toMatchObject({ status: "sent", messageId: "m1" });
  });
});
