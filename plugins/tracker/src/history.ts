import {
  type Delivery,
  describeSchedule,
  formatInstant,
  visibleFindings,
  visibleTask,
  type Occurrence,
  type StoredFinding,
  type Reply,
  type Task,
  type TaskEvent,
  type User,
} from "@rackbops/docket-core";
import { clip, NO_SUCH_TASK, oneLine, pagesNote, type TrackerDeps } from "./actions.js";
import { isRecipientPause, PERSON_REF, pauseNames } from "./delivery-health.js";
import { IN_CONVERSATION } from "./intake-store.js";
import { errorNamesOther } from "./roster.js";
import type { ChangesTail, RunsTail } from "./store.js";

/**
 * `/task history` (plan 1.3 "History", 5.10): a task's newest runs -- when each was due, how it went,
 * how the owner answered it, what anyone replied -- and its newest changes, older ones counted, newest
 * last, for whoever docket's authorized read lets see the task (owner, accepted recipient, or an admin).
 */

/** Runs and changes shown; older ones are summarized by count. */
export const HISTORY_RUNS = 10;
export const HISTORY_CHANGES = 5;

function replyText(r: Reply): string {
  if (r.kind === "text") {
    const text = typeof r.payload === "object" && r.payload !== null ? String((r.payload as { text?: unknown }).text ?? "") : "";
    // One line even when it was kept before #205, line breaks and all.
    return `replied "${clip(oneLine(text), 80)}"`;
  }
  if (r.kind === "decision") return `chose ${String((r.payload as { choice?: unknown } | null)?.choice ?? "?")}`;
  return r.kind === "opt_out" ? "opted out" : r.kind;
}

/** One run, in words: the Discord text and the web page both render this. */
export interface RunView {
  due: string;
  status: string;
  late: boolean;
  /** The failure, clipped; null unless the run failed with one. */
  error: string | null;
  /** `Larry replied "..."`, `Curly opted out`: plain text, one line each; Discord's rendering (`runLine`) escapes them. */
  answers: string[];
  /** How the run's message went out (`loadHistory` only; the task API shows it, #369). */
  delivery?: RunDelivery;
}

/**
 * How one run's message went out, from docket's deliveries (plan 5.5), for the task API (#369):
 *
 * - `not_run`: the run has not fired yet, so nothing was planned.
 * - `nothing_to_send`: it ran and had no message for anyone (a price that did not move).
 * - `sending`: a copy is still owed: not tried yet, out now, or failed or deferred with a retry to come.
 * - `delivered`: every copy went out.
 * - `unconfirmed`: a send failed in a way that does not say whether it went out; it is never resent.
 * - `failed`: a copy failed for good; `reason` says why.
 *
 * A copy that failed for good outweighs one unconfirmed, which outweighs one still owed.
 */
export type DeliveryState = "not_run" | "nothing_to_send" | "sending" | "delivered" | "unconfirmed" | "failed";

export interface DeliverySend {
  /** The recipient, as they are called now. */
  to: string;
  status: Delivery["status"];
  /** Why it failed, was deferred, or is unconfirmed; clipped. */
  error: string | null;
}

export interface RunDelivery {
  state: DeliveryState;
  /** The first final failure's (or unconfirmed send's) error, clipped; null otherwise. */
  reason: string | null;
  /** Each copy the viewer may see: every one for the owner or an admin, only their own for a recipient (#273). */
  sends: DeliverySend[];
}

/** A copy still owed: a retry is set (`pending`, `deferred`, `failed` with tries left), or the send is out. */
function owed(r: Delivery): boolean {
  return r.retryAt !== null || r.status === "claimed" || r.status === "pending";
}

/** Pure: a run's delivery state from its delivery rows, as `viewer` may see them. */
export function deliveryView(o: Occurrence, rows: readonly Delivery[], people: ReadonlyMap<string, User>, viewer: User, seesEveryone: boolean): RunDelivery {
  const shown = seesEveryone ? rows : rows.filter((r) => r.userId === viewer.id);
  const sends = shown.map((r) => ({ to: people.get(r.userId)?.displayName ?? r.userId, status: r.status, error: r.error ? clip(r.error, 120) : null }));
  if (rows.length === 0) {
    const fired = o.record !== null || (o.status !== "queued" && o.status !== "running");
    return { state: fired ? "nothing_to_send" : "not_run", reason: null, sends };
  }
  const lost = shown.find((r) => r.status === "failed" && !owed(r));
  if (lost) return { state: "failed", reason: lost.error ? clip(lost.error, 120) : null, sends };
  const unsure = shown.find((r) => r.status === "unconfirmed");
  if (unsure) return { state: "unconfirmed", reason: unsure.error ? clip(unsure.error, 120) : null, sends };
  if (shown.some(owed)) return { state: "sending", reason: null, sends };
  // A recipient with no copy of their own (one added after the run) sees it as the task's: sent.
  return { state: rows.some(owed) ? "sending" : "delivered", reason: null, sends };
}

