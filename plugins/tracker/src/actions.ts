import {
  ADMIN_DISCLOSURE,
  createTask,
  describeSchedule,
  formatInstant,
  formatTaskList,
  Lanes,
  parseWhen,
  ReplyRefusedError,
  reschedule,
  SNOOZE_PREFIX,
  taskList,
  visibleTask,
  wallClock,
  type Actor,
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
import { admit, PeopleError, setPreferences } from "./people.js";
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
}

/** Discord's cap on a message; every answer is cut to it. */
export const MAX_ANSWER = 2000;
/** The longest reminder text: it goes out as the DM itself. */
export const MAX_REMINDER_TEXT = 1500;
const MAX_TITLE = 100;

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
  if (zoneChanged || updated.preferredHour !== user.preferredHour) await rescheduleOwned(d, updated, zoneChanged);
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
  if (zoneChanged || updated.preferredHour !== user.preferredHour) await rescheduleOwned(d, updated, zoneChanged);
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
  const moved = await rescheduleOwned(d, updated, false);
  const note = moved > 0 ? ` ${moved} recurring reminder(s) moved to it.` : "";
  return `Your preferred hour is now ${String(hour).padStart(2, "0")}:00, ${updated.timeZone} time.${note}`;
}

/**
 * A preferred-hour or zone edit cancels and replaces what is queued (plan 5.3): every active
 * recurring task of the owner whose time depends on it -- all calendar and period tasks when the
 * zone moved, only those naming no hour when just the hour did. Returns how many moved.
 *
 * docket's `reschedule` drops every queued occurrence, a snooze's run included; a snooze is an
 * instant the person asked for, not a time the schedule computed, so it is put back as it was
 * (same due instant, same `snooze:` key, so its chain to the run it re-asks is unchanged).
 */
async function rescheduleOwned(d: TrackerDeps, owner: User, zoneChanged: boolean): Promise<number> {
  let moved = 0;
  for (const task of await d.store.listTasks({ ownerId: owner.id, status: "active" })) {
    const s = task.schedule;
    if (!s || (s.kind !== "calendar" && s.kind !== "period")) continue;
    if (!zoneChanged && s.hour !== undefined) continue;
    const snoozes = (await d.store.listOccurrences({ taskId: task.id, status: "queued" })).filter((o) => o.dedupeKey.startsWith(SNOOZE_PREFIX));
    const now = d.clock.now();
    await reschedule(d.store, task, owner, s, owner.id, now);
    for (const o of snoozes) {
      await d.store.createOccurrence({ taskId: o.taskId, lane: o.lane, dueAt: o.dueAt, dedupeKey: o.dedupeKey, at: now.toISOString() });
    }
    moved++;
  }
  return moved;
}

export type Repeat = "none" | "day" | "week" | "month";

/**
 * The schedule `/remind` asks for, pure. A one-off needs a `when`; a repeating reminder starts on
 * the `when`'s day at its time, or, with no `when`, today at the person's preferred hour.
 */
export function reminderSchedule(when: Date | null, repeat: Repeat, zone: string, now: Date): Schedule | string {
  if (repeat === "none") {
    if (!when) return 'Say when: for example "in 20 minutes", "tomorrow 9am" or "friday at 17:30".';
    return { kind: "once", at: when.toISOString() };
  }
  const w = wallClock(when ?? now, zone);
  const start = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
  const base = { kind: "calendar" as const, every: 1, unit: repeat, start };
  if (!when) return base;
  return {
    ...base,
    hour: w.hour,
    minute: w.minute,
    ...(repeat === "week" ? { weekdays: [w.weekday] } : {}),
    ...(repeat === "month" ? { dayOfMonth: w.day } : {}),
  };
}

/** `/remind text [when] [repeat]` (category 4, plan 1.2): docket's `reminder` type. */
export async function remind(d: TrackerDeps, user: User, input: { text: string; when?: string; repeat: Repeat }): Promise<string> {
  const type = d.types.reminder;
  if (!type) return "Reminders are not available on this bot.";
  const text = input.text.trim();
  if (text.length === 0) return "Say what to remind you of.";
  if (text.length > MAX_REMINDER_TEXT) return `That reminder is longer than ${MAX_REMINDER_TEXT} characters.`;
  const now = d.clock.now();
  let when: Date | null = null;
  if (input.when !== undefined && input.when.trim() !== "") {
    const parsed = parseWhen(input.when, now, { zone: user.timeZone, defaultHour: user.preferredHour });
    if (!parsed.ok) return parsed.error;
    when = parsed.at;
  }
  const schedule = reminderSchedule(when, input.repeat, user.timeZone, now);
  if (typeof schedule === "string") return schedule;
  const actor: Actor = { userId: user.id, admin: user.admin };
  const { task, next } = await createTask(d.store, actor, user, { type, title: clip(text, MAX_TITLE), config: { text }, schedule }, now);
  const at = next ? formatInstant(next.dueAt, user.timeZone, now) : "never (that time has no next run)";
  const cadence = schedule.kind === "once" ? "" : `, ${describeSchedule(schedule, user, user.timeZone, now)}`;
  return clip(`Reminder \`${task.id}\` set: ${text}\nNext: ${at}${cadence}.`);
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

async function ownTask(d: TrackerDeps, user: User, taskId: string) {
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

/** `/task resume` (plan 5.5): the owner goes on without the recipients whose DMs failed. */
export async function resumeTask(d: TrackerDeps, user: User, taskId: string): Promise<string> {
  const task = await ownTask(d, user, taskId);
  if (!task) return NO_SUCH_TASK;
  const removed = await d.health.resumeTask(task, user.id, d.clock.now());
  if (removed === null) return task.status === "paused" ? "That task was not paused by failed DMs." : `That task is ${task.status}, not paused.`;
  const names = [];
  for (const id of removed) names.push((await d.store.getUser(id))?.displayName ?? id);
  const without = names.length > 0 ? `, without ${names.join(", ")}` : "";
  return `Resumed \`${task.id}\`${without}.`;
}
