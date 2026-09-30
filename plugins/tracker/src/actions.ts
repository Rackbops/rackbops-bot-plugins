import {
  ADMIN_DISCLOSURE,
  formatInstant,
  formatTaskList,
  Lanes,
  parseWhen,
  ReplyRefusedError,
  reschedule,
  SNOOZE_PREFIX,
  taskList,
  visibleTask,
  type Clock,
  type Fetch,
  type Notifier,
  type Schedule,
  type Store,
  type Task,
  type TaskListEntry,
  type TaskType,
  type User,
} from "@rackbops/docket-core";
import type { HostApi, PluginLog } from "../../../packages/api/contract.js";
import { decideAccess, type Membership, type Need } from "./access.js";
import type { Admissions } from "./admissions.js";
import { type DeliveryHealth, PAUSE_AFTER, resumedNotice } from "./delivery-health.js";
import { MAX_LIVE_TASKS, MAX_WHEN } from "./limits.js";
import { admit, PeopleError, setPreferences } from "./people.js";
import { heldRuns, restoreHeldRun } from "./retime.js";
import type { Roster } from "./roster.js";
import type { ApiTokens } from "./web/api-tokens.js";
import type { Sessions } from "./web/sessions.js";
import type { LoginLinks } from "./web/signin-link.js";

/**
 * What each slash command does (plan 5.5, 5.8, E2), with no discord.js in sight: discord.ts reads
 * the options, looks up membership, and renders the `content` these return, always ephemerally.
 * Everything touches the world only through the injected Store, clock and host `dm`.
 */

export interface TrackerDeps {
  store: Store;
  admissions: Admissions;
  health: DeliveryHealth;
  clock: Clock;
  types: Readonly<Record<string, TaskType<unknown>>>;
  /** Page reads for `/price`'s first look (fetch.ts); the poll tick makes its own, with its signal. */
  fetch: Fetch | null;
  dm: HostApi["dm"];
  log: PluginLog;
  /** Sends one DM through the tracker's Notifier (claims, buttons, the failure count). */
  notifier: Notifier;
  /** The web area's one-time sign-in links and its sessions (web/). */
  logins: LoginLinks;
  sessions: Sessions;
  /** The task API's personal bearer tokens (web/api-tokens.ts). */
  apiTokens: ApiTokens;
  /** The Discord ids `TRACKER_ADMIN_DISCORD_IDS` names: made admin at every start, so not revocable from the web. */
  configuredAdmins: ReadonlySet<string>;
  /** Whether a notify or poll tick is running, and a bounded wait for none to be (index.ts). */
  lanes: TickGate;
  /** People, blocks and forget-me's erasure: the SQL docket's Store has no method for (roster.ts). */
  roster: Roster;
  /** Whether the web area (and its task editor) is set up: `TRACKER_WEB_URL`. Answers mention it only then. */
  webEditor: boolean;
}

/** The ticks as forget-me sees them: whether one runs now, and a wait of at most `ms` for none to (false when it timed out). */
export interface TickGate {
  busy(): boolean;
  idle(ms: number): Promise<boolean>;
}

/** Discord's cap on a message; every answer is cut to it. */
export const MAX_ANSWER = 2000;

/** A two-turn action's second turn, when the person was forgotten (or removed) in between. */
export const NO_LONGER_LISTED = "You are no longer on this tracker's list.";

/** Never echoes the id a person typed: a typed id is theirs to see, not the bot's to repeat. */
export const NO_SUCH_TASK = "You have no task with that id. `/tasks` lists yours.";

export function clip(text: string, max = MAX_ANSWER): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export type Entry = { ok: true; user: User; notice: string | null } | { ok: false; content: string };

/**
 * The gates, then the resume: a paused person who shows up is resumed, and told why they were
 * paused (plan 5.5: "the owner is told"; the bot could not DM them).
 */
