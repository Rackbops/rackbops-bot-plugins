import {
  describeSchedule,
  ScheduleError,
  formatInstant,
  hasFired,
  nextDue,
  type Occurrence,
  type PeriodSchedule,
  periodDate,
  type Schedule,
  scheduleProblems,
  SNOOZE_PREFIX,
  type Task,
  type TaskPatch,
  type User,
  wallClock,
} from "@rackbops/docket-core";
import { DEFAULT_BASELINE, DEFAULT_DROP_PERCENT, type PriceConfig, type RenewalConfig } from "@rackbops/docket-types";
import { MAX_TITLE } from "./limits.js";
import {
  clip,
  JOB_OUT_NOTE,
  NO_SUCH_TASK,
  ONCE_JOB_OUT,
  onceJobOutRefusal,
  rescheduleKeepingSnoozes,
  type TaskResult,
  type TrackerDeps,
} from "./actions.js";
import { editable, FINISHED, ownLiveTask } from "./manage.js";
import { reminderPlan, type Repeat, repeatOf } from "./reminders.js";
import { type PriceSettings, priceSettingsPlan, titleFor } from "./price.js";
import { askText, firstAskIfDue, type PeriodUnit, renewalPlan } from "./tracked.js";

/**
 * Editing a task after it is made (rackbops-bot-plugins#80, plan 5.10's task editor), for its owner
 * only, with the rules that made it: `reminderPlan`, `renewalPlan` and `priceSettingsPlan` are the
 * ones `/remind`, `/renewal` and `/price` run. A changed title or config is one `edited` event; a
 * changed schedule goes through `rescheduleKeepingSnoozes` (docket's cancel-and-replace, which
 * records its own `schedule_changed`), exactly as a zone or hour move does. Nothing here changes
 * when nothing was changed. A field left out, or left empty, keeps what the task has (an empty note
 * or price name is the one way to clear it: no note, the page's address). A price's page (`url`, `near`) is not editable: a different page is a
 * different tracker, and its readings would not compare. Each edit runs under the task's lock
 * (locks.ts), so no run of the task fires between docket's cancel and its new schedule.
 */

