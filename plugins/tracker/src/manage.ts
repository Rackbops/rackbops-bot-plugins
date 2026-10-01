import { hasFired, materialize, type Task, type User } from "@rackbops/docket-core";
import { NO_SUCH_TASK, ownTask, type TrackerDeps } from "./actions.js";
import { TASK_BUSY } from "./locks.js";

/**
 * Pausing, resuming and deleting a task (rackbops-bot-plugins#80, plan 5.10's task editor): the
 * owner's own acts on their own task, with no discord.js, for the web editor and `/task resume`
 * alike. Every write here runs in the surface's one queue, under the task's lock (locks.ts).
 *
 * - A pause by the owner sets the task `paused`; its queued run stays, and docket runs no paused
 *   task's due runs and holds its owed sends, so nothing is sent. It is told apart from a pause for
 *   failed DMs by having no `delivery_pauses` row, so a person's delivery resuming never un-pauses it.
 * - A resume sets it `active` again and gives it its next run (docket's catch-up: a run missed while
 *   paused fires once, late). A task paused for failed DMs resumes as `/task resume` always did,
 *   without the recipients who could not be DMed.
 * - A delete archives: the task leaves every list and nothing more is sent, its queued runs that
 *   have not fired are dropped (one fired and put back to finish is kept: docket finishes it, and
 *   ends what it still owed unsent, as for any archived task), and its history stays on record (an admin can see every task, plan 1.1). The store has
 *   no way to erase a task; only forget-me erases, and it erases the whole person (admin.ts).
 */

export type Done = { ok: true; text: string } | { ok: false; error: string };

/** The owner's task as long as it has not been deleted; null for anything else, one answer. */
export async function ownLiveTask(d: Pick<TrackerDeps, "store">, user: User, taskId: string): Promise<Task | null> {
  const task = await ownTask(d, user, taskId);
  return task && task.status !== "archived" ? task : null;
}

/** Whether an edit may change the task: not once it has finished. */
export function editable(task: Task): boolean {
  return task.status === "active" || task.status === "paused";
}

export const FINISHED = "That task has finished, so it cannot be changed. Set a new one instead.";

/** `act` on the owner's task under the task's lock, the id as the person typed it. */
function locked(d: TrackerDeps, taskId: string, act: () => Promise<Done>): Promise<Done> {
  return d.locks.turn(taskId.trim(), act, () => ({ ok: false, error: TASK_BUSY }));
}

export function pauseTask(d: TrackerDeps, user: User, taskId: string): Promise<Done> {
  return locked(d, taskId, () => pauseLocked(d, user, taskId));
}

async function pauseLocked(d: TrackerDeps, user: User, taskId: string): Promise<Done> {
  const task = await ownLiveTask(d, user, taskId);
  if (!task) return { ok: false, error: NO_SUCH_TASK };
  if (task.status !== "active") return { ok: false, error: `That task is ${task.status}, not active.` };
  const at = d.clock.now().toISOString();
  await d.store.updateTask(task.id, { status: "paused", at });
  await d.store.addTaskEvent({ taskId: task.id, actorId: user.id, kind: "paused", detail: "paused by the owner", at });
  return { ok: true, text: `Paused \`${task.id}\`: nothing is sent until you resume it.` };
}

/**
 * `/task resume` and the web's Resume (plan 5.5): a task paused for failed DMs goes on without the
 * recipients who could not be DMed; one the owner paused simply goes on. The owner's own delivery
 * pause is lifted first, as using a command does (`enter`), since they are here asking.
 */
export function resumeTask(d: TrackerDeps, user: User, taskId: string): Promise<Done> {
  return locked(d, taskId, () => resumeLocked(d, user, taskId));
}

async function resumeLocked(d: TrackerDeps, user: User, taskId: string): Promise<Done> {
  const task = await ownLiveTask(d, user, taskId);
  if (!task) return { ok: false, error: NO_SUCH_TASK };
  if (task.status !== "paused") return { ok: false, error: `That task is ${task.status}, not paused.` };
  const now = d.clock.now();
  if (d.health.isPaused(user.id)) await d.health.resume(user.id, now);
  const removed = await d.health.resumeTask(task, user.id, now);
  if (removed === null) {
    const current = await d.store.getTask(task.id);
    if (current?.status === "paused") {
      const at = now.toISOString();
      const active = await d.store.updateTask(task.id, { status: "active", at });
      await d.store.addTaskEvent({ taskId: task.id, actorId: user.id, kind: "resumed", detail: "resumed by the owner", at });
      await materialize(d.store, active, user, now);
    }
    return { ok: true, text: `Resumed \`${task.id}\`.` };
  }
  const names = [];
  for (const id of removed) names.push((await d.store.getUser(id))?.displayName ?? id);
  const without = names.length > 0 ? `, without ${names.join(", ")}` : "";
  return { ok: true, text: `Resumed \`${task.id}\`${without}.` };
}

export function deleteTask(d: TrackerDeps, user: User, taskId: string): Promise<Done> {
  return locked(d, taskId, () => deleteLocked(d, user, taskId));
}

async function deleteLocked(d: TrackerDeps, user: User, taskId: string): Promise<Done> {
  const task = await ownLiveTask(d, user, taskId);
  if (!task) return { ok: false, error: NO_SUCH_TASK };
  const at = d.clock.now().toISOString();
  for (const o of await d.store.listOccurrences({ taskId: task.id, status: "queued" })) {
    if (!hasFired(o)) await d.store.deleteOccurrence(o.id);
  }
  await d.store.updateTask(task.id, { status: "archived", at });
  await d.store.addTaskEvent({ taskId: task.id, actorId: user.id, kind: "archived", detail: "deleted by the owner", at });
  return { ok: true, text: `Deleted \`${task.id}\` ${task.title}.` };
}