export async function enter(d: TrackerDeps, discordId: string, membership: Membership, need: Need): Promise<Entry> {
  const person = await d.store.findUserByDiscordId(discordId);
  const registered = person ? d.admissions.isRegistered(person.id) : false;
  const refusal = decideAccess({ membership, person, registered, need });
  if (refusal !== null || !person) return { ok: false, content: refusal ?? "" };
  const resumed = await d.health.resume(person.id, d.clock.now());
  return { ok: true, user: person, notice: resumed ? resumedNotice(resumed) : null };
}

/** `/allow @user` (plan 5.8): an admin admits a person, who can then `/register`. */
export async function allowPerson(
  d: TrackerDeps,
  admin: User,
  target: { discordId: string; bot: boolean; membership: Membership },
): Promise<string> {
  if (target.bot) return "A bot cannot use the tracker.";
  if (target.membership === "not-member") return `<@${target.discordId}> is not a member of this tracker's server.`;
  if (target.membership === "unknown") return "I could not check that they are a member of this tracker's server. Try again in a minute.";
  const before = await d.store.findUserByDiscordId(target.discordId);
  const now = d.clock.now();
  const user = await admit(d.store, target.discordId, now);
  d.admissions.record(user.id, admin.id, now.toISOString());
  if (before) return `<@${target.discordId}> is already on the list.`;
  return `Allowed <@${target.discordId}>: they can now use \`/register\`.`;
}

/** The reply to `/register`: when things arrive, and the disclosure (plan 1.1, 5.5, 5.8). */
export function registeredText(user: User, first: boolean): string {
  return [
    first ? "You are registered." : "Your settings are updated.",
    `Reminders reach you by DM. One without a time of day arrives at ${String(user.preferredHour).padStart(2, "0")}:00, ${user.timeZone} time.`,
    `Your tasks are private to you and anyone you choose to share them with. ${ADMIN_DISCLOSURE}`,
    `Keep DMs from this server open: after ${PAUSE_AFTER} DMs in a row that cannot be delivered, your reminders pause until you next use a command.`,
  ].join("\n");
}

/** `/register [hour] [zone]` (plan 5.8): the admitted person's first contact; running it again edits. */
export async function registerPerson(
  d: TrackerDeps,
  user: User,
  input: { displayName: string; hour?: number; zone?: string },
): Promise<string> {
  let updated: User;
  try {
    updated = await setPreferences(d.store, user.id, {
      ...(input.hour !== undefined ? { preferredHour: input.hour } : {}),
      ...(input.zone !== undefined ? { timeZone: input.zone } : {}),
    });
  } catch (err) {
    if (err instanceof PeopleError) return err.message;
    throw err;
  }
  updated = await d.store.updateUser(user.id, { displayName: clip(input.displayName, 100) });
  const first = !d.admissions.isRegistered(user.id);
  d.admissions.markRegistered(user.id, d.clock.now().toISOString());
  const zoneChanged = updated.timeZone !== user.timeZone;
  if (zoneChanged || updated.preferredHour !== user.preferredHour) await rescheduleOwned(d, updated, zoneChanged, user);
  return registeredText(updated, first);
}

/**
 * The web area's settings form (plan 5.10): the preferred hour and the zone together, validated as
 * `/register` validates them, with the same rescheduling. Returns null when saved, else the reason.
 */
export async function saveSettings(d: TrackerDeps, user: User, input: { hour: number; zone: string }): Promise<string | null> {
  let updated: User;
  try {
    updated = await setPreferences(d.store, user.id, { preferredHour: input.hour, timeZone: input.zone });
  } catch (err) {
    if (err instanceof PeopleError) return err.message;
    throw err;
  }
  const zoneChanged = updated.timeZone !== user.timeZone;
  if (zoneChanged || updated.preferredHour !== user.preferredHour) await rescheduleOwned(d, updated, zoneChanged, user);
  return null;
}

