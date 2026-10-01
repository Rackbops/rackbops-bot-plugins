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
 * of a locked task lands mid-run. It is the one holder of several locks at once; deadlock-free
 * because it takes them in one global order, never enters the queue, and every other holder takes
 * one task's lock at a time.
 *
 * Its tasks are reserved (`TaskLocks.reserve`) for the tick: the notify tick skips them (they send a
 * minute later) and a queue turn about one answers "busy, try again" (`TaskLocks.turn`), so a slow
 * city-hall (each call is bounded, executor.ts) holds up neither a reminder nor another person's
 * command. index.ts starts it in the background and returns at once, at most one at a time and at
 * most once per `EXECUTE_EVERY_MS`. What a run owes its recipients goes out on the notify tick, as
 * docket asks.
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

/**
 * The execute lane: one docket `Lanes` for as long as the plugin is active (index.ts makes one on
 * activate), since docket keeps the usage-limit pause on the instance (`executeAfter`): a `Lanes`
 * made each tick would forget it and submit a fresh Job every minute through a spent window. Each
 * tick narrows the same Store view to the tasks it holds (`scope`).
 */
export class ExecuteLane {
  private readonly scope = new Set<string>();
  private readonly lanes: Lanes;

  constructor(private readonly d: ExecuteLaneDeps) {
    this.lanes = new Lanes({
      store: tasksStore(d.store, this.scope),
      clock: d.clock,
      types: d.types,
      notifier: d.notifier,
      executor: d.executor,
      ...(d.budget ? { budget: d.budget } : {}),
    });
  }

  async tick(): Promise<TickResult> {
    const ids = await executeTasks(this.d.store, this.d.clock.now());
    if (ids.length === 0) return { ran: 0, failed: 0, skipped: 0 };
    // Reserved before the locks are taken, so a queue turn about one of them answers "busy" at once
    // instead of waiting behind a city-hall call (locks.ts), and the notify tick passes them by.
    this.d.locks.reserve(ids);
    try {
      return await withLocks(this.d.locks, ids, () => {
        this.scope.clear();
        for (const id of ids) this.scope.add(id);
        return this.lanes.tickExecute();
      });
    } finally {
      this.scope.clear();
      this.d.locks.unreserve(ids);
    }
  }
}