async function owned(d: TrackerDeps, user: User, taskId: string, type: string): Promise<Task | string> {
  const task = await ownLiveTask(d, user, taskId);
  if (!task || task.type !== type) return NO_SUCH_TASK;
  if (!editable(task)) return FINISHED;
  return task;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Writes a title/config/state change as one update and one `edited` event naming the fields. */
async function applyEdit(d: TrackerDeps, task: Task, user: User, patch: Omit<TaskPatch, "at">): Promise<Task> {
  const fields = Object.keys(patch);
  if (fields.length === 0) return task;
  const at = d.clock.now().toISOString();
  const updated = await d.store.updateTask(task.id, { ...patch, at });
  await d.store.addTaskEvent({ taskId: task.id, actorId: user.id, kind: "edited", detail: fields.join(", "), at });
  return updated;
}

/** The next run still to fire: a queued run that fired and was put back to finish is not one. */
async function nextRun(d: TrackerDeps, task: Task): Promise<Occurrence | null> {
  const queued = await d.store.listOccurrences({ taskId: task.id, status: "queued" });
  return queued.find((o) => !hasFired(o)) ?? null;
}

function savedText(task: Task, user: User, next: Occurrence | null, now: Date, what: string, jobOut = false): string {
  const cadence = task.schedule ? describeSchedule(task.schedule, user, user.timeZone, now) : "no schedule";
  const when = task.status === "paused" ? "paused" : next ? formatInstant(next.dueAt, user.timeZone, now) : "nothing scheduled";
  return clip(`Saved \`${task.id}\` ${what}: ${cadence}. Next: ${when}.${jobOut ? ` ${JOB_OUT_NOTE}` : ""}`);
}

/**
 * docket's `ScheduleError` from a reschedule (a `once` task whose run is with the runner, 0.5.0) as
 * a plain refusal; `onceJobOutRefusal` asks first, so this is the backstop for a run sent out
 * between the two.
 */
async function refusingScheduleError(edit: () => Promise<TaskResult>): Promise<TaskResult> {
  try {
    return await edit();
  } catch (err) {
    if (err instanceof ScheduleError) return { ok: false, error: ONCE_JOB_OUT };
    throw err;
  }
}

/** An edit: every field optional; one left out or empty keeps the task's own. */
export interface ReminderEdit {
  text?: string;
  when?: string;
  repeat?: Repeat;
}

const blank = (v: string | undefined): v is undefined => v === undefined || v.trim() === "";

export function editReminder(d: TrackerDeps, user: User, taskId: string, input: ReminderEdit): Promise<TaskResult> {
  return d.locks.run(taskId.trim(), () => refusingScheduleError(() => editReminderLocked(d, user, taskId, input)));
}

async function editReminderLocked(d: TrackerDeps, user: User, taskId: string, input: ReminderEdit): Promise<TaskResult> {
  const task = await owned(d, user, taskId, "reminder");
  if (typeof task === "string") return { ok: false, error: task };
  const config = (task.config ?? {}) as { text?: string };
  const text = blank(input.text) ? String(config.text ?? "") : input.text;
  const repeat = input.repeat ?? repeatOf(task.schedule);
  const plan = reminderPlan(d, user, { text, repeat, ...(input.when !== undefined ? { when: input.when } : {}) }, task.schedule);
  if (!plan.ok) return plan;
  const moves = !same(plan.schedule, task.schedule);
  // Asked before anything is written, so a refused edit changes nothing.
  const refused = moves ? await onceJobOutRefusal(d, task, plan.schedule) : null;
  if (refused) return { ok: false, error: refused };
  let updated = config.text === plan.text ? task : await applyEdit(d, task, user, { title: clip(plan.text, MAX_TITLE), config: { ...config, text: plan.text } });
  let jobOut = false;
  if (moves) ({ task: updated, jobOut } = await rescheduleKeepingSnoozes(d, updated, user, plan.schedule, user.id));
  return { ok: true, task: updated, text: savedText(updated, user, await nextRun(d, updated), d.clock.now(), "(reminder)", jobOut) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The first period date of `s` on or after `date` (`YYYY-MM-DD`, the owner's zone), or null. */
function periodDateFrom(s: PeriodSchedule, date: string, owner: User): string | null {
  const ctx = { zone: owner.timeZone, preferredHour: owner.preferredHour };
  // An ask comes `leadDays` before its date: start the search a little before the earliest one.
  let after = new Date(Date.parse(`${date}T00:00:00Z`) - ((s.leadDays ?? 0) + 2) * DAY_MS);
  for (let i = 0; i < 1000; i++) {
    const due = nextDue(s, after, ctx);
    if (!due) return null;
    const on = periodDate(s, due, owner.timeZone);
    if (on >= date) return on;
    after = due;
  }
  return null;
}

/**
 * The renewal date the edit form offers: the stored anchor while it is to come, else the next
 * period date from today -- a period date of the schedule as it is, so saving it unchanged keeps
 * the schedule (and its anchor) exactly as it is.
 */
export function renewalDate(task: Task, owner: User, now: Date): string {
  const s = task.schedule;
  if (s?.kind !== "period") return "";
  const w = wallClock(now, owner.timeZone);
  const today = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
  if (s.anchor >= today) return s.anchor;
  return periodDateFrom(s, today, owner) ?? s.anchor;
}

/**
 * Whether a run of the renewal's schedule as it was already asked about `date`: then a new schedule
 * whose first ask about that date is past does not ask it again (the dedupe key alone would not
 * catch a changed lead, which moves the ask's instant).
 */
async function askedAbout(d: TrackerDeps, task: Task, owner: User, date: string): Promise<boolean> {
  const old = task.schedule;
  if (old?.kind !== "period") return false;
  const fired = (await d.store.listOccurrences({ taskId: task.id })).filter((o) => (o.status !== "queued" || hasFired(o)) && !o.dedupeKey.startsWith(SNOOZE_PREFIX));
  return fired.some((o) => periodDate(old, new Date(o.dueAt), owner.timeZone) === date);
}

export interface RenewalEdit {
  name?: string;
  amount?: number;
  currency?: string;
  renews?: string;
  every?: number;
  unit?: PeriodUnit;
  lead?: number;
  /** Left out keeps the note; empty clears it. */
  note?: string;
}

/**
 * A renewal's name, amount, currency, note and schedule. A new amount is what one period costs from
 * now on: it replaces the amount as first entered and, once a decision has recorded one, the amount
 * the type carries between runs (its state), which is the one the next ask quotes. A date that is
 * one of the schedule's own period dates, with the same unit, every and lead, is the schedule as it
 * is: the stored anchor stays, since docket clamps a month's day from the anchor (the 31st would
 * otherwise become the 30th for good). Only a different date re-anchors; a new schedule gets
 * `/renewal`'s first-ask rule (`firstAskIfDue`), but a date already asked about is not asked again.
 */
export function editRenewal(d: TrackerDeps, user: User, taskId: string, input: RenewalEdit): Promise<TaskResult> {
  return d.locks.run(taskId.trim(), () => refusingScheduleError(() => editRenewalLocked(d, user, taskId, input)));
}

async function editRenewalLocked(d: TrackerDeps, user: User, taskId: string, input: RenewalEdit): Promise<TaskResult> {
  const task = await owned(d, user, taskId, "renewal");
  if (typeof task === "string") return { ok: false, error: task };
  if (task.schedule?.kind !== "period") return { ok: false, error: FINISHED };
  const old = task.schedule;
  const now = d.clock.now();
  const config = task.config as RenewalConfig;
  const state = task.state as { amount?: unknown } | null;
  const carried = state && typeof state.amount === "number" ? state.amount : null;
  const note = input.note ?? config.note;
  const plan = renewalPlan(d, user, {
    name: blank(input.name) ? task.title : input.name,
    amount: input.amount ?? carried ?? config.amount,
    currency: blank(input.currency) ? config.currency : input.currency,
    renews: blank(input.renews) ? renewalDate(task, user, now) : input.renews,
    every: input.every ?? old.every,
    unit: input.unit ?? old.unit,
    lead: input.lead ?? old.leadDays ?? 0,
    ...(note !== undefined ? { note } : {}),
  });
  if (!plan.ok) return plan;
  const sameShape = plan.schedule.every === old.every && plan.schedule.unit === old.unit && plan.schedule.leadDays === (old.leadDays ?? 0);
  const schedule: PeriodSchedule = sameShape && periodDateFrom(old, plan.schedule.anchor, user) === plan.schedule.anchor ? old : plan.schedule;
  // Checked before anything is written, so a refused edit changes nothing (docket would throw).
  const problems = scheduleProblems(schedule);
  if (problems.length > 0) return { ok: false, error: `That schedule does not work: ${problems.join("; ")}.` };
  const patch: Omit<TaskPatch, "at"> = {};
  if (plan.name !== task.title) patch.title = plan.name;
  const newAmount = plan.amount !== (carried ?? config.amount);
  const nextConfig: RenewalConfig = { amount: newAmount ? plan.amount : config.amount, currency: plan.currency, ...(plan.note ? { note: plan.note } : {}) };
  if (!same(nextConfig, config)) patch.config = nextConfig;
  if (newAmount && carried !== null) patch.state = { ...state, amount: plan.amount };
  let updated = await applyEdit(d, task, user, patch);
  let next = await nextRun(d, updated);
  let jobOut = false;
  if (!same(schedule, old)) {
    const asked = await askedAbout(d, task, user, schedule.anchor);
    ({ task: updated, jobOut } = await rescheduleKeepingSnoozes(d, updated, user, schedule, user.id));
    next = (asked ? null : await firstAskIfDue(d, updated, user, schedule)) ?? (await nextRun(d, updated));
  }
  const ask = updated.status === "paused" ? "paused" : askText(next, plan.days, user, now);
  const cadence = describeSchedule(schedule, user, user.timeZone, now);
  return { ok: true, task: updated, text: clip(`Saved \`${updated.id}\` (renewal): ${cadence}. Next ask: ${ask}.${jobOut ? ` ${JOB_OUT_NOTE}` : ""}`) };
}

/** A price's name, interval, drop and baseline; the page stays the one it was made for. Left out keeps; an empty name is the page's address. */
export function editPrice(d: TrackerDeps, user: User, taskId: string, input: PriceSettings): Promise<TaskResult> {
  return d.locks.run(taskId.trim(), () => refusingScheduleError(() => editPriceLocked(d, user, taskId, input)));
}

async function editPriceLocked(d: TrackerDeps, user: User, taskId: string, input: PriceSettings): Promise<TaskResult> {
  const task = await owned(d, user, taskId, "price");
  if (typeof task === "string") return { ok: false, error: task };
  const config = task.config as PriceConfig;
  const schedule = task.schedule;
  const plan = priceSettingsPlan({
    name: input.name ?? task.title,
    hours: input.hours ?? (schedule?.kind === "poll" ? schedule.every : undefined),
    drop: input.drop ?? config.dropPercent ?? DEFAULT_DROP_PERCENT,
    baseline: input.baseline ?? config.baseline ?? DEFAULT_BASELINE,
  });
  if (!plan.ok) return plan;
  const patch: Omit<TaskPatch, "at"> = {};
  const title = plan.name || titleFor(config.url);
  if (title !== task.title) patch.title = title;
  const nextConfig: PriceConfig = { ...config, dropPercent: plan.drop, baseline: plan.baseline };
  if (!same(nextConfig, config)) patch.config = nextConfig;
  let updated = await applyEdit(d, task, user, patch);
  let jobOut = false;
  if (schedule?.kind === "poll" && (schedule.every !== plan.hours || schedule.unit !== "hour")) {
    // The grid keeps its start, so the checks stay where they were, only further apart or closer.
    const next: Schedule = { ...schedule, every: plan.hours, unit: "hour" };
    ({ task: updated, jobOut } = await rescheduleKeepingSnoozes(d, updated, user, next, user.id));
  }
  return { ok: true, task: updated, text: savedText(updated, user, await nextRun(d, updated), d.clock.now(), "(price)", jobOut) };
}
