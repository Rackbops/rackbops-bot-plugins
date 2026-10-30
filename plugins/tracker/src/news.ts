import { type Actor, type CalendarSchedule, createTask, describeSchedule, formatInstant, type TaskPatch, type User } from "@rackbops/docket-core";
import { MAX_DISAMBIGUATE_CHARS, MAX_INCLUDE, MAX_KIND_CHARS, MAX_SUBJECT_CHARS, NEWS_MAX_BUDGET_USD, NEWS_REVIEW_MAX_BUDGET_USD, type NewsConfig } from "@rackbops/docket-types";

/** What one try of each run costs at most, for the confirmation and the web form: a failed try is retried once. */
export const NEWS_COST_TEXT = `up to ${NEWS_MAX_BUDGET_USD.toFixed(2)} USD for the search and ${NEWS_REVIEW_MAX_BUDGET_USD.toFixed(2)} USD for the review, each try (a failed try is retried once)`;
import { clip, liveTaskCap, type Plan, rescheduleKeepingSnoozes, type TaskResult, type TrackerDeps } from "./actions.js";
import { applyEdit, busyTask, nextRun, owned, refusingScheduleError, same, savedText } from "./edit.js";
import { MAX_TITLE } from "./limits.js";
import { scoutSchedule } from "./scout.js";
import { excludePlan } from "./want.js";

/**
 * The news watch's rules (plan item 153, docket#78; the Platinum Blonde and Rhythm Corps pilots of
 * rackbops-bot-plugins#368): `/news new` and `/news edit`, and the web editor and the task API
 * through the same calls, over docket-types' `news`. Like the scout it is made only while the
 * execute lane runs (`d.research`), edited in place, and runs every N days at the owner's preferred
 * hour, so a `/settings hour` change moves it with their reminders. Each run is a search and, when
 * it found anything new, a reviewer run; only what the review keeps is DMed.
 */

export const NEWS_OFF = "The news watch is not available on this bot yet: it needs the model runner, which is not set up here.";

/** News watches one person may have active or paused: a run with news is a search and a review. */
export const MAX_LIVE_NEWS = 3;
export const DEFAULT_NEWS_EVERY = 7;
export const MAX_NEWS_EVERY = 30;
/** The kinds as typed, before they are split. */
export const MAX_INCLUDE_TEXT = 1000;

export interface NewsInput {
  subject: string;
  /** What counts, separated by commas, semicolons or new lines. */
  include?: string;
  /** What never counts, separated by commas. */
  exclude?: string;
  disambiguate?: string;
  /** A boolean from Discord; the web and the API send "yes" or "no", and anything else is refused. */
  shows?: boolean | string;
  every?: number;
}

/** Every field optional: one left out keeps the watch's own; an empty or `-` include, exclude or disambiguate clears it. */
export type NewsEdit = Partial<NewsInput>;

/** `-` is "none": Discord sends no empty option, so `/news new` and `/news edit` both take it. */
const none = (v: string | undefined): string => (v === undefined || v.trim() === "-" ? "" : v.trim());

/** The kinds as a list: split, trimmed, without repeats (ignoring case), or why not. Empty is "any news". */
export function parseInclude(raw: string): string[] | string {
  if (raw.length > MAX_INCLUDE_TEXT) return `\`include\` is longer than ${MAX_INCLUDE_TEXT} characters.`;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\n]/)) {
    const kind = part.trim().replace(/\s+/g, " ");
    if (kind.length === 0 || seen.has(kind.toLowerCase())) continue;
    if (kind.length > MAX_KIND_CHARS) return `Each kind in \`include\` is at most ${MAX_KIND_CHARS} characters; "${clip(kind, 40)}" is longer.`;
    seen.add(kind.toLowerCase());
    out.push(kind);
  }
  if (out.length > MAX_INCLUDE) return `\`include\` takes at most ${MAX_INCLUDE} kinds; that is ${out.length}.`;
  return out;
}

/** Always begins "News", which the DMs lead with. */
export function newsTitle(config: NewsConfig): string {
  return clip(`News: ${config.subject}`, MAX_TITLE);
}

/** The subject, kinds, exclusions, notes and shows as a config, and the days between runs; or why not. */
export function newsPlan(input: NewsInput): Plan<{ config: NewsConfig; every: number }> {
  const subject = input.subject.trim().replace(/\s+/g, " ");
  if (subject.length === 0) return { ok: false, error: "Name who or what to watch, with enough to tell it apart: for example `Platinum Blonde (the Canadian band)`." };
  if (subject.length > MAX_SUBJECT_CHARS) return { ok: false, error: `\`subject\` is longer than ${MAX_SUBJECT_CHARS} characters.` };
  const include = parseInclude(none(input.include));
  if (typeof include === "string") return { ok: false, error: include };
  const exclude = excludePlan(input.exclude, null);
  if (!exclude.ok) return exclude;
  const disambiguate = none(input.disambiguate);
  if (disambiguate.length > MAX_DISAMBIGUATE_CHARS) return { ok: false, error: `\`disambiguate\` is longer than ${MAX_DISAMBIGUATE_CHARS} characters.` };
  const every = input.every ?? DEFAULT_NEWS_EVERY;
  if (!Number.isInteger(every) || every < 1 || every > MAX_NEWS_EVERY) return { ok: false, error: `\`every\` is a whole number of days from 1 to ${MAX_NEWS_EVERY}.` };
  const shows = input.shows === "yes" ? true : input.shows === "no" ? false : input.shows;
  if (shows !== undefined && typeof shows !== "boolean") return { ok: false, error: "`shows` is yes or no." };
  const config: NewsConfig = {
    subject,
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.exclude.length > 0 ? { exclude: exclude.exclude } : {}),
    ...(disambiguate ? { disambiguate } : {}),
    ...(shows === true ? { shows: true } : {}),
  };
  return { ok: true, config, every };
}