export interface ChangeView {
  at: string;
  /** `created`, `recipient added`, ... */
  kind: string;
  /** Shown for a pause or a resume, and `in conversation` on a task the intake made (intake.ts). */
  detail: string | null;
}

/** A failed run's error as a recipient other than the one it names sees it (#273). */
export const OTHER_RECIPIENT_ERROR = "a recipient cannot be messaged";

/**
 * `seesEveryone`: the viewer owns the task or is an admin. Anyone else is not shown an error that
 * names another recipient (a run from before 0.9.0 stored `recipient <id> cannot be messaged` and
 * the like, roster.ts `errorForms`), only `OTHER_RECIPIENT_ERROR` (#273).
 */
export function runView(o: Occurrence, replies: readonly Reply[], people: ReadonlyMap<string, User>, viewer: User, now: Date, seesEveryone: boolean): RunView {
  const error = o.status === "failed" && o.error ? (seesEveryone || !errorNamesOther(o.error, viewer.id) ? clip(o.error, 120) : OTHER_RECIPIENT_ERROR) : null;
  return {
    due: formatInstant(o.dueAt, viewer.timeZone, now),
    status: o.status,
    late: o.late,
    error,
    answers: replies.filter((r) => r.occurrenceId === o.id).map((r) => `${people.get(r.userId)?.displayName ?? r.userId} ${replyText(r)}`),
  };
}

export function changeView(e: TaskEvent, viewer: User, now: Date, names: ReadonlyMap<string, string> = new Map()): ChangeView {
  const detail =
    e.kind === "paused" || e.kind === "resumed"
      ? e.detail.replace(PERSON_REF, (_, id: string) => names.get(id) ?? "someone no longer on the tracker")
      : (e.kind === "created" || e.kind === "edited" || e.kind === "schedule_changed") && e.detail.endsWith(IN_CONVERSATION)
        ? IN_CONVERSATION.trim()
        : null;
  return { at: formatInstant(e.at, viewer.timeZone, now), kind: e.kind.replaceAll("_", " "), detail };
}

/**
 * Shown as typed in Discord: a backslash before each `\`, `[`, `]`, `<`, `|` and backtick, and before
 * a `(` right after a `]` -- Discord's link text ignores escapes, so a `[` elsewhere on the message (a
 * title, another line) could still pair with an escaped `]`. No masked link, spoiler or code renders
 * from a reply; a mention or timestamp typed right after a bare link still can (the link takes the
 * backslash), and `NO_MENTIONS` keeps it from pinging.
 */
