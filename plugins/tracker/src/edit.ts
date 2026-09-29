import { describeSchedule, formatInstant, periodDate, scheduleProblems, SNOOZE_PREFIX, type Occurrence, type Schedule, type Task, type TaskPatch, type User } from "@rackbops/docket-core";
import type { PriceConfig, RenewalConfig } from "@rackbops/docket-types";
import { clip, MAX_TITLE, NO_SUCH_TASK, rescheduleKeepingSnoozes, type TaskResult, type TrackerDeps } from "./actions.js";
import { editable, FINISHED, ownLiveTask } from "./manage.js";
import { reminderPlan, type ReminderInput } from "./reminders.js";
import { type PriceSettings, priceSettingsPlan, titleFor } from "./price.js";
import { askText, firstAskIfDue, renewalPlan, type RenewalInput } from "./tracked.js";

/**
 * Editing a task after it is made (rackbops-bot-plugins#80, plan 5.10's task editor), for its owner
 * only, with the rules that made it: `reminderPlan`, `renewalPlan` and `priceSettingsPlan` are the
 * ones `/remind`, `/renewal` and `/price` run. A changed title or config is one `edited` event; a
 * changed schedule goes through `rescheduleKeepingSnoozes` (docket's cancel-and-replace, which
 * records its own `schedule_changed`), exactly as a zone or hour move does. Nothing here changes
 * when nothing was changed. A price's page (`url`, `near`) is not editable: a different page is a
 * different tracker, and its readings would not compare.
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

async function nextRun(d: TrackerDeps, task: Task): Promise<Occurrence | null> {
  const queued = await d.store.listOccurrences({ taskId: task.id, status: "queued" });
  return queued[0] ?? null;
}

function savedText(task: Task, user: User, next: Occurrence | null, now: Date, what: string): string {
  const cadence = task.schedule ? describeSchedule(task.schedule, user, user.timeZone, now) : "no schedule";
  const when = task.status === "paused" ? "paused" : next ? formatInstant(next.dueAt, user.timeZone, now) : "nothing scheduled";
  return clip(`Saved \`${task.id}\` ${what}: ${cadence}. Next: ${when}.`);
}

export async function editReminder(d: TrackerDeps, user: User, taskId: string, input: ReminderInput): Promise<TaskResult> {
  const task = await owned(d, user, taskId, "reminder");
  if (typeof task === "string") return { ok: false, error: task };
  const plan = reminderPlan(d, user, input, task.schedule);
  if (!plan.ok) return plan;
  const config = (task.config ?? {}) as { text?: string };
  let updated = config.text === plan.text ? task : await applyEdit(d, task, user, { title: clip(plan.text, MAX_TITLE), config: { ...config, text: plan.text } });
  if (!same(plan.schedule, task.schedule)) updated = await rescheduleKeepingSnoozes(d, updated, user, plan.schedule, user.id);
  return { ok: true, task: updated, text: savedText(updated, user, await nextRun(d, updated), d.clock.now(), "(reminder)") };
}

/**
 * Whether a run of the renewal's schedule as it was already asked about `date`: then a new schedule
 * whose first ask about that date is past does not ask it again (the dedupe key alone would not
 * catch a changed lead, which moves the ask's instant).
 */
async function askedAbout(d: TrackerDeps, task: Task, owner: User, date: string): Promise<boolean> {
  const old = task.schedule;
  if (old?.kind !== "period") return false;
  const fired = (await d.store.listOccurrences({ taskId: task.id })).filter((o) => o.status !== "queued" && !o.dedupeKey.startsWith(SNOOZE_PREFIX));
  return fired.some((o) => periodDate(old, new Date(o.dueAt), owner.timeZone) === date);
}

/**
 * A renewal's name, amount, currency, note and schedule. A new amount is what one period costs from
 * now on: it replaces the amount as first entered and, once a decision has recorded one, the amount
 * the type carries between runs (its state), which is the one the next ask quotes. A new schedule
 * gets the same first-ask rule as `/renewal` (`firstAskIfDue`); an ask already made is not repeated.
 */
export async function editRenewal(d: TrackerDeps, user: User, taskId: string, input: RenewalInput): Promise<TaskResult> {
  const task = await owned(d, user, taskId, "renewal");
  if (typeof task === "string") return { ok: false, error: task };
  const plan = renewalPlan(d, user, input);
  if (!plan.ok) return plan;
  // Checked before anything is written, so a refused edit changes nothing (docket would throw).
  const problems = scheduleProblems(plan.schedule);
  if (problems.length > 0) return { ok: false, error: `That schedule does not work: ${problems.join("; ")}.` };
  const config = task.config as RenewalConfig;
  const state = task.state as { amount?: unknown } | null;
  const patch: Omit<TaskPatch, "at"> = {};
  if (plan.name !== task.title) patch.title = plan.name;
  const carried = state && typeof state.amount === "number" ? state.amount : null;
  const newAmount = plan.amount !== (carried ?? config.amount);
  const nextConfig: RenewalConfig = { amount: newAmount ? plan.amount : config.amount, currency: plan.currency, ...(plan.note ? { note: plan.note } : {}) };
  if (!same(nextConfig, config)) patch.config = nextConfig;
  if (newAmount && carried !== null) patch.state = { ...state, amount: plan.amount };
  let updated = await applyEdit(d, task, user, patch);
  const now = d.clock.now();
  let next = await nextRun(d, updated);
  if (!same(plan.schedule, task.schedule)) {
    const asked = await askedAbout(d, task, user, plan.schedule.anchor);
    updated = await rescheduleKeepingSnoozes(d, updated, user, plan.schedule, user.id);
    next = (asked ? null : await firstAskIfDue(d, updated, user, plan.schedule)) ?? (await nextRun(d, updated));
  }
  const ask = updated.status === "paused" ? "paused" : askText(next, plan.days, user, now);
  const cadence = describeSchedule(plan.schedule, user, user.timeZone, now);
  return { ok: true, task: updated, text: clip(`Saved \`${updated.id}\` (renewal): ${cadence}. Next ask: ${ask}.`) };
}

/** A price's name, interval, drop and baseline; the page stays the one it was made for. */
export async function editPrice(d: TrackerDeps, user: User, taskId: string, input: PriceSettings): Promise<TaskResult> {
  const task = await owned(d, user, taskId, "price");
  if (typeof task === "string") return { ok: false, error: task };
  const plan = priceSettingsPlan(input);
  if (!plan.ok) return plan;
  const config = task.config as PriceConfig;
  const patch: Omit<TaskPatch, "at"> = {};
  const title = plan.name || titleFor(config.url);
  if (title !== task.title) patch.title = title;
  const nextConfig: PriceConfig = { ...config, dropPercent: plan.drop, baseline: plan.baseline };
  if (!same(nextConfig, config)) patch.config = nextConfig;
  let updated = await applyEdit(d, task, user, patch);
  const schedule = task.schedule;
  if (schedule?.kind === "poll" && (schedule.every !== plan.hours || schedule.unit !== "hour")) {
    // The grid keeps its start, so the checks stay where they were, only further apart or closer.
    const next: Schedule = { ...schedule, every: plan.hours, unit: "hour" };
    updated = await rescheduleKeepingSnoozes(d, updated, user, next, user.id);
  }
  return { ok: true, task: updated, text: savedText(updated, user, await nextRun(d, updated), d.clock.now(), "(price)") };
}
