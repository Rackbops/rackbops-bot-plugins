/** A queue turn's answer about a task the execute tick holds (`TaskLocks.turn`). */
export const TASK_BUSY = "That task is with the model runner right now; try again in a minute.";

/**
 * One task at a time (docket 0.4.0, "Adopting 0.4.0": serialize per task). A task's runs, its
 * replies and its edits (`reschedule`, pause, resume, delete) never overlap: docket guards a run's
 * start and a snooze by compare-and-set, but a schedule edit racing a firing run can leave a run of
 * the old schedule beside the new one, and a reply is "once" only while a task's replies are handled
 * one at a time.
 *
 * The two sides that touch a task are the ticks (notify-lane.ts, one pass per task, outside the
 * surface's queue) and the surface's one queue (discord-common.ts `serial`, the commands, the
 * buttons and the web area). Each takes the task's lock around what it does to that task.
 *
 * Deadlock-free by construction: every holder but one takes one task's lock at a time and never
 * waits for another task's while holding one. The one exception is the execute tick
 * (execute-lane.ts), which holds the locks of every task with an execute-lane run due, taken in id
 * order (one global order), and never enters the queue. No tick pass enters the queue, and nothing
 * that holds DeliveryHealth's lock (delivery-health.ts) waits for a task's lock (a pause or a
 * resume there changes a task's status without it, which is safe: each Store write is one
 * statement).
 *
 * The cost: a queue turn about task T waits for T's notify pass when one is in flight -- one task's
 * run and its DMs, or for a price its one page read -- and holds the queue meanwhile. That is rare
 * (an answer landing while its own task runs) and bounded by one pass. The execute tick is
 * different: it can wait on city-hall for a while (each call is bounded, executor.ts), so it
 * reserves its tasks first (`reserve`), and a queue turn about a reserved task does not wait: it
 * takes `turn`, which answers "busy, try again" at once. So a slow city-hall never holds the queue,
 * and no other person's command waits on it.
 */
export class TaskLocks {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly reservations = new Map<string, number>();

  /** Runs `fn` once every earlier holder of `taskId`'s lock is done; the lock is released however it ends. */
  async run<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.tails.get(taskId) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = before.then(() => mine);
    this.tails.set(taskId, tail);
    try {
      await before;
      return await fn();
    } finally {
      release();
      // The last holder cleans up, so the map holds only tasks with a holder or a waiter.
      if (this.tails.get(taskId) === tail) this.tails.delete(taskId);
    }
  }

  /**
   * A queue turn about `taskId`: `busy()` at once while the execute tick has the task reserved,
   * else `run`. Every queue-side caller takes this but one; the ticks take `run`. The exception is
   * `rescheduleOwned` (actions.ts), a zone or hour change that must reach every task it re-times:
   * it touches calendar and period tasks only. A scout (#83) is a calendar task the execute tick can
   * hold, so an hour or zone change may wait out that one tick (each city-hall call is bounded,
   * executor.ts); it must reach the scout, so it waits rather than answer busy.
   */
  turn<T>(taskId: string, fn: () => Promise<T>, busy: () => T): Promise<T> {
    return this.reserved(taskId) ? Promise.resolve(busy()) : this.run(taskId, fn);
  }

  /** Marks `ids` as held by the execute tick, before it takes their locks (execute-lane.ts). */
  reserve(ids: readonly string[]): void {
    for (const id of ids) this.reservations.set(id, (this.reservations.get(id) ?? 0) + 1);
  }

  /** Undoes one `reserve(ids)`. */
  unreserve(ids: readonly string[]): void {
    for (const id of ids) {
      const n = (this.reservations.get(id) ?? 0) - 1;
      if (n > 0) this.reservations.set(id, n);
      else this.reservations.delete(id);
    }
  }

  /** Whether the execute tick has `taskId` reserved: the notify tick passes it by, a queue turn answers busy. */
  reserved(taskId: string): boolean {
    return this.reservations.has(taskId);
  }

  /** Whether anyone holds or waits for `taskId`'s lock (for tests and the health view). */
  held(taskId: string): boolean {
    return this.tails.has(taskId);
  }
}
