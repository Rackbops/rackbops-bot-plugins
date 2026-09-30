import type { Database } from "bun:sqlite";
import { materialize, type Store, type Task, type User } from "@rackbops/docket-core";
import type { PluginLog } from "../../../packages/api/contract.js";

/**
 * Pause after repeated delivery failures (plan 5.5: "After three consecutive delivery failures (DMs
 * closed, left the server) the task pauses and the owner is told"; plan 6, "Discord DM
 * reachability"). The count is kept per person, since a closed DM fails every task of theirs alike:
 * each DM the host refuses with "cannot be messaged" adds one, and any DM that goes through clears
 * it. At `PAUSE_AFTER` the person's delivery is paused, and so is every active task that would DM
 * them -- the ones they own and the ones they receive -- each with a `delivery_pauses` row naming
 * them and a `paused` task event:
 *
 * - The owner of a task paused for a recipient is DMed once, and `/tasks` names the reason. The
 *   task resumes when that recipient next uses the tracker, or when the owner runs `/task resume`,
 *   which takes the unreachable recipient off it.
 * - A person paused for their own DMs cannot be DMed; they are told the next time they use a
 *   command, which resumes them (`resume`).
 *
 * A task is set active again only when no pause row is left on it and it is still `paused`, so a
 * resume never undoes anything but this mechanism. Pausing and resuming run one at a time (a
 * promise chain), so a resume landing while a pause is still writing waits for it, and the rows and
 * the tasks' statuses always agree.
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
}

type Row = { user_id: string; failures: number; last_error: string | null; last_failed_at: string | null; paused_at: string | null };

export interface FailureResult {
  failures: number;
  /** True when this failure paused the person's delivery. */
  paused: boolean;
}

export interface Resumed {
  pausedAt: string;
  /** The tasks set active again. */
  tasks: string[];
}

/** An owner to tell that a recipient's failures paused their task, sent once the lock is released. */
interface Notice {
  owner: User;
  task: Task;
  text: string;
}

export interface DeliveryHealthOptions {
  /** DMs a task's owner that a recipient's failures paused the task. Best effort: a throw is logged. */
  tellOwner?: (owner: User, text: string) => Promise<void>;
  log?: PluginLog;
}

function name(u: User | null, fallback: string): string {
  return u?.displayName ?? fallback;
}

/** What the owner of a task paused for a recipient is told, once, by DM and in `/tasks`. */
export function recipientPausedText(task: Task, recipient: User | null, recipientId: string): string {
  return (
    `Your task \`${task.id}\` (${task.title}) is paused: I could not DM ${name(recipient, recipientId)} ${PAUSE_AFTER} times in a row. ` +
    `It resumes when they next use the tracker, or run \`/task resume ${task.id}\` to go on without them.`
  );
}

