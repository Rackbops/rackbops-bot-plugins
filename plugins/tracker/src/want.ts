import { type Actor, createTask, type Schedule, type TaskPatch, type User } from "@rackbops/docket-core";
import { isEbayHost, money, pageSource, parseBggThingId, type SourceId, SourceMiss, type WantConfig, withinLimits } from "@rackbops/docket-types";
import { clip, liveTaskCap, NO_LONGER_LISTED, NO_SUCH_TASK, type Plan, rescheduleKeepingSnoozes, said, type TaskResult, type TrackerDeps } from "./actions.js";
import type { Step } from "./discord.js";
import { applyEdit, busyTask, nextRun, owned, refusingScheduleError, same, savedText } from "./edit.js";
import { FetchRefusedError, urlProblem } from "./fetch.js";
import { CURRENCY_LENGTH, MAX_TITLE, MAX_URL } from "./limits.js";

/**
 * `/want`'s rules (category 2; rackbops-bot-plugins#83), for the command, the web editor and the task
 * API alike, over the wantlist type (docket-types' `wantlist`). Three answers to "where do I look":
 *
 * - `page`: a listing or search page the owner pastes. Checked like `/price`'s page, then read once
 *   outside the queue, so the owner hears at once whether it carries listings the watcher can read;
 *   the task is made only when it does.
 * - `bgg`: a BoardGameGeek game, only while `TRACKER_BGG_TOKEN` is set (`d.bgg`).
 * - `ebay`: no task. The tracker never reads eBay, so the answer is an eBay search, with the price
 *   cap in it, for the owner to save on eBay; eBay's own saved-search alerts do the watching.
 *
 * A watch is judged (docket-types' `wantjudge`: the model looks at each new listing before it is DMed)
 * whenever the model runner is set up (`d.research`), unless the owner says `judge: false`; without
 * the runner it is a plain watch, and `judge: true` is refused. Which it is stays fixed once made,
 * since a task's type is: to change it, make a new watch.
 */

export const MAX_WANT_TASKS = 20;
export const DEFAULT_PAGE_HOURS = 12;
export const DEFAULT_BGG_HOURS = 24;
export const MAX_WANT_HOURS = 168;
export const MAX_WANT_PRICE = 10_000_000;
export const WANT_SOURCES = ["page", "bgg", "ebay"] as const;
export type WantSource = (typeof WANT_SOURCES)[number];

export const WANT_OFF = "The want-list watcher is not available on this bot.";
export const NO_BGG = "This bot has no BoardGameGeek access yet: BGG has not approved its application. A listing page (`source: page`) works now.";
export const JUDGE_OFF = "Checking listings with the model needs the model runner, which this bot does not have set up. Leave `judge` out for a plain watch.";
export const WANT_TYPES: ReadonlySet<string> = new Set(["wantlist", "wantjudge"]);
export const EBAY_PAGE = "I never read eBay's pages. Use `source: ebay` instead: I give you an eBay search to save, and eBay emails you new listings.";

export interface WantInput {
  name: string;
  source: string;
  /** The page's address or the BGG game; for `ebay`, the words to search for (the name when empty). */
  target?: string;
  max?: number;
  currency?: string;
  hours?: number;
  /** Whether the model looks at each new listing first; left out, it does whenever it can. */
  judge?: boolean;
}

/** Every field optional: one left out keeps the task's own; an empty `max` or `currency`, or `-`, clears it. */
export interface WantEdit {
  name?: string;
  max?: number | null;
  currency?: string;
  hours?: number;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

interface Limits {
  name: string;
  hours: number;
  maxPrice?: number;
  currency?: string;
}

function limitsPlan(input: { name: string; max?: number | undefined; currency?: string | undefined; hours?: number | undefined }, defaultHours: number): Plan<{ limits: Limits }> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length === 0) return { ok: false, error: "Name what you want, for example `Wingspan Oceania expansion`." };
  if (name.length > MAX_TITLE) return { ok: false, error: `That name is longer than ${MAX_TITLE} characters.` };
  const hours = input.hours ?? defaultHours;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_WANT_HOURS) return { ok: false, error: `\`hours\` is a whole number from 1 to ${MAX_WANT_HOURS}.` };
  if (input.max !== undefined && (!Number.isFinite(input.max) || input.max <= 0 || input.max > MAX_WANT_PRICE)) {
    return { ok: false, error: "`max` is a price above 0." };
  }
  const currency = (input.currency ?? "").trim().toUpperCase();
  if (currency && !new RegExp(`^[A-Z]{${CURRENCY_LENGTH}}$`).test(currency)) return { ok: false, error: "`currency` is a three-letter code, such as USD or EUR." };
  return {
    ok: true,
    limits: { name, hours, ...(input.max !== undefined ? { maxPrice: input.max } : {}), ...(currency ? { currency } : {}) },
  };
}

