import { describe, expect, it } from "bun:test";
import type { Clock, TaskStatus } from "@rackbops/docket-core";
import type { TrackerDeps } from "./actions.js";
import { TRACKER_TYPES } from "./index.js";
import { TaskLocks } from "./locks.js";
import { admit } from "./people.js";
import { press } from "./press.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

/**
 * An accept or decline pressed on a task that is gone, deleted or done is refused with the reason, and
 * nothing is recorded (#205, Epic #265 decision 6). The invitation here is written after the task ended,
 * as one left open before ended tasks withdrew their invitations would be.
 */

const OWNER = "111111111111111111";
const FRIEND = "222222222222222222";
const AT = "2026-10-01T12:00:00.000Z";

async function setup(status: TaskStatus, friendState: "invited" | "accepted" = "invited") {
  const store = new SqliteStore(openDatabase(":memory:"));
  const clock: Clock = { now: () => new Date(AT) };
  const owner = await admit(store, OWNER, clock.now());
  const friend = await admit(store, FRIEND, clock.now());
  const task = await store.createTask({
    ownerId: owner.id,
    type: "reminder",
    title: "bins out",
    config: { text: "bins out" },
    schedule: { kind: "calendar", every: 1, unit: "week", start: "2026-10-01", hour: 9 },
    lane: "notify",
    capabilities: ["notify"],
    at: AT,
  });
  if (status !== "active") await store.updateTask(task.id, { status, at: AT });
  await store.setRecipient(task.id, friend.id, friendState, AT);
  const d = { store, clock, types: TRACKER_TYPES, locks: new TaskLocks(), notifier: { sendDm: async () => {} } } as unknown as TrackerDeps;
  return { store, owner, friend, task, d };
}

/** Everything a consent answer could have written. */
async function recorded(s: Awaited<ReturnType<typeof setup>>) {
  return {
    recipients: (await s.store.listRecipients(s.task.id)).map((r) => r.state),
    blocks: (await s.store.listBlocks(s.owner.id, s.friend.id)).length,
    replies: (await s.store.listReplies(s.task.id)).length,
  };
}

describe("accept and decline on a task that has ended", () => {
  it("an accept on a deleted task says so and records nothing", async () => {
    const s = await setup("archived");
    const before = await recorded(s);
    expect(await press(s.d, s.friend, `a.t.${s.task.id}`)).toEqual({ ok: false, error: "That task was deleted." });
    expect(await recorded(s)).toEqual(before);
    expect(before.recipients).toEqual(["invited"]);
  });

  it("a decline on a done task says so and writes no block", async () => {
    const s = await setup("done");
    expect(await press(s.d, s.friend, `x.t.${s.task.id}`)).toEqual({ ok: false, error: "That task is done." });
    expect(await recorded(s)).toEqual({ recipients: ["invited"], blocks: 0, replies: 0 });
  });

  it("an accept on a task that no longer exists says it was deleted", async () => {
    const s = await setup("active");
    expect(await press(s.d, s.friend, "a.t.t99")).toEqual({ ok: false, error: "That task was deleted." });
  });

  it("an accept on an active or paused task still goes through", async () => {
    for (const status of ["active", "paused"] as const) {
      const s = await setup(status);
      const result = await press(s.d, s.friend, `a.t.${s.task.id}`);
      expect(result.ok).toBe(true);
      expect((await recorded(s)).recipients).toEqual(["accepted"]);
    }
  });

  it("an opt-out on a done or deleted task still works", async () => {
    for (const status of ["done", "archived"] as const) {
      const s = await setup(status, "accepted");
      const result = await press(s.d, s.friend, `q.t.${s.task.id}`);
      expect(result).toEqual({ ok: true, status: "You will not get this task's messages any more.", keepReplyFor: null });
      expect((await recorded(s)).recipients).toEqual(["opted_out"]);
    }
  });
});