function discordPlain(text: string): string {
  return text.replace(/[\\[\]<|`]|(?<=\])\(/g, "\\$&");
}

function runLine(v: RunView): string {
  const late = v.late ? " (late)" : "";
  const error = v.error ? `: ${v.error}` : "";
  const answered = v.answers.length > 0 ? `; ${v.answers.map(discordPlain).join(", ")}` : "";
  return `- ${v.due} -- ${v.status}${late}${error}${answered}`;
}

function changeLine(v: ChangeView): string {
  return `- ${v.at} ${v.kind}${v.detail !== null ? `: ${v.detail}` : ""}`;
}

export function formatRun(o: Occurrence, replies: readonly Reply[], people: ReadonlyMap<string, User>, viewer: User, now: Date, seesEveryone: boolean): string {
  return runLine(runView(o, replies, people, viewer, now, seesEveryone));
}

export function formatChange(e: TaskEvent, viewer: User, now: Date, names: ReadonlyMap<string, string> = new Map()): string {
  return changeLine(changeView(e, viewer, now, names));
}

/** One stored finding (docket 0.5.0, a research request's checked claim), as the pages show it. */
export interface FindingView {
  claim: string;
  /** The source, only an http(s) URL; null when there is none or it is anything else. */
  source: string | null;
  /** When it was stored, in the viewer's zone. */
  at: string;
  /** The same instant, ISO-8601 (the API's). */
  atIso: string;
}

/** Findings shown on a task's page; the API returns them all. */
export const FINDINGS_SHOWN = 50;

const HTTP_URL = /^https?:\/\/[^\s<>"]+$/i;

export function findingView(f: StoredFinding, viewer: User, now: Date): FindingView {
  const source = f.source !== null && HTTP_URL.test(f.source) ? f.source : null;
  return { claim: f.text, source, at: formatInstant(f.at, viewer.timeZone, now), atIso: f.at };
}

/**
 * What a delivery pause reads as to a viewer who is neither the task's owner nor an admin (#273):
 * another recipient's (`isRecipientPause`) and the owner's own (`PAUSE_DETAIL`) alike, so the two
 * cannot be told apart.
 */
export const NEUTRAL_PAUSE = "delivery paused";
/** The `paused` details such a viewer reads as stored: a pause by hand names no one. */
const OPEN_PAUSES: ReadonlySet<string> = new Set(["paused by the owner"]);
/** The `resumed` details anyone may read; any other reads as `NEUTRAL_RESUME` (#273). */
const NEUTRAL_RESUMES: ReadonlySet<string> = new Set(["delivery resumed", "resumed by the owner"]);
const NEUTRAL_RESUME = "delivery resumed";

/**
 * A task's changes as a viewer who is neither its owner nor an admin sees them (#167, #273): nothing
 * names or implies another recipient. A pause for another recipient (delivery-health.ts
 * `isRecipientPause`) reads as `NEUTRAL_PAUSE`, as the owner's own delivery pause does (any pause
 * but one by hand or the viewer's own), and the `resumed` row that ends it as `NEUTRAL_RESUME`, so
 * the pair reads as the task's own; another recipient's is left out while the task already shows
 * paused. Any other `resumed` row reads as `NEUTRAL_RESUME` unless its detail is one of
 * `NEUTRAL_RESUMES` (forget-me's `LEFT_DETAIL` says a recipient left), and is left out with no
 * pause shown above it (forget-me deletes the pause row that named the person it forgot). Stored
 * rows are not rewritten.
 */
export function changesForRecipient(events: readonly TaskEvent[], viewerId: string): TaskEvent[] {
  const shown: TaskEvent[] = [];
  let paused = false;
  // The pause shown is `NEUTRAL_PAUSE`: its resume reads `NEUTRAL_RESUME` whatever it says, so an
  // owner going on without a recipient reads as an owner's own delivery resuming (manage.ts resumes
  // that with `health.resume`, "delivery resumed").
  let neutral = false;
  for (const e of events) {
    if (e.kind === "paused") {
      const own = isRecipientPause(e) && pauseNames(e.detail, viewerId);
      if (isRecipientPause(e) && !own && paused) continue;
      paused = true;
      neutral = !own && !OPEN_PAUSES.has(e.detail);
      shown.push(neutral ? { ...e, detail: NEUTRAL_PAUSE } : e);
    } else if (e.kind === "resumed") {
      if (!paused) continue;
      paused = false;
      shown.push(!neutral && NEUTRAL_RESUMES.has(e.detail) ? e : { ...e, detail: NEUTRAL_RESUME });
    } else {
      shown.push(e);
    }
  }
  return shown;
}

/** A task's history as the viewer may see it: the newest `HISTORY_RUNS` runs and `HISTORY_CHANGES` changes. */
export interface HistoryView {
  task: Task;
  cadence: string;
  /** The next run, in the viewer's zone; null when nothing is scheduled. */
  next: string | null;
  runs: RunView[];
  /** How many older runs are left out. */
  earlierRuns: number;
  changes: ChangeView[];
  earlierChanges: number;
  /** The task's stored findings, oldest first, through docket's `visibleFindings`. */
  findings: FindingView[];
}

/**
 * The reads `loadHistory` makes past docket's Store port (store.ts), so it reads only what it shows
 * and counts the rest in SQL (#265, decision 7): a task's runs and history are kept, however long.
 */
export interface HistoryReads {
  /**
   * The task's runs but those still to come (queued, due after `now`), the newest `limit` in
   * `listOccurrences`' order, how many there are, and the first still to come.
   */
  runsTail(taskId: string, now: string, limit: number): Promise<RunsTail>;
  /** The task's replies to these runs, in the order made; with `userId`, only theirs. */
  repliesTo(taskId: string, occurrenceIds: readonly string[], userId: string | null): Promise<Reply[]>;
  /**
   * The task's newest `limit` changes and how many there are: every one with no `viewerId`, else the
   * ones that recipient is shown (docket's `visibleHistory`, then `changesForRecipient`'s choice).
   */
  changesTail(taskId: string, viewerId: string | null, limit: number): Promise<ChangesTail>;
}

/**
 * Reads a task's history: the task through docket's authorized read (owner, accepted recipient, or
 * an admin), then its runs, replies and changes by `HistoryReads`, by the same rules as docket's
 * `visibleOccurrences`, `visibleReplies` and `visibleHistory`; null when the task does not exist or
 * the viewer may not see it -- the two are one answer. Only the runs and changes shown are read,
 * with their replies and people, and the older ones are counted.
 */
export async function loadHistory(d: Pick<TrackerDeps, "store" | "clock">, user: User, taskId: string): Promise<HistoryView | null> {
  const actor = { userId: user.id, admin: user.admin };
  const task = await visibleTask(d.store, actor, taskId.trim());
  if (!task) return null;
  const now = d.clock.now();
  const seesEveryone = user.admin || task.ownerId === user.id;
  const tailed = await d.store.runsTail(task.id, now.toISOString(), HISTORY_RUNS);
  // A recipient sees every run without its `record`, the owner's (docket's `visibleOccurrences`),
  // and only their own replies (`visibleReplies`).
  const runs = seesEveryone ? tailed : { ...tailed, rows: tailed.rows.map((o) => ({ ...o, record: null })) };
  const next = runs.next;
  const replies = await d.store.repliesTo(task.id, runs.rows.map((o) => o.id), seesEveryone ? null : user.id);
  // A pause for a recipient is shown only to them, the owner and admins (#167; delivery-health.ts
  // `isRecipientPause`): docket's `visibleHistory` hides a recipient's own rows from the others, but
  // not this one. Anyone else reads it, and the resume after it, as the task's own (#273,
  // `changesForRecipient`). Chosen before the newest are taken and the "(N earlier)" count, so
  // Discord, the web and the API agree; what a resume says hangs on the pause shown above it, so
  // that one is read too while the task shows paused there.
  const tail = await d.store.changesTail(task.id, seesEveryone ? null : user.id, HISTORY_CHANGES);
  const lead = tail.before?.kind === "paused" ? [tail.before] : [];
  const changes = seesEveryone ? tail.rows : changesForRecipient([...lead, ...tail.rows], user.id).slice(lead.length);
  const deliveries = new Map<string, Delivery[]>();
  for (const o of runs.rows) deliveries.set(o.id, await d.store.listDeliveries({ occurrenceId: o.id }));
  const people = new Map<string, User>();
  for (const r of [...replies, ...[...deliveries.values()].flat()]) {
    if (!people.has(r.userId)) {
      const u = await d.store.getUser(r.userId);
      if (u) people.set(u.id, u);
    }
  }
  // The people a pause names by id, as they are called now (delivery-health.ts `recipientPauseDetail`).
  const names = new Map<string, string>();
  for (const e of changes) {
    for (const [, id] of e.detail.matchAll(PERSON_REF)) {
      if (id === undefined || names.has(id)) continue;
      const u = await d.store.getUser(id);
      if (u) names.set(id, u.displayName ?? id);
    }
  }
  const findings = (await visibleFindings(d.store, actor, task.id)) ?? [];
  const owner = task.ownerId === user.id ? user : await d.store.getUser(task.ownerId);
  return {
    task,
    cadence: task.schedule && owner ? describeSchedule(task.schedule, owner, user.timeZone, now) : "no schedule",
    next: next ? formatInstant(next.dueAt, user.timeZone, now) : null,
    runs: runs.rows.map((o) => ({ ...runView(o, replies, people, user, now, seesEveryone), delivery: deliveryView(o, deliveries.get(o.id) ?? [], people, user, seesEveryone) })),
    earlierRuns: Math.max(0, runs.total - HISTORY_RUNS),
    changes: changes.map((e) => changeView(e, user, now, names)),
    earlierChanges: Math.max(0, tail.total - HISTORY_CHANGES),
    findings: findings.map((f) => findingView(f, user, now)),
  };
}

export async function taskHistory(d: TrackerDeps, user: User, taskId: string): Promise<string> {
  const h = await loadHistory(d, user, taskId);
  if (!h) return NO_SUCH_TASK;
  const { task } = h;
  const lines = [`\`${task.id}\` ${task.title} -- ${task.type}, ${task.status}, ${h.cadence}${await pagesNote(d, task)}`];
  lines.push(h.next ? `Next: ${h.next}` : "Next: nothing scheduled");
  lines.push(h.runs.length === 0 ? "Runs: none yet" : "Runs:");
  if (h.earlierRuns > 0) lines.push(`- (${h.earlierRuns} earlier)`);
  for (const v of h.runs) lines.push(runLine(v));
  lines.push("Changes:");
  if (h.earlierChanges > 0) lines.push(`- (${h.earlierChanges} earlier)`);
  for (const c of h.changes) lines.push(changeLine(c));
  return clip(lines.join("\n"));
}
