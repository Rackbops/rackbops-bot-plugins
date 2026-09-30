import {
  createTask,
  daysUntil,
  describeSchedule,
  formatInstant,
  nextDue,
  ReplyRefusedError,
  ScheduleError,
  scheduledKey,
  visibleTask,
  type Actor,
  type Occurrence,
  type PeriodSchedule,
  type Task,
  type User,
} from "@rackbops/docket-core";
import { money, type RenewalConfig, type RenewalDecision } from "@rackbops/docket-types";
import { CURRENCY_LENGTH, DATE_LENGTH, MAX_NOTE, MAX_TITLE } from "./limits.js";
import { clip, liveTaskCap, NO_SUCH_TASK, type Plan, replyLanes, said, type TaskResult, type TrackerDeps } from "./actions.js";

/**
 * Renewals (rackbops-bot-plugins#81, plan 1.2 category 6, E6): `/renewal`'s rules and the command
 * that answers a renewal with an amount, over docket's `renewal` type -- notify lane, no model,
 * nothing to city-hall -- for the commands and the web editor alike. The price tracker is price.ts.
 * Like actions.ts, no discord.js: discord.ts reads the options and renders what these return.
 */

export const DEFAULT_LEAD_DAYS = 7;
export const MAX_LEAD_DAYS = 365;
export const MAX_EVERY = 100;

export type PeriodUnit = "day" | "week" | "month" | "year";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export interface RenewalInput {
  name: string;
  amount: number;
  currency: string;
  /** The next renewal or expiry date, `YYYY-MM-DD`. */
  renews: string;
  every?: number;
  unit?: PeriodUnit;
  lead?: number;
  note?: string;
}

export const PERIOD_UNITS: readonly PeriodUnit[] = ["year", "month", "week", "day"];

/**
 * `/renewal`'s rules, for the command and the web editor alike: the name, the amount and currency,
 * the note, and the `period` schedule anchored at the next renewal date, asking `lead` days before.
 */
export function renewalPlan(
  d: Pick<TrackerDeps, "clock">,
  user: User,
  input: RenewalInput,
): Plan<{ name: string; amount: number; currency: string; note: string; days: number; schedule: PeriodSchedule }> {
  const bad = (error: string) => ({ ok: false as const, error });
  const name = input.name.trim();
  if (name.length === 0) return bad("Say what renews: a subscription, a domain, a warranty.");
  if (name.length > MAX_TITLE) return bad(`That name is longer than ${MAX_TITLE} characters.`);
  if (!Number.isFinite(input.amount) || input.amount < 0) return bad("The amount has to be zero or more.");
  const currency = input.currency.trim().toUpperCase();
  if (!new RegExp(`^[A-Z]{${CURRENCY_LENGTH}}$`).test(currency)) return bad("The currency is a three-letter code, such as USD or EUR.");
  const note = input.note?.trim() ?? "";
  if (note.length > MAX_NOTE) return bad(`The note is longer than ${MAX_NOTE} characters.`);
  const unit = input.unit ?? "year";
  if (!PERIOD_UNITS.includes(unit)) return bad("`unit` is yearly, monthly, weekly or daily.");
  const every = input.every ?? 1;
  if (!Number.isInteger(every) || every < 1 || every > MAX_EVERY) return bad(`\`every\` is a whole number from 1 to ${MAX_EVERY}.`);
  const lead = input.lead ?? DEFAULT_LEAD_DAYS;
  if (!Number.isInteger(lead) || lead < 0 || lead > MAX_LEAD_DAYS) return bad(`\`lead\` is a whole number of days from 0 to ${MAX_LEAD_DAYS}.`);
  const renews = input.renews.trim();
  const days = renews.length === DATE_LENGTH && /^\d{4}-\d{2}-\d{2}$/.test(renews) ? daysUntil(renews, d.clock.now(), user.timeZone) : null;
  if (days === null) return bad("Give the date as YYYY-MM-DD, for example 2026-12-01.");
  if (days < 0) return bad("That date has passed: give the next renewal or expiry date.");
  return { ok: true, name, amount: input.amount, currency, note, days, schedule: { kind: "period", every, unit, anchor: renews, leadDays: lead } };
}

/**
 * The first period's ask, when it is already due (a renewal in three days with a week's lead): it
 * runs now, about that date, instead of waiting a whole period. It is the period schedule's own
 * first occurrence (same dedupe key), just due in the past, so an ask that already ran is not
 * asked again. Null when not due yet.
 */
