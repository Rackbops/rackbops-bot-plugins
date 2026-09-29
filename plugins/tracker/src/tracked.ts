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
  type Schedule,
  type User,
} from "@rackbops/docket-core";
import {
  BASELINE_RULES,
  type BaselineRule,
  DEFAULT_BASELINE,
  DEFAULT_DROP_PERCENT,
  extractPrice,
  money,
  type PriceConfig,
  type RenewalConfig,
  type RenewalDecision,
} from "@rackbops/docket-types";
import { clip, NO_SUCH_TASK, replyLanes, type TrackerDeps } from "./actions.js";
import type { Step } from "./discord.js";
import { FetchRefusedError, urlProblem } from "./fetch.js";

/**
 * Renewals and the price tracker (rackbops-bot-plugins#81, plan 1.2 categories 6 and 3, E6): the
 * slash commands that create them and the one that answers a renewal with an amount, over docket's
 * `renewal` and `price` types -- notify lane, no model, nothing to city-hall. Like actions.ts, no
 * discord.js: discord.ts reads the options and renders what these return.
 */

const MAX_TITLE = 100;
export const MAX_NOTE = 300;
export const MAX_NEAR = 100;
/** Active and paused price trackers one person may own: each is a page read every few hours. */
export const MAX_PRICE_TASKS = 20;
export const DEFAULT_POLL_HOURS = 12;
export const MAX_POLL_HOURS = 168;
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

/**
 * `/renewal` (category 6): docket's `renewal` type on a `period` schedule anchored at the next
 * renewal date, asking `lead` days before each one at the owner's preferred hour. When that ask is
 * already past but the date is not (a renewal in three days with a week's lead), the first ask runs
 * now, about that date, instead of waiting a whole period: it is the period schedule's own first
 * occurrence (same dedupe key), just due in the past.
 */
export async function addRenewal(d: TrackerDeps, user: User, input: RenewalInput): Promise<string> {
  const type = d.types.renewal;
  if (!type) return "Renewals are not available on this bot.";
  const name = input.name.trim();
  if (name.length === 0) return "Say what renews: a subscription, a domain, a warranty.";
  if (name.length > MAX_TITLE) return `That name is longer than ${MAX_TITLE} characters.`;
  if (!Number.isFinite(input.amount) || input.amount < 0) return "The amount has to be zero or more.";
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return "The currency is a three-letter code, such as USD or EUR.";
  const note = input.note?.trim() ?? "";
  if (note.length > MAX_NOTE) return `The note is longer than ${MAX_NOTE} characters.`;
  const every = input.every ?? 1;
  if (!Number.isInteger(every) || every < 1 || every > MAX_EVERY) return `\`every\` is a whole number from 1 to ${MAX_EVERY}.`;
  const lead = input.lead ?? DEFAULT_LEAD_DAYS;
  if (!Number.isInteger(lead) || lead < 0 || lead > MAX_LEAD_DAYS) return `\`lead\` is a whole number of days from 0 to ${MAX_LEAD_DAYS}.`;
  const renews = input.renews.trim();
  const now = d.clock.now();
  const days = /^\d{4}-\d{2}-\d{2}$/.test(renews) ? daysUntil(renews, now, user.timeZone) : null;
  if (days === null) return "Give the date as YYYY-MM-DD, for example 2026-12-01.";
  if (days < 0) return "That date has passed: give the next renewal or expiry date.";
  const schedule: Schedule = { kind: "period", every, unit: input.unit ?? "year", anchor: renews, leadDays: lead };
  const config: RenewalConfig = { amount: input.amount, currency, ...(note ? { note } : {}) };
  const actor: Actor = { userId: user.id, admin: user.admin };
  let created;
  try {
    created = await createTask(d.store, actor, user, { type, title: name, config, schedule }, now);
  } catch (err) {
    if (err instanceof ScheduleError) return `That schedule does not work: ${err.message}.`;
    throw err;
  }
  const { task } = created;
  let next = created.next;
  // The first period's ask, when it is already due: nextDue from the epoch is period 0's.
  const first = nextDue(schedule, new Date(0), { zone: user.timeZone, preferredHour: user.preferredHour });
  if (first && first.getTime() <= now.getTime()) {
    next = await d.store.createOccurrence({
      taskId: task.id,
      lane: task.lane,
      dueAt: first.toISOString(),
      dedupeKey: scheduledKey(task.id, first),
      at: now.toISOString(),
    });
  }
  const cadence = describeSchedule(schedule, user, user.timeZone, now);
  const when = days === 0 ? "today" : `in ${plural(days, "day")}`;
  const ask = !next
    ? "never (that schedule has no next date)"
    : Date.parse(next.dueAt) <= now.getTime()
      ? `in the next minute (it renews ${when})`
      : formatInstant(next.dueAt, user.timeZone, now);
  return clip(
    [
      `Renewal \`${task.id}\` set: ${name}, ${money(input.amount, currency)}, ${cadence}.`,
      `First ask: ${ask}. Each ask has Keep, Cancel and Renewed buttons; paid a different amount? Answer with \`/task decide\` instead of a button.`,
    ].join("\n"),
  );
}

export interface PriceInput {
  url: string;
  name?: string;
  hours?: number;
  drop?: number;
  baseline?: BaselineRule;
  /** Text just before the price on the page, for a page with no structured price. */
  near?: string;
}

