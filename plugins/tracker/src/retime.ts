import { nextDue, type Occurrence, periodDate, type Schedule, scheduledKey, SNOOZE_PREFIX, type Store, type Task, type User, wallClock } from "@rackbops/docket-core";

/**
 * Re-timing a paused task's queued run when its owner's zone or preferred hour moves
 * (rackbops-bot-plugins#80). docket's `reschedule` drops every queued run and materializes the next
 * only for an active task, and a resume materializes from now: a paused task would lose the run it
 * was holding -- a renewal's due ask never sent, a missed daily reminder never fired late. So the
 * held run is put back, once, at the time the same occurrence has under the new zone or hour: the
 * same period date for a `period` schedule, the same local day for a `calendar` one. Resume (the
 * owner's, or delivery's) then finds it queued and it fires once, late, as a paused run does.
 * docket itself is unchanged.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function localDay(at: Date, zone: string): string {
  const w = wallClock(at, zone);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** Which occurrence a due instant is: its period date, or its local day. */
function occurrenceDay(s: Schedule, due: Date, zone: string): string {
  return s.kind === "period" ? periodDate(s, due, zone) : localDay(due, zone);
}

/** The instant the occurrence of `day` has under `owner`'s zone and hour, or null when there is none. */
export function retimed(s: Schedule, day: string, owner: User): Date | null {
  const ctx = { zone: owner.timeZone, preferredHour: owner.preferredHour };
  const lead = s.kind === "period" ? (s.leadDays ?? 0) : 0;
  let after = new Date(Date.parse(`${day}T00:00:00Z`) - (lead + 2) * DAY_MS);
  for (let i = 0; i < 1000; i++) {
    const due = nextDue(s, after, ctx);
    if (!due) return null;
    const on = occurrenceDay(s, due, owner.timeZone);
    if (on === day) return due;
    if (on > day) return null;
    after = due;
  }
  return null;
}

/** The task's queued scheduled runs (not snoozes), read before a reschedule drops them. */
export async function heldRuns(store: Store, task: Task): Promise<Occurrence[]> {
  return (await store.listOccurrences({ taskId: task.id, status: "queued" })).filter((o) => !o.dedupeKey.startsWith(SNOOZE_PREFIX));
}

/**
 * Puts a paused task's held run back after a reschedule, re-timed for `after` (the owner now) from
 * `before` (the owner as they were). One run at most: the earliest one held.
 */
export async function restoreHeldRun(store: Store, task: Task, held: readonly Occurrence[], before: User, after: User, now: Date): Promise<Occurrence | null> {
  const s = task.schedule;
  const first = held[0];
  if (!s || !first) return null;
  const due = retimed(s, occurrenceDay(s, new Date(first.dueAt), before.timeZone), after);
  if (!due) return null;
  return store.createOccurrence({ taskId: task.id, lane: task.lane, dueAt: due.toISOString(), dedupeKey: scheduledKey(task.id, due), at: now.toISOString() });
}
