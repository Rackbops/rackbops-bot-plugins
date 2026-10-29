import type { Database } from "bun:sqlite";
import type {
  ConsentState,
  Delivery,
  DeliveryFilter,
  DeleteGuard,
  DeliverySettle,
  DeliveryStatus,
  FindingFilter,
  InviteBlock,
  Lane,
  NewBlock,
  NewEvent,
  NewFinding,
  NewOccurrence,
  NewReply,
  NewSeriesPoint,
  NewTask,
  NewTaskEvent,
  NewUsage,
  NewUser,
  Occurrence,
  OccurrenceEvent,
  OccurrenceFilter,
  OccurrencePatch,
  OccurrenceStatus,
  Reply,
  RunRecord,
  SeriesFilter,
  SeriesPoint,
  Store,
  StoredFinding,
  Task,
  TaskEvent,
  TaskFilter,
  TaskPatch,
  TaskRecipient,
  Usage,
  UsageFilter,
  User,
  UserFilter,
  UserPatch,
} from "@rackbops/docket-core";

/**
 * docket's Store port on `bun:sqlite` (plan 5.2, E1b). docket's `MemoryStore` is the reference for
 * the semantics and `STORE_CONTRACT` the proof (store.test.ts runs every case against a fresh
 * in-memory database). Every read builds a fresh object from the row, so a caller mutating what it
 * got back changes nothing stored -- the contract's "reads return copies" case.
 *
 * `bun:sqlite` is synchronous, so each method is one or two statements with no `await` between a
 * read and its write: two callers on the one event loop cannot interleave inside a method, which is
 * what makes `createOccurrence`'s dedupe (`ON CONFLICT (dedupe_key) DO NOTHING`) and the
 * read-merge-write updates safe without a transaction.
 *
 * The guarded writes docket 0.4.0 relies on are single statements, so they hold even across
 * connections: `updateOccurrenceIf` is one `UPDATE ... WHERE seq = ? AND status = ?`, `claimDelivery`
 * one `UPDATE ... WHERE retry_at IS NOT NULL`, `deleteOccurrence` one `DELETE ... AND status =
 * 'queued'`, and `planDelivery`, `addSeriesPoint`, `addFinding` and `addUsage` (keyed) and `claimNotice` an `INSERT ... ON
 * CONFLICT DO NOTHING`.
 *
 * Stricter than MemoryStore in one way: a Discord id belongs to at most one user (a partial UNIQUE
 * index), so `createUser` and `updateUser` reject a duplicate. people.ts's `admit` relies on it.
 */

type Row = Record<string, unknown>;

const DEFAULT_TIME_ZONE = "UTC"; // docket's default (STORE_CONTRACT); people.ts passes the tracker's own
const DEFAULT_PREFERRED_HOUR = 9;

function idOf(prefix: string, seq: unknown): string {
  return `${prefix}${Number(seq)}`;
}

