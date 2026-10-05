import { formatInstant, hasFired, wallClock, zonedInstant, type Notifier, type Occurrence, type Store, type Task, type User } from "@rackbops/docket-core";
import type { PluginLog } from "../../../packages/api/contract.js";
import type { DeliveryHealth } from "./delivery-health.js";

/**
 * The daily "today and overdue" digest (plan 5.5): one DM per person a day, at their preferred hour
 * in their own zone, listing what of theirs is due today and what is overdue. Notify lane only: it
 * runs on the `notify` tick after the due runs, reads the Store, and never calls a model.
 *
 * Exactly once per person per day, by research-triage's claim pattern (plan 3, `digest_last_sent_at`):
 * the day is claimed before the person's tasks are read or anything is sent -- docket's once-only `claimNotice`, keyed
 * `digest:<user>:<YYYY-MM-DD>` in the person's zone -- so a restart, a second tick, or a tick the host
 * abandoned can never send it twice. A crash between the claim and the send loses that day's digest
 * rather than doubling it, as a claimed delivery is never resent (plan 5.5). The claim is made even
 * when nothing is due, so the day is looked at once, at the hour, and a reminder made later that day
 * does not set off a digest of its own. A person whose delivery is paused (delivery-health.ts) is
 * passed by without a claim, so their digest goes out later that day if the pause lifts.
 *
 * What it lists: the person's own active reminders and renewals (`DIGEST_TYPES`), the two kinds of
 * task whose runs wait on an answer (done, or a renewal's keep / cancel / renewed). The others --
 * price checks, want-list watches, scouts, research -- run on their own and owe nothing, so they
 * would only be noise here. Only tasks the person owns: only the owner answers a run (item 34).
 *
 * - Due today: a run not yet fired that falls due today, and the task's latest fired run when it
 *   fell due today and is not answered yet.
 * - Overdue: the task's latest fired run when it fell due before today and is not answered. A run
 *   that was snoozed is not overdue: its snooze run is what is due. An older run behind a newer one
 *   is not listed: the newer run is what waits on the person.
 *
 * A renewal's run is its ask, `lead` days before the date, so an overdue renewal's line says "asked",
 * not "due". docket keeps one scheduled run queued at a time, so a reminder that comes twice a day
 * shows its next run only; a run that never fired (the lane was off) is in neither list until it
 * fires.
 *
 * Late but same-day: the digest goes at the first `notify` tick at or after the hour, so one the bot
 * was down for goes out when it is back, until the person's midnight; a day missed entirely is not
 * sent the next day.
 */

/** The task types a digest lists: those whose runs wait on the owner's answer. */
export const DIGEST_TYPES: ReadonlySet<string> = new Set(["reminder", "renewal"]);

/** The replies that answer a run: a reminder's done, a renewal's decision. A snooze moves it instead. */
const ANSWERS: ReadonlySet<string> = new Set(["done", "decision"]);

/** Lines shown per section; the rest is counted. */
export const MAX_LINES = 10;

/** docket's once-only notice key for a person's digest on one local day. */
export function digestKey(userId: string, day: string): string {
  return `digest:${userId}:${day}`;
}

/** The person's local day at `now` (`YYYY-MM-DD`), and the instants it starts and ends. */
export function localDay(now: Date, zone: string): { day: string; start: Date; end: Date; hour: number } {
  const w = wallClock(now, zone);
  const next = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
  return {
    day: `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`,
    start: zonedInstant(w.year, w.month, w.day, 0, 0, zone),
    end: zonedInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, zone),
    hour: w.hour,
  };
}

export interface DigestItem {
  task: Task;
  run: Occurrence;
  /** The run has fired (its message went out) and waits on an answer. */
  waiting: boolean;
}

export interface Digest {
  overdue: DigestItem[];
  today: DigestItem[];
}

/** What the person's digest lists for the day `[start, end)`. Reads only. */
export async function collectDigest(store: Store, user: User, start: Date, end: Date): Promise<Digest> {
  const from = start.toISOString();
  const to = end.toISOString();
  const overdue: DigestItem[] = [];
  const today: DigestItem[] = [];
  for (const task of await store.listTasks({ ownerId: user.id, status: "active" })) {
    if (!DIGEST_TYPES.has(task.type)) continue;
    const runs = await store.listOccurrences({ taskId: task.id });
    const last = runs.filter(hasFired).at(-1);
    if (last && last.status !== "snoozed" && !(await answered(store, task, last))) {
      (last.dueAt < from ? overdue : today).push({ task, run: last, waiting: true });
    }
    for (const run of runs) {
      if (run.status === "queued" && !hasFired(run) && run.dueAt >= from && run.dueAt < to) today.push({ task, run, waiting: false });
    }
  }
  const byDue = (a: DigestItem, b: DigestItem) => (a.run.dueAt < b.run.dueAt ? -1 : a.run.dueAt > b.run.dueAt ? 1 : 0);
  return { overdue: overdue.sort(byDue), today: today.sort(byDue) };
}

