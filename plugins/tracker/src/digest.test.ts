import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Lanes, materialize, type Clock, type Schedule, type User } from "@rackbops/docket-core";
import { makeFakeDelivery, makeFakeHost } from "../../../packages/testkit/index.js";
import type { HostApi, HostMessage } from "../../../packages/api/contract.js";
import { DeliveryHealth } from "./delivery-health.js";
import { collectDigest, digestKey, type DigestItem, formatDigest, localDay, MAX_LINES, runDigests } from "./digest.js";
import { createPlugin, DB_DIR, DB_FILE, TRACKER_TYPES } from "./index.js";
import { createDmNotifier, HOST_CANNOT_MESSAGE, MAX_CONTENT, wrapBareUrls } from "./notifier.js";
import { runNotifyTick } from "./notify-lane.js";
import { admit, setPreferences } from "./people.js";
import { Roster } from "./roster.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";
import { removeDir } from "./test-dirs.js";

// Mon 2026-10-05 in New York is UTC-4: 9:00 there is 13:00Z.
const BEFORE_HOUR = "2026-10-05T12:59:00.000Z";
const AT_HOUR = "2026-10-05T13:00:00.000Z";
const OWNER = "111111111111111111";
const FRIEND = "222222222222222222";
const FOOTER = "`/task done` marks a reminder done, `/task decide` answers a renewal, `/task snooze` puts either off; `/tasks` lists everything.";
// Sat 2026-10-03, 9:30 in New York: every renewal of `longDay` has been asked.
const ASKED = "2026-10-03T13:30:00.000Z";

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

/**
 * A day past one message (#211), made by `make`: twelve renewals asked on the morning of Sat Oct 3,
 * overdue on Mon Oct 5 once they fire (at `ASKED`), and twelve reminders due that Monday evening.
 * Every title is 100 characters, so each is cut to 80 in its line; `reminderTitle` sets the reminders'.
 */
async function longDay(
  make: (title: string, schedule: Schedule, type: string, config: unknown) => Promise<unknown>,
  reminderTitle = (i: number) => `reminder ${i} `.padEnd(100, "m"),
): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await make(`renewal ${i} `.padEnd(100, "r"), { kind: "once", at: `2026-10-03T13:${10 + i}:00.000Z` }, "renewal", { amount: 9.99, currency: "USD", renews: "2026-10-10", lead: 7 });
  }
  for (let i = 0; i < 12; i++) await make(reminderTitle(i), { kind: "once", at: `2026-10-05T22:${10 + i}:00.000Z` }, "reminder", { text: reminderTitle(i) });
}

