import { type Actor, createTask, formatInstant, parseWhen, type User } from "@rackbops/docket-core";
import { MAX_CONTEXT_CHARS, MAX_QUESTION_CHARS, parseSocial, platformName, type ResearchConfig, SOURCES_DEADLINE_MARGIN_MINUTES, SOURCES_WAIT_DAYS, type SocialPlatform, sourcesExpiry } from "@rackbops/docket-types";
import { clip, liveTaskCap, said, type TaskResult, type TrackerDeps } from "./actions.js";
import { MAX_SOCIAL, MAX_TITLE, MAX_WHEN } from "./limits.js";
import { awaitingPages, MAX_SOURCES_PER_TASK } from "./research-sources.js";

/** The least time a browser request leaves its browser to gather pages before its run, when a deadline brings that run forward. */
export const MIN_GATHER_MINUTES = 10;

/**
 * The one-off research request (category 5, plan 1.2 row 5; rackbops-bot-plugins#82): `/research`'s
 * rules over docket's `research` type, which runs on the execute lane through city-hall and the
 * runner (executor.ts, execute-lane.ts). Mapped as docket's core README "Adopting 0.5.0" says: the
 * optional `at` becomes the schedule `{ kind: "once", at: at ?? now }`, the optional `deadline` goes
 * into `config.deadline` as an ISO instant. The type declares only `notify` (tier 0), which
 * `createTask` grants; the plugin has no grants of its own to add. The budgets are docket's (5.7):
 * the execute lane checks the owner's and the global daily ceilings before each run and tells the
 * person and the admins once at a ceiling.
 *
 * `sources: browser` (0.28.0, docket-types 0.8.0's `sources: "sent"`, rackbops-bot-plugins#125):
 * the request answers from pages the owner's own browser gathers -- Claude in Chrome, when they ask
 * it to -- and sends in through the task API (research-sources.ts, web/api-sources.ts), for pages
 * a web run cannot or may not read: a web run tries BoardGameGeek (docket-types 0.10.0) and lists a
 * page that refuses it in `blocked`, for the fuller pass, and eBay is never opened. Its run is queued at the
 * latest it may wait, `SOURCES_WAIT_DAYS` from now or `SOURCES_DEADLINE_MARGIN_MINUTES` before the
 * deadline, whichever is sooner (docket-types' `sourcesExpiry`: a run started past the deadline makes no call), and
 * `sources/ready` moves it to now once the pages are in; so `at` is refused with it. A request whose
 * `ready` never comes runs then on whatever pages are in; with none, docket makes no model call,
 * tells the owner no pages were gathered for it, and ends it.
 */

export { MAX_CONTEXT_CHARS, MAX_QUESTION_CHARS } from "@rackbops/docket-types";

/**
 * Research requests one person may have waiting or running at once: each is up to about 3 USD of
 * model runs. A request waiting for pages for a fuller pass (`awaitingPages`, 0.29.0) does not
 * count: its first answer is already delivered, and it runs nothing until `ready` or its expiry.
 */
export const MAX_LIVE_RESEARCH = 5;

export const RESEARCH_OFF = "Research is not available on this bot yet: it needs the model runner, which is not set up here.";

/** Fewer than this many characters in `question` is refused (a stray "0" once went in that way). */
export const MIN_QUESTION_CHARS = 3;

export const SHORT_QUESTION =
  `Put the whole question in \`question\`: it needs at least ${MIN_QUESTION_CHARS} characters, with a letter in it. \`context\` is only for background.`;

/**
 * A question that is a stray character or two, or has no letter at all ("0"): what lands in
 * `question` when the real question went into `context` by mistake (task t2 on Clerk, 2026-10-04).
 * Refused before anything is made, so no model run is paid for it.
 */
function tooShort(question: string): boolean {
  return question.length < MIN_QUESTION_CHARS || !/\p{L}/u.test(question);
}

/** Where a request's pages come from: the runs search the web (the default), or the owner's own browser sends them in. */
export const RESEARCH_SOURCES = ["web", "browser"] as const;
export type ResearchSourcesChoice = (typeof RESEARCH_SOURCES)[number];

export const BROWSER_AT =
  "`at` does not go with `sources: browser`: the research starts when your browser has sent its pages in and said they are ready.";

export const BROWSER_OFF =
  "Research on pages your browser gathers needs this bot's web area: the pages are sent in through its task API, and this bot has no web area set up. Leave `sources` out to have the research search the web.";

export const SOCIAL_VALUES =
  "`social` is `auto`, `none`, or the platforms to search, separated by commas: `youtube`, `tiktok`, `instagram`, `bluesky`. Reddit is not one: the research never reads it.";

export const BROWSER_SOCIAL =
  "`social` and `since` do not go with `sources: browser`: the research answers from the pages your browser sends in and searches no platform.";

export const SINCE_FORMAT = "`since` is a day, as `2026-09-01` or `3 months ago`, on or before today.";

