import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Lanes, materialize, type Clock, type Schedule, type User } from "@rackbops/docket-core";
import { makeFakeDelivery, makeFakeHost } from "../../../packages/testkit/index.js";
import type { HostApi, HostMessage } from "../../../packages/api/contract.js";
import { DeliveryHealth } from "./delivery-health.js";
import { collectDigest, digestKey, formatDigest, localDay, MAX_LINES, runDigests } from "./digest.js";
import { createPlugin, DB_DIR, DB_FILE, TRACKER_TYPES } from "./index.js";
import { createDmNotifier, HOST_CANNOT_MESSAGE } from "./notifier.js";
import { runNotifyTick } from "./notify-lane.js";
import { admit, setPreferences } from "./people.js";
import { Roster } from "./roster.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

// Mon 2026-10-05 in New York is UTC-4: 9:00 there is 13:00Z.
const BEFORE_HOUR = "2026-10-05T12:59:00.000Z";
const AT_HOUR = "2026-10-05T13:00:00.000Z";
const OWNER = "111111111111111111";
const FRIEND = "222222222222222222";

function fakeClock(iso: string): Clock & { set(iso: string): void } {
  let now = new Date(iso);
  return { now: () => new Date(now), set: (s) => (now = new Date(s)) };
}

function fakeDm(fail?: (n: number) => Error | null) {
  const calls: { userId: string; message: HostMessage }[] = [];
  const dm: NonNullable<HostApi["dm"]> = async (userId, message) => {
    calls.push({ userId, message });
    const err = fail?.(calls.length);
    if (err) throw err;
    return { guildId: null, channelId: "c1", messageId: `m${calls.length}` };
  };
  return { dm, calls };
}

function quietLog() {
  const warnings: string[] = [];
  const errors: string[] = [];
  return { warnings, errors, log: { info() {}, warn: (m: string) => void warnings.push(m), error: (m: string) => void errors.push(m) } };
}

async function setup(start = "2026-10-03T12:00:00.000Z") {
  const db = openDatabase(":memory:");
  const store = new SqliteStore(db);
  const clock = fakeClock(start);
  const owner = await admit(store, OWNER, clock.now());
  const { dm, calls } = fakeDm();
  const { log, warnings, errors } = quietLog();
  const health = new DeliveryHealth(db, store);
  const notifier = createDmNotifier({ store, dm, clock, log, health });
  const tick = async () => runNotifyTick({ store, clock, types: TRACKER_TYPES, dm, log, health });
  const digests = (signal?: AbortSignal) => runDigests({ store, notifier, log, health }, clock.now(), signal);
  const make = async (title: string, schedule: Schedule, who: User = owner, type = "reminder", config: unknown = { text: title }) => {
    const task = await store.createTask({ ownerId: who.id, type, title, config, schedule, lane: "notify", capabilities: ["notify"], at: clock.now().toISOString() });
    await materialize(store, task, who, clock.now());
    return task;
  };
  const reply = (taskId: string, occurrenceId: string, kind: "done" | "snooze", payload: unknown = null, userId = owner.id) =>
    new Lanes({ store, clock, types: TRACKER_TYPES, notifier }).reply({ taskId, occurrenceId, userId, kind, payload });
  const lastRun = async (taskId: string) => (await store.listOccurrences({ taskId })).at(-1)!;
  return { db, store, clock, owner, calls, warnings, errors, health, tick, digests, make, reply, lastRun };
}

describe("localDay", () => {
  it("is the person's own calendar day, its bounds the zone's midnights, across a clock change", () => {
    expect(localDay(new Date(AT_HOUR), "America/New_York")).toEqual({
      day: "2026-10-05",
      start: new Date("2026-10-05T04:00:00.000Z"),
      end: new Date("2026-10-06T04:00:00.000Z"),
      hour: 9,
    });
    // 13:00Z is already 22:00 on the 5th in Tokyo, and still the 4th's evening nowhere near.
    expect(localDay(new Date(AT_HOUR), "Asia/Tokyo").day).toBe("2026-10-05");
    expect(localDay(new Date("2026-10-05T16:00:00.000Z"), "Asia/Tokyo")).toMatchObject({ day: "2026-10-06", hour: 1 });
    // New York falls back on Sun 2026-11-01: a 25-hour day.
    const fallBack = localDay(new Date("2026-11-01T15:00:00.000Z"), "America/New_York");
    expect(fallBack.end.getTime() - fallBack.start.getTime()).toBe(25 * 3_600_000);
    // Month and year ends roll over.
    expect(localDay(new Date("2026-12-31T20:00:00.000Z"), "America/New_York").end).toEqual(new Date("2027-01-01T05:00:00.000Z"));
  });
});

