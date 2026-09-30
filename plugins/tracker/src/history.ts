import {
  describeSchedule,
  formatInstant,
  visibleHistory,
  visibleOccurrences,
  visibleReplies,
  visibleTask,
  type Occurrence,
  type Reply,
  type Task,
  type TaskEvent,
  type User,
} from "@rackbops/docket-core";
import { clip, NO_SUCH_TASK, type TrackerDeps } from "./actions.js";
import { PERSON_REF } from "./delivery-health.js";

/**
 * `/task history` (plan 1.3 "History", 5.10): every run of a task -- when it was due, how it went,
 * how the owner answered it, what anyone replied -- and the task's own changes, read through docket's
 * authorized reads (owner, accepted recipient, or an admin), newest last.
 */

/** Runs and changes shown; older ones are summarized by count. */
export const HISTORY_RUNS = 10;
export const HISTORY_CHANGES = 5;

function replyText(r: Reply): string {
  if (r.kind === "text") {
    const text = typeof r.payload === "object" && r.payload !== null ? String((r.payload as { text?: unknown }).text ?? "") : "";
    return `replied "${clip(text, 80)}"`;
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
  /** `Larry replied "..."`, `Curly opted out`. */
  answers: string[];
}

export interface ChangeView {
  at: string;
  /** `created`, `recipient added`, ... */
  kind: string;
  /** Shown for a pause or a resume only. */
  detail: string | null;
}

export function runView(o: Occurrence, replies: readonly Reply[], people: ReadonlyMap<string, User>, viewer: User, now: Date): RunView {
  return {
    due: formatInstant(o.dueAt, viewer.timeZone, now),
    status: o.status,
    late: o.late,
    error: o.status === "failed" && o.error ? clip(o.error, 120) : null,
    answers: replies.filter((r) => r.occurrenceId === o.id).map((r) => `${people.get(r.userId)?.displayName ?? r.userId} ${replyText(r)}`),
  };
}

export function changeView(e: TaskEvent, viewer: User, now: Date, names: ReadonlyMap<string, string> = new Map()): ChangeView {
  const detail = e.kind === "paused" || e.kind === "resumed" ? e.detail.replace(PERSON_REF, (_, id: string) => names.get(id) ?? "someone no longer on the tracker") : null;
  return { at: formatInstant(e.at, viewer.timeZone, now), kind: e.kind.replaceAll("_", " "), detail };
}

function runLine(v: RunView): string {
  const late = v.late ? " (late)" : "";
  const error = v.error ? `: ${v.error}` : "";
  const answered = v.answers.length > 0 ? `; ${v.answers.join(", ")}` : "";
  return `- ${v.due} -- ${v.status}${late}${error}${answered}`;
}

function changeLine(v: ChangeView): string {
  return `- ${v.at} ${v.kind}${v.detail !== null ? `: ${v.detail}` : ""}`;
}

export function formatRun(o: Occurrence, replies: readonly Reply[], people: ReadonlyMap<string, User>, viewer: User, now: Date): string {
  return runLine(runView(o, replies, people, viewer, now));
}

export function formatChange(e: TaskEvent, viewer: User, now: Date, names: ReadonlyMap<string, string> = new Map()): string {
  return changeLine(changeView(e, viewer, now, names));
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
}

/**
 * Reads a task's history through docket's authorized reads (owner, accepted recipient, or an
 * admin); null when the task does not exist or the viewer may not see it -- the two are one answer.
 */
export async function loadHistory(d: Pick<TrackerDeps, "store" | "clock">, user: User, taskId: string): Promise<HistoryView | null> {
  const actor = { userId: user.id, admin: user.admin };
  const task = await visibleTask(d.store, actor, taskId.trim());
  if (!task) return null;
  const now = d.clock.now();
  const all = (await visibleOccurrences(d.store, actor, task.id)) ?? [];
  const upcoming = (o: Occurrence) => o.status === "queued" && Date.parse(o.dueAt) > now.getTime();
  const runs = all.filter((o) => !upcoming(o));
  const next = all.find(upcoming);
  const replies = (await visibleReplies(d.store, actor, task.id)) ?? [];
  const changes = (await visibleHistory(d.store, actor, task.id)) ?? [];
  const people = new Map<string, User>();
  for (const r of replies) {
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
  const owner = task.ownerId === user.id ? user : await d.store.getUser(task.ownerId);
  return {
    task,
    cadence: task.schedule && owner ? describeSchedule(task.schedule, owner, user.timeZone, now) : "no schedule",
    next: next ? formatInstant(next.dueAt, user.timeZone, now) : null,
    runs: runs.slice(-HISTORY_RUNS).map((o) => runView(o, replies, people, user, now)),
    earlierRuns: Math.max(0, runs.length - HISTORY_RUNS),
    changes: changes.slice(-HISTORY_CHANGES).map((e) => changeView(e, user, now, names)),
    earlierChanges: Math.max(0, changes.length - HISTORY_CHANGES),
  };
}

export async function taskHistory(d: TrackerDeps, user: User, taskId: string): Promise<string> {
  const h = await loadHistory(d, user, taskId);
  if (!h) return NO_SUCH_TASK;
  const { task } = h;
  const lines = [`\`${task.id}\` ${task.title} -- ${task.type}, ${task.status}, ${h.cadence}`];
  lines.push(h.next ? `Next: ${h.next}` : "Next: nothing scheduled");
  lines.push(h.runs.length === 0 ? "Runs: none yet" : "Runs:");
  if (h.earlierRuns > 0) lines.push(`- (${h.earlierRuns} earlier)`);
  for (const v of h.runs) lines.push(runLine(v));
  lines.push("Changes:");
  if (h.earlierChanges > 0) lines.push(`- (${h.earlierChanges} earlier)`);
  for (const c of h.changes) lines.push(changeLine(c));
  return clip(lines.join("\n"));
}