async function answered(store: Store, task: Task, run: Occurrence): Promise<boolean> {
  return (await store.listReplies(task.id)).some((r) => r.occurrenceId === run.id && r.userId === task.ownerId && ANSWERS.has(r.kind));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Mon Oct 5`, the person's date at `now`. */
function dateLabel(now: Date, zone: string): string {
  const w = wallClock(now, zone);
  return `${WEEKDAYS[w.weekday]} ${MONTHS[w.month - 1]} ${w.day}`;
}

function clockTime(instant: string, zone: string): string {
  const w = wallClock(new Date(instant), zone);
  return `${w.hour}:${String(w.minute).padStart(2, "0")}`;
}

function waitingOn(task: Task): string {
  return task.type === "renewal" ? "waiting on your keep, cancel or renewed" : "not marked done yet";
}

function section(title: string, items: readonly DigestItem[], line: (item: DigestItem) => string): string[] {
  if (items.length === 0) return [];
  const lines = [title, ...items.slice(0, MAX_LINES).map(line)];
  if (items.length > MAX_LINES) lines.push(`- and ${items.length - MAX_LINES} more`);
  return lines;
}

/** The digest as one DM, in the person's zone; null when there is nothing to list. */
export function formatDigest(digest: Digest, user: User, now: Date): string | null {
  if (digest.overdue.length === 0 && digest.today.length === 0) return null;
  const zone = user.timeZone;
  const title = (t: Task) => (t.title.length > 80 ? `${t.title.slice(0, 77)}...` : t.title);
  const lines = [
    `Your day, ${dateLabel(now, zone)}:`,
    ...section("**Overdue**", digest.overdue, (i) => `- \`${i.task.id}\` ${title(i.task)} -- ${i.task.type === "renewal" ? "asked" : "due"} ${formatInstant(i.run.dueAt, zone, now)}, ${waitingOn(i.task)}`),
    ...section("**Due today**", digest.today, (i) =>
      i.waiting ? `- \`${i.task.id}\` ${title(i.task)} -- ${clockTime(i.run.dueAt, zone)}, ${waitingOn(i.task)}` : `- \`${i.task.id}\` ${title(i.task)} -- ${clockTime(i.run.dueAt, zone)}`,
    ),
    "`/task done` marks a reminder done, `/task decide` answers a renewal, `/task snooze` puts either off; `/tasks` lists everything.",
  ];
  // The notifier cuts a message past Discord's bound (notifier.ts `toHostMessage`).
  return lines.join("\n");
}

export interface DigestDeps {
  store: Store;
  notifier: Notifier;
  log: PluginLog;
  health?: DeliveryHealth;
}

export interface DigestResult {
  /** Days claimed this pass (a digest sent, or nothing to send). */
  claimed: number;
  sent: number;
  failed: number;
}

/**
 * One pass over everyone: each person whose preferred hour has come today, and whose day is not yet
 * claimed, gets their day claimed and, when anything is listed, their digest. Stops between people
 * once `signal` aborts; whoever is left goes on the next tick.
 */
export async function runDigests(d: DigestDeps, now: Date, signal?: AbortSignal): Promise<DigestResult> {
  const result: DigestResult = { claimed: 0, sent: 0, failed: 0 };
  for (const user of await d.store.listUsers()) {
    if (signal?.aborted) break;
    let day: ReturnType<typeof localDay>;
    try {
      day = localDay(now, user.timeZone);
    } catch (err) {
      d.log.warn(`digest: ${user.id} has a time zone the clock cannot read (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (day.hour < user.preferredHour) continue;
    if (d.health?.isPaused(user.id)) continue;
    if (!(await d.store.claimNotice(digestKey(user.id, day.day), now.toISOString()))) continue;
    result.claimed++;
    let text: string | null;
    try {
      text = formatDigest(await collectDigest(d.store, user, day.start, day.end), user, now);
    } catch (err) {
      d.log.error(`digest: could not read ${user.id}'s day; today's digest is skipped`, err);
      result.failed++;
      continue;
    }
    if (text === null) continue;
    try {
      await d.notifier.sendDm(user.id, { text });
      result.sent++;
    } catch (err) {
      // Claimed, so never resent: the notifier has counted a closed DM toward the person's pause.
      d.log.warn(`digest: today's digest to ${user.id} did not go out (${err instanceof Error ? err.message : String(err)}); it is not resent`);
      result.failed++;
    }
  }
  return result;
}