/** The row number behind an id, or null when `id` is not one of this prefix's (so it matches nothing). */
export function seqOf(prefix: string, id: string): number | null {
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  return /^[1-9][0-9]*$/.test(rest) ? Number(rest) : null;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parse(text: unknown): unknown {
  return JSON.parse(String(text));
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toUser(r: Row): User {
  return {
    id: idOf("u", r.seq),
    discordId: str(r.discord_id),
    displayName: str(r.display_name),
    timeZone: String(r.time_zone),
    preferredHour: Number(r.preferred_hour),
    admin: Number(r.admin) === 1,
    createdAt: String(r.created_at),
  };
}

function toTask(r: Row): Task {
  return {
    id: idOf("t", r.seq),
    ownerId: String(r.owner_id),
    type: String(r.type),
    title: String(r.title),
    config: parse(r.config),
    state: parse(r.state),
    schedule: parse(r.schedule) as Task["schedule"],
    lane: String(r.lane) as Lane,
    capabilities: parse(r.capabilities) as Task["capabilities"],
    status: String(r.status) as Task["status"],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toRecipient(r: Row): TaskRecipient {
  return { taskId: String(r.task_id), userId: String(r.user_id), state: String(r.state) as ConsentState, at: String(r.at) };
}

function toBlock(r: Row): InviteBlock {
  return {
    id: idOf("b", r.seq),
    ownerId: String(r.owner_id),
    recipientId: String(r.recipient_id),
    expiresAt: str(r.expires_at),
    declineReplyId: str(r.decline_reply_id),
    liftedBy: str(r.lifted_by),
    liftedAt: str(r.lifted_at),
    createdAt: String(r.created_at),
  };
}

function toOccurrence(r: Row): Occurrence {
  return {
    id: idOf("o", r.seq),
    taskId: String(r.task_id),
    lane: String(r.lane) as Lane,
    dueAt: String(r.due_at),
    startedAt: str(r.started_at),
    finishedAt: str(r.finished_at),
    status: String(r.status) as Occurrence["status"],
    late: Number(r.late) === 1,
    dedupeKey: String(r.dedupe_key),
    summary: str(r.summary),
    costUsd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd),
    error: str(r.error),
    record: r.record === null || r.record === undefined ? null : (parse(r.record) as RunRecord | null),
    createdAt: String(r.created_at),
  };
}

function toEvent(r: Row): OccurrenceEvent {
  return {
    id: idOf("e", r.seq),
    occurrenceId: String(r.occurrence_id),
    agent: String(r.agent),
    type: String(r.type) as OccurrenceEvent["type"],
    text: String(r.text),
    at: String(r.at),
  };
}

function toTaskEvent(r: Row): TaskEvent {
  return {
    id: idOf("h", r.seq),
    taskId: String(r.task_id),
    actorId: str(r.actor_id),
    kind: String(r.kind) as TaskEvent["kind"],
    detail: String(r.detail),
    at: String(r.at),
  };
}

function toReply(r: Row): Reply {
  return {
    id: idOf("r", r.seq),
    occurrenceId: str(r.occurrence_id),
    taskId: String(r.task_id),
    userId: String(r.user_id),
    kind: String(r.kind) as Reply["kind"],
    payload: parse(r.payload),
    at: String(r.at),
  };
}

function toPoint(r: Row): SeriesPoint {
  return { id: idOf("s", r.seq), taskId: String(r.task_id), key: str(r.key), at: String(r.at), value: Number(r.value), unit: str(r.unit), note: str(r.note) };
}

function toUsage(r: Row): Usage {
  return {
    id: idOf("c", r.seq),
    userId: String(r.user_id),
    taskId: str(r.task_id),
    occurrenceId: str(r.occurrence_id),
    source: String(r.source) as Usage["source"],
    key: str(r.key),
    calls: Number(r.calls),
    costUsd: Number(r.cost_usd),
    at: String(r.at),
  };
}

function toFinding(r: Row): StoredFinding {
  const tags = parse(r.tags);
  return {
    id: idOf("f", r.seq),
    taskId: String(r.task_id),
    ownerId: String(r.owner_id),
    occurrenceId: str(r.occurrence_id),
    key: str(r.key),
    type: String(r.type),
    text: String(r.text),
    tags: Array.isArray(tags) ? tags.map(String) : [],
    source: str(r.source),
    at: String(r.at),
  };
}

function toDelivery(r: Row): Delivery {
  return {
    occurrenceId: String(r.occurrence_id),
    userId: String(r.user_id),
    status: String(r.status) as Delivery["status"],
    messageId: str(r.message_id),
    error: str(r.error),
    attempts: Number(r.attempts),
    deferrals: Number(r.deferrals),
    retryAt: str(r.retry_at),
    createdAt: String(r.created_at),
    claimedAt: str(r.claimed_at),
    settledAt: str(r.settled_at),
  };
}

/** The newest `limit` rows a read matches, oldest first, and how many it matches in all. */
export interface Tail<T> {
  rows: T[];
  total: number;
}

export interface RunsTail extends Tail<Occurrence> {
  /** The first run still to come, or null. */
  next: Occurrence | null;
}

export interface ChangesTail extends Tail<TaskEvent> {
  /** For a recipient: the latest pause or resume they are shown before `rows`, or null. */
  before: TaskEvent | null;
}

/**
 * docket's history kinds about one recipient (authz.ts `ABOUT_A_RECIPIENT`, not exported): a
 * recipient sees only their own, those whose `detail` is their id or starts with it and a space.
 */
const ABOUT_A_RECIPIENT = ["recipient_invited", "recipient_accepted", "recipient_declined", "recipient_opted_out", "recipient_removed", "blocked", "block_lifted"];

/** The kind of the pause or resume row before `e`'s on its task, or NULL: an index walk back from it. */
const PREV_PAUSE_OR_RESUME =
  "(SELECT x.kind FROM task_events x WHERE x.task_id = e.task_id AND x.kind IN ('paused', 'resumed') AND x.seq < e.seq ORDER BY x.seq DESC LIMIT 1)";

/**
 * The task events a recipient is shown, as a `WHERE` on `task_events e`: docket's `visibleHistory`
 * filter, then history.ts `changesForRecipient`'s choice of pauses and resumes -- which it shows,
 * not what they say. That scan's state before a row is only whether the row before it that pauses
 * or resumes pauses (`PREV_PAUSE_OR_RESUME`): a resume is shown after a pause, and a pause unless it
 * is another recipient's (`isRecipientPause` and not `pauseNames`) while the task already shows
 * paused. Each row is decided on its own, so a read of the newest shown rows walks back only as far
 * as it needs to; only the count reads them all. history.test.ts checks it against the two for
 * every kind and many orders.
 */
function recipientShown(taskId: string, viewerId: string): [string, unknown[]] {
  const about = ABOUT_A_RECIPIENT.map((k) => `'${k}'`).join(", ");
  const sql = `e.task_id = ? AND (
      (e.kind NOT IN ('paused', 'resumed') AND (e.kind NOT IN (${about}) OR e.detail = ? OR instr(e.detail, ?) = 1))
      OR (e.kind = 'resumed' AND ${PREV_PAUSE_OR_RESUME} = 'paused')
      OR (e.kind = 'paused' AND NOT (${PREV_PAUSE_OR_RESUME} IS 'paused' AND instr(e.detail, 'delivery to ') = 1 AND instr(e.detail, ?) <> 1))
    )`;
  return [sql, [taskId, viewerId, `${viewerId} `, `delivery to {${viewerId}} paused:`]];
}

/**
 * Forget-me's delete of one person's delivery rows, as one statement: `SqliteStore.deleteDeliveries`
 * runs it, and so does roster.ts's erasure inside its own transaction (a `bun:sqlite` transaction
 * cannot span the port's `await`), so both erase exactly the same rows.
 */
export function deleteDeliveriesOf(db: Database, userId: string): number {
  return db.query("DELETE FROM deliveries WHERE user_id = ?").run(userId).changes;
}

/**
 * Forget-me's delete of the findings of one person's tasks, as one statement: `SqliteStore.deleteFindings`
 * runs it, and so does roster.ts's erasure inside its own transaction, as for `deleteDeliveriesOf`.
 * A finding names its task's owner when stored; the task clause also catches one stored under an
 * owner the task no longer has (no path changes an owner today).
 */
export function deleteFindingsOf(db: Database, ownerId: string): number {
  return db.query("DELETE FROM findings WHERE owner_id = ? OR task_id IN (SELECT 't' || seq FROM tasks WHERE owner_id = ?)").run(ownerId, ownerId).changes;
}

export class SqliteStore implements Store {
  constructor(private readonly db: Database) {}

  private one(sql: string, ...params: unknown[]): Row | null {
    return (this.db.query(sql).get(...(params as never[])) as Row | null) ?? null;
  }

  private all(sql: string, ...params: unknown[]): Row[] {
    return this.db.query(sql).all(...(params as never[])) as Row[];
  }

  private run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.db.query(sql).run(...(params as never[]));
  }

  private byId(table: string, prefix: string, id: string): Row | null {
    const seq = seqOf(prefix, id);
    return seq === null ? null : this.one(`SELECT * FROM ${table} WHERE seq = ?`, seq);
  }

  private mustGet(table: string, prefix: string, id: string, what: string): Row {
    const row = this.byId(table, prefix, id);
    if (!row) throw new Error(`no ${what} ${id}`);
    return row;
  }

  // --- users ---------------------------------------------------------------------------------

  async getUser(id: string): Promise<User | null> {
    const r = this.byId("users", "u", id);
    return r ? toUser(r) : null;
  }

  async findUserByDiscordId(discordId: string): Promise<User | null> {
    const r = this.one("SELECT * FROM users WHERE discord_id = ? ORDER BY seq LIMIT 1", discordId);
    return r ? toUser(r) : null;
  }

  async createUser(u: NewUser): Promise<User> {
    const { lastInsertRowid } = this.run(
      `INSERT INTO users (discord_id, display_name, time_zone, preferred_hour, admin, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      u.discordId ?? null,
      u.displayName ?? null,
      u.timeZone ?? DEFAULT_TIME_ZONE,
      u.preferredHour ?? DEFAULT_PREFERRED_HOUR,
      u.admin ? 1 : 0,
      u.at,
    );
    return toUser(this.mustGet("users", "u", idOf("u", lastInsertRowid), "user"));
  }

  async updateUser(id: string, patch: UserPatch): Promise<User> {
    const cur = toUser(this.mustGet("users", "u", id, "user"));
    const next: User = {
      ...cur,
      ...(patch.discordId !== undefined ? { discordId: patch.discordId } : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.timeZone !== undefined ? { timeZone: patch.timeZone } : {}),
      ...(patch.preferredHour !== undefined ? { preferredHour: patch.preferredHour } : {}),
      ...(patch.admin !== undefined ? { admin: patch.admin } : {}),
    };
    this.run(
      `UPDATE users SET discord_id = ?, display_name = ?, time_zone = ?, preferred_hour = ?, admin = ?
       WHERE seq = ?`,
      next.discordId,
      next.displayName,
      next.timeZone,
      next.preferredHour,
      next.admin ? 1 : 0,
      seqOf("u", id),
    );
    return toUser(this.mustGet("users", "u", id, "user"));
  }

  async listUsers(filter: UserFilter = {}): Promise<User[]> {
    const rows =
      filter.admin === undefined
        ? this.all("SELECT * FROM users ORDER BY seq")
        : this.all("SELECT * FROM users WHERE admin = ? ORDER BY seq", filter.admin ? 1 : 0);
    return rows.map(toUser);
  }

  // --- tasks ---------------------------------------------------------------------------------

  async createTask(t: NewTask): Promise<Task> {
    const { lastInsertRowid } = this.run(
      `INSERT INTO tasks (owner_id, type, title, config, state, schedule, lane, capabilities, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      t.ownerId,
      t.type,
      t.title,
      json(t.config),
      json(t.state),
      json(t.schedule),
      t.lane,
      json(t.capabilities),
      t.at,
      t.at,
    );
    return toTask(this.mustGet("tasks", "t", idOf("t", lastInsertRowid), "task"));
  }

  async getTask(id: string): Promise<Task | null> {
    const r = this.byId("tasks", "t", id);
    return r ? toTask(r) : null;
  }

  async listTasks(filter: TaskFilter = {}): Promise<Task[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.ownerId !== undefined) (where.push("owner_id = ?"), params.push(filter.ownerId));
    if (filter.status !== undefined) (where.push("status = ?"), params.push(filter.status));
    if (filter.type !== undefined) (where.push("type = ?"), params.push(filter.type));
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.all(`SELECT * FROM tasks ${clause} ORDER BY seq`, ...params).map(toTask);
  }

  /**
   * Also the one place an ended task's open invitations are withdrawn (#205, Epic #265 decision 6): a task
   * leaves `active`/`paused` for `done` (docket's dispatcher, once a one-off has run) or `archived` (the
   * owner's delete), and every recipient still `invited` is removed with a `recipient_removed` event, in the
   * same synchronous run as the status write. A late Accept or Decline then finds no open invitation to answer
   * (docket's `replyForRef` refuses it), so no accept is confirmed and no decline block is written against the
   * owner. Accepted recipients are left alone.
   */
  async updateTask(id: string, patch: TaskPatch): Promise<Task> {
    const cur = toTask(this.mustGet("tasks", "t", id, "task"));
    const next: Task = {
      ...cur,
      updatedAt: patch.at,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.config !== undefined ? { config: patch.config } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
      ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    };
    this.run(
      `UPDATE tasks SET title = ?, config = ?, state = ?, schedule = ?, capabilities = ?, status = ?, updated_at = ?
       WHERE seq = ?`,
      next.title,
      json(next.config),
      json(next.state),
      json(next.schedule),
      json(next.capabilities),
      next.status,
      next.updatedAt,
      seqOf("t", id),
    );
    const ended = (status: string) => status === "done" || status === "archived";
    if (ended(next.status) && !ended(cur.status)) {
      // A watch that ends takes its inbox rows with it (#208, Epic #265 decision 7): its key is dead, so nothing reads them again.
      this.run("DELETE FROM want_inbox WHERE task_id = ?", id);
      const why = next.status === "archived" ? "deleted" : "finished";
      for (const r of this.all("SELECT * FROM task_recipients WHERE task_id = ? AND state = 'invited' ORDER BY seq", id).map(toRecipient)) {
        this.run("DELETE FROM task_recipients WHERE task_id = ? AND user_id = ?", id, r.userId);
        this.insertTaskEvent({
          taskId: id,
          actorId: null,
          kind: "recipient_removed",
          detail: `${r.userId}: the task was ${why}, so the invitation is withdrawn`,
          at: patch.at,
        });
      }
    }
    return toTask(this.mustGet("tasks", "t", id, "task"));
  }

  // --- recipients and blocks -----------------------------------------------------------------

  async listRecipients(taskId: string): Promise<TaskRecipient[]> {
    return this.all("SELECT * FROM task_recipients WHERE task_id = ? ORDER BY seq", taskId).map(toRecipient);
  }

  async setRecipient(taskId: string, userId: string, state: ConsentState, at: string): Promise<TaskRecipient> {
    this.run(
      `INSERT INTO task_recipients (task_id, user_id, state, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (task_id, user_id) DO UPDATE SET state = excluded.state, at = excluded.at`,
      taskId,
      userId,
      state,
      at,
    );
    return { taskId, userId, state, at };
  }

  async removeRecipient(taskId: string, userId: string): Promise<void> {
    this.run("DELETE FROM task_recipients WHERE task_id = ? AND user_id = ?", taskId, userId);
  }

  async listBlocks(ownerId: string, recipientId: string): Promise<InviteBlock[]> {
    return this.all("SELECT * FROM invite_blocks WHERE owner_id = ? AND recipient_id = ? ORDER BY seq", ownerId, recipientId).map(toBlock);
  }

  async getBlock(id: string): Promise<InviteBlock | null> {
    const r = this.byId("invite_blocks", "b", id);
    return r ? toBlock(r) : null;
  }

  async createBlock(b: NewBlock): Promise<InviteBlock> {
    const { lastInsertRowid } = this.run(
      "INSERT INTO invite_blocks (owner_id, recipient_id, expires_at, decline_reply_id, created_at) VALUES (?, ?, ?, ?, ?)",
      b.ownerId,
      b.recipientId,
      b.expiresAt,
      b.declineReplyId,
      b.at,
    );
    return toBlock(this.mustGet("invite_blocks", "b", idOf("b", lastInsertRowid), "block"));
  }

  async liftBlock(id: string, adminId: string, at: string): Promise<InviteBlock> {
    this.mustGet("invite_blocks", "b", id, "block");
    this.run("UPDATE invite_blocks SET lifted_by = ?, lifted_at = ? WHERE seq = ?", adminId, at, seqOf("b", id));
    return toBlock(this.mustGet("invite_blocks", "b", id, "block"));
  }

  // --- occurrences ---------------------------------------------------------------------------

  async createOccurrence(o: NewOccurrence): Promise<Occurrence | null> {
    const { changes, lastInsertRowid } = this.run(
      `INSERT INTO occurrences (task_id, lane, due_at, status, late, dedupe_key, created_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      o.taskId,
      o.lane,
      o.dueAt,
      o.dedupeKey,
      o.at,
    );
    if (changes === 0) return null;
    return toOccurrence(this.mustGet("occurrences", "o", idOf("o", lastInsertRowid), "occurrence"));
  }

  async getOccurrence(id: string): Promise<Occurrence | null> {
    const r = this.byId("occurrences", "o", id);
    return r ? toOccurrence(r) : null;
  }

  async listOccurrences(filter: OccurrenceFilter = {}): Promise<Occurrence[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.taskId !== undefined) (where.push("task_id = ?"), params.push(filter.taskId));
    if (filter.lane !== undefined) (where.push("lane = ?"), params.push(filter.lane));
    if (filter.status !== undefined) (where.push("status = ?"), params.push(filter.status));
    if (filter.dueBefore !== undefined) (where.push("due_at <= ?"), params.push(filter.dueBefore));
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.all(`SELECT * FROM occurrences ${clause} ORDER BY due_at, created_at, seq`, ...params).map(toOccurrence);
  }

  async updateOccurrence(id: string, patch: OccurrencePatch): Promise<Occurrence> {
    this.mustGet("occurrences", "o", id, "occurrence");
    this.patchOccurrence(id, patch, null);
    return toOccurrence(this.mustGet("occurrences", "o", id, "occurrence"));
  }

  async updateOccurrenceIf(id: string, expected: OccurrenceStatus, patch: OccurrencePatch): Promise<Occurrence | null> {
    if (!this.patchOccurrence(id, patch, expected)) return null;
    return toOccurrence(this.mustGet("occurrences", "o", id, "occurrence"));
  }

  /**
   * One `UPDATE` setting only the columns `patch` names, guarded by `expected` when given (the
   * compare-and-set). True when a row changed. Named columns only, so a guarded write never reads
   * first: nothing it did not name can be overwritten with a stale value.
   */
  private patchOccurrence(id: string, patch: OccurrencePatch, expected: OccurrenceStatus | null): boolean {
    const seq = seqOf("o", id);
    if (seq === null) return false;
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => (sets.push(`${column} = ?`), params.push(value));
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.startedAt !== undefined) set("started_at", patch.startedAt);
    if (patch.finishedAt !== undefined) set("finished_at", patch.finishedAt);
    if (patch.late !== undefined) set("late", patch.late ? 1 : 0);
    if (patch.summary !== undefined) set("summary", patch.summary);
    if (patch.costUsd !== undefined) set("cost_usd", patch.costUsd);
    if (patch.error !== undefined) set("error", patch.error);
    if (patch.record !== undefined) set("record", patch.record === null ? null : json(patch.record));
    // An empty patch still has to answer whether the guard held: a no-op assignment does.
    if (sets.length === 0) sets.push("seq = seq");
    params.push(seq);
    const guard = expected === null ? "" : " AND status = ?";
    if (expected !== null) params.push(expected);
    return this.run(`UPDATE occurrences SET ${sets.join(", ")} WHERE seq = ?${guard}`, ...params).changes > 0;
  }

  async deleteOccurrence(id: string, guard?: DeleteGuard): Promise<boolean> {
    const seq = seqOf("o", id);
    if (seq === null) return false;
    if (guard === undefined) return this.run("DELETE FROM occurrences WHERE seq = ? AND status = 'queued'", seq).changes > 0;
    // One statement, so an event written between the caller's read and this delete is seen. An event
    // id the store cannot find refuses: `seq > (subquery)` would be NULL there, and NULL deletes.
    const last = guard.lastEventId === null ? null : seqOf("e", guard.lastEventId);
    if (guard.lastEventId !== null && last === null) return false;
    if (last === null) {
      return (
        this.run(
          "DELETE FROM occurrences WHERE seq = ? AND status = 'queued' AND record IS NULL AND NOT EXISTS (SELECT 1 FROM events WHERE occurrence_id = ?)",
          seq,
          id,
        ).changes > 0
      );
    }
    return (
      this.run(
        `DELETE FROM occurrences WHERE seq = ? AND status = 'queued' AND record IS NULL
         AND EXISTS (SELECT 1 FROM events WHERE seq = ? AND occurrence_id = ?)
         AND NOT EXISTS (SELECT 1 FROM events WHERE occurrence_id = ? AND seq > ?)`,
        seq,
        last,
        id,
        id,
        last,
      ).changes > 0
    );
  }

  async requeueRunning(lane?: Lane): Promise<string[]> {
    const rows =
      lane === undefined
        ? this.all("SELECT seq FROM occurrences WHERE status = 'running' ORDER BY seq")
        : this.all("SELECT seq FROM occurrences WHERE status = 'running' AND lane = ? ORDER BY seq", lane);
    // Fully unstarted (docket 0.4.0): `started_at` back to null; `record` is kept, so a fired run resumes.
    for (const r of rows) this.run("UPDATE occurrences SET status = 'queued', started_at = NULL WHERE seq = ? AND status = 'running'", r.seq);
    return rows.map((r) => idOf("o", r.seq));
  }

  // --- history -------------------------------------------------------------------------------

  async addEvent(e: NewEvent): Promise<OccurrenceEvent> {
    const { lastInsertRowid } = this.run(
      "INSERT INTO events (occurrence_id, agent, type, text, at) VALUES (?, ?, ?, ?, ?)",
      e.occurrenceId,
      e.agent,
      e.type,
      e.text,
      e.at,
    );
    return toEvent(this.mustGet("events", "e", idOf("e", lastInsertRowid), "event"));
  }

  async listEvents(occurrenceId: string, after?: string): Promise<OccurrenceEvent[]> {
    // MemoryStore starts after the named event wherever it is, and from the start when it names
    // none it knows; the same here.
    const cursor = after === undefined ? null : this.byId("events", "e", after);
    return this.all(
      "SELECT * FROM events WHERE occurrence_id = ? AND seq > ? ORDER BY seq",
      occurrenceId,
      cursor ? Number(cursor.seq) : 0,
    ).map(toEvent);
  }

  async addTaskEvent(e: NewTaskEvent): Promise<TaskEvent> {
    return this.insertTaskEvent(e);
  }

  private insertTaskEvent(e: NewTaskEvent): TaskEvent {
    const { lastInsertRowid } = this.run(
      "INSERT INTO task_events (task_id, actor_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)",
      e.taskId,
      e.actorId,
      e.kind,
      e.detail,
      e.at,
    );
    return toTaskEvent(this.mustGet("task_events", "h", idOf("h", lastInsertRowid), "task event"));
  }

  async listTaskEvents(taskId: string): Promise<TaskEvent[]> {
    return this.all("SELECT * FROM task_events WHERE task_id = ? ORDER BY seq", taskId).map(toTaskEvent);
  }

  async addReply(r: NewReply): Promise<Reply> {
    const { lastInsertRowid } = this.run(
      "INSERT INTO replies (occurrence_id, task_id, user_id, kind, payload, at) VALUES (?, ?, ?, ?, ?, ?)",
      r.occurrenceId,
      r.taskId,
      r.userId,
      r.kind,
      json(r.payload),
      r.at,
    );
    return toReply(this.mustGet("replies", "r", idOf("r", lastInsertRowid), "reply"));
  }

  async listReplies(taskId: string): Promise<Reply[]> {
    return this.all("SELECT * FROM replies WHERE task_id = ? ORDER BY seq", taskId).map(toReply);
  }

  // --- history's bounded reads (history.ts `HistoryReads`, #265) -------------------------------

  async runsTail(taskId: string, now: string, limit: number): Promise<RunsTail> {
    // Still to come: queued and due after `now`, compared as text like `listOccurrences`' `dueBefore`
    // (every `dueAt` is a `toISOString()`).
    const past = "task_id = ? AND NOT (status = 'queued' AND due_at > ?)";
    const total = Number(this.one(`SELECT COUNT(*) AS n FROM occurrences WHERE ${past}`, taskId, now)?.n ?? 0);
    // listOccurrences' order, newest first, then turned back.
    const rows = this.all(`SELECT * FROM occurrences WHERE ${past} ORDER BY due_at DESC, created_at DESC, seq DESC LIMIT ?`, taskId, now, limit);
    const next = this.one("SELECT * FROM occurrences WHERE task_id = ? AND status = 'queued' AND due_at > ? ORDER BY due_at, created_at, seq LIMIT 1", taskId, now);
    return { rows: rows.reverse().map(toOccurrence), total, next: next ? toOccurrence(next) : null };
  }

  async repliesTo(taskId: string, occurrenceIds: readonly string[], userId: string | null): Promise<Reply[]> {
    if (occurrenceIds.length === 0) return [];
    const ids = `occurrence_id IN (${occurrenceIds.map(() => "?").join(", ")})`;
    const own = userId === null ? "" : " AND user_id = ?";
    return this.all(`SELECT * FROM replies WHERE task_id = ? AND ${ids}${own} ORDER BY seq`, taskId, ...occurrenceIds, ...(userId === null ? [] : [userId])).map(toReply);
  }

  async changesTail(taskId: string, viewerId: string | null, limit: number): Promise<ChangesTail> {
    if (viewerId === null) {
      const total = Number(this.one("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?", taskId)?.n ?? 0);
      const rows = this.all("SELECT * FROM task_events WHERE task_id = ? ORDER BY seq DESC LIMIT ?", taskId, limit).reverse();
      return { rows: rows.map(toTaskEvent), total, before: null };
    }
    const [shown, params] = recipientShown(taskId, viewerId);
    const total = Number(this.one(`SELECT COUNT(*) AS n FROM task_events e WHERE ${shown}`, ...params)?.n ?? 0);
    const rows = this.all(`SELECT e.* FROM task_events e WHERE ${shown} ORDER BY e.seq DESC LIMIT ?`, ...params, limit).reverse();
    const first = rows[0];
    const before = first
      ? this.one(`SELECT e.* FROM task_events e WHERE ${shown} AND e.kind IN ('paused', 'resumed') AND e.seq < ? ORDER BY e.seq DESC LIMIT 1`, ...params, Number(first.seq))
      : null;
    return { rows: rows.map(toTaskEvent), total, before: before ? toTaskEvent(before) : null };
  }

  async addSeriesPoint(p: NewSeriesPoint): Promise<SeriesPoint> {
    const key = p.key ?? null;
    const { changes, lastInsertRowid } = this.run(
      "INSERT INTO series (task_id, key, at, value, unit, note) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key) WHERE key IS NOT NULL DO NOTHING",
      p.taskId,
      key,
      p.at,
      p.value,
      p.unit ?? null,
      p.note ?? null,
    );
    if (changes === 0) {
      // The key is stored: the point a run already appended, unchanged.
      const known = this.one("SELECT * FROM series WHERE key = ?", key);
      if (!known) throw new Error(`series point ${key} was neither added nor found`);
      return toPoint(known);
    }
    return toPoint(this.mustGet("series", "s", idOf("s", lastInsertRowid), "series point"));
  }

  async listSeries(taskId: string, filter: SeriesFilter = {}): Promise<SeriesPoint[]> {
    const points =
      filter.since === undefined
        ? this.all("SELECT * FROM series WHERE task_id = ? ORDER BY at, seq", taskId)
        : this.all("SELECT * FROM series WHERE task_id = ? AND at >= ? ORDER BY at, seq", taskId, filter.since);
    const kept = filter.limit === undefined ? points : !(filter.limit >= 1) ? [] : points.slice(-filter.limit);
    return kept.map(toPoint);
  }

  // --- findings (docket 0.5.0: a run's stored claims, plan 5.2) -----------------------------------

  async addFinding(f: NewFinding): Promise<StoredFinding> {
    const key = f.key ?? null;
    const { changes, lastInsertRowid } = this.run(
      `INSERT INTO findings (task_id, owner_id, occurrence_id, key, type, text, tags, source, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) WHERE key IS NOT NULL DO NOTHING`,
      f.taskId,
      f.ownerId,
      f.occurrenceId,
      key,
      f.type,
      f.text,
      json(f.tags ?? []),
      f.source ?? null,
      f.at,
    );
    if (changes === 0) {
      const known = this.one("SELECT * FROM findings WHERE key = ?", key);
      if (!known) throw new Error(`finding ${key} was neither added nor found`);
      return toFinding(known);
    }
    return toFinding(this.mustGet("findings", "f", idOf("f", lastInsertRowid), "finding"));
  }

  async listFindings(filter: FindingFilter = {}): Promise<StoredFinding[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.taskId !== undefined) (where.push("task_id = ?"), params.push(filter.taskId));
    if (filter.ownerId !== undefined) (where.push("owner_id = ?"), params.push(filter.ownerId));
    if (filter.since !== undefined) (where.push("at >= ?"), params.push(filter.since));
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.all(`SELECT * FROM findings ${clause} ORDER BY at, seq`, ...params).map(toFinding);
  }

  async deleteFindings(ownerId: string): Promise<number> {
    return deleteFindingsOf(this.db, ownerId);
  }

  // --- usage and notices (docket's budget.ts; written only by an execute lane) ----------------

  async addUsage(u: NewUsage): Promise<Usage> {
    const key = u.key ?? null;
    const { changes, lastInsertRowid } = this.run(
      "INSERT INTO usage (user_id, task_id, occurrence_id, source, key, calls, cost_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) WHERE key IS NOT NULL DO NOTHING",
      u.userId,
      u.taskId,
      u.occurrenceId,
      u.source,
      key,
      u.calls,
      u.costUsd,
      u.at,
    );
    if (changes === 0) {
      // The key is stored: the charge a run already made, unchanged (docket 0.5.0).
      const known = this.one("SELECT * FROM usage WHERE key = ?", key);
      if (!known) throw new Error(`usage ${key} was neither added nor found`);
      return toUsage(known);
    }
    return toUsage(this.mustGet("usage", "c", idOf("c", lastInsertRowid), "usage"));
  }

  async listUsage(filter: UsageFilter = {}): Promise<Usage[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.userId !== undefined) (where.push("user_id = ?"), params.push(filter.userId));
    if (filter.since !== undefined) (where.push("at >= ?"), params.push(filter.since));
    if (filter.before !== undefined) (where.push("at < ?"), params.push(filter.before));
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.all(`SELECT * FROM usage ${clause} ORDER BY at, seq`, ...params).map(toUsage);
  }

  async claimNotice(key: string, at: string): Promise<boolean> {
    return this.run("INSERT INTO notices (key, at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", key, at).changes === 1;
  }

  /**
   * The notice whose key starts with `prefix` and whose `at` is the latest, or null. Reads only: a
   * range over the key's primary-key index (the bound `prefix` + U+FFFF holds for the ASCII keys
   * written here). The daily digest reads a person's last claimed day with it (digest.ts).
   */
  async lastNotice(prefix: string): Promise<{ key: string; at: string } | null> {
    const r = this.one("SELECT key, at FROM notices WHERE key >= ? AND key < ? ORDER BY at DESC LIMIT 1", prefix, `${prefix}\uffff`);
    return r ? { key: String(r.key), at: String(r.at) } : null;
  }

  // --- deliveries (docket's delivery.ts: one row per run and person, claimed before each send) --

  private delivery(occurrenceId: string, userId: string): Delivery | null {
    const r = this.one("SELECT * FROM deliveries WHERE occurrence_id = ? AND user_id = ?", occurrenceId, userId);
    return r ? toDelivery(r) : null;
  }

  async planDelivery(occurrenceId: string, userId: string, at: string): Promise<Delivery | null> {
    const { changes } = this.run(
      `INSERT INTO deliveries (occurrence_id, user_id, status, attempts, deferrals, retry_at, created_at)
       VALUES (?, ?, 'pending', 0, 0, ?, ?)
       ON CONFLICT (occurrence_id, user_id) DO NOTHING`,
      occurrenceId,
      userId,
      at,
      at,
    );
    return changes === 1 ? this.delivery(occurrenceId, userId) : null;
  }

  async claimDelivery(occurrenceId: string, userId: string, at: string): Promise<Delivery | null> {
    const { changes } = this.run(
      `UPDATE deliveries SET status = 'claimed', claimed_at = ?, retry_at = NULL
       WHERE occurrence_id = ? AND user_id = ? AND retry_at IS NOT NULL`,
      at,
      occurrenceId,
      userId,
    );
    return changes === 1 ? this.delivery(occurrenceId, userId) : null;
  }

  async settleDelivery(occurrenceId: string, userId: string, settle: DeliverySettle, expected?: DeliveryStatus): Promise<Delivery> {
    const { changes } = this.run(
      `UPDATE deliveries SET status = ?, message_id = ?, error = ?, attempts = ?, deferrals = ?, retry_at = ?, settled_at = ?
       WHERE occurrence_id = ? AND user_id = ?${expected === undefined ? "" : " AND status = ?"}`,
      settle.status,
      settle.messageId ?? null,
      settle.error ?? null,
      settle.attempts,
      settle.deferrals,
      settle.retryAt,
      settle.at,
      occurrenceId,
      userId,
      ...(expected === undefined ? [] : [expected]),
    );
    // A moved-on row is returned as it stands; only a missing one throws.
    if (changes === 0 && !this.delivery(occurrenceId, userId)) throw new Error(`no delivery ${occurrenceId}:${userId}`);
    return this.delivery(occurrenceId, userId) as Delivery;
  }

  async listDeliveries(filter: DeliveryFilter = {}): Promise<Delivery[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.occurrenceId !== undefined) (where.push("occurrence_id = ?"), params.push(filter.occurrenceId));
    if (filter.userId !== undefined) (where.push("user_id = ?"), params.push(filter.userId));
    if (filter.status !== undefined) (where.push("status = ?"), params.push(filter.status));
    if (filter.dueBefore !== undefined) (where.push("retry_at IS NOT NULL AND retry_at <= ?"), params.push(filter.dueBefore));
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.all(`SELECT * FROM deliveries ${clause} ORDER BY created_at, seq`, ...params).map(toDelivery);
  }

  async deleteDeliveries(userId: string): Promise<number> {
    return deleteDeliveriesOf(this.db, userId);
  }
}