export interface ResearchInput {
  question: string;
  context?: string;
  at?: string;
  deadline?: string;
  /** `web` when unset. */
  sources?: string;
  /** docket-types 0.23.0's `social`: `auto` when unset, `none`, or the platforms to search. */
  social?: string;
  /** A day: posts before it do not count (0.43.0). */
  since?: string;
}

/** Today's calendar date in `zone`: year, month (1 to 12), day. */
function todayIn(now: Date, zone: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return [get("year"), get("month"), get("day")];
}

/**
 * `since` as a day: `YYYY-MM-DD`, or `N days|weeks|months|years ago` (`a`, `an` or `one` for 1),
 * counted from today in the person's zone. The day's UTC midnight, since docket counts whole UTC
 * days (`sinceOf`); so a person's own date never slips a day because their evening is already
 * tomorrow in UTC. Null when the text is not one of those, the date does not exist, or the day
 * lies after today. `parseWhen` is not used: it resolves only to an instant after now.
 */
export function parseSinceDay(text: string, now: Date, zone: string): Date | null {
  const raw = text.trim().toLowerCase().replace(/\s+/g, " ");
  const [y, m, d] = todayIn(now, zone);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const ago = /^(a|an|one|\d{1,3}) (day|week|month|year)s? ago$/.exec(raw);
  let at: Date;
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    // `setUTCFullYear` keeps the year as typed; `Date.UTC` would read `0026` as 1926.
    at = new Date(0);
    at.setUTCFullYear(year, month - 1, day);
    // A date that does not exist (2026-02-30) rolls over; refuse it rather than read a day nobody typed.
    if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  } else if (ago) {
    const count = /^\d/.test(String(ago[1])) ? Number(ago[1]) : 1;
    const unit = ago[2];
    if (unit === "day" || unit === "week") at = new Date(Date.UTC(y, m - 1, d - count * (unit === "week" ? 7 : 1)));
    else {
      const months = unit === "month" ? count : count * 12;
      const lastDay = new Date(Date.UTC(y, m - months, 0)).getUTCDate();
      at = new Date(Date.UTC(y, m - 1 - months, Math.min(d, lastDay)));
    }
  } else return null;
  if (Number.isNaN(at.getTime())) return null;
  return at.getTime() <= Date.UTC(y, m - 1, d) ? at : null;
}

