import { hasFired, runNowKey, type User } from "@rackbops/docket-core";
import { NO_SUCH_TASK, type TrackerDeps } from "./actions.js";
import { TASK_BUSY } from "./locks.js";
import { type Done, ownLiveTask } from "./manage.js";

/**
 * Run a task now (`POST /tasks/<id>/run`, rackbops-bot-plugins#369): one extra run, due now, off the
 * schedule (docket-core 0.18.0's `runNowKey`), so the schedule's next run stays where it was. The
 * notify lane fires it on its next tick, within a minute; a model run (a scout, a judged watch) then
 * waits its turn on the execute lane and counts against its owner's daily ceilings like any run.
 *
 * Refused, with `NOT_NOW` and a reason (docket-core README, "Adopting 0.18.0"):
 * - a task not active: a paused one would only run on its resume, a finished one never;
 * - a one-off (`once`): its own run stays queued, so a reminder would go twice and a research
 *   request end early;
 * - a renewal: its ask reads its period from the run's due time, so it would ask about a date the
 *   schedule never had;
 * - any type not in `RUNNABLE`;
 * - a task with a run already due and not yet fired: that one goes within a minute anyway.
 *
 * At most `RUN_NOW_PER_DAY` runs now per person in any 24 hours, over all their tasks.
 */

/** The types a run now suits: each run is the same look or the same reminder as a scheduled one. */
export const RUNNABLE: ReadonlySet<string> = new Set(["reminder", "price", "wantlist", "wantjudge", "scout"]);

export const RUN_NOW_PER_DAY = 10;
const DAY_MS = 24 * 3_600_000;

/** Starts each refusal that is about the task, not the request: the API answers it `409 cannot_run_now`. */
export const NOT_NOW = "That task cannot run now:";

/** The count `runNow` caps, read past docket's Store port (store.ts). */
export interface RunNowReads {
  /** Runs now made for `ownerId`'s tasks at or after `since` (an ISO instant). */
  runsNowSince(ownerId: string, since: string): Promise<number>;
}

export function runNow(d: TrackerDeps, user: User, taskId: string): Promise<Done> {
  return d.locks.turn(taskId.trim(), () => runNowLocked(d, user, taskId), () => ({ ok: false, error: TASK_BUSY }));
}

async function runNowLocked(d: TrackerDeps, user: User, taskId: string): Promise<Done> {
  const task = await ownLiveTask(d, user, taskId);
  if (!task) return { ok: false, error: NO_SUCH_TASK };
  if (task.status !== "active") return { ok: false, error: `That task is ${task.status}, not active.` };
  if (task.type === "renewal") return { ok: false, error: `${NOT_NOW} a renewal asks about its own date, at its own time.` };
  if (!RUNNABLE.has(task.type)) return { ok: false, error: `${NOT_NOW} a ${task.type} runs only on its own schedule.` };
  if (!task.schedule || task.schedule.kind === "once") {
    return { ok: false, error: `${NOT_NOW} a one-off runs once, at its own time; change its time instead.` };
  }
  const now = d.clock.now();
  const queued = await d.store.listOccurrences({ taskId: task.id, status: "queued" });
  if (queued.some((o) => !hasFired(o) && Date.parse(o.dueAt) <= now.getTime())) {
    return { ok: false, error: `${NOT_NOW} it already has a run due, which goes within a minute.` };
  }
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  if ((await d.store.runsNowSince(user.id, since)) >= RUN_NOW_PER_DAY) {
    return { ok: false, error: `You already ran ${RUN_NOW_PER_DAY} tasks now in the last 24 hours; each runs on its own schedule meanwhile.` };
  }
  const at = now.toISOString();
  const made = await d.store.createOccurrence({ taskId: task.id, lane: task.lane, dueAt: at, dedupeKey: runNowKey(task.id, crypto.randomUUID()), at });
  if (!made) return { ok: false, error: TASK_BUSY };
  d.log.info(`run now: ${task.id} for ${user.id} (${made.id})`);
  return { ok: true, text: `Running \`${task.id}\` now: it goes within a minute, and its schedule stays as it was.` };
}
