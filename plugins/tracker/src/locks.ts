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
 * Deadlock-free by construction: a holder takes one task's lock at a time and never waits for
 * another task's while holding one; a tick pass never enters the queue; and nothing that holds
 * DeliveryHealth's lock (delivery-health.ts) waits for a task's lock (a pause or a resume there
 * changes a task's status without it, which is safe: each Store write is one statement).
 *
 * The cost: a queue turn about task T waits for T's pass when one is in flight -- one task's run
 * and its DMs, or for a price its one page read -- and holds the queue meanwhile. That is rare (an
 * answer landing while its own task runs) and bounded by one pass.
 */
export class TaskLocks {
  private readonly tails = new Map<string, Promise<void>>();

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

  /** Whether anyone holds or waits for `taskId`'s lock (for tests and the health view). */
  held(taskId: string): boolean {
    return this.tails.has(taskId);
  }
}
