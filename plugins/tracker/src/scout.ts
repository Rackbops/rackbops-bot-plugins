import { type Actor, type CalendarSchedule, createTask, describeSchedule, formatInstant, type TaskPatch, type User, wallClock } from "@rackbops/docket-core";
import { clip, liveTaskCap, type Plan, rescheduleKeepingSnoozes, type TaskResult, type TrackerDeps } from "./actions.js";
import { applyEdit, busyTask, nextRun, owned, refusingScheduleError, same, savedText } from "./edit.js";
import { MAX_TITLE } from "./limits.js";
import { LENSES, type Lens, MAX_FOR_CHARS, MAX_INTEREST_CHARS, MAX_INTERESTS, MAX_SCOUT_NOTES, SCOUT_MAX_BUDGET_USD, type ScoutConfig } from "@rackbops/docket-types";

/**
 * The interest scout's rules (category 1, plan 1.2 row 1; rackbops-bot-plugins#83): `/scout new`
 * and `/scout edit`, and the web editor and the task API through the same calls, over the scout
 * type (docket-types' `scout`). Like `/research` it is made only while the execute lane runs (`d.research`);
 * unlike a research request it is edited in place, since the interest list "must be editable"
 * (plan 1.2). A scout runs every N days at the owner's preferred hour, so a `/settings hour` change
 * moves it with their reminders (actions.ts `rescheduleOwned`).
 */

export const SCOUT_OFF = "The interest scout is not available on this bot yet: it needs the model runner, which is not set up here.";

/** Scouts one person may have active or paused: each run can cost up to 1.50 USD of a 2 USD day. */
export const MAX_LIVE_SCOUTS = 3;
export const DEFAULT_SCOUT_EVERY = 1;
export const MAX_SCOUT_EVERY = 30;
/** The interests as typed, before they are split. */
export const MAX_INTERESTS_TEXT = 1000;

export interface ScoutInput {
  /** Separated by commas, semicolons or new lines. */
  interests: string;
  lens?: string;
  for?: string;
  notes?: string;
  every?: number;
}

/** Every field optional: one left out keeps the scout's own; an empty `for` or `notes`, or `-` (Discord sends no empty option), clears it. */
export interface ScoutEdit {
  interests?: string;
  lens?: string;
  for?: string;
  notes?: string;
  every?: number;
}

/** The interests as a list: split, trimmed, without repeats (ignoring case), or why not. */
export function parseInterests(raw: string): string[] | string {
  if (raw.trim().length > MAX_INTERESTS_TEXT) return `\`interests\` is longer than ${MAX_INTERESTS_TEXT} characters.`;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\n]/)) {
    const interest = part.trim().replace(/\s+/g, " ");
    if (interest.length === 0 || seen.has(interest.toLowerCase())) continue;
    if (interest.length > MAX_INTEREST_CHARS) return `Each interest is at most ${MAX_INTEREST_CHARS} characters; "${clip(interest, 40)}" is longer.`;
    seen.add(interest.toLowerCase());
    out.push(interest);
  }
  if (out.length === 0) return "Name at least one interest, separated by commas: for example `birding, sourdough, cozy mysteries`.";
  if (out.length > MAX_INTERESTS) return `At most ${MAX_INTERESTS} interests; that is ${out.length}.`;
  return out;
}

/** Always begins "Scout", which the DMs lead with. */
export function scoutTitle(config: ScoutConfig): string {
  const lens = config.lens === "general" ? "" : ` (${config.lens})`;
  const base = config.for ? `Scout for ${config.for}` : `Scout: ${config.interests.join(", ")}`;
  return clip(`${clip(base, MAX_TITLE - lens.length)}${lens}`, MAX_TITLE);
}

/** The interests, lens, who and notes as a config, and the days between runs; or why not. */
export function scoutPlan(input: ScoutInput): Plan<{ config: ScoutConfig; every: number }> {
  const interests = parseInterests(input.interests);
  if (typeof interests === "string") return { ok: false, error: interests };
  const lens = (input.lens ?? "general").trim() || "general";
  if (!(LENSES as readonly string[]).includes(lens)) return { ok: false, error: "`lens` is general, birthday, anniversary or christmas." };
  // `-` is "none": Discord sends no empty option, so `/scout new` and `/scout edit` both take it.
  const none = (v: string | undefined) => (v === undefined || v.trim() === "-" ? "" : v);
  const who = none(input.for).trim().replace(/\s+/g, " ");
  if (who.length > MAX_FOR_CHARS) return { ok: false, error: `\`for\` is longer than ${MAX_FOR_CHARS} characters.` };
  const notes = none(input.notes).trim();
  if (notes.length > MAX_SCOUT_NOTES) return { ok: false, error: `\`notes\` is longer than ${MAX_SCOUT_NOTES} characters.` };
  const every = input.every ?? DEFAULT_SCOUT_EVERY;
  if (!Number.isInteger(every) || every < 1 || every > MAX_SCOUT_EVERY) return { ok: false, error: `\`every\` is a whole number of days from 1 to ${MAX_SCOUT_EVERY}.` };
  const config: ScoutConfig = { interests, lens: lens as Lens, ...(who ? { for: who } : {}), ...(notes ? { notes } : {}) };
  return { ok: true, config, every };
}

