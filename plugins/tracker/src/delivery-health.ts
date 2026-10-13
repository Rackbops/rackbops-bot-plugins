import type { Database } from "bun:sqlite";
import { materialize, type Store, type Task, type TaskStatus, type User } from "@rackbops/docket-core";
import type { PluginLog } from "../../../packages/api/contract.js";
import { seqOf } from "./store.js";

/**
 * Pause after repeated delivery failures (plan 5.5: "After three consecutive delivery failures (DMs
 * closed, left the server) the task pauses and the owner is told"; plan 6, "Discord DM
 * reachability"). The count is kept per person, since a closed DM fails every task of theirs alike:
 * each DM the host refuses with "cannot be messaged" adds one, and any DM that goes through clears
 * it. Nothing else counts: a message the host refused (retried by docket), a deferral, a send that
 * may have gone out. Under docket 0.4.0 each person's copy of a run is its own delivery, and an
 * unreachable copy fails for good at once, never retried (notifier.ts), so the count goes up once
 * per run per person -- three runs, not three ticks or three retries of one run -- and one
 * unreachable recipient no longer keeps the owner or anyone else from their copy. At `PAUSE_AFTER`
 * the person's delivery is paused, and so is every active task that would DM them -- the ones they
 * own and the ones they receive -- each with a `delivery_pauses` row naming them and a `paused`
 * task event. docket then starts none of those tasks' runs and holds what their runs still owe,
 * with a fresh round of tries for the resume:
 *
 * - The owner of a task paused for a recipient is DMed once, and `/tasks` names the reason. The
 *   task resumes when that recipient next uses the tracker, or when the owner runs `/task resume`,
 *   which takes the unreachable recipient off it.
 * - A person paused for their own DMs cannot be DMed; they are told the next time they use a
 *   command, which resumes them (`resume`).
 *
 * A task can still come to DM a person while they stay paused: one they make on the web or through
 * the task API (making a task there resumes no one); one its owner had paused, which the pass
 * leaves alone, and resumes by hand; one a pause stopped part way never reached (the pass is a run
 * of Store writes, not one transaction). The notifier never DMs a paused person: it runs the same
 * pass first (`holdFor`), so that task pauses too, then defers the send, which docket's next tick
 * holds with its task until the resume (notifier.ts). Only a send for a task already finished (a
 * research answer, say) is not held: a finished task is never paused, so docket's eight deferrals
 * of it run out (about two hours) and it fails.
 *
 * A task is set active again only when no pause row is left on it and it is still `paused`, and
 * paused only while it is still `active`, each status checked in the write itself (a
 * compare-and-set, `statusIf`), so a resume never undoes anything but this mechanism: an owner's
 * delete landing while a pause or a resume runs stands, and an owner's own pause takes this lock
 * too (manage.ts). Pausing and resuming run one at a time (a promise chain), so a resume landing
 * while a pause is still writing waits for it, and the rows and the tasks' statuses always agree.
 */

/** Consecutive refused DMs before a person's delivery pauses: the plan's three. */
export const PAUSE_AFTER = 3;

export const PAUSE_DETAIL = `delivery paused: ${PAUSE_AFTER} DMs in a row could not be delivered (DMs closed, or the bot is blocked)`;

/**
 * A pause for a recipient names them by tracker id in braces (`{u5}`), never by name: history
 * renders the name when it is read (history.ts), so a later name change shows, and forget-me finds
 * the row by id (roster.ts). Rows written before 0.6.0 carry the display name of the time instead.
 */
export function recipientPauseDetail(userId: string): string {
  return `delivery to {${userId}} paused: ${PAUSE_AFTER} DMs in a row could not be delivered`;
}

/** A person named in a history row's detail by `recipientPauseDetail`'s braces. */
export const PERSON_REF = /\{(u[1-9][0-9]*)\}/g;

/**
 * Whether a history row is a pause for a recipient (`recipientPauseDetail`), which only that
 * recipient, the task's owner and admins may see (#167, history.ts `loadHistory`): another recipient
 * would learn from it who else receives the task, and that their DMs fail. Matched on the detail's
 * `delivery to ` prefix, so a row from before 0.6.0, which carries a display name, is one too.
 * `PAUSE_DETAIL` (the owner's own DMs failed), `paused by the owner` (manage.ts) and every
 * `resumed` row are not.
 */
export function isRecipientPause(e: { kind: string; detail: string }): boolean {
  return e.kind === "paused" && e.detail.startsWith("delivery to ");
}

/**
 * Whether a recipient pause's detail is `recipientPauseDetail(userId)`'s: matched on its exact
 * `delivery to {<id>} paused:` start, as forget-me matches it (roster.ts `historyNames`), never on a
 * name or an id anywhere else. A row from before 0.6.0 names nobody, even one whose stored display
 * name holds a braced id (`delivery to Zed {u4} paused: ...`), and is left to the owner and admins.
 */
