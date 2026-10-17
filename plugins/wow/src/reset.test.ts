import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "./config.js";
import { lastWeeklyReset, nextDailyReset, nextWeeklyReset } from "./reset.js";

// Fixed instants, written out by hand, so the table is checked against the calendar and not against the
// code under test: 2026-09-15 is a Tuesday, 2026-09-16 a Wednesday.
const iso = (d: Date) => d.toISOString();
let savedRegion: typeof config.region;
beforeEach(() => {
  savedRegion = config.region;
});
afterEach(() => {
  config.region = savedRegion;
});

describe("US resets: daily 15:00 UTC, weekly Tuesday 15:00 UTC", () => {
  beforeEach(() => {
    config.region = "us";
  });

  test("nextDailyReset: before the hour is today, the exact instant and after are tomorrow", () => {
    expect(iso(nextDailyReset(new Date("2026-09-15T14:59:59.999Z")))).toBe("2026-09-15T15:00:00.000Z");
    expect(iso(nextDailyReset(new Date("2026-09-15T15:00:00.000Z")))).toBe("2026-09-16T15:00:00.000Z"); // mutation: `<` instead of `<=`
    expect(iso(nextDailyReset(new Date("2026-09-15T15:00:00.001Z")))).toBe("2026-09-16T15:00:00.000Z");
  });

  test("nextDailyReset rolls over a month and a year end", () => {
    expect(iso(nextDailyReset(new Date("2026-09-30T20:00:00Z")))).toBe("2026-10-01T15:00:00.000Z");
    expect(iso(nextDailyReset(new Date("2026-12-31T20:00:00Z")))).toBe("2027-01-01T15:00:00.000Z");
  });

  test("nextWeeklyReset: the Tuesday before the hour is that day, the exact instant and after are a week on", () => {
    expect(iso(nextWeeklyReset(new Date("2026-09-15T14:59:59.999Z")))).toBe("2026-09-15T15:00:00.000Z");
    expect(iso(nextWeeklyReset(new Date("2026-09-15T15:00:00.000Z")))).toBe("2026-09-22T15:00:00.000Z"); // mutation: `<` or 6 days
    expect(iso(nextWeeklyReset(new Date("2026-09-15T15:00:00.001Z")))).toBe("2026-09-22T15:00:00.000Z");
  });

  test("nextWeeklyReset from other weekdays lands on the following Tuesday", () => {
    expect(iso(nextWeeklyReset(new Date("2026-09-16T00:00:00Z")))).toBe("2026-09-22T15:00:00.000Z"); // Wednesday
    expect(iso(nextWeeklyReset(new Date("2026-09-20T23:00:00Z")))).toBe("2026-09-22T15:00:00.000Z"); // Sunday
    expect(iso(nextWeeklyReset(new Date("2026-09-14T23:00:00Z")))).toBe("2026-09-15T15:00:00.000Z"); // Monday
  });

  test("lastWeeklyReset is the reset itself at the exact instant and the previous one just before", () => {
    expect(iso(lastWeeklyReset(new Date("2026-09-15T15:00:00.000Z")))).toBe("2026-09-15T15:00:00.000Z");
    expect(iso(lastWeeklyReset(new Date("2026-09-15T14:59:59.999Z")))).toBe("2026-09-08T15:00:00.000Z");
    expect(iso(lastWeeklyReset(new Date("2026-09-17T09:00:00Z")))).toBe("2026-09-15T15:00:00.000Z");
  });
});

describe("EU resets: daily 04:00 UTC, weekly Wednesday 04:00 UTC", () => {
  beforeEach(() => {
    config.region = "eu";
  });

  test("nextDailyReset boundary", () => {
    expect(iso(nextDailyReset(new Date("2026-09-16T03:59:59.999Z")))).toBe("2026-09-16T04:00:00.000Z");
    expect(iso(nextDailyReset(new Date("2026-09-16T04:00:00.000Z")))).toBe("2026-09-17T04:00:00.000Z");
  });

  test("nextWeeklyReset boundary and weekday", () => {
    expect(iso(nextWeeklyReset(new Date("2026-09-16T03:59:59.999Z")))).toBe("2026-09-16T04:00:00.000Z");
    expect(iso(nextWeeklyReset(new Date("2026-09-16T04:00:00.000Z")))).toBe("2026-09-23T04:00:00.000Z");
    expect(iso(nextWeeklyReset(new Date("2026-09-15T20:00:00Z")))).toBe("2026-09-16T04:00:00.000Z"); // the US Tuesday is not the EU reset
  });

  test("lastWeeklyReset", () => {
    expect(iso(lastWeeklyReset(new Date("2026-09-16T04:00:00.000Z")))).toBe("2026-09-16T04:00:00.000Z");
    expect(iso(lastWeeklyReset(new Date("2026-09-16T03:59:59.999Z")))).toBe("2026-09-09T04:00:00.000Z");
  });
});