/** The eBay search the owner saves on eBay: the words, used and new, with the price cap as eBay's own. */
export function ebaySearchUrl(words: string, max?: number): string {
  const q = new URLSearchParams({ _nkw: words });
  if (max !== undefined) q.set("_udhi", String(max));
  return `https://www.ebay.com/sch/i.html?${q.toString()}`;
}

function ebayAnswer(words: string, limits: Limits): string {
  const cap = limits.maxPrice !== undefined ? ` at or under ${money(limits.maxPrice, limits.currency ?? "")}` : "";
  return clip(
    [
      `I do not read eBay, so for eBay the watching is eBay's own. Your search for "${words}"${cap}: <${ebaySearchUrl(words, limits.maxPrice)}>`,
      "1. Open it and sign in to eBay.",
      "2. Choose **Save this search** (the heart beside the results count) and keep the email alerts on.",
      "eBay then emails you new listings. Nothing is made here; `/want source: page` or `source: bgg` watches elsewhere.",
    ].join("\n"),
  );
}

async function liveWants(d: TrackerDeps, user: User): Promise<number> {
  let n = 0;
  for (const type of WANT_TYPES) {
    for (const status of ["active", "paused"] as const) n += (await d.store.listTasks({ ownerId: user.id, status, type })).length;
  }
  return n;
}

/** Whether a new watch is judged, or why it cannot be. */
function judgePlan(d: TrackerDeps, asked: boolean | undefined): Plan<{ judge: boolean }> {
  const can = d.research === true && d.types.wantjudge !== undefined;
  if (asked === true && !can) return { ok: false, error: JUDGE_OFF };
  return { ok: true, judge: asked ?? can };
}

function atCap(d: Pick<TrackerDeps, "webEditor">): string {
  const where = d.webEditor ? ", or delete one on the web," : "";
  return `You already watch for ${MAX_WANT_TASKS} things, the most one person may. Stop one with \`/task done\`${where} first.`;
}

/** A `/want` that passed its checks: a task to make, or (eBay) only an answer. */
export type WantStart = { kind: "answer"; text: string } | PendingWant;
export interface PendingWant {
  kind: "task";
  title: string;
  hours: number;
  config: WantConfig;
  judge: boolean;
}