/** `/settings hour` (plan 1.1, 5.13): the hour a reminder without a time of day arrives. */
export async function setHour(d: TrackerDeps, user: User, hour: number): Promise<string> {
  if (hour === user.preferredHour) return `Your preferred hour is already ${String(hour).padStart(2, "0")}:00, ${user.timeZone} time.`;
  let updated: User;
  try {
    updated = await setPreferences(d.store, user.id, { preferredHour: hour });
  } catch (err) {
    if (err instanceof PeopleError) return err.message;
    throw err;
  }
  const moved = await rescheduleOwned(d, updated, false, user);
  const note = moved > 0 ? ` ${moved} recurring reminder(s) moved to it.` : "";
  return `Your preferred hour is now ${String(hour).padStart(2, "0")}:00, ${updated.timeZone} time.${note}`;
}

/**
 * A preferred-hour or zone edit cancels and replaces what is queued (plan 5.3): every active or
 * paused recurring task of the owner whose time depends on it -- all calendar and period tasks when the
 * zone moved, only those naming no hour when just the hour did. Returns how many moved.
 */
async function rescheduleOwned(d: TrackerDeps, owner: User, zoneChanged: boolean, before: User): Promise<number> {
  let moved = 0;
  // Paused ones too: a paused task keeps its queued run, which would otherwise fire at the old zone's
  // time on resume. docket's reschedule drops it and makes no next run for a paused task, so the run
  // it held is put back, re-timed to the new zone or hour for the same occurrence (retime.ts).
  const live = [...(await d.store.listTasks({ ownerId: owner.id, status: "active" })), ...(await d.store.listTasks({ ownerId: owner.id, status: "paused" }))];
  for (const task of live) {
    const s = task.schedule;
    if (!s || (s.kind !== "calendar" && s.kind !== "period")) continue;
    if (!zoneChanged && s.hour !== undefined) continue;
    const held = task.status === "paused" ? await heldRuns(d.store, task) : [];
    const updated = await rescheduleKeepingSnoozes(d, task, owner, s, owner.id);
    if (held.length > 0) await restoreHeldRun(d.store, updated, held, before, owner, d.clock.now());
    moved++;
  }
  return moved;
}

/**
 * docket's `reschedule` -- cancel what is queued, record the change, materialize the next run --
 * keeping the task's snoozes. docket drops every queued occurrence, a snooze's run included; a
 * snooze is an instant the person asked for, not a time the schedule computed, so it is put back as
 * it was (same due instant, same `snooze:` key, so its chain to the run it re-asks is unchanged).
 * The one path for a schedule change: a zone or hour move, and an edit on the web.
 */
export async function rescheduleKeepingSnoozes(d: TrackerDeps, task: Task, owner: User, schedule: Schedule, actorId: string): Promise<Task> {
  const snoozes = (await d.store.listOccurrences({ taskId: task.id, status: "queued" })).filter((o) => o.dedupeKey.startsWith(SNOOZE_PREFIX));
  const now = d.clock.now();
  const { task: updated } = await reschedule(d.store, task, owner, schedule, actorId, now);
  for (const o of snoozes) {
    await d.store.createOccurrence({ taskId: o.taskId, lane: o.lane, dueAt: o.dueAt, dedupeKey: o.dedupeKey, at: now.toISOString() });
  }
  return updated;
}

export type Plan<T> = ({ ok: true } & T) | { ok: false; error: string };

/** What a create or an edit did: the task and the words for it, or why not. */
export type TaskResult = { ok: true; task: Task; text: string } | { ok: false; error: string };

/** Why `owner` may not make another task, or null: at most `MAX_LIVE_TASKS` active and paused, all types together. */
export async function liveTaskCap(d: Pick<TrackerDeps, "store" | "webEditor">, owner: User): Promise<string | null> {
  const active = await d.store.listTasks({ ownerId: owner.id, status: "active" });
  const paused = await d.store.listTasks({ ownerId: owner.id, status: "paused" });
  if (active.length + paused.length < MAX_LIVE_TASKS) return null;
  const where = d.webEditor ? " or delete one on the web" : "";
  return `You already have ${MAX_LIVE_TASKS} active or paused tasks, the most one person may. Finish one${where} first.`;
}

/** A result as a command's answer. */
export function said(r: TaskResult | { ok: true; text: string }): string {
  return r.ok ? r.text : r.error;
}