export function pauseNames(detail: string, userId: string): boolean {
  return detail.startsWith(`delivery to {${userId}} paused:`);
}

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
   * forget-me's erasure uses (admin.ts), then `release`s the tasks it freed from inside `fn`, and the
   * owner's own pause (manage.ts `pauseTask`, after the task's lock).
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

  /**
   * Runs `fn` on the lock, then tells the owners of the tasks it paused for a recipient. The owners'
   * DMs go out after the lock is released: `enter` awaits `resume` on that lock from the interaction
   * queue, so a slow DM held inside it would hold up every command.
   */
  private async lockedThenTell<T>(fn: (notices: Notice[]) => Promise<T>): Promise<T> {
    const notices: Notice[] = [];
    try {
      return await this.locked(() => fn(notices));
    } finally {
      // After a throw part way too: the tasks paused before it stay paused, so their owners are told,
      // and the error still reaches the caller (`tellOwner` never throws).
      for (const n of notices) await this.tellOwner(n);
    }
  }

  /** A DM the host refused as undeliverable. Pauses on the `PAUSE_AFTER`th in a row. */
  recordFailure(userId: string, error: string, at: string): Promise<FailureResult> {
    return this.lockedThenTell(async (notices): Promise<FailureResult> => {
      // Forgotten while the DM was out (an invitation's DM runs outside every lock): nothing may
      // name them again. The erasure runs on this same lock, so the check cannot race it.
      if (!(await this.store.getUser(userId))) return { failures: 0, paused: false };
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
      // Paused now, or already (this DM was in flight when another paused them): either way the one
      // pass a held send runs too (`holdFor`), so a task that came to DM them since the pause -- made
      // on the web, or paused and resumed by its owner -- pauses here as well.
      await this.pauseAffected(userId, at, notices);
      return { failures: row.failures, paused: pauses };
    });
  }

  /**
   * A send to `userId` is held because their delivery is paused (notifier.ts): every active task
   * that would still DM them pauses, as at the pause itself (`pauseAffected`) -- one made on the web
   * or through the task API since, one its owner had paused and resumed by hand, one the pause
   * stopped before reaching -- so docket holds the send with its task until the resume instead of
   * running out its deferrals (all but a send for a task already finished). Run on every held send;
   * a task already paused for them is left as it is, so its owner is told only the first time. Does
   * nothing when they were resumed (or forgotten: the erasure deletes their row) since the notifier
   * looked.
   */
  holdFor(userId: string, at: string): Promise<void> {
    return this.lockedThenTell(async (notices) => {
      if (this.isPaused(userId)) await this.pauseAffected(userId, at, notices);
    });
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
    const hold = this.db.query("INSERT INTO delivery_pauses (task_id, user_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING");
    for (const { task, asRecipient } of await this.affected(userId)) {
      // Only an active task, or one this mechanism already paused for someone else.
      if (task.status !== "active" && this.pausesFor(task.id).length === 0) continue;
      if (task.status !== "active") {
        hold.run(task.id, userId, at);
        continue;
      }
      // `task` was read before the awaits above, without the task's lock (locks.ts): an owner's
      // pause or delete, or docket finishing it, may have landed since. So the pause is a
      // compare-and-set, and what landed stands; written over, the person's resume would set it
      // active again. The status and the row change together (one transaction, no await in it): the
      // row goes in when this paused the task (it may be there already, left by a pass that stopped
      // part way), and comes off when it did not, so no row of theirs is left on a task this
      // mechanism did not pause. The owner is read first, so their notice is on the list the moment
      // the pause applies: a Store error after it would otherwise lose it for good, since the next
      // pass finds the task paused and leaves it.
      const owner = asRecipient ? await this.store.getUser(task.ownerId) : null;
      const paused = this.db.transaction((): boolean => {
        if (!this.statusIf(task.id, "active", "paused", at)) {
          this.db.query("DELETE FROM delivery_pauses WHERE task_id = ? AND user_id = ?").run(task.id, userId);
          return false;
        }
        hold.run(task.id, userId, at);
        return true;
      })();
      if (!paused) continue;
      if (owner) notices.push({ owner, task, text: recipientPausedText(task, recipient, userId) });
      const detail = asRecipient ? recipientPauseDetail(userId) : PAUSE_DETAIL;
      await this.store.addTaskEvent({ taskId: task.id, actorId: null, kind: "paused", detail, at });
    }
  }

  /**
   * Sets the task's status from `from` to `to` only while it is still `from`: one `UPDATE` with the
   * status in its `WHERE`, setting the columns `store.ts`'s `updateTask` changes for a status
   * (`status`, `updated_at`). True when it did. docket's Store port has no compare-and-set for a
   * task (only `updateOccurrenceIf`), so it runs on the tracker's own table. The pause and the
   * resume here write a task's status without its lock (locks.ts), so both go through this.
   */
  private statusIf(taskId: string, from: TaskStatus, to: TaskStatus, at: string): boolean {
    const { changes } = this.db.query("UPDATE tasks SET status = ?, updated_at = ? WHERE seq = ? AND status = ?").run(to, at, seqOf("t", taskId), from);
    return changes === 1;
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
   * inside the lock: `resume`, `resumeTask`, or `exclusive`. The write is a compare-and-set from
   * `paused`: the lock is not the task's (locks.ts), so an owner's delete landing between the read
   * and the write stands -- no `resumed` event, no next run. One landing after the write stands too:
   * the `resumed` event is already written, and a run `materialize` queued just before it stays,
   * inert, on the archived task.
   */
  async release(taskId: string, actorId: string | null, detail: string, now: Date): Promise<boolean> {
    if (this.pausesFor(taskId).length > 0) return false;
    const task = await this.store.getTask(taskId);
    if (!task || task.status !== "paused") return false;
    const at = now.toISOString();
    if (!this.statusIf(taskId, "paused", "active", at)) return false;
    await this.store.addTaskEvent({ taskId, actorId, kind: "resumed", detail, at });
    const owner = await this.store.getUser(task.ownerId);
    // Read again for its run: `materialize` gives none to a task deleted since.
    const active = await this.store.getTask(taskId);
    if (owner && active) await materialize(this.store, active, owner, now);
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
