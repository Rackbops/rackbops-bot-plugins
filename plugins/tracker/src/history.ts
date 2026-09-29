import {
  describeSchedule,
  formatInstant,
  visibleHistory,
  visibleOccurrences,
  visibleReplies,
  visibleTask,
  type Occurrence,
  type Reply,
  type TaskEvent,
  type User,
} from "@rackbops/docket-core";
import { clip, NO_SUCH_TASK, type TrackerDeps } from "./actions.js";

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

export function formatRun(o: Occurrence, replies: readonly Reply[], people: ReadonlyMap<string, User>, viewer: User, now: Date): string {
  const late = o.late ? " (late)" : "";
  const error = o.status === "failed" && o.error ? `: ${clip(o.error, 120)}` : "";
  const answers = replies
    .filter((r) => r.occurrenceId === o.id)
    .map((r) => `${people.get(r.userId)?.displayName ?? r.userId} ${replyText(r)}`);
  const answered = answers.length > 0 ? `; ${answers.join(", ")}` : "";
  return `- ${formatInstant(o.dueAt, viewer.timeZone, now)} -- ${o.status}${late}${error}${answered}`;
}

export function formatChange(e: TaskEvent, viewer: User, now: Date): string {
  const detail = e.kind === "paused" || e.kind === "resumed" ? `: ${e.detail}` : "";
  return `- ${formatInstant(e.at, viewer.timeZone, now)} ${e.kind.replaceAll("_", " ")}${detail}`;
}

export async function taskHistory(d: TrackerDeps, user: User, taskId: string): Promise<string> {
  const actor = { userId: user.id, admin: user.admin };
  const id = taskId.trim();
  const task = await visibleTask(d.store, actor, id);
  if (!task) return NO_SUCH_TASK;
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
  const owner = task.ownerId === user.id ? user : await d.store.getUser(task.ownerId);
  const cadence = task.schedule && owner ? describeSchedule(task.schedule, owner, user.timeZone, now) : "no schedule";
  const lines = [`\`${task.id}\` ${task.title} -- ${task.type}, ${task.status}, ${cadence}`];
  lines.push(next ? `Next: ${formatInstant(next.dueAt, user.timeZone, now)}` : "Next: nothing scheduled");
  lines.push(runs.length === 0 ? "Runs: none yet" : "Runs:");
  if (runs.length > HISTORY_RUNS) lines.push(`- (${runs.length - HISTORY_RUNS} earlier)`);
  for (const o of runs.slice(-HISTORY_RUNS)) lines.push(formatRun(o, replies, people, user, now));
  lines.push("Changes:");
  if (changes.length > HISTORY_CHANGES) lines.push(`- (${changes.length - HISTORY_CHANGES} earlier)`);
  for (const e of changes.slice(-HISTORY_CHANGES)) lines.push(formatChange(e, user, now));
  return clip(lines.join("\n"));
}