/**
 * The owner's `near` text as the price type's `pattern`: the text, then up to 40 characters that
 * are not digits, then the price. Built here, never typed by a person, so it is always a literal
 * followed by bounded classes and cannot backtrack for long on a large page (a free-form regular
 * expression could hang the bot's one thread).
 */
export function nearPattern(near: string): string {
  const literal = near.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `${literal}[^0-9]{0,40}([0-9][0-9.,]{0,15})`;
}

interface Validated {
  url: string;
  title: string;
  hours: number;
  config: PriceConfig;
}

export type PreviewResult = { ok: true; text: string } | { ok: false; error: string };

/** What the first look at the page found, in the owner's words. */
async function preview(d: TrackerDeps, v: Validated): Promise<PreviewResult> {
  if (!d.fetch) return { ok: false, error: "Price tracking is not available on this bot." };
  try {
    const response = await d.fetch.get(v.url);
    if (response.status !== 200) return { ok: false, error: `That page answered HTTP ${response.status}, so there is no price to track.` };
    const found = extractPrice(response.body, v.config.pattern);
    if (!found) {
      return {
        ok: false,
        error: v.config.pattern
          ? "I found no price after that `near` text on the page. Check the words as the page shows them."
          : "I found no price on that page. Some shops show it only to a browser; `near` (the words just before the price) can help.",
      };
    }
    return { ok: true, text: money(found.value, found.currency ?? "") };
  } catch (err) {
    if (err instanceof FetchRefusedError) return { ok: false, error: `I cannot read that page: ${err.message}.` };
    return { ok: false, error: "I could not read that page just now; try again later." };
  }
}

async function ownedPriceTasks(d: TrackerDeps, user: User): Promise<number> {
  const active = await d.store.listTasks({ ownerId: user.id, status: "active" });
  const paused = await d.store.listTasks({ ownerId: user.id, status: "paused" });
  return [...active, ...paused].filter((t) => t.type === "price").length;
}

function titleFor(url: string): string {
  const u = new URL(url);
  return clip(`${u.hostname}${u.pathname === "/" ? "" : u.pathname}`, MAX_TITLE);
}

/**
 * `/price` (category 3): docket's `price` type on a `poll` schedule every `hours`, starting now.
 * Checked in the queue (the URL, the numbers, the per-person cap), then the page is read once
 * outside it -- the owner hears at once whether a price can be read -- and the task is created back
 * in the queue only when one could. The first poll runs within a minute and DMs the baseline.
 */
export async function trackPrice(d: TrackerDeps, user: User, input: PriceInput): Promise<Step> {
  if (!d.types.price || !d.fetch) return "Price tracking is not available on this bot.";
  const url = input.url.trim();
  const problem = urlProblem(url);
  if (problem) return problem;
  const hours = input.hours ?? DEFAULT_POLL_HOURS;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_POLL_HOURS) return `\`hours\` is a whole number from 1 to ${MAX_POLL_HOURS}.`;
  const drop = input.drop ?? DEFAULT_DROP_PERCENT;
  if (!Number.isFinite(drop) || drop < 1 || drop > 90) return "`drop` is a percentage from 1 to 90.";
  const baseline = input.baseline ?? DEFAULT_BASELINE;
  if (!(BASELINE_RULES as readonly string[]).includes(baseline)) return "`baseline` is first, last or peak.";
  const near = input.near?.trim() ?? "";
  if (near.length > MAX_NEAR) return `\`near\` is longer than ${MAX_NEAR} characters.`;
  const name = input.name?.trim() ?? "";
  if (name.length > MAX_TITLE) return `That name is longer than ${MAX_TITLE} characters.`;
  if ((await ownedPriceTasks(d, user)) >= MAX_PRICE_TASKS) {
    return `You already track ${MAX_PRICE_TASKS} prices, the most one person may. Stop one with \`/task done\` first.`;
  }
  const v: Validated = {
    url,
    title: name || titleFor(url),
    hours,
    config: { url, dropPercent: drop, baseline, ...(near ? { pattern: nearPattern(near) } : {}) },
  };
  return {
    outside: () => preview(d, v),
    finish: (result) => finishPrice(d, user, v, result as PreviewResult),
  };
}

async function finishPrice(d: TrackerDeps, user: User, v: Validated, seen: PreviewResult): Promise<string> {
  if (!seen.ok) return seen.error;
  const type = d.types.price;
  if (!type) return "Price tracking is not available on this bot.";
  // Checked again: two `/price` commands can both pass the first check before either creates.
  if ((await ownedPriceTasks(d, user)) >= MAX_PRICE_TASKS) {
    return `You already track ${MAX_PRICE_TASKS} prices, the most one person may. Stop one with \`/task done\` first.`;
  }
  const now = d.clock.now();
  const schedule: Schedule = { kind: "poll", every: v.hours, unit: "hour", start: now.toISOString() };
  const actor: Actor = { userId: user.id, admin: user.admin };
  const { task } = await createTask(d.store, actor, user, { type, title: v.title, config: v.config, schedule }, now);
  const rule = v.config.baseline ?? DEFAULT_BASELINE;
  return clip(
    [
      `Tracking \`${task.id}\`: ${v.title}. I read ${seen.text} just now.`,
      `I check every ${plural(v.hours, "hour")} and DM you when it drops ${v.config.dropPercent}% or more from the ${rule} price seen; the first check, within a minute, DMs the starting price. \`/task done ${task.id}\` stops it.`,
    ].join("\n"),
  );
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