/** Every `every` days from today, at the owner's preferred hour (no hour of its own, so it follows theirs). */
export function scoutSchedule(every: number, zone: string, now: Date): CalendarSchedule {
  const w = wallClock(now, zone);
  const start = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
  return { kind: "calendar", every, unit: "day", start };
}

async function liveScouts(d: TrackerDeps, user: User): Promise<number> {
  const active = await d.store.listTasks({ ownerId: user.id, status: "active", type: "scout" });
  const paused = await d.store.listTasks({ ownerId: user.id, status: "paused", type: "scout" });
  return active.length + paused.length;
}

/** `/scout new`: a scout that searches every N days and DMs what it finds. */
export async function createScout(d: TrackerDeps, user: User, input: ScoutInput): Promise<TaskResult> {
  const type = d.types.scout;
  if (!type || !d.research) return { ok: false, error: SCOUT_OFF };
  const plan = scoutPlan(input);
  if (!plan.ok) return plan;
  const capped = await liveTaskCap(d, user);
  if (capped) return { ok: false, error: capped };
  if ((await liveScouts(d, user)) >= MAX_LIVE_SCOUTS) {
    return { ok: false, error: `You already have ${MAX_LIVE_SCOUTS} scouts, the most one person may. Delete or change one instead.` };
  }
  const now = d.clock.now();
  const actor: Actor = { userId: user.id, admin: user.admin };
  const schedule = scoutSchedule(plan.every, user.timeZone, now);
  const { task, next } = await createTask(d.store, actor, user, { type, title: scoutTitle(plan.config), config: plan.config, schedule }, now);
  const first = next ? formatInstant(next.dueAt, user.timeZone, now) : "not scheduled";
  return {
    ok: true,
    task,
    text: clip(
      `Scout \`${task.id}\` made: ${describeSchedule(schedule, user, user.timeZone, now)}. First run ${first}.\n` +
        `Each run looks on the web for 5 to 10 new things that fit ${plan.config.interests.length} interest(s) and DMs them to you; a link it showed you before is not shown again. ` +
        `A run can cost up to ${SCOUT_MAX_BUDGET_USD.toFixed(2)} USD of the daily model budget. \`/scout edit ${task.id}\` changes the interests.`,
    ),
  };
}

export function editScout(d: TrackerDeps, user: User, taskId: string, input: ScoutEdit): Promise<TaskResult> {
  return d.locks.turn(taskId.trim(), () => refusingScheduleError(() => editScoutLocked(d, user, taskId, input)), busyTask);
}

async function editScoutLocked(d: TrackerDeps, user: User, taskId: string, input: ScoutEdit): Promise<TaskResult> {
  const task = await owned(d, user, taskId, "scout");
  if (typeof task === "string") return { ok: false, error: task };
  const config = task.config as ScoutConfig;
  const schedule = task.schedule?.kind === "calendar" ? task.schedule : scoutSchedule(DEFAULT_SCOUT_EVERY, user.timeZone, d.clock.now());
  const keep = (v: string | undefined): v is undefined => v === undefined || v.trim() === "";
  const cleared = (v: string | undefined): string | undefined => (v !== undefined && v.trim() === "-" ? "" : v);
  input = { ...input, ...(input.for !== undefined ? { for: cleared(input.for) as string } : {}), ...(input.notes !== undefined ? { notes: cleared(input.notes) as string } : {}) };
  const plan = scoutPlan({
    interests: keep(input.interests) ? config.interests.join("\n") : input.interests,
    lens: keep(input.lens) ? config.lens : input.lens,
    // An empty `for` or `notes` clears it; left out keeps it.
    ...(input.for !== undefined ? { for: input.for } : config.for !== undefined ? { for: config.for } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : config.notes !== undefined ? { notes: config.notes } : {}),
    every: input.every ?? schedule.every,
  });
  if (!plan.ok) return plan;
  const patch: Omit<TaskPatch, "at"> = {};
  if (!same(plan.config, config)) patch.config = plan.config;
  const title = scoutTitle(plan.config);
  if (title !== task.title) patch.title = title;
  let updated = await applyEdit(d, task, user, patch);
  let jobOut = false;
  if (task.schedule?.kind !== "calendar" || schedule.every !== plan.every) {
    // The count keeps its start day, so the runs stay on the same days, only further apart or closer.
    ({ task: updated, jobOut } = await rescheduleKeepingSnoozes(d, updated, user, { ...schedule, every: plan.every }, user.id));
  }
  return { ok: true, task: updated, text: savedText(updated, user, await nextRun(d, updated), d.clock.now(), "(scout)", jobOut) };
}
