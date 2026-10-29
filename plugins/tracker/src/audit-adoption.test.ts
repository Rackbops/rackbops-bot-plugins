import { describe, expect, it } from "bun:test";
import { createTask, ScheduleError } from "@rackbops/docket-core";
import { rescheduleKeepingSnoozes, type TrackerDeps } from "./actions.js";
import { TRACKER_TYPES } from "./index.js";
import { admit } from "./people.js";
import { nearPattern, patternRefusal } from "./price.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

/** Adopting docket 0.16's audit fixes (rackbops-bot-plugins#364): the calls the host now makes. */

const AT = "2026-10-01T12:00:00.000Z";

describe("an edit is checked against the task's type (docket#50)", () => {
  it("refuses a poll schedule on a reminder, and accepts one the type takes", async () => {
    const store = new SqliteStore(openDatabase(":memory:"));
    const now = new Date(AT);
    const owner = await admit(store, "100000000000000000", now);
    const type = TRACKER_TYPES.reminder;
    if (!type) throw new Error("no reminder type");
    const { task } = await createTask(
      store,
      { userId: owner.id, admin: owner.admin },
      owner,
      { type, title: "bins out", config: { text: "bins out" }, schedule: { kind: "once", at: "2026-10-02T09:00:00.000Z" } },
      now,
    );
    const d = { store, types: TRACKER_TYPES, clock: { now: () => now } } as unknown as TrackerDeps;
    const poll = { kind: "poll", every: 1, unit: "hour", start: AT } as const;
    await expect(rescheduleKeepingSnoozes(d, task, owner, poll, owner.id)).rejects.toBeInstanceOf(ScheduleError);
    const calendar = { kind: "calendar", every: 1, unit: "day", start: "2026-10-02", hour: 9 } as const;
    await expect(rescheduleKeepingSnoozes(d, task, owner, calendar, owner.id)).resolves.toBeDefined();
  });
});

describe("a price pattern docket-types refuses (docket#45)", () => {
  it("is refused with its message; the pattern built from `near` is taken", () => {
    expect(patternRefusal("(a+)+b")).toStartWith("That `near` text cannot be used: ");
    expect(patternRefusal(nearPattern("Now only ($) ".repeat(7)))).toBeNull();
    expect(patternRefusal(undefined)).toBeNull();
  });
});
