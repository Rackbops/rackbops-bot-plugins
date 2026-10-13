import { describe, expect, it } from "bun:test";
import { nextDue, type Schedule } from "@rackbops/docket-core";
import { reminderSchedule } from "./reminders.js";

/** `/remind`'s schedule as docket runs it (#209, tracker-tasks-11): a monthly one at a month's end and in a clock change's gap. */

const ZONE = "America/New_York";
const ctx = { zone: ZONE, preferredHour: 9 };

function schedule(when: string, repeat: "day" | "week" | "month"): Schedule {
  const s = reminderSchedule(new Date(when), repeat, ZONE, new Date("2026-01-01T00:00:00.000Z"));
  if (typeof s === "string") throw new Error(s);
  return s;
}

/** The next `n` runs after `from`. */
function runs(s: Schedule, from: string, n: number): string[] {
  const out: string[] = [];
  let after = new Date(from);
  for (let i = 0; i < n; i++) {
    const next = nextDue(s, after, ctx);
    if (!next) break;
    out.push(next.toISOString());
    after = next;
  }
  return out;
}

describe("reminderSchedule", () => {
  it("a monthly reminder on the 31st runs on each shorter month's last day, then the 31st again", () => {
    // Sat Jan 31 2026, 9:00 in New York (EST).
    const s = schedule("2026-01-31T14:00:00.000Z", "month");
    expect(s).toEqual({ kind: "calendar", every: 1, unit: "month", start: "2026-01-31", hour: 9, minute: 0, dayOfMonth: 31 });
    expect(runs(s, "2026-01-31T14:00:00.000Z", 3)).toEqual([
      "2026-02-28T14:00:00.000Z",
      "2026-03-31T13:00:00.000Z", // EDT from Mar 8: still 9:00 there
      "2026-04-30T13:00:00.000Z",
    ]);
  });

  it("a monthly reminder whose time falls in the spring-forward gap runs that day, an hour on", () => {
    // Sun Feb 8 2026, 2:30 in New York; Mar 8 has no 2:30 (2:00 EST is 3:00 EDT).
    const s = schedule("2026-02-08T07:30:00.000Z", "month");
    expect(runs(s, "2026-02-08T07:30:00.000Z", 2)).toEqual(["2026-03-08T07:30:00.000Z", "2026-04-08T06:30:00.000Z"]);
  });

  it("a weekly reminder keeps its weekday, written out though docket would take it from the start", () => {
    // Thu Oct 1 2026, 9:00 in New York.
    const s = schedule("2026-10-01T13:00:00.000Z", "week");
    expect(s).toMatchObject({ unit: "week", weekdays: [4] });
    expect(runs(s, "2026-10-01T13:00:00.000Z", 2)).toEqual(["2026-10-08T13:00:00.000Z", "2026-10-15T13:00:00.000Z"]);
  });
});