/** `/want`'s checks, in the queue: the source, the target, the limits and the caps. */
export async function startWant(d: TrackerDeps, user: User, input: WantInput): Promise<Plan<{ start: WantStart }>> {
  if (!d.types.wantlist) return { ok: false, error: WANT_OFF };
  const source = input.source.trim().toLowerCase();
  if (!(WANT_SOURCES as readonly string[]).includes(source)) return { ok: false, error: "`source` is page, bgg or ebay." };
  const planned = limitsPlan(input, source === "bgg" ? DEFAULT_BGG_HOURS : DEFAULT_PAGE_HOURS);
  if (!planned.ok) return planned;
  const { limits } = planned;
  const judged = judgePlan(d, input.judge);
  if (!judged.ok) return judged;
  const target = (input.target ?? "").trim();
  if (source === "ebay") {
    const words = (target || limits.name).replace(/\s+/g, " ");
    if (words.length > MAX_TITLE) return { ok: false, error: `The words to search for are longer than ${MAX_TITLE} characters.` };
    return { ok: true, start: { kind: "answer", text: ebayAnswer(words, limits) } };
  }
  if (target.length === 0) return { ok: false, error: source === "page" ? "`target` is the listing page's address." : "`target` is the BGG game: its address or its id." };
  if (target.length > MAX_URL) return { ok: false, error: `That address is longer than ${MAX_URL} characters.` };
  if (source === "page") {
    if (!d.fetch) return { ok: false, error: WANT_OFF };
    const problem = urlProblem(target);
    if (problem) return { ok: false, error: problem };
    if (isEbayHost(new URL(target).hostname)) return { ok: false, error: EBAY_PAGE };
  } else {
    if (!d.bgg) return { ok: false, error: NO_BGG };
    if (parseBggThingId(target) === null) {
      return { ok: false, error: "That is not a BGG game. Paste its address, such as `https://boardgamegeek.com/boardgame/266192/wingspan`, or its id." };
    }
  }
  if ((await liveWants(d, user)) >= MAX_WANT_TASKS) return { ok: false, error: atCap(d) };
  const capped = await liveTaskCap(d, user);
  if (capped) return { ok: false, error: capped };
  const id = source === "bgg" ? String(parseBggThingId(target)) : target;
  const config: WantConfig = {
    source: source as SourceId,
    target: id,
    ...(limits.maxPrice !== undefined ? { maxPrice: limits.maxPrice } : {}),
    ...(limits.currency ? { currency: limits.currency } : {}),
  };
  return { ok: true, start: { kind: "task", title: limits.name, hours: limits.hours, config, judge: judged.judge } };
}

export type WantPreview = { ok: true; text: string } | { ok: false; error: string };

/** A page's first read, outside the queue: how many listings it carries now, or why it cannot be watched. A BGG game is not read here. */
export async function previewWant(d: TrackerDeps, start: PendingWant): Promise<WantPreview> {
  if (start.config.source !== "page") return { ok: true, text: "" };
  try {
    const listings = await pageSource.search(start.config.target, d.fetch ?? undefined);
    const within = listings.filter((l) => withinLimits(l, start.config)).length;
    const limited = start.config.maxPrice !== undefined || start.config.currency ? `, ${within} within your limits` : "";
    return { ok: true, text: `The page lists ${plural(listings.length, "thing")} now${limited}.` };
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    if (cause instanceof FetchRefusedError) return { ok: false, error: `I cannot read that page: ${cause.message}.` };
    if (err instanceof SourceMiss && err.message.startsWith("no listings")) {
      return {
        ok: false,
        error: "I found no listings on that page that I can read: I read only the structured product data a shop puts in its pages (JSON-LD), and this one has none. A different shop's search page may work.",
      };
    }
    return { ok: false, error: "I could not read that page just now; try again later." };
  }
}

/** The task, back in the queue, once the page's first read found listings. */
export async function finishWant(d: TrackerDeps, asked: User, start: PendingWant, seen: WantPreview): Promise<TaskResult> {
  const user = await d.store.getUser(asked.id);
  if (!user || !d.admissions.isRegistered(user.id)) return { ok: false, error: NO_LONGER_LISTED };
  if (!seen.ok) return seen;
  const type = start.judge ? d.types.wantjudge : d.types.wantlist;
  if (!type) return { ok: false, error: start.judge ? JUDGE_OFF : WANT_OFF };
  if ((await liveWants(d, user)) >= MAX_WANT_TASKS) return { ok: false, error: atCap(d) };
  const capped = await liveTaskCap(d, user);
  if (capped) return { ok: false, error: capped };
  const now = d.clock.now();
  const schedule: Schedule = { kind: "poll", every: start.hours, unit: "hour", start: now.toISOString() };
  const actor: Actor = { userId: user.id, admin: user.admin };
  const { task } = await createTask(d.store, actor, user, { type, title: start.title, config: start.config, schedule }, now);
  const c = start.config;
  const limits = [
    ...(c.maxPrice !== undefined ? [`at or under ${money(c.maxPrice, c.currency ?? "")}`] : []),
    ...(c.currency && c.maxPrice === undefined ? [`in ${c.currency}`] : []),
  ];
  const where = c.source === "bgg" ? "BoardGameGeek's marketplace" : "that page";
  return {
    ok: true,
    task,
    text: clip(
      [
        `Watching \`${task.id}\`: ${start.title}.${seen.text ? ` ${seen.text}` : ""}`,
        start.judge
          ? `I look at ${where} every ${plural(start.hours, "hour")}, and the model looks at each listing${limits.length ? ` ${limits.join(" ")}` : ""} I have not shown you before -- whether it is the thing, and what its page shows about the seller -- then I DM you the ones worth a look, with its notes; the first look starts within a minute. Those looks are model runs, charged like research; \`judge: false\` makes a watch without them. Press Done on a DM once you have it, or \`/task done ${task.id}\`.`
          : `I look at ${where} every ${plural(start.hours, "hour")} and DM you each listing${limits.length ? ` ${limits.join(" ")}` : ""} I have not shown you before; the first look, within a minute, DMs what is there now. Press Done on a DM once you have it, or \`/task done ${task.id}\`.`,
      ].join("\n"),
    ),
  };
}