describe("runDigests (plan 5.5)", () => {
  it("lists what is overdue and what is due today, once, at the person's hour", async () => {
    const s = await setup();
    // Fired Saturday, never answered: overdue.
    const rent = await s.make("pay rent", { kind: "once", at: "2026-10-03T13:00:00.000Z" });
    s.clock.set("2026-10-03T13:00:00.000Z");
    await s.tick();
    expect(s.calls.map((c) => c.message.content)).toEqual(["pay rent"]);
    // Due tonight at 18:00 New York: due today.
    s.clock.set("2026-10-05T10:00:00.000Z");
    const mom = await s.make("call mom", { kind: "once", at: "2026-10-05T22:00:00.000Z" });
    // Due tomorrow: not listed.
    await s.make("dentist", { kind: "once", at: "2026-10-06T14:00:00.000Z" });

    s.clock.set(BEFORE_HOUR);
    expect(await s.digests()).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(s.calls).toHaveLength(1);

    s.clock.set(AT_HOUR);
    expect(await s.digests()).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]?.userId).toBe(OWNER);
    expect(s.calls[1]?.message.content).toBe(
      [
        "Your day, Mon Oct 5:",
        "**Overdue**",
        `- \`${rent.id}\` pay rent -- due Sat Oct 3, 9:00, not marked done yet`,
        "**Due today**",
        `- \`${mom.id}\` call mom -- 18:00`,
        "`/task done` marks a reminder done, `/task decide` answers a renewal, `/task snooze` puts either off; `/tasks` lists everything.",
      ].join("\n"),
    );
    // No buttons: a digest is about many runs, each answered by its own command or message.
    expect(s.calls[1]?.message.buttons).toBeUndefined();

    // Exactly once: later the same day, nothing more.
    s.clock.set("2026-10-05T20:00:00.000Z");
    expect(await s.digests()).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(s.calls).toHaveLength(2);
    expect(s.db.query("SELECT key FROM notices").all()).toEqual([{ key: digestKey(s.owner.id, "2026-10-05") }]);

    // The next morning: rent is still overdue, mom's run fired at 18:00 and is now overdue too.
    s.clock.set("2026-10-05T22:00:00.000Z");
    await s.tick();
    s.clock.set("2026-10-06T13:00:00.000Z");
    await s.digests();
    expect(s.calls.at(-1)?.message.content).toContain(`- \`${mom.id}\` call mom -- due Mon Oct 5, 18:00, not marked done yet`);
    expect(s.calls.at(-1)?.message.content).toContain("dentist -- 10:00");
  });

  it("claims the day but sends nothing when nothing is due or overdue, and looks at it once", async () => {
    const s = await setup();
    s.clock.set(AT_HOUR);
    expect(await s.digests()).toEqual({ claimed: 1, sent: 0, failed: 0 });
    // A reminder made later that day for that evening sets off no digest of its own.
    s.clock.set("2026-10-05T15:00:00.000Z");
    await s.make("bins out", { kind: "once", at: "2026-10-05T23:00:00.000Z" });
    expect(await s.digests()).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(s.calls).toHaveLength(0);
  });

  it("goes out late the same day when the bot was down at the hour, never the next day for a missed one", async () => {
    const s = await setup();
    await s.make("call mom", { kind: "once", at: "2026-10-05T22:00:00.000Z" });
    s.clock.set("2026-10-05T19:30:00.000Z");
    expect((await s.digests()).sent).toBe(1);
    expect(s.calls[0]?.message.content).toContain("call mom -- 18:00");
  });

  it("leaves out a run answered done, a snoozed run (its snooze is what is due), and an older run behind a newer one", async () => {
    const s = await setup();
    const done = await s.make("pay rent", { kind: "once", at: "2026-10-03T13:00:00.000Z" });
    const snoozed = await s.make("water plants", { kind: "once", at: "2026-10-03T13:00:00.000Z" });
    const daily = await s.make("stretch", { kind: "calendar", every: 1, unit: "day", hour: 8, start: "2026-10-04" });
    s.clock.set("2026-10-03T13:00:00.000Z");
    await s.tick();
    await s.reply(done.id, (await s.lastRun(done.id)).id, "done");
    await s.reply(snoozed.id, (await s.lastRun(snoozed.id)).id, "snooze", { until: "2026-10-05T21:00:00.000Z" });
    // The daily stretch fired on the 4th and the 5th at 8:00, never answered.
    for (const at of ["2026-10-04T12:00:00.000Z", "2026-10-05T12:00:00.000Z"]) {
      s.clock.set(at);
      await s.tick();
    }
    s.clock.set(AT_HOUR);
    await s.digests();
    const text = s.calls.at(-1)?.message.content ?? "";
    expect(text).not.toContain("pay rent");
    expect(text).not.toContain("**Overdue**");
    expect(text).toContain(`- \`${snoozed.id}\` water plants -- 17:00`);
    expect(text).toContain(`- \`${daily.id}\` stretch -- 8:00, not marked done yet`);
    expect(text.match(/stretch/g)).toHaveLength(1);
  });

  it("lists only the person's own reminders and renewals, never a price check or a task they receive", async () => {
    const s = await setup();
    const friend = await admit(s.store, FRIEND, s.clock.now());
    await s.make("theirs", { kind: "once", at: "2026-10-05T22:00:00.000Z" }, friend);
    await s.make("price of a lamp", { kind: "poll", every: 1, unit: "hour", start: "2026-10-03T12:00:00.000Z" }, s.owner, "price", { url: "https://shop.example/lamp" });
    const renewal = await s.make(
      "Netflix",
      { kind: "once", at: "2026-10-05T14:00:00.000Z" },
      s.owner,
      "renewal",
      { amount: 15.49, currency: "USD", renews: "2026-10-12", lead: 7 },
    );
    s.clock.set("2026-10-05T14:00:00.000Z");
    await s.tick();
    expect(await s.digests()).toEqual({ claimed: 2, sent: 2, failed: 0 });
    const mine = s.calls.filter((c) => c.userId === OWNER).at(-1)?.message.content ?? "";
    expect(mine).toContain(`- \`${renewal.id}\` Netflix -- 10:00, waiting on your keep, cancel or renewed`);
    expect(mine).not.toContain("lamp");
    expect(mine).not.toContain("theirs");
    const theirs = s.calls.filter((c) => c.userId === FRIEND).at(-1)?.message.content ?? "";
    expect(theirs).toContain("theirs -- 18:00");
    // Unanswered the next morning, the renewal's line says when it was asked, not a due date.
    s.clock.set("2026-10-06T13:00:00.000Z");
    await s.digests();
    expect(s.calls.filter((c) => c.userId === OWNER).at(-1)?.message.content).toContain(
      `- \`${renewal.id}\` Netflix -- asked Mon Oct 5, 10:00, waiting on your keep, cancel or renewed`,
    );
  });

  it("uses each person's own zone and hour", async () => {
    const s = await setup();
    await setPreferences(s.store, s.owner.id, { timeZone: "Asia/Tokyo", preferredHour: 7 });
    // 7:00 on Tue Oct 6 in Tokyo is 22:00Z on the 5th.
    await s.make("train", { kind: "once", at: "2026-10-06T00:30:00.000Z" });
    s.clock.set("2026-10-05T21:59:00.000Z");
    expect((await s.digests()).claimed).toBe(0);
    s.clock.set("2026-10-05T22:00:00.000Z");
    expect((await s.digests()).sent).toBe(1);
    expect(s.calls[0]?.message.content).toStartWith("Your day, Tue Oct 6:");
    expect(s.calls[0]?.message.content).toContain("train -- 9:30");
    expect(s.db.query("SELECT key FROM notices").all()).toEqual([{ key: digestKey(s.owner.id, "2026-10-06") }]);
  });

  it("passes a paused person by without claiming, and sends once the pause lifts that day", async () => {
    const s = await setup();
    await s.make("call mom", { kind: "once", at: "2026-10-05T22:00:00.000Z" });
    for (let i = 0; i < 3; i++) await s.health.recordFailure(s.owner.id, HOST_CANNOT_MESSAGE, s.clock.now().toISOString());
    expect(s.health.isPaused(s.owner.id)).toBe(true);
    s.clock.set(AT_HOUR);
    expect(await s.digests()).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(s.calls).toHaveLength(0);
    // The pause lifts (they used the tracker again) later that day: the digest goes then.
    s.clock.set("2026-10-05T16:00:00.000Z");
    await s.health.resume(s.owner.id, s.clock.now());
    expect(s.health.isPaused(s.owner.id)).toBe(false);
    expect(await s.digests()).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(s.calls[0]?.message.content).toContain("call mom -- 18:00");
  });

  it("settles a send that fails as failed, claimed, and not tried again that day", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteStore(db);
    const clock = fakeClock("2026-10-05T10:00:00.000Z");
    const owner = await admit(store, OWNER, clock.now());
    const task = await store.createTask({
      ownerId: owner.id,
      type: "reminder",
      title: "call mom",
      config: { text: "call mom" },
      schedule: { kind: "once", at: "2026-10-05T22:00:00.000Z" },
      lane: "notify",
      capabilities: ["notify"],
      at: clock.now().toISOString(),
    });
    await materialize(store, task, owner, clock.now());
    const { dm, calls } = fakeDm(() => new Error("socket hang up"));
    const { log, warnings } = quietLog();
    const notifier = createDmNotifier({ store, dm, clock, log });
    clock.set(AT_HOUR);
    expect(await runDigests({ store, notifier, log }, clock.now())).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(warnings.some((w) => w.includes("did not go out (socket hang up); it is not resent"))).toBe(true);
    clock.set("2026-10-05T13:01:00.000Z");
    expect(await runDigests({ store, notifier, log }, clock.now())).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(calls).toHaveLength(1);
  });

  it("stops between people once the tick is aborted", async () => {
    const s = await setup();
    await admit(s.store, FRIEND, s.clock.now());
    s.clock.set(AT_HOUR);
    const ac = new AbortController();
    ac.abort();
    expect(await s.digests(ac.signal)).toEqual({ claimed: 0, sent: 0, failed: 0 });
  });
});

