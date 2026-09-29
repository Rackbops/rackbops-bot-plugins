import { describe, expect, it } from "bun:test";
import { materialize, type Clock, type Schedule } from "@rackbops/docket-core";
import { TASK_TYPES } from "@rackbops/docket-types";
import type { HostApi, HostMessage } from "../../../packages/api/contract.js";
import { ClaimStore } from "./claims.js";
import { HOST_CANNOT_MESSAGE, MAX_CONTENT, UNCONFIRMED_MESSAGE_ID } from "./notifier.js";
import { runNotifyTick } from "./notify-lane.js";
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
  const claims = new ClaimStore(db);
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
  return { db, store, claims, clock, owner, task, occurrence };
}

describe("runNotifyTick", () => {
  it("sends nothing before the reminder is due, then DMs the owner's Discord id once it is", async () => {
    const s = await setup();
    const { dm, calls } = fakeDm();
    const { log } = silentLog();
    const deps = { store: s.store, claims: s.claims, clock: s.clock, types: TASK_TYPES, dm, log };

    expect(await runNotifyTick(deps)).toEqual({ kind: "ran", result: { ran: 0, failed: 0, skipped: 0 } });
    expect(calls).toHaveLength(0);

    s.clock.set(DUE);
    expect(await runNotifyTick(deps)).toEqual({ kind: "ran", result: { ran: 1, failed: 0, skipped: 0 } });
    expect(calls).toEqual([{ userId: DISCORD, message: { content: "water the plants" } }]);
    const after = await s.store.getOccurrence(s.occurrence.id);
    expect(after?.status).toBe("done");
    const delivered = (await s.store.listEvents(s.occurrence.id)).filter((e) => e.type === "delivered");
    expect(delivered.map((e) => e.text)).toEqual([`${s.owner.id} m1`]);
    expect(s.claims.get(s.occurrence.id, s.owner.id)).toMatchObject({ status: "sent", messageId: "m1", channelId: "c1" });

    expect(await runNotifyTick(deps)).toEqual({ kind: "ran", result: { ran: 0, failed: 0, skipped: 0 } });
    expect(calls).toHaveLength(1);
  });

  it("maps the host's 'recipient cannot be messaged' to a failed run, and a recurring task keeps its next run", async () => {
    const s = await setup({ kind: "calendar", every: 1, unit: "day", start: "2026-10-01", hour: 9 });
    const { dm, calls } = fakeDm(async () => {
      throw new Error(HOST_CANNOT_MESSAGE);
    });
    const { log } = silentLog();
    s.clock.set(s.occurrence.dueAt);
    const outcome = await runNotifyTick({ store: s.store, claims: s.claims, clock: s.clock, types: TASK_TYPES, dm, log });
    expect(outcome).toEqual({ kind: "ran", result: { ran: 0, failed: 1, skipped: 0 } });
    expect(calls).toHaveLength(1);
    const failed = await s.store.getOccurrence(s.occurrence.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe(`recipient ${s.owner.id} cannot be messaged (DMs closed, or the bot is blocked)`);
    expect(s.claims.get(s.occurrence.id, s.owner.id)).toMatchObject({ status: "failed", error: HOST_CANNOT_MESSAGE });
    const queued = await s.store.listOccurrences({ taskId: s.task.id, status: "queued" });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.dueAt > s.occurrence.dueAt).toBe(true);
  });

  it("never resends a delivery claimed before a crash without a recorded send; records it as unconfirmed", async () => {
    const s = await setup();
    s.clock.set(DUE);
    // The crash: the claim was written and the run was running when the process died.
    s.claims.claim(s.occurrence.id, s.owner.id, DISCORD, DUE);
    await s.store.updateOccurrence(s.occurrence.id, { status: "running" });
    await s.store.requeueRunning();

    const { dm, calls } = fakeDm();
    const { log, warnings } = silentLog();
    await runNotifyTick({ store: s.store, claims: s.claims, clock: s.clock, types: TASK_TYPES, dm, log });
    expect(calls).toHaveLength(0);
    expect(s.claims.get(s.occurrence.id, s.owner.id)?.status).toBe("unconfirmed");
    const delivered = (await s.store.listEvents(s.occurrence.id)).filter((e) => e.type === "delivered");
    expect(delivered.map((e) => e.text)).toEqual([`${s.owner.id} ${UNCONFIRMED_MESSAGE_ID}`]);
    expect(warnings.some((w) => w.includes("unconfirmed"))).toBe(true);
    expect(s.claims.listUnsettled()).toHaveLength(1);
  });

  it("a send that settled before the crash is recorded with its real message id, not sent again", async () => {
    const s = await setup();
    s.clock.set(DUE);
    s.claims.claim(s.occurrence.id, s.owner.id, DISCORD, DUE);
    s.claims.settle(s.occurrence.id, s.owner.id, "sent", DUE, { messageId: "m-before", channelId: "c1" });
    const { dm, calls } = fakeDm();
    const { log } = silentLog();
    await runNotifyTick({ store: s.store, claims: s.claims, clock: s.clock, types: TASK_TYPES, dm, log });
    expect(calls).toHaveLength(0);
    const delivered = (await s.store.listEvents(s.occurrence.id)).filter((e) => e.type === "delivered");
    expect(delivered.map((e) => e.text)).toEqual([`${s.owner.id} m-before`]);
  });

  it("an error that does not say whether Discord took the DM leaves an unconfirmed claim that is never resent", async () => {
    const s = await setup({ kind: "calendar", every: 1, unit: "day", start: "2026-10-01", hour: 9 });
    const { dm, calls } = fakeDm(async () => {
      throw new Error("socket hang up");
    });
    const { log } = silentLog();
    s.clock.set(s.occurrence.dueAt);
    await runNotifyTick({ store: s.store, claims: s.claims, clock: s.clock, types: TASK_TYPES, dm, log });
    expect(calls).toHaveLength(1);
    expect((await s.store.getOccurrence(s.occurrence.id))?.error).toBe("socket hang up");
    expect(s.claims.get(s.occurrence.id, s.owner.id)).toMatchObject({ status: "unconfirmed", error: "socket hang up" });
  });

  it("an aborted signal sends nothing and leaves the due run queued for the next tick", async () => {
    const s = await setup();
    s.clock.set(DUE);
    const { dm, calls } = fakeDm();
    const { log } = silentLog();
    const deps = { store: s.store, claims: s.claims, clock: s.clock, types: TASK_TYPES, dm, log };
    const controller = new AbortController();
    controller.abort();
    expect(await runNotifyTick(deps, controller.signal)).toEqual({ kind: "aborted" });
    expect(calls).toHaveLength(0);
    expect((await s.store.getOccurrence(s.occurrence.id))?.status).toBe("queued");

    await runNotifyTick(deps, new AbortController().signal);
    expect(calls).toHaveLength(1);
  });

  it("an abort mid-tick stops the next send: that run goes back to the queue, unclaimed", async () => {
    const s = await setup();
    const other = await s.store.createTask({ ...s.task, config: { text: "second" }, title: "second", at: DUE });
    const second = await materialize(s.store, other, s.owner, s.clock.now());
    s.clock.set(DUE);
    const controller = new AbortController();
    const { dm, calls } = fakeDm(async () => controller.abort());
    const { log } = silentLog();
    const outcome = await runNotifyTick({ store: s.store, claims: s.claims, clock: s.clock, types: TASK_TYPES, dm, log }, controller.signal);
    expect(outcome).toEqual({ kind: "aborted" });
    expect(calls).toHaveLength(1);
    expect((await s.store.getOccurrence(s.occurrence.id))?.status).toBe("done");
    expect((await s.store.getOccurrence(second?.id ?? ""))?.status).toBe("queued");
    expect(s.claims.get(second?.id ?? "", s.owner.id)).toBeNull();
  });

  it("does nothing on a host without dm", async () => {
    const s = await setup();
    s.clock.set(DUE);
    const { log } = silentLog();
    expect(await runNotifyTick({ store: s.store, claims: s.claims, clock: s.clock, types: TASK_TYPES, dm: undefined, log })).toEqual({ kind: "no-dm" });
    expect((await s.store.getOccurrence(s.occurrence.id))?.status).toBe("queued");
  });

  it("cuts a message longer than Discord allows", async () => {
    const s = await setup(undefined, "x".repeat(MAX_CONTENT + 50));
    s.clock.set(DUE);
    const { dm, calls } = fakeDm();
    const { log } = silentLog();
    await runNotifyTick({ store: s.store, claims: s.claims, clock: s.clock, types: TASK_TYPES, dm, log });
    expect(calls[0]?.message.content).toHaveLength(MAX_CONTENT);
    expect(calls[0]?.message.content.endsWith("...")).toBe(true);
  });
});
