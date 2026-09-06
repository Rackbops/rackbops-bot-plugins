import { config } from "./config.js";

// The Darkmoon Faire opens at 00:01 realm time on the first Sunday of each
// month and runs for one week. Realm time is modeled by config.dmfTimezone.
export interface DmfWindow {
  // The calendar month this window was computed for (0-indexed) -- distinct from `start`'s
  // UTC year/month, which for an ahead-of-UTC timezone can land in the *previous* UTC month
  // (see dmfKey's gotcha).
  year: number;
  monthIndex: number;
  start: Date;
  end: Date;
}

// Wall-clock parts of `date` as seen in timezone `tz`.
function wallClock(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year!, mo: +p.month! - 1, d: +p.day!, h: +p.hour!, mi: +p.minute! };
}

// UTC instant for a wall-clock time in an IANA timezone (two-pass DST correction).
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const target = Date.UTC(y, mo, d, h, mi);
  let ts = target;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(ts), tz);
    ts += target - Date.UTC(w.y, w.mo, w.d, w.h, w.mi);
  }
  return new Date(ts);
}

// `tz` defaults to config.dmfTimezone but is a real parameter (not just a module read) so
// callers -- notably tests -- can exercise a region without fighting the config singleton
// (the plugin resolves config from host.env once via initWowConfig; passing tz avoids leaning on it).
export function dmfWindow(
  year: number,
  monthIndex: number,
  tz: string = config.dmfTimezone,
): DmfWindow {
  let day = 1;
  while (new Date(Date.UTC(year, monthIndex, day)).getUTCDay() !== 0) day++;
  const start = zonedToUtc(year, monthIndex, day, 0, 1, tz);
  // Computed independently from `start` (not `start + 7 days`) so a DST transition inside the
  // window is reflected in realm-local terms rather than baked in as a fixed UTC offset.
  const end = zonedToUtc(year, monthIndex, day + 7, 0, 1, tz);
  // currentOrNextDmf calls this with monthIndex=12 for "next January" etc. -- Date.UTC normalizes
  // that for `start`/`end`, but the raw `year`/`monthIndex` params must be normalized separately,
  // or dmfKey produces a non-canonical key (e.g. "2033-13") that mismatches the same window's key
  // once `now` rolls into the new year and this function is called with already-canonical inputs.
  const canonical = new Date(Date.UTC(year, monthIndex, 1));
  return { year: canonical.getUTCFullYear(), monthIndex: canonical.getUTCMonth(), start, end };
}

// Picks whichever of "this UTC month" or "next UTC month"'s calendar-month window actually
// contains `now`. Checking only "this month" would miss the case where next month's window has
// already opened before UTC midnight (ahead-of-UTC realm timezones, e.g. EU) -- see dmfKey.
export function currentOrNextDmf(
  now = new Date(),
  tz: string = config.dmfTimezone,
): { active: boolean; window: DmfWindow } {
  const candidates = [
    dmfWindow(now.getUTCFullYear(), now.getUTCMonth(), tz),
    dmfWindow(now.getUTCFullYear(), now.getUTCMonth() + 1, tz),
  ];
  for (const window of candidates) {
    if (now < window.end) return { active: now >= window.start, window };
  }
  return { active: false, window: candidates[1]! };
}

// The dedup key for a window: keyed on the calendar month it was computed for, never on
// `start`'s UTC year/month. An ahead-of-UTC realm timezone (EU) can open a month's window
// before UTC midnight of the *previous* month whenever that month's 1st is a Sunday -- keying
// on `start`'s UTC parts then collides with the previous month's key and the Faire silently
// never announces (issue #36).
export function dmfKey(window: DmfWindow): string {
  return `${window.year}-${window.monthIndex + 1}`;
}

// Pure decision: is there a new Darkmoon Faire to announce right now? Mirrors
// decideRealmTransition/decideReleaseAnnouncements so announce.ts stays a thin wrapper.
export function decideDmfAnnouncement(
  now: Date,
  announcedFor: string | undefined,
  tz: string = config.dmfTimezone,
): { key: string; window: DmfWindow } | null {
  const { active, window } = currentOrNextDmf(now, tz);
  if (!active) return null;
  const key = dmfKey(window);
  if (key === announcedFor) return null;
  return { key, window };
}