export class DeliveryHealth {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly store: Store,
    private readonly options: DeliveryHealthOptions = {},
  ) {}

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  /**
   * Runs `fn` on the same lock as a pause and a resume, so it never interleaves with one: what
   * forget-me's erasure uses (admin.ts), then `release`s the tasks it freed from inside `fn`.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.locked(fn);
  }

  get(userId: string): HealthRow | null {
    const r = this.db.query("SELECT * FROM delivery_health WHERE user_id = ?").get(userId) as Row | null;
    if (!r) return null;
    return { userId: r.user_id, failures: Number(r.failures), lastError: r.last_error, lastFailedAt: r.last_failed_at, pausedAt: r.paused_at };
  }

  isPaused(userId: string): boolean {
    return this.get(userId)?.pausedAt != null;
  }

  /** Who a task is paused for (tracker user ids); empty when this mechanism did not pause it. */
  pausesFor(taskId: string): string[] {
    return (this.db.query("SELECT user_id FROM delivery_pauses WHERE task_id = ? ORDER BY at, user_id").all(taskId) as { user_id: string }[]).map(
      (r) => r.user_id,
    );
  }

  /** A DM went through: the run of failures is over. */
  recordSuccess(userId: string): void {
    this.db.query("UPDATE delivery_health SET failures = 0 WHERE user_id = ? AND paused_at IS NULL").run(userId);
  }

  /** A DM the host refused as undeliverable. Pauses on the `PAUSE_AFTER`th in a row. */
  async recordFailure(userId: string, error: string, at: string): Promise<FailureResult> {
    const notices: Notice[] = [];
    const result = await this.locked(async (): Promise<FailureResult> => {
      this.db
        .query(
          `INSERT INTO delivery_health (user_id, failures, last_error, last_failed_at) VALUES (?, 1, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET failures = delivery_health.failures + 1,
             last_error = excluded.last_error, last_failed_at = excluded.last_failed_at`,
        )
        .run(userId, error, at);
      const row = this.get(userId) as HealthRow;
      const pauses = decidePause(row.failures, row.pausedAt !== null);
      if (!pauses && row.pausedAt === null) return { failures: row.failures, paused: false };
      if (pauses) this.db.query("UPDATE delivery_health SET paused_at = ? WHERE user_id = ?").run(at, userId);
      // Already paused: a task that started DMing them since (a new share, say) pauses too.
      await this.pauseAffected(userId, at, notices);
      return { failures: row.failures, paused: pauses };
    });
    // The owners' DMs go out after the lock is released: `enter` awaits `resume` on that lock from
    // the interaction queue, so a slow DM held inside it would hold up every command.
    for (const n of notices) await this.tellOwner(n);
    return result;
  }

  /** Every task that would DM `userId`: theirs, and the ones they accepted. */
  private async affected(userId: string): Promise<{ task: Task; asRecipient: boolean }[]> {
    const found: { task: Task; asRecipient: boolean }[] = [];
    for (const task of await this.store.listTasks()) {
      if (task.ownerId === userId) found.push({ task, asRecipient: false });
      else if ((await this.store.listRecipients(task.id)).some((r) => r.userId === userId && r.state === "accepted")) {
        found.push({ task, asRecipient: true });
      }
    }
    return found;
  }

  private async pauseAffected(userId: string, at: string, notices: Notice[]): Promise<void> {
    const recipient = await this.store.getUser(userId);
    for (const { task, asRecipient } of await this.affected(userId)) {
      // Only an active task, or one this mechanism already paused for someone else.
      if (task.status !== "active" && this.pausesFor(task.id).length === 0) continue;
      const { changes } = this.db.query("INSERT INTO delivery_pauses (task_id, user_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(task.id, userId, at);
      if (changes === 0 || task.status !== "active") continue;
      await this.store.updateTask(task.id, { status: "paused", at });
      const detail = asRecipient ? `delivery to ${name(recipient, userId)} paused: ${PAUSE_AFTER} DMs in a row could not be delivered` : PAUSE_DETAIL;
      await this.store.addTaskEvent({ taskId: task.id, actorId: null, kind: "paused", detail, at });
      if (asRecipient) {
        const owner = await this.store.getUser(task.ownerId);
        if (owner) notices.push({ owner, task, text: recipientPausedText(task, recipient, userId) });
      }
    }
  }

  private async tellOwner({ owner, task, text }: Notice): Promise<void> {
    if (!this.options.tellOwner) return;
    try {
      await this.options.tellOwner(owner, text);
    } catch (err) {
      this.options.log?.warn(`could not tell ${owner.id} that ${task.id} paused: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Sets a task active again once nothing holds it paused, and gives it its next run. Only from
   * inside the lock: `resume`, `resumeTask`, or `exclusive`.
   */
  async release(taskId: string, actorId: string | null, detail: string, now: Date): Promise<boolean> {
    if (this.pausesFor(taskId).length > 0) return false;
    const task = await this.store.getTask(taskId);
    if (!task || task.status !== "paused") return false;
    const at = now.toISOString();
    const active = await this.store.updateTask(taskId, { status: "active", at });
    await this.store.addTaskEvent({ taskId, actorId, kind: "resumed", detail, at });
    const owner = await this.store.getUser(task.ownerId);
    if (owner) await materialize(this.store, active, owner, now);
    return true;
  }

  /**
   * Resumes a paused person (they used a command, so they are here): clears the count and their
   * pause rows, and sets active every task nothing else still holds. Null when they were not paused.
   */
  resume(userId: string, now: Date): Promise<Resumed | null> {
    return this.locked(async () => {
      const row = this.get(userId);
      if (!row?.pausedAt) return null;
      const tasks = this.pausedTasksOf(userId);
      this.db.transaction(() => {
        this.db.query("UPDATE delivery_health SET failures = 0, paused_at = NULL WHERE user_id = ?").run(userId);
        this.db.query("DELETE FROM delivery_pauses WHERE user_id = ?").run(userId);
      })();
      const resumed: string[] = [];
      for (const id of tasks) if (await this.release(id, userId, "delivery resumed", now)) resumed.push(id);
      return { pausedAt: row.pausedAt, tasks: resumed };
    });
  }

  private pausedTasksOf(userId: string): string[] {
    return (this.db.query("SELECT task_id FROM delivery_pauses WHERE user_id = ? ORDER BY at, task_id").all(userId) as { task_id: string }[]).map(
      (r) => r.task_id,
    );
  }

  /**
   * `/task resume` by the owner: every recipient the task is paused for is taken off it (on record),
   * and the task goes on without them. Returns who was removed, or null when this mechanism had not
   * paused it. The owner's own pause is not here: using the command already resumed them.
   */
  resumeTask(task: Task, ownerId: string, now: Date): Promise<string[] | null> {
    return this.locked(async () => {
      const held = this.pausesFor(task.id).filter((u) => u !== ownerId);
      if (held.length === 0 && this.pausesFor(task.id).length === 0) return null;
      const at = now.toISOString();
      for (const userId of held) {
        this.db.query("DELETE FROM delivery_pauses WHERE task_id = ? AND user_id = ?").run(task.id, userId);
        await this.store.removeRecipient(task.id, userId);
        await this.store.addTaskEvent({ taskId: task.id, actorId: ownerId, kind: "recipient_removed", detail: `${userId}: DMs could not be delivered`, at });
      }
      await this.release(task.id, ownerId, "resumed by the owner", now);
      return held;
    });
  }
}

/** What a resumed person is told, ahead of the answer to what they did. */
export function resumedNotice(r: Resumed): string {
  const what = r.tasks.length === 0 ? "Nothing else was waiting on you." : `${r.tasks.length} task(s) are back on.`;
  return (
    `I could not DM you ${PAUSE_AFTER} times in a row, so your reminders were paused. ${what} ` +
    "Check that you accept DMs from members of a server we share, or they will pause again."
  );
}