/** `/want`: checked in the queue, a page read once outside it, the task made back in it. */
export async function wantCommand(d: TrackerDeps, user: User, input: WantInput): Promise<Step> {
  const started = await startWant(d, user, input);
  if (!started.ok) return started.error;
  const { start } = started;
  if (start.kind === "answer") return start.text;
  if (start.config.source !== "page") return said(await finishWant(d, user, start, { ok: true, text: "" }));
  return {
    outside: () => previewWant(d, start),
    finish: async (result) => said(await finishWant(d, user, start, result as WantPreview)),
  };
}

/** A watch's name, top price, currency and hours; where it looks stays the same. */
export function editWant(d: TrackerDeps, user: User, taskId: string, input: WantEdit): Promise<TaskResult> {
  return d.locks.turn(taskId.trim(), () => refusingScheduleError(() => editWantLocked(d, user, taskId, input)), busyTask);
}

async function editWantLocked(d: TrackerDeps, user: User, taskId: string, input: WantEdit): Promise<TaskResult> {
  const plain = await owned(d, user, taskId, "wantlist");
  const task = typeof plain === "string" && plain === NO_SUCH_TASK ? await owned(d, user, taskId, "wantjudge") : plain;
  if (typeof task === "string") return { ok: false, error: task };
  const config = task.config as WantConfig;
  const schedule = task.schedule;
  const cleared = (v: string | undefined) => v !== undefined && (v.trim() === "" || v.trim() === "-");
  const currency = input.currency === undefined ? config.currency : cleared(input.currency) ? undefined : input.currency;
  const max = input.max === undefined ? config.maxPrice : input.max === null ? undefined : input.max;
  const planned = limitsPlan(
    { name: input.name ?? task.title, max, currency, hours: input.hours ?? (schedule?.kind === "poll" ? schedule.every : undefined) },
    config.source === "bgg" ? DEFAULT_BGG_HOURS : DEFAULT_PAGE_HOURS,
  );
  if (!planned.ok) return planned;
  const { limits } = planned;
  const nextConfig: WantConfig = {
    source: config.source,
    target: config.target,
    ...(limits.maxPrice !== undefined ? { maxPrice: limits.maxPrice } : {}),
    ...(limits.currency ? { currency: limits.currency } : {}),
  };
  const patch: Omit<TaskPatch, "at"> = {};
  if (limits.name !== task.title) patch.title = limits.name;
  if (!same(nextConfig, config)) patch.config = nextConfig;
  let updated = await applyEdit(d, task, user, patch);
  let jobOut = false;
  if (schedule?.kind === "poll" && (schedule.every !== limits.hours || schedule.unit !== "hour")) {
    ({ task: updated, jobOut } = await rescheduleKeepingSnoozes(d, updated, user, { ...schedule, every: limits.hours, unit: "hour" }, user.id));
  }
  return { ok: true, task: updated, text: savedText(updated, user, await nextRun(d, updated), d.clock.now(), "(want list)", jobOut) };
}
