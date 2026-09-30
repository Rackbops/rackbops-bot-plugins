import { describe, expect, it } from "bun:test";
import { materialize, STILL_FINISHING, type Clock } from "@rackbops/docket-core";
import type { HostApi } from "../../../packages/api/contract.js";
import { answerable, answerLatest, type TrackerDeps } from "./actions.js";
import { TRACKER_TYPES } from "./index.js";
import { TaskLocks } from "./locks.js";
import { createDmNotifier } from "./notifier.js";
import { runNotifyTick } from "./notify-lane.js";
import { admit } from "./people.js";
import { press } from "./press.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

/**
 * Answering a run under docket 0.4.0: a run is answerable once it has fired, whatever it still owes
 * anyone, and a fired run still finishing is refused with docket's "still finishing".
 */

const OWNER = "111111111111111111";
const FRIEND = "222222222222222222";
const DUE = "2026-10-01T13:00:00.000Z";
const log = { info() {}, warn() {}, error() {} };

function fakeClock(iso: string): Clock & { set(iso: string): void } {
  let now = new Date(iso);
  return { now: () => new Date(now), set: (s) => (now = new Date(s)) };
}

async function setup() {
  const db = openDatabase(":memory:");
  const store = new SqliteStore(db);
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
  await store.setRecipient(task.id, friend.id, "accepted", clock.now().toISOString());
  const first = await materialize(store, task, owner, clock.now());
  // The friend's copy fails with nothing sent, so it stays owed; the owner's goes out.
  const dm: NonNullable<HostApi["dm"]> = async (userId) => {
    if (userId === FRIEND) throw new Error("content is empty");
    return { guildId: null, channelId: "c", messageId: "m" };
  };
  const locks = new TaskLocks();
  const d = {
    store,
    clock,
    types: TRACKER_TYPES,
    locks,
    notifier: createDmNotifier({ store, dm, clock, log }),
  } as unknown as TrackerDeps;
  return { store, clock, owner, friend, task, first, dm, locks, d };
}

describe("answering a run that still owes a delivery", () => {
  it("/task done answers the latest fired run while a recipient's copy is still owed", async () => {
    const s = await setup();
    s.clock.set(DUE);
    await runNotifyTick({ store: s.store, locks: s.locks, clock: s.clock, types: TRACKER_TYPES, dm: s.dm, log });
    const run = s.first?.id ?? "";
    const owed = await s.store.listDeliveries({ occurrenceId: run, userId: s.friend.id });
    expect(owed.map((d) => [d.status, d.retryAt !== null])).toEqual([["failed", true]]);
    // The next day's run is queued, not fired: never the one answered.
    expect((await s.store.listOccurrences({ taskId: s.task.id, status: "queued" })).length).toBe(1);

    expect(await answerLatest(s.d, s.owner, { taskId: s.task.id, kind: "done" })).toBe("Marked done.");
    expect((await s.store.listReplies(s.task.id)).map((r) => [r.occurrenceId, r.kind])).toEqual([[run, "done"]]);
    // Answering changes nothing the run owes: the friend's copy is still tried.
    expect((await s.store.listDeliveries({ occurrenceId: run, userId: s.friend.id }))[0]?.retryAt).not.toBeNull();
  });

  it("a fired run put back to finish is the latest, and docket's STILL_FINISHING reaches the owner, by command and by button", async () => {
    const s = await setup();
    const run = s.first?.id ?? "";
    // What a Store error after the record leaves: the run fired, back in the queue to resume.
    await s.store.updateOccurrence(run, {
      record: { outcome: { notify: { text: "stretch", actions: ["done", "snooze"] } }, costUsd: null, firedAt: DUE, appliedAt: null, resumes: 1 },
    });
    const finishing = await s.store.getOccurrence(run);
    expect(finishing && answerable(finishing)).toBe(true);
    s.clock.set(DUE);
    expect(await answerLatest(s.d, s.owner, { taskId: s.task.id, kind: "done" })).toBe(STILL_FINISHING);
    expect(await press(s.d, s.owner, `d.o.${run}`)).toEqual({ ok: false, error: STILL_FINISHING });
    expect(await s.store.listReplies(s.task.id)).toEqual([]);
  });

  it("a queued or running run that has not fired is not answerable", async () => {
    const s = await setup();
    const queued = await s.store.getOccurrence(s.first?.id ?? "");
    expect(queued && answerable(queued)).toBe(false);
    expect(queued && answerable({ ...queued, status: "running", startedAt: DUE })).toBe(false);
    expect(await answerLatest(s.d, s.owner, { taskId: s.task.id, kind: "done" })).toContain("nothing to answer");
  });

  it("an answer waits for its task's lock, held by a run of the task in flight", async () => {
    const s = await setup();
    let release: () => void = () => {};
    const held = s.locks.run(s.task.id, () => new Promise<void>((r) => (release = r)));
    const answered: string[] = [];
    const answer = answerLatest(s.d, s.owner, { taskId: s.task.id, kind: "done" }).then((a) => void answered.push(a));
    await new Promise((r) => setTimeout(r, 5));
    expect(answered).toEqual([]);
    release();
    await held;
    await answer;
    expect(answered[0]).toContain("nothing to answer");
    expect(s.locks.held(s.task.id)).toBe(false);
  });
});