/** Every `every` days from today, at the owner's preferred hour: the scout's schedule. */
export function newsSchedule(every: number, zone: string, now: Date): CalendarSchedule {
  return scoutSchedule(every, zone, now);
}

/** The cap's refusal: `/news new`, the web and the task API's create and validate. */
export const NEWS_CAP = `You already have ${MAX_LIVE_NEWS} news watches, the most one person may. Delete or change one instead.`;

export async function liveNews(d: TrackerDeps, user: User): Promise<number> {
  const active = await d.store.listTasks({ ownerId: user.id, status: "active", type: "news" });
  const paused = await d.store.listTasks({ ownerId: user.id, status: "paused", type: "news" });
  return active.length + paused.length;
}

/** The kinds a config holds, as stored (a list) or as an older host might have stored them (one string). */
export function kindsOf(v: NewsConfig["include"]): string[] {
  return Array.isArray(v) ? v.filter((k) => typeof k === "string") : typeof v === "string" && v.trim() ? [v] : [];
}

/** `/news new`: a watch that looks every N days and DMs only what is new and passed its review. */
export async function createNews(d: TrackerDeps, user: User, input: NewsInput): Promise<TaskResult> {
  const type = d.types.news;
  if (!type || !d.research) return { ok: false, error: NEWS_OFF };
  const plan = newsPlan(input);
  if (!plan.ok) return plan;
  const capped = await liveTaskCap(d, user);
  if (capped) return { ok: false, error: capped };
  if ((await liveNews(d, user)) >= MAX_LIVE_NEWS) return { ok: false, error: NEWS_CAP };
  const now = d.clock.now();
  const actor: Actor = { userId: user.id, admin: user.admin };
  const schedule = newsSchedule(plan.every, user.timeZone, now);
  const { task, next } = await createTask(d.store, actor, user, { type, title: newsTitle(plan.config), config: plan.config, schedule }, now);
  const first = next ? formatInstant(next.dueAt, user.timeZone, now) : "not scheduled";
  const kinds = kindsOf(plan.config.include);
  return {
    ok: true,
    task,
    text: clip(
      `News watch \`${task.id}\` made: ${describeSchedule(schedule, user, user.timeZone, now)}. First run ${first}.\n` +
        `Each run looks on the web for new ${kinds.length > 0 ? kinds.join(", ") : "news"} about ${plan.config.subject}; a second run checks each find against its page, and only what passes is DMed to you. ` +
        `A run with nothing new sends nothing. A run counts against the daily model budget, ${NEWS_COST_TEXT}. \`/news edit ${task.id}\` changes it.`,
    ),
  };
}

export function editNews(d: TrackerDeps, user: User, taskId: string, input: NewsEdit): Promise<TaskResult> {
  return d.locks.turn(taskId.trim(), () => refusingScheduleError(() => editNewsLocked(d, user, taskId, input)), busyTask);
}

async function editNewsLocked(d: TrackerDeps, user: User, taskId: string, input: NewsEdit): Promise<TaskResult> {
  const task = await owned(d, user, taskId, "news");
  if (typeof task === "string") return { ok: false, error: task };
  const config = task.config as NewsConfig;
  const schedule = task.schedule?.kind === "calendar" ? task.schedule : newsSchedule(DEFAULT_NEWS_EVERY, user.timeZone, d.clock.now());
  // A subject cannot be cleared: empty or `-` keeps it.
  const keepSubject = input.subject === undefined || input.subject.trim() === "" || input.subject.trim() === "-";
  const exclude = Array.isArray(config.exclude) ? config.exclude.join(", ") : typeof config.exclude === "string" ? config.exclude : "";
  const plan = newsPlan({
    subject: keepSubject ? config.subject : (input.subject as string),
    // Left out keeps it; sent empty, or `-`, clears it.
    include: input.include !== undefined ? input.include : kindsOf(config.include).join("\n"),
    exclude: input.exclude !== undefined ? input.exclude : exclude,
    disambiguate: input.disambiguate !== undefined ? input.disambiguate : (config.disambiguate ?? ""),
    shows: input.shows !== undefined ? input.shows : config.shows === true,
    every: input.every ?? schedule.every,
  });
  if (!plan.ok) return plan;
  const patch: Omit<TaskPatch, "at"> = {};
  if (!same(plan.config, config)) patch.config = plan.config;
  const title = newsTitle(plan.config);
  if (title !== task.title) patch.title = title;
  let updated = await applyEdit(d, task, user, patch);
  let jobOut = false;
  if (task.schedule?.kind !== "calendar" || schedule.every !== plan.every) {
    // The count keeps its start day, so the runs stay on the same days, only further apart or closer.
    ({ task: updated, jobOut } = await rescheduleKeepingSnoozes(d, updated, user, { ...schedule, every: plan.every }, user.id));
  }
  return { ok: true, task: updated, text: savedText(updated, user, await nextRun(d, updated), d.clock.now(), "(news watch)", jobOut) };
}
