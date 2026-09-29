import type { Database } from "bun:sqlite";
import { materialize, type Store, type Task } from "@rackbops/docket-core";

/**
 * Pause after repeated delivery failures (plan 5.5: "After three consecutive delivery failures (DMs
 * closed, left the server) the task pauses and the owner is told"; plan 6, "Discord DM
 * reachability"). The count is kept per person, since a closed DM fails every task of theirs alike:
 * each DM the host refuses with "cannot be messaged" adds one, and any DM that goes through clears
 * it. At `PAUSE_AFTER` the person's delivery is paused -- every active task they own is paused, on
 * record as a `paused` task event -- and they are told the next time they use a command or a button,
 * which also resumes it (the bot cannot DM them to say so). While paused they are left out of other
 * people's tasks they receive, instead of failing those runs.
 */

/** Consecutive refused DMs before a person's delivery pauses: the plan's three. */
export const PAUSE_AFTER = 3;

export const PAUSE_DETAIL = `delivery paused: ${PAUSE_AFTER} DMs in a row could not be delivered (DMs closed, or the bot is blocked)`;

/** Whether this failure is the one that pauses: pure, so the threshold is tested on its own. */
export function decidePause(failures: number, alreadyPaused: boolean): boolean {
  return !alreadyPaused && failures >= PAUSE_AFTER;
}

export interface HealthRow {
  userId: string;
  failures: number;
  lastError: string | null;
  lastFailedAt: string | null;
  pausedAt: string | null;
  /** The tasks the pause stopped; a resume reactivates only these. */
  pausedTasks: string[];
}

type Row = {
  user_id: string;
  failures: number;
  last_error: string | null;
  last_failed_at: string | null;
  paused_at: string | null;
  paused_tasks: string;
};

export interface FailureResult {
  failures: number;
  /** True when this failure paused the person's delivery. */
  paused: boolean;
}

export interface Resumed {
  /** When the pause began. */
  pausedAt: string;
  /** The tasks set active again. */
  tasks: string[];
}

export class DeliveryHealth {
  constructor(
    private readonly db: Database,
    private readonly store: Store,
  ) {}

  get(userId: string): HealthRow | null {
    const r = this.db.query("SELECT * FROM delivery_health WHERE user_id = ?").get(userId) as Row | null;
    if (!r) return null;
    return {
      userId: r.user_id,
      failures: Number(r.failures),
      lastError: r.last_error,
      lastFailedAt: r.last_failed_at,
      pausedAt: r.paused_at,
      pausedTasks: JSON.parse(r.paused_tasks) as string[],
    };
  }

  isPaused(userId: string): boolean {
    return this.get(userId)?.pausedAt != null;
  }

  /** The people whose delivery is paused now. */
  pausedUsers(): Set<string> {
    const rows = this.db.query("SELECT user_id FROM delivery_health WHERE paused_at IS NOT NULL").all() as { user_id: string }[];
    return new Set(rows.map((r) => r.user_id));
  }

  /** A DM went through: the run of failures is over. */
  recordSuccess(userId: string): void {
    this.db.query("UPDATE delivery_health SET failures = 0 WHERE user_id = ? AND paused_at IS NULL").run(userId);
  }

  /** A DM the host refused as undeliverable. Pauses the person's tasks on the `PAUSE_AFTER`th in a row. */
  async recordFailure(userId: string, error: string, at: string): Promise<FailureResult> {
    this.db
      .query(
        `INSERT INTO delivery_health (user_id, failures, last_error, last_failed_at, paused_tasks) VALUES (?, 1, ?, ?, '[]')
         ON CONFLICT (user_id) DO UPDATE SET failures = delivery_health.failures + 1,
           last_error = excluded.last_error, last_failed_at = excluded.last_failed_at`,
      )
      .run(userId, error, at);
    const row = this.get(userId) as HealthRow;
    if (!decidePause(row.failures, row.pausedAt !== null)) return { failures: row.failures, paused: false };
    // Claim the pause before any await, so two failures landing together pause once.
    this.db.query("UPDATE delivery_health SET paused_at = ? WHERE user_id = ?").run(at, userId);
    const paused: string[] = [];
    for (const task of await this.store.listTasks({ ownerId: userId, status: "active" })) {
      await this.store.updateTask(task.id, { status: "paused", at });
      await this.store.addTaskEvent({ taskId: task.id, actorId: null, kind: "paused", detail: PAUSE_DETAIL, at });
      paused.push(task.id);
    }
    this.db.query("UPDATE delivery_health SET paused_tasks = ? WHERE user_id = ?").run(JSON.stringify(paused), userId);
    return { failures: row.failures, paused: true };
  }

  /**
   * Resumes a paused person (they used a command or a button, so they are here): clears the count,
   * sets every task the pause stopped active again -- unless something else changed it since -- and
   * gives each its next run. Null when they were not paused.
   */
  async resume(userId: string, now: Date): Promise<Resumed | null> {
    const row = this.get(userId);
    if (!row?.pausedAt) return null;
    this.db.query("UPDATE delivery_health SET failures = 0, paused_at = NULL, paused_tasks = '[]' WHERE user_id = ?").run(userId);
    const owner = await this.store.getUser(userId);
    const at = now.toISOString();
    const resumed: string[] = [];
    for (const id of row.pausedTasks) {
      const task: Task | null = await this.store.getTask(id);
      if (!task || task.status !== "paused") continue;
      const active = await this.store.updateTask(id, { status: "active", at });
      await this.store.addTaskEvent({ taskId: id, actorId: userId, kind: "resumed", detail: "delivery resumed", at });
      if (owner) await materialize(this.store, active, owner, now);
      resumed.push(id);
    }
    return { pausedAt: row.pausedAt, tasks: resumed };
  }
}

/** What a resumed person is told, ahead of the answer to what they did. */
export function resumedNotice(r: Resumed): string {
  const what = r.tasks.length === 0 ? "Nothing was waiting." : `${r.tasks.length} task(s) are back on.`;
  return (
    `I could not DM you ${PAUSE_AFTER} times in a row, so your reminders were paused. ${what} ` +
    "Check that you accept DMs from members of a server we share, or they will pause again."
  );
}