describe("formatDigest", () => {
  it("is null with nothing to list, and counts what is past the per-section limit", async () => {
    const s = await setup("2026-10-05T10:00:00.000Z");
    const { start, end } = localDay(new Date(AT_HOUR), s.owner.timeZone);
    expect(formatDigest(await collectDigest(s.store, s.owner, start, end), s.owner, new Date(AT_HOUR))).toBeNull();
    for (let i = 0; i < MAX_LINES + 2; i++) await s.make(`chore ${i}`, { kind: "once", at: `2026-10-05T2${i % 4}:${String(10 + i).padStart(2, "0")}:00.000Z` });
    const text = formatDigest(await collectDigest(s.store, s.owner, start, end), s.owner, new Date(AT_HOUR)) ?? "";
    expect(text.split("\n").filter((l) => l.startsWith("- `"))).toHaveLength(MAX_LINES);
    expect(text).toContain("- and 2 more");
  });
});

describe("forget-me", () => {
  it("erases the person's digest claims and no one else's", async () => {
    const s = await setup();
    const friend = await admit(s.store, FRIEND, s.clock.now());
    await s.store.claimNotice(digestKey(s.owner.id, "2026-10-05"), AT_HOUR);
    await s.store.claimNotice(digestKey(friend.id, "2026-10-05"), AT_HOUR);
    new Roster(s.db).erase(s.owner.id);
    expect(s.db.query("SELECT key FROM notices").all()).toEqual([{ key: digestKey(friend.id, "2026-10-05") }]);
  });
});

