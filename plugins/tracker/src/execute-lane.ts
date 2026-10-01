import { type BudgetPolicy, type Clock, type Executor, Lanes, type Notifier, type Store, type TaskType, type TickResult } from "@rackbops/docket-core";
import type { TaskLocks } from "./locks.js";
import { tasksStore } from "./notify-lane.js";

/**
 * The execute lane on a tick of its own (plan 5.3, 5.12; rackbops-bot-plugins#82): docket's
 * `Lanes.tickExecute` with the city-hall Executor (executor.ts). Off while no Executor is
 * configured: the research runs stay queued, and nobody can make one (`/research` says so).
 *
 * docket runs model Jobs one at a time across every owner (5.3): each tick first asks about every
 * run whose Job is out, and submits nothing new while one is. So the tick is one `tickExecute` over
 * every task with a due execute-lane run, not one pass per task as the notify lane does -- a pass
 * that saw one task would not see another task's Job out. It holds each of those tasks' locks
 * (locks.ts) for the whole tick, taken in id order, over a Store view narrowed to them, so a run
 * of a task that was not locked (due a moment later) waits for the next tick, and no edit or reply
 * of a locked task lands mid-run. Deadlock-free: the notify passes and the surface's queue each
 * hold one task's lock at a time and never wait for a second while holding one, and this tick
 * takes its locks in one global order and never enters the queue.
 *
 * It never blocks the notify lane: index.ts starts it in the background and returns at once, at
 * most one at a time and at most once per `EXECUTE_EVERY_MS`, and the notify tick skips the tasks
 * it holds (`holding`) instead of waiting for their locks, so a slow city-hall (each call is
 * bounded, executor.ts) holds up no reminder. What a run owes its recipients goes out on the notify
 * tick, as docket asks: a task this tick holds sends a minute later.
 */

/** How often the execute lane is asked to run; each run asks city-hall about at most every Job out. */
export const EXECUTE_EVERY_MS = 60_000;

export interface ExecuteLaneDeps {
  store: Store;
  clock: Clock;
  types: Readonly<Record<string, TaskType<unknown>>>;
  notifier: Notifier;
  executor: Executor;
  locks: TaskLocks;
  budget?: BudgetPolicy;
  /**
   * The tasks this tick holds, for as long as it holds them: the notify tick skips them (they wait
   * a minute) rather than wait on a city-hall call (index.ts `executeHolds`).
   */
  holding?: Set<string>;
}

/** Runs `fn` holding every lock in `ids`, taken in sorted order. */
export async function withLocks<T>(locks: TaskLocks, ids: readonly string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(ids)].sort();
  const take = (i: number): Promise<T> => (i === sorted.length ? fn() : locks.run(sorted[i] as string, () => take(i + 1)));
  return take(0);
}

/** The tasks with an execute-lane run due now (a Job out is one: it waits in the queue). */
export async function executeTasks(store: Store, now: Date): Promise<string[]> {
  const due = await store.listOccurrences({ lane: "execute", status: "queued", dueBefore: now.toISOString() });
  const running = await store.listOccurrences({ lane: "execute", status: "running" });
  return [...new Set([...due, ...running].map((o) => o.taskId))].sort();
}

export async function runExecuteTick(d: ExecuteLaneDeps): Promise<TickResult> {
  const ids = await executeTasks(d.store, d.clock.now());
  if (ids.length === 0) return { ran: 0, failed: 0, skipped: 0 };
  for (const id of ids) d.holding?.add(id);
  try {
    return await withLocks(d.locks, ids, () => {
      const lanes = new Lanes({
        store: tasksStore(d.store, new Set(ids)),
        clock: d.clock,
        types: d.types,
        notifier: d.notifier,
        executor: d.executor,
        ...(d.budget ? { budget: d.budget } : {}),
      });
      return lanes.tickExecute();
    });
  } finally {
    for (const id of ids) d.holding?.delete(id);
  }
}