/** Platform names in a sentence: "YouTube, TikTok and Bluesky". */
function names(platforms: readonly SocialPlatform[]): string {
  const list = platforms.map(platformName);
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** `/research question [context] [deadline] [at] [sources] [social] [since]`: one request, answered once by DM after a reviewer checks it. */
export async function createResearch(d: TrackerDeps, user: User, input: ResearchInput): Promise<TaskResult> {
  const type = d.types.research;
  if (!type || !d.research) return { ok: false, error: RESEARCH_OFF };
  const question = input.question.trim();
  if (question.length === 0) return { ok: false, error: "Say what to look into." };
  if (question.length > MAX_QUESTION_CHARS) return { ok: false, error: `That question is longer than ${MAX_QUESTION_CHARS} characters.` };
  if (tooShort(question)) return { ok: false, error: SHORT_QUESTION };
  const context = input.context?.trim() ?? "";
  if (context.length > MAX_CONTEXT_CHARS) return { ok: false, error: `\`context\` is longer than ${MAX_CONTEXT_CHARS} characters.` };
  const sources = input.sources?.trim().toLowerCase() || "web";
  if (!(RESEARCH_SOURCES as readonly string[]).includes(sources)) return { ok: false, error: "`sources` is `web` or `browser`." };
  const browser = sources === "browser";
  if (browser && !d.webEditor) return { ok: false, error: BROWSER_OFF };
  if (browser && input.at !== undefined && input.at.trim() !== "") return { ok: false, error: BROWSER_AT };
  // Social platforms (0.43.0, docket-types 0.23.0): which count, and from when. A browser request's
  // runs search no platform, so neither option goes with it.
  const socialRaw = input.social?.trim() ?? "";
  const sinceRaw = input.since?.trim() ?? "";
  if (socialRaw.length > MAX_SOCIAL) return { ok: false, error: `\`social\` is longer than ${MAX_SOCIAL} characters.` };
  const social = parseSocial(socialRaw);
  if (!social) return { ok: false, error: SOCIAL_VALUES };
  if (sinceRaw.length > MAX_WHEN) return { ok: false, error: `\`since\` is longer than ${MAX_WHEN} characters.` };
  // `auto` is the default and asks for nothing, so it passes with browser pages; a choice or a day does not.
  if (browser && (social.mode !== "auto" || sinceRaw !== "")) return { ok: false, error: BROWSER_SOCIAL };
  const now = d.clock.now();
  const since = sinceRaw === "" ? null : parseSinceDay(sinceRaw, now, user.timeZone);
  if (sinceRaw !== "" && !since) return { ok: false, error: SINCE_FORMAT };
  const when = (raw: string | undefined, name: string): Date | null | string => {
    if (raw === undefined || raw.trim() === "") return null;
    if (raw.trim().length > MAX_WHEN) return `\`${name}\` is longer than ${MAX_WHEN} characters.`;
    const parsed = parseWhen(raw, now, { zone: user.timeZone, defaultHour: user.preferredHour });
    return parsed.ok ? parsed.at : `\`${name}\`: ${parsed.error}`;
  };
  const at = when(input.at, "at");
  if (typeof at === "string") return { ok: false, error: at };
  const deadline = when(input.deadline, "deadline");
  if (typeof deadline === "string") return { ok: false, error: deadline };
  const start = at ?? now;
  if (deadline && deadline.getTime() <= Math.max(start.getTime(), now.getTime())) return { ok: false, error: "The deadline has to be after the research starts." };
  if (browser && deadline && deadline.getTime() - now.getTime() < (SOURCES_DEADLINE_MARGIN_MINUTES + MIN_GATHER_MINUTES) * 60_000) {
    return { ok: false, error: `With \`sources: browser\` the deadline has to be at least ${SOURCES_DEADLINE_MARGIN_MINUTES + MIN_GATHER_MINUTES} minutes away: the research starts ${SOURCES_DEADLINE_MARGIN_MINUTES} minutes before it, and your browser needs time to gather the pages first.` };
  }

  const capped = await liveTaskCap(d, user);
  if (capped) return { ok: false, error: capped };
  const live = [...(await d.store.listTasks({ ownerId: user.id, status: "active", type: "research" })), ...(await d.store.listTasks({ ownerId: user.id, status: "paused", type: "research" }))];
  let counted = 0;
  for (const t of live) if (!(await awaitingPages(d.store, t))) counted++;
  if (counted >= MAX_LIVE_RESEARCH) {
    return { ok: false, error: `You already have ${MAX_LIVE_RESEARCH} research requests waiting, the most one person may. Wait for one to be answered first.` };
  }

  const config: ResearchConfig = {
    question,
    ...(context.length > 0 ? { context } : {}),
    ...(deadline ? { deadline: deadline.toISOString() } : {}),
    ...(browser ? { sources: "sent" as const } : {}),
    // `auto` is the type's default and is not written; a list is kept as the platform ids, aliases resolved.
    ...(social.mode === "none" ? { social: "none" } : social.mode === "only" ? { social: social.platforms.join(",") } : {}),
    ...(since ? { since: since.toISOString() } : {}),
  };
  // A browser request's run waits as long as it may; `sources/ready` moves it to now.
  const expiry = sourcesExpiry(now, deadline);
  const runAt = browser ? expiry.at : start;
  const actor: Actor = { userId: user.id, admin: user.admin };
  const { task } = await createTask(d.store, actor, user, { type, title: clip(question, MAX_TITLE), config, schedule: { kind: "once", at: runAt.toISOString() } }, now);
  if (browser) {
    return {
      ok: true,
      task,
      text: clip(
        `Research \`${task.id}\` is waiting for pages: ${clip(question, 200)}\n` +
          `Ask Claude in Chrome to gather them in your own browser and send them in for \`${task.id}\` (up to ${MAX_SOURCES_PER_TASK} pages, through the task API's \`POST /api/v1/tasks/${task.id}/sources\`, then \`/sources/ready\`); ` +
          `the research starts when your browser sends ready. A second run checks the answer against the pages before I DM it to you. ` +
          `If ready never comes, it runs on ${formatInstant(expiry.at, user.timeZone, now)}${expiry.byDeadline ? ` (up to ${SOURCES_DEADLINE_MARGIN_MINUTES} minutes before your deadline)` : ` (in ${SOURCES_WAIT_DAYS} days)`} on whatever pages are in by then; with none, nothing is run. Requests share a daily budget.`,
      ),
    };
  }
  const starts = at ? `Starts ${formatInstant(at, user.timeZone, now)}` : "Starts within a minute or two";
  const by = deadline ? `; past ${formatInstant(deadline, user.timeZone, now)} nothing is run` : "";
  const posts = social.mode === "none" ? "; no social posts" : social.mode === "only" ? `; social posts from ${names(social.platforms)}` : "";
  const from = since ? `; posts dated before ${since.toISOString().slice(0, 10)} do not count` : "";
  return {
    ok: true,
    task,
    text: clip(
      `Research \`${task.id}\` queued: ${clip(question, 200)}\n${starts}${by}${posts}${from}. A second run checks the answer against its sources before I DM it to you, so it can take a while; ` +
        "an answer that does not pass the check is not sent. Requests share a daily budget.",
    ),
  };
}

export async function researchCommand(d: TrackerDeps, user: User, input: ResearchInput): Promise<string> {
  return said(await createResearch(d, user, input));
}