describe("the plugin's notify tick", () => {
  it("sends the digest after the runs due now, on a real data file", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tracker-digest-"));
    try {
      const clock = fakeClock("2026-10-05T10:00:00.000Z");
      const delivery = makeFakeDelivery();
      const plugin = createPlugin(makeFakeHost({ name: "tracker", dataDir, env: { TRACKER_ADMIN_DISCORD_IDS: OWNER }, ...delivery }), { clock });
      await plugin.activate!();
      const store = new SqliteStore(openDatabase(join(dataDir, DB_DIR, DB_FILE)));
      const owner = await admit(store, OWNER, clock.now());
      const task = await store.createTask({
        ownerId: owner.id,
        type: "reminder",
        title: "stretch",
        config: { text: "stretch" },
        schedule: { kind: "once", at: AT_HOUR },
        lane: "notify",
        capabilities: ["notify"],
        at: clock.now().toISOString(),
      });
      await materialize(store, task, owner, clock.now());
      clock.set(AT_HOUR);
      await plugin.ticks![0]!.run(new AbortController().signal);
      expect(delivery.calls.dm.map((c) => c.message.content)).toEqual([
        "stretch",
        [
          "Your day, Mon Oct 5:",
          "**Due today**",
          `- \`${task.id}\` stretch -- 9:00, not marked done yet`,
          "`/task done` marks a reminder done, `/task decide` answers a renewal, `/task snooze` puts either off; `/tasks` lists everything.",
        ].join("\n"),
      ]);
      // The poll tick sends none.
      await plugin.ticks![1]!.run(new AbortController().signal);
      clock.set("2026-10-05T13:01:00.000Z");
      await plugin.ticks![0]!.run(new AbortController().signal);
      expect(delivery.calls.dm).toHaveLength(2);
      await plugin.dispose!();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