/** A paused task of the person's, and who could not be DMed (empty when paused for another reason). */
export interface PausedTask {
  task: Task;
  held: string[];
}

/** What `/tasks` and the web area's "my tasks" show: the active list (docket's), then the paused ones. */
export async function loadTaskList(d: Pick<TrackerDeps, "store" | "health">, user: User): Promise<{ entries: TaskListEntry[]; paused: PausedTask[] }> {
  const entries = await taskList(d.store, { userId: user.id, admin: user.admin });
  const paused: PausedTask[] = [];
  for (const task of await d.store.listTasks({ ownerId: user.id, status: "paused" })) {
    const held = [];
    for (const id of d.health.pausesFor(task.id).filter((u) => u !== user.id)) held.push((await d.store.getUser(id))?.displayName ?? id);
    paused.push({ task, held });
  }
  return { entries, paused };
}

/** `/tasks`: the person's own active tasks and the ones they receive, plus their paused ones. */
export async function listTasks(d: TrackerDeps, user: User): Promise<string> {
  const { entries, paused } = await loadTaskList(d, user);
  const lines = [formatTaskList(entries, user, d.clock.now())];
  for (const { task, held } of paused) {
    if (held.length === 0) lines.push(`Paused: \`${task.id}\` ${task.title}`);
    else lines.push(`Paused: \`${task.id}\` ${task.title} -- I could not DM ${held.join(", ")}; \`/task resume ${task.id}\` goes on without them.`);
  }
  return clip(lines.join("\n"));
}

/** A Lanes for replies only: answering never sends, so its Notifier is the tracker's but unused. */
export function replyLanes(d: TrackerDeps): Lanes {
  return new Lanes({ store: d.store, clock: d.clock, types: d.types, notifier: d.notifier });
}

/** The task, when `user` owns it; null for an unknown id and for anyone else's alike. */
export async function ownTask(d: Pick<TrackerDeps, "store">, user: User, taskId: string): Promise<Task | null> {
  const task = await visibleTask(d.store, { userId: user.id, admin: false }, taskId.trim());
  return task && task.ownerId === user.id ? task : null;
}

/**
 * `/task done` and `/task snooze` (plan 5.5, item 34): the owner answers the task's latest fired
 * run -- the one docket's `Lanes.reply` asks a host to pick -- with docket deciding whether it may.
 */
export async function answerLatest(
  d: TrackerDeps,
  user: User,
  input: { taskId: string; kind: "done" | "snooze"; until?: string },
): Promise<string> {
  if (input.until !== undefined && input.until.trim().length > MAX_WHEN) return `\`until\` is longer than ${MAX_WHEN} characters.`;
  const task = await ownTask(d, user, input.taskId);
  if (!task) return NO_SUCH_TASK;
  const fired = (await d.store.listOccurrences({ taskId: task.id })).filter(
    (o) => o.status === "running" || o.status === "done" || o.status === "failed",
  );
  const latest = fired.at(-1);
  if (!latest) return "That task has not reminded you yet, so there is nothing to answer.";
  let payload: unknown = null;
  if (input.kind === "snooze" && input.until !== undefined && input.until.trim() !== "") {
    const parsed = parseWhen(input.until, d.clock.now(), { zone: user.timeZone, defaultHour: user.preferredHour });
    if (!parsed.ok) return parsed.error;
    payload = { until: parsed.at.toISOString() };
  }
  try {
    const outcome = await replyLanes(d).reply({ taskId: task.id, occurrenceId: latest.id, userId: user.id, kind: input.kind, payload });
    return answeredText(input.kind, outcome?.snoozeUntil ?? null, user, d.clock.now());
  } catch (err) {
    if (err instanceof ReplyRefusedError) return err.message;
    throw err;
  }
}

/** What an answered run says, on a button's message or a command's reply. */
export function answeredText(kind: string, snoozeUntil: Date | null, user: User, now: Date): string {
  if (kind === "snooze" && snoozeUntil) return `Snoozed until ${formatInstant(snoozeUntil, user.timeZone, now)}.`;
  if (kind === "done") return "Marked done.";
  return "Recorded.";
}