export async function firstAskIfDue(d: TrackerDeps, task: Task, owner: User, schedule: PeriodSchedule): Promise<Occurrence | null> {
  const now = d.clock.now();
  const first = nextDue(schedule, new Date(0), { zone: owner.timeZone, preferredHour: owner.preferredHour });
  if (!first || first.getTime() > now.getTime()) return null;
  return d.store.createOccurrence({ taskId: task.id, lane: task.lane, dueAt: first.toISOString(), dedupeKey: scheduledKey(task.id, first), at: now.toISOString() });
}

/** When the next ask comes, in the owner's words. */
export function askText(next: Occurrence | null, days: number, user: User, now: Date): string {
  const when = days === 0 ? "today" : `in ${plural(days, "day")}`;
  if (!next) return "never (that schedule has no next date)";
  return Date.parse(next.dueAt) <= now.getTime() ? `in the next minute (it renews ${when})` : formatInstant(next.dueAt, user.timeZone, now);
}

/**
 * `/renewal` (category 6): docket's `renewal` type on a `period` schedule anchored at the next
 * renewal date, asking `lead` days before each one at the owner's preferred hour; a first ask
 * already past comes at once (`firstAskIfDue`).
 */
export async function createRenewal(d: TrackerDeps, user: User, input: RenewalInput): Promise<TaskResult> {
  const type = d.types.renewal;
  if (!type) return { ok: false, error: "Renewals are not available on this bot." };
  const plan = renewalPlan(d, user, input);
  if (!plan.ok) return plan;
  const capped = await liveTaskCap(d, user);
  if (capped) return { ok: false, error: capped };
  const { name, currency, note, schedule } = plan;
  const now = d.clock.now();
  const config: RenewalConfig = { amount: plan.amount, currency, ...(note ? { note } : {}) };
  const actor: Actor = { userId: user.id, admin: user.admin };
  let created;
  try {
    created = await createTask(d.store, actor, user, { type, title: name, config, schedule }, now);
  } catch (err) {
    if (err instanceof ScheduleError) return { ok: false, error: `That schedule does not work: ${err.message}.` };
    throw err;
  }
  const { task } = created;
  const next = (await firstAskIfDue(d, task, user, schedule)) ?? created.next;
  const cadence = describeSchedule(schedule, user, user.timeZone, now);
  return {
    ok: true,
    task,
    text: clip(
      [
        `Renewal \`${task.id}\` set: ${name}, ${money(plan.amount, currency)}, ${cadence}.`,
        `First ask: ${askText(next, plan.days, user, now)}. Each ask has Keep, Cancel and Renewed buttons; paid a different amount? Answer with \`/task decide\` instead of a button.`,
      ].join("\n"),
    ),
  };
}

export async function addRenewal(d: TrackerDeps, user: User, input: RenewalInput): Promise<string> {
  return said(await createRenewal(d, user, input));
}

/**
 * `/task decide` (category 6): the owner answers the renewal's latest ask -- keep, cancel or
 * renewed -- optionally with the amount actually paid, which a button cannot carry. docket records
 * it (`decisionOf`): the amount becomes the task's current amount and a point in its series; a
 * cancel ends the task.
 */
export async function decideRenewal(
  d: TrackerDeps,
  user: User,
  input: { taskId: string; choice: RenewalDecision; amount?: number },
): Promise<string> {
  const task = await visibleTask(d.store, { userId: user.id, admin: false }, input.taskId.trim());
  if (!task || task.ownerId !== user.id) return NO_SUCH_TASK;
  if (task.type !== "renewal") return `\`/task decide\` answers a renewal; \`${task.id}\` is a ${task.type}.`;
  if (input.amount !== undefined && (!Number.isFinite(input.amount) || input.amount < 0)) return "The amount has to be zero or more.";
  const fired = (await d.store.listOccurrences({ taskId: task.id })).filter(
    (o) => o.status === "running" || o.status === "done" || o.status === "failed",
  );
  const latest = fired.at(-1);
  if (!latest) return "That renewal has no ask waiting for an answer yet.";
  const payload = input.amount === undefined ? input.choice : { choice: input.choice, amount: input.amount };
  try {
    await replyLanes(d).reply({ taskId: task.id, occurrenceId: latest.id, userId: user.id, kind: "decision", payload });
  } catch (err) {
    if (err instanceof ReplyRefusedError) return err.message;
    throw err;
  }
  if (input.choice === "cancel") return `Cancelled: \`${task.id}\` ${task.title} will not ask again.`;
  const currency = (task.config as Partial<RenewalConfig>).currency ?? "";
  const paid = input.amount !== undefined ? ` at ${money(input.amount, currency)}` : "";
  return `Recorded: ${input.choice}${paid}.`;
}
