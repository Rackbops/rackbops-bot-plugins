import { createTask, describeSchedule, formatInstant, parseWhen, wallClock, type Actor, type Schedule, type User } from "@rackbops/docket-core";
import { clip, MAX_TITLE, type Plan, type TaskResult, said, type TrackerDeps } from "./actions.js";

/**
 * Reminders (category 4, plan 1.2): `/remind`'s rules -- the text, the `when`, the repeat -- in one
 * place for the command and the web editor, over docket's `reminder` type. No discord.js.
 */

/** The longest reminder text: it goes out as the DM itself. */
export const MAX_REMINDER_TEXT = 1500;

export const REPEATS = ["none", "day", "week", "month"] as const;
export type Repeat = (typeof REPEATS)[number];

/**
 * The schedule `/remind` asks for, pure. A one-off needs a `when`; a repeating reminder starts on
 * the `when`'s day at its time, or, with no `when`, today at the person's preferred hour.
 */
export function reminderSchedule(when: Date | null, repeat: Repeat, zone: string, now: Date): Schedule | string {
  if (repeat === "none") {
    if (!when) return 'Say when: for example "in 20 minutes", "tomorrow 9am" or "friday at 17:30".';
    return { kind: "once", at: when.toISOString() };
  }
  const w = wallClock(when ?? now, zone);
  const start = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
  const base = { kind: "calendar" as const, every: 1, unit: repeat, start };
  if (!when) return base;
  return {
    ...base,
    hour: w.hour,
    minute: w.minute,
    ...(repeat === "week" ? { weekdays: [w.weekday] } : {}),
    ...(repeat === "month" ? { dayOfMonth: w.day } : {}),
  };
}

/** Which `repeat` a reminder's schedule is: what the web editor shows as chosen. */
export function repeatOf(schedule: Schedule | null): Repeat {
  if (schedule?.kind !== "calendar") return "none";
  return schedule.unit;
}

export interface ReminderInput {
  text: string;
  when?: string;
  repeat: Repeat;
}

/**
 * `/remind`'s rules, for the command and the web editor alike: the text, the `when` (docket's
 * `parseWhen`, in the person's zone) and the repeat, to a text and a schedule. `keep` is an edit's
 * current schedule: with no `when` and the same repeat, it stays as it is.
 */
export function reminderPlan(d: Pick<TrackerDeps, "clock">, user: User, input: ReminderInput, keep?: Schedule | null): Plan<{ text: string; schedule: Schedule }> {
  const text = input.text.trim();
  if (text.length === 0) return { ok: false, error: "Say what to remind you of." };
  if (text.length > MAX_REMINDER_TEXT) return { ok: false, error: `That reminder is longer than ${MAX_REMINDER_TEXT} characters.` };
  if (!(REPEATS as readonly string[]).includes(input.repeat)) return { ok: false, error: "`repeat` is once, daily, weekly or monthly." };
  const now = d.clock.now();
  let when: Date | null = null;
  if (input.when !== undefined && input.when.trim() !== "") {
    const parsed = parseWhen(input.when, now, { zone: user.timeZone, defaultHour: user.preferredHour });
    if (!parsed.ok) return { ok: false, error: parsed.error };
    when = parsed.at;
  }
  if (when === null && keep && repeatOf(keep) === input.repeat) return { ok: true, text, schedule: keep };
  const schedule = reminderSchedule(when, input.repeat, user.timeZone, now);
  if (typeof schedule === "string") return { ok: false, error: schedule };
  return { ok: true, text, schedule };
}

/** `/remind text [when] [repeat]` (category 4, plan 1.2): docket's `reminder` type. */
export async function createReminder(d: TrackerDeps, user: User, input: ReminderInput): Promise<TaskResult> {
  const type = d.types.reminder;
  if (!type) return { ok: false, error: "Reminders are not available on this bot." };
  const plan = reminderPlan(d, user, input);
  if (!plan.ok) return plan;
  const { text, schedule } = plan;
  const now = d.clock.now();
  const actor: Actor = { userId: user.id, admin: user.admin };
  const { task, next } = await createTask(d.store, actor, user, { type, title: clip(text, MAX_TITLE), config: { text }, schedule }, now);
  const at = next ? formatInstant(next.dueAt, user.timeZone, now) : "never (that time has no next run)";
  const cadence = schedule.kind === "once" ? "" : `, ${describeSchedule(schedule, user, user.timeZone, now)}`;
  return { ok: true, task, text: clip(`Reminder \`${task.id}\` set: ${text}\nNext: ${at}${cadence}.`) };
}

export async function remind(d: TrackerDeps, user: User, input: ReminderInput): Promise<string> {
  return said(await createReminder(d, user, input));
}
