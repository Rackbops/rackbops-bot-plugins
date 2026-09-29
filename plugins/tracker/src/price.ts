import { createTask, type Actor, type Schedule, type User } from "@rackbops/docket-core";
import {
  BASELINE_RULES,
  type BaselineRule,
  DEFAULT_BASELINE,
  DEFAULT_DROP_PERCENT,
  extractPrice,
  money,
  type PriceConfig,
} from "@rackbops/docket-types";
import { clip, MAX_TITLE, type Plan, said, type TaskResult, type TrackerDeps } from "./actions.js";
import type { Step } from "./discord.js";
import { FetchRefusedError, urlProblem } from "./fetch.js";

/**
 * The price tracker (rackbops-bot-plugins#81, plan 1.2 category 3, E6): `/price`'s rules and the
 * steps that make one -- the checks in the queue, the first look at the page outside it, the task
 * back in it -- over docket's `price` type, for the command and the web editor alike. No discord.js.
 */

export const MAX_NEAR = 100;
/** Active and paused price trackers one person may own: each is a page read every few hours. */
export const MAX_PRICE_TASKS = 20;
export const DEFAULT_POLL_HOURS = 12;
export const MAX_POLL_HOURS = 168;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
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

export interface PriceSettings {
  name?: string;
  hours?: number;
  drop?: number;
  baseline?: BaselineRule;
}

/** `/price`'s rules for what can change after it is made: the name, the interval, the drop and the baseline. */
export function priceSettingsPlan(input: PriceSettings): Plan<{ name: string; hours: number; drop: number; baseline: BaselineRule }> {
  const hours = input.hours ?? DEFAULT_POLL_HOURS;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_POLL_HOURS) return { ok: false, error: `\`hours\` is a whole number from 1 to ${MAX_POLL_HOURS}.` };
  const drop = input.drop ?? DEFAULT_DROP_PERCENT;
  if (!Number.isFinite(drop) || drop < 1 || drop > 90) return { ok: false, error: "`drop` is a percentage from 1 to 90." };
  const baseline = input.baseline ?? DEFAULT_BASELINE;
  if (!(BASELINE_RULES as readonly string[]).includes(baseline)) return { ok: false, error: "`baseline` is first, last or peak." };
  const name = input.name?.trim() ?? "";
  if (name.length > MAX_TITLE) return { ok: false, error: `That name is longer than ${MAX_TITLE} characters.` };
  return { ok: true, name, hours, drop, baseline };
}

/** A `/price` that passed its checks, waiting on the first look at the page. */
export interface PendingPrice {
  url: string;
  title: string;
  hours: number;
  config: PriceConfig;
}

export type PreviewResult = { ok: true; text: string } | { ok: false; error: string };

/** What the first look at the page found, in the owner's words. Outside the queue: it waits on the page. */
export async function previewPrice(d: TrackerDeps, v: PendingPrice): Promise<PreviewResult> {
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

const AT_CAP = `You already track ${MAX_PRICE_TASKS} prices, the most one person may. Stop one with \`/task done\`, or delete one on the web, first.`;

/** The title a price gets with no name: the page's host and path. */
export function titleFor(url: string): string {
  const u = new URL(url);
  return clip(`${u.hostname}${u.pathname === "/" ? "" : u.pathname}`, MAX_TITLE);
}

/**
 * `/price`'s checks, in the queue (the URL, the numbers, the per-person cap): a pending price for
 * `previewPrice`, or why not.
 */
export async function startPrice(d: TrackerDeps, user: User, input: PriceInput): Promise<Plan<{ pending: PendingPrice }>> {
  if (!d.types.price || !d.fetch) return { ok: false, error: "Price tracking is not available on this bot." };
  const url = input.url.trim();
  const problem = urlProblem(url);
  if (problem) return { ok: false, error: problem };
  const settings = priceSettingsPlan(input);
  if (!settings.ok) return settings;
  const near = input.near?.trim() ?? "";
  if (near.length > MAX_NEAR) return { ok: false, error: `\`near\` is longer than ${MAX_NEAR} characters.` };
  if ((await ownedPriceTasks(d, user)) >= MAX_PRICE_TASKS) return { ok: false, error: AT_CAP };
  const { name, hours, drop, baseline } = settings;
  const config: PriceConfig = { url, dropPercent: drop, baseline, ...(near ? { pattern: nearPattern(near) } : {}) };
  return { ok: true, pending: { url, title: name || titleFor(url), hours, config } };
}

/**
 * `/price` (category 3): docket's `price` type on a `poll` schedule every `hours`, starting now.
 * Checked in the queue (`startPrice`), then the page is read once outside it (`previewPrice`) --
 * the owner hears at once whether a price can be read -- and the task is created back in the queue
 * (`finishPrice`) only when one could. The first poll runs within a minute and DMs the baseline.
 */
export async function trackPrice(d: TrackerDeps, user: User, input: PriceInput): Promise<Step> {
  const started = await startPrice(d, user, input);
  if (!started.ok) return started.error;
  const { pending } = started;
  return {
    outside: () => previewPrice(d, pending),
    finish: async (result) => said(await finishPrice(d, user, pending, result as PreviewResult)),
  };
}

export async function finishPrice(d: TrackerDeps, user: User, v: PendingPrice, seen: PreviewResult): Promise<TaskResult> {
  if (!seen.ok) return seen;
  const type = d.types.price;
  if (!type) return { ok: false, error: "Price tracking is not available on this bot." };
  // Checked again: two `/price` commands can both pass the first check before either creates.
  if ((await ownedPriceTasks(d, user)) >= MAX_PRICE_TASKS) return { ok: false, error: AT_CAP };
  const now = d.clock.now();
  const schedule: Schedule = { kind: "poll", every: v.hours, unit: "hour", start: now.toISOString() };
  const actor: Actor = { userId: user.id, admin: user.admin };
  const { task } = await createTask(d.store, actor, user, { type, title: v.title, config: v.config, schedule }, now);
  const rule = v.config.baseline ?? DEFAULT_BASELINE;
  return {
    ok: true,
    task,
    text: clip(
      [
        `Tracking \`${task.id}\`: ${v.title}. I read ${seen.text} just now.`,
        `I check every ${plural(v.hours, "hour")} and DM you when it drops ${v.config.dropPercent}% or more from the ${rule} price seen; the first check, within a minute, DMs the starting price. \`/task done ${task.id}\` stops it.`,
      ].join("\n"),
    ),
  };
}