/** The `- \`id\`` lines a digest shows in each section. */
function shownLines(text: string): { overdue: string[]; today: string[] } {
  const lines = text.split("\n");
  const split = lines.indexOf("**Due today**");
  const item = (l: string) => l.startsWith("- `");
  return { overdue: lines.slice(0, split).filter(item), today: lines.slice(split).filter(item) };
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

  it("sends no second digest within 20 hours after a move east; the next goes at the following local day's hour (#211 notify-5)", async () => {
    const s = await setup();
    await s.make("pay rent", { kind: "once", at: "2026-10-03T13:00:00.000Z" });
    s.clock.set("2026-10-03T13:00:00.000Z");
    await s.tick();
    s.calls.length = 0;
    // 9:00 Mon Oct 5 in New York.
    s.clock.set(AT_HOUR);
    expect(await s.digests()).toEqual({ claimed: 1, sent: 1, failed: 0 });
    // That evening Maria moves to Tokyo, where 00:00Z is already 9:00 on Tue Oct 6: 11 hours on.
    await setPreferences(s.store, s.owner.id, { timeZone: "Asia/Tokyo", preferredHour: 9 });
    s.clock.set("2026-10-06T00:00:00.000Z");
    expect(await s.digests()).toEqual({ claimed: 0, sent: 0, failed: 0 });
    // 18:00 in Tokyo, 20 hours after the last: the day stays passed over, or every later one would come at 18:00.
    s.clock.set("2026-10-06T09:00:00.000Z");
    expect(await s.digests()).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(s.calls).toHaveLength(1);
    // 9:00 Wed Oct 7 in Tokyo.
    s.clock.set("2026-10-07T00:00:00.000Z");
    expect(await s.digests()).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(s.calls[1]?.message.content).toStartWith("Your day, Wed Oct 7:");
    expect(s.db.query("SELECT key, at FROM notices ORDER BY at").all()).toEqual([
      { key: digestKey(s.owner.id, "2026-10-05"), at: AT_HOUR },
      { key: digestKey(s.owner.id, "2026-10-07"), at: "2026-10-07T00:00:00.000Z" },
    ]);
  });

  it("sends every day at the hour across both clock changes, and after a late one (#211 notify-5)", async () => {
    const s = await setup();
    await s.make("pay rent", { kind: "once", at: "2026-10-03T13:00:00.000Z" });
    s.clock.set("2026-10-03T13:00:00.000Z");
    await s.tick();
    s.calls.length = 0;
    // 9:00 in New York, on either side of the fall back (Sun Nov 1) and the spring forward (Sun Mar 14 2027):
    // 25 and 23 hours apart.
    const hours = [
      "2026-10-31T13:00:00.000Z",
      "2026-11-01T14:00:00.000Z",
      "2026-11-02T14:00:00.000Z",
      "2027-03-13T14:00:00.000Z",
      "2027-03-14T13:00:00.000Z",
      "2027-03-15T13:00:00.000Z",
    ];
    for (const at of hours) {
      s.clock.set(at);
      expect(await s.digests()).toEqual({ claimed: 1, sent: 1, failed: 0 });
    }
    // The bot was down at the hour on Tue Mar 16 and sent it at 23:00; Wednesday's still goes at 9:00,
    // 10 hours after that send: the gap is between the hours the digests were due.
    s.clock.set("2027-03-17T03:00:00.000Z");
    expect((await s.digests()).sent).toBe(1);
    s.clock.set("2027-03-17T13:00:00.000Z");
    expect((await s.digests()).sent).toBe(1);
    expect(s.calls).toHaveLength(hours.length + 2);
  });

  it("the gap is 20 hours: a due hour 19 hours after the last claim is passed over, one 21 hours after is sent (#211 notify-5)", async () => {
    for (const [preferredHour, sent] of [[4, 0], [6, 1]] as const) {
      const s = await setup();
      s.clock.set(AT_HOUR);
      await s.digests();
      // 9:00 New York on Oct 5 was 13:00Z; the hour moves earlier for Tue Oct 6.
      await setPreferences(s.store, s.owner.id, { timeZone: "America/New_York", preferredHour });
      await s.make("call mom", { kind: "once", at: "2026-10-06T22:00:00.000Z" });
      // 4:00 is 08:00Z (19 hours on), 6:00 is 10:00Z (21 hours on); 20:00Z is later the same day.
      for (const at of [`2026-10-06T${String(preferredHour + 4).padStart(2, "0")}:00:00.000Z`, "2026-10-06T20:00:00.000Z"]) {
        s.clock.set(at);
        await s.digests();
      }
      expect(s.calls).toHaveLength(sent);
    }
  });

  it("dates a claim at the first pass of an hour a fall-back repeats, so the rest of that hour writes nothing (#211 notify-5)", async () => {
    const s = await setup();
    // London falls back on Sun 2026-10-25: 1:00 comes at 00:00Z (BST) and again at 01:00Z (GMT), and
    // docket 0.16 resolves the due hour to the first pass (00:00Z); the claim is never dated after now.
    await setPreferences(s.store, s.owner.id, { timeZone: "Europe/London", preferredHour: 1 });
    const claims: string[] = [];
    const claimNotice = s.store.claimNotice.bind(s.store);
    s.store.claimNotice = (key, at) => (claims.push(key), claimNotice(key, at));
    s.clock.set("2026-10-25T00:30:00.000Z");
    expect((await s.digests()).claimed).toBe(1);
    expect(s.db.query("SELECT at FROM notices").all()).toEqual([{ at: "2026-10-25T00:00:00.000Z" }]);
    s.clock.set("2026-10-25T00:45:00.000Z");
    expect(await s.digests()).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(claims).toEqual([digestKey(s.owner.id, "2026-10-25")]);
  });

  it("a last claim dated in the future (a clock that ran ahead) holds nothing back (#211 notify-5)", async () => {
    const s = await setup();
    await s.make("call mom", { kind: "once", at: "2026-10-05T22:00:00.000Z" });
    await s.store.claimNotice(digestKey(s.owner.id, "2026-12-01"), "2026-12-01T14:00:00.000Z");
    s.clock.set(AT_HOUR);
    expect(await s.digests()).toEqual({ claimed: 1, sent: 1, failed: 0 });
  });

  it("writes no claim on later ticks once the day is claimed, nor on a day passed over (#211 notify-5)", async () => {
    const s = await setup();
    const claims: string[] = [];
    const claimNotice = s.store.claimNotice.bind(s.store);
    s.store.claimNotice = (key, at) => (claims.push(key), claimNotice(key, at));
    s.clock.set(AT_HOUR);
    expect((await s.digests()).claimed).toBe(1);
    for (const at of ["2026-10-05T13:01:00.000Z", "2026-10-05T18:00:00.000Z", "2026-10-06T03:59:00.000Z"]) {
      s.clock.set(at);
      expect(await s.digests()).toEqual({ claimed: 0, sent: 0, failed: 0 });
    }
    await setPreferences(s.store, s.owner.id, { timeZone: "Asia/Tokyo", preferredHour: 9 });
    s.clock.set("2026-10-06T00:00:00.000Z");
    await s.digests();
    expect(claims).toEqual([digestKey(s.owner.id, "2026-10-05")]);
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

  it("a digest to a closed DM counts toward the person's pause (#212)", async () => {
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
    const { dm } = fakeDm(() => new Error(HOST_CANNOT_MESSAGE));
    const { log } = quietLog();
    const health = new DeliveryHealth(db, store);
    const notifier = createDmNotifier({ store, dm, clock, log, health });
    clock.set(AT_HOUR);
    expect(await runDigests({ store, notifier, log, health }, clock.now())).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(health.get(owner.id)?.failures).toBe(1);
  });

  it("a zone or hour changed after the day's digest went sends no second one that day (#212)", async () => {
    const s = await setup();
    await s.make("call mom", { kind: "once", at: "2026-10-05T22:00:00.000Z" });
    s.clock.set(AT_HOUR);
    expect((await s.digests()).sent).toBe(1);
    // A later hour: the day is already claimed.
    await setPreferences(s.store, s.owner.id, { preferredHour: 11 });
    s.clock.set("2026-10-05T15:00:00.000Z");
    expect(await s.digests()).toEqual({ claimed: 0, sent: 0, failed: 0 });
    // A zone to the west, where it is still Mon Oct 5 and past the hour: the same day, still claimed.
    await setPreferences(s.store, s.owner.id, { timeZone: "America/Los_Angeles", preferredHour: 7 });
    expect(await s.digests()).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(s.calls).toHaveLength(1);
  });

  it("passes by a person whose stored zone the clock cannot read, logged, and goes on to the next (#212)", async () => {
    const s = await setup();
    const friend = await admit(s.store, FRIEND, s.clock.now());
    await s.make("call mom", { kind: "once", at: "2026-10-05T22:00:00.000Z" }, friend);
    s.db.query("UPDATE users SET time_zone = 'Not/AZone' WHERE discord_id = ?").run(OWNER);
    s.clock.set(AT_HOUR);
    expect(await s.digests()).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(s.calls.map((c) => c.userId)).toEqual([FRIEND]);
    expect(s.warnings.some((w) => w.includes(`digest: ${s.owner.id} has a time zone the clock cannot read`))).toBe(true);
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

  /** `longDay` with its renewals asked, and what it lists on Mon Oct 5. */
  async function longDigest(reminderTitle?: (i: number) => string) {
    const s = await setup();
    await longDay((title, schedule, type, config) => s.make(title, schedule, s.owner, type, config), reminderTitle);
    s.clock.set(ASKED);
    await s.tick();
    const { start, end } = localDay(new Date(AT_HOUR), s.owner.timeZone);
    return { s, digest: await collectDigest(s.store, s.owner, start, end) };
  }

  it("a digest past one message shows the same number of lines in each section, as many as fit, and keeps Due today, the footer and both counts", async () => {
    const { s, digest } = await longDigest();
    expect([digest.overdue.length, digest.today.length]).toEqual([12, 12]);
    const text = formatDigest(digest, s.owner, new Date(AT_HOUR)) ?? "";
    expect(wrapBareUrls(text).length).toBeLessThanOrEqual(MAX_CONTENT);
    const { overdue, today } = shownLines(text);
    const k = overdue.length;
    expect(k).toBeGreaterThanOrEqual(1);
    expect(today).toHaveLength(k);
    const lines = text.split("\n");
    expect(lines.slice(0, 2)).toEqual(["Your day, Mon Oct 5:", "**Overdue**"]);
    expect(lines.slice(k + 2, k + 4)).toEqual([`- and ${12 - k} more`, "**Due today**"]);
    expect(lines.slice(-2)).toEqual([`- and ${12 - k} more`, FOOTER]);
    // As many as fit: one more line in each section would not.
    const longest = (shown: string[]) => Math.max(...shown.map((l) => l.length));
    expect(text.length + longest(overdue) + longest(today) + 2).toBeGreaterThan(MAX_CONTENT);
    // Nothing is cut: a cut title's own "..." is inside its line, and no line ends in one.
    expect(overdue[0]).toContain("... -- asked Sat Oct 3, 9:10,");
    expect(lines.filter((l) => l.endsWith("..."))).toEqual([]);
  });

  it("a title with a bare link counts the host's wrapping", async () => {
    // Every reminder's title is a bare link, two characters longer once the host wraps it. The first
    // one's length sets the wrapped text with eight lines a section: 2000 characters at 29, 2001 at 30.
    const linked = (first: number) => longDigest((i) => `https://shop.example/${i}/`.padEnd(i === 0 ? first : 54, "m"));
    // Exactly MAX_CONTENT once wrapped fits: eight lines a section.
    const exact = await linked(29);
    const fits = formatDigest(exact.digest, exact.s.owner, new Date(AT_HOUR)) ?? "";
    expect(wrapBareUrls(fits).length).toBe(MAX_CONTENT);
    expect(shownLines(fits).overdue).toHaveLength(8);
    expect(shownLines(fits).today).toHaveLength(8);
    // One character more does not: seven lines a section.
    const { s, digest } = await linked(30);
    const text = formatDigest(digest, s.owner, new Date(AT_HOUR)) ?? "";
    expect(wrapBareUrls(text).length).toBeLessThanOrEqual(MAX_CONTENT);
    expect(shownLines(text).overdue).toHaveLength(7);
    expect(shownLines(text).today).toHaveLength(7);
    // The same digest with no link ("hxxps" is the same length) shows eight; with the links back, that
    // text fits by its plain length and is one over once they are wrapped.
    const unlink = (i: DigestItem) => ({ ...i, task: { ...i.task, title: i.task.title.replace("https://", "hxxps://") } });
    const oneMore = (formatDigest({ overdue: digest.overdue, today: digest.today.map(unlink) }, s.owner, new Date(AT_HOUR)) ?? "").replaceAll("hxxps://", "https://");
    expect(oneMore.length).toBeLessThanOrEqual(MAX_CONTENT);
    expect(wrapBareUrls(oneMore).length).toBe(MAX_CONTENT + 1);
    expect(shownLines(oneMore).overdue).toHaveLength(8);
    expect(shownLines(oneMore).today).toHaveLength(8);
  });

  it("a section that can show no line counts them all, and an empty section leaves the other the full cap", async () => {
    // Only a stand-in id this long reaches the case: with titles cut to 80 and the store's own ids,
    // one line in each section comes to about 590 characters at most.
    const { s, digest } = await longDigest();
    const long = (i: DigestItem) => ({ ...i, task: { ...i.task, id: "9".repeat(MAX_CONTENT) } });
    expect(formatDigest({ overdue: digest.overdue.map(long), today: digest.today.map(long) }, s.owner, new Date(AT_HOUR))).toBe(
      ["Your day, Mon Oct 5:", "**Overdue**", "- 12 in all", "**Due today**", "- 12 in all", FOOTER].join("\n"),
    );
    // The twelve overdue alone, nothing due today: all ten lines fit, and only the rest is counted.
    const asked = (i: number) => `- \`t${i + 1}\` ${`renewal ${i} `.padEnd(77, "r")}... -- asked Sat Oct 3, 9:${10 + i}, waiting on your keep, cancel or renewed`;
    expect(formatDigest({ overdue: digest.overdue, today: [] }, s.owner, new Date(AT_HOUR))).toBe(
      ["Your day, Mon Oct 5:", "**Overdue**", ...Array.from({ length: MAX_LINES }, (_, i) => asked(i)), "- and 2 more", FOOTER].join("\n"),
    );
  });

  it("a section with no more items than the cap shows them all, with no count", async () => {
    // Seven overdue and twelve due today: seven lines a section is the most that fits, all of Overdue.
    const { s, digest } = await longDigest();
    const text = formatDigest({ overdue: digest.overdue.slice(0, 7), today: digest.today }, s.owner, new Date(AT_HOUR)) ?? "";
    expect(shownLines(text).overdue).toHaveLength(7);
    expect(shownLines(text).today).toHaveLength(7);
    const lines = text.split("\n");
    expect(lines[9]).toBe("**Due today**");
    expect(lines.filter((l) => l.startsWith("- and "))).toEqual(["- and 5 more"]);
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
    // The plugin and a second connection to its file, closed before the directory goes: Windows
    // refuses to delete an open file (#232).
    let plugin: ReturnType<typeof createPlugin> | null = null;
    let db: Database | null = null;
    try {
      const clock = fakeClock("2026-10-05T10:00:00.000Z");
      const delivery = makeFakeDelivery();
      plugin = createPlugin(makeFakeHost({ name: "tracker", dataDir, env: { TRACKER_ADMIN_DISCORD_IDS: OWNER }, ...delivery }), { clock });
      await plugin.activate!();
      db = openDatabase(join(dataDir, DB_DIR, DB_FILE));
      const store = new SqliteStore(db);
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
    } finally {
      await plugin?.dispose?.();
      db?.close();
      removeDir(dataDir);
    }
  });

  it("sends a digest past one message whole: Due today, both counts and the footer, nothing cut (#211)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tracker-digest-"));
    try {
      const clock = fakeClock("2026-10-03T12:00:00.000Z");
      const delivery = makeFakeDelivery();
      const plugin = createPlugin(makeFakeHost({ name: "tracker", dataDir, env: { TRACKER_ADMIN_DISCORD_IDS: OWNER }, ...delivery }), { clock });
      await plugin.activate!();
      const store = new SqliteStore(openDatabase(join(dataDir, DB_DIR, DB_FILE)));
      const owner = await admit(store, OWNER, clock.now());
      await longDay(async (title, schedule, type, config) => {
        const task = await store.createTask({ ownerId: owner.id, type, title, config, schedule, lane: "notify", capabilities: ["notify"], at: clock.now().toISOString() });
        await materialize(store, task, owner, clock.now());
      });
      clock.set(ASKED);
      await plugin.ticks![0]!.run(new AbortController().signal);
      clock.set(AT_HOUR);
      await plugin.ticks![0]!.run(new AbortController().signal);
      const sent = delivery.calls.dm.at(-1)?.message.content ?? "";
      expect(sent).toStartWith("Your day, Mon Oct 5:\n**Overdue**\n");
      expect(sent).toContain("\n**Due today**\n");
      expect(sent.match(/^- and \d+ more$/gm)).toHaveLength(2);
      expect(sent).toEndWith(`\n${FOOTER}`);
      expect(sent).not.toEndWith("...");
      await plugin.dispose!();
    } finally {
      removeDir(dataDir);
    }
  });
});
