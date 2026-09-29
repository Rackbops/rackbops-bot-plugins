import type { Database } from "bun:sqlite";
import type {
  ConsentState,
  InviteBlock,
  Lane,
  NewBlock,
  NewEvent,
  NewOccurrence,
  NewReply,
  NewSeriesPoint,
  NewTask,
  NewTaskEvent,
  NewUser,
  Occurrence,
  OccurrenceEvent,
  OccurrenceFilter,
  OccurrencePatch,
  Reply,
  SeriesFilter,
  SeriesPoint,
  Store,
  Task,
  TaskEvent,
  TaskFilter,
  TaskPatch,
  TaskRecipient,
  User,
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
function seqOf(prefix: string, id: string): number | null {
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
    usrSubject: str(r.usr_subject),
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
  return { id: idOf("s", r.seq), taskId: String(r.task_id), at: String(r.at), value: Number(r.value), unit: str(r.unit), note: str(r.note) };
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

  async findUserBySubject(usrSubject: string): Promise<User | null> {
    const r = this.one("SELECT * FROM users WHERE usr_subject = ? ORDER BY seq LIMIT 1", usrSubject);
    return r ? toUser(r) : null;
  }

  async createUser(u: NewUser): Promise<User> {
    const { lastInsertRowid } = this.run(
      `INSERT INTO users (discord_id, usr_subject, display_name, time_zone, preferred_hour, admin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      u.discordId ?? null,
      u.usrSubject ?? null,
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
      ...(patch.usrSubject !== undefined ? { usrSubject: patch.usrSubject } : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.timeZone !== undefined ? { timeZone: patch.timeZone } : {}),
      ...(patch.preferredHour !== undefined ? { preferredHour: patch.preferredHour } : {}),
      ...(patch.admin !== undefined ? { admin: patch.admin } : {}),
    };
    this.run(
      `UPDATE users SET discord_id = ?, usr_subject = ?, display_name = ?, time_zone = ?, preferred_hour = ?, admin = ?
       WHERE seq = ?`,
      next.discordId,
      next.usrSubject,
      next.displayName,
      next.timeZone,
      next.preferredHour,
      next.admin ? 1 : 0,
      seqOf("u", id),
    );
    return toUser(this.mustGet("users", "u", id, "user"));
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
    const cur = toOccurrence(this.mustGet("occurrences", "o", id, "occurrence"));
    const next: Occurrence = {
      ...cur,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
      ...(patch.late !== undefined ? { late: patch.late } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.costUsd !== undefined ? { costUsd: patch.costUsd } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
    };
    this.run(
      `UPDATE occurrences SET status = ?, started_at = ?, finished_at = ?, late = ?, summary = ?, cost_usd = ?, error = ?
       WHERE seq = ?`,
      next.status,
      next.startedAt,
      next.finishedAt,
      next.late ? 1 : 0,
      next.summary,
      next.costUsd,
      next.error,
      seqOf("o", id),
    );
    return toOccurrence(this.mustGet("occurrences", "o", id, "occurrence"));
  }

  async deleteQueuedOccurrences(taskId: string): Promise<number> {
    return this.run("DELETE FROM occurrences WHERE task_id = ? AND status = 'queued'", taskId).changes;
  }

  async requeueRunning(lane?: Lane): Promise<string[]> {
    const rows =
      lane === undefined
        ? this.all("SELECT seq FROM occurrences WHERE status = 'running' ORDER BY seq")
        : this.all("SELECT seq FROM occurrences WHERE status = 'running' AND lane = ? ORDER BY seq", lane);
    for (const r of rows) this.run("UPDATE occurrences SET status = 'queued' WHERE seq = ?", r.seq);
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

  async addSeriesPoint(p: NewSeriesPoint): Promise<SeriesPoint> {
    const { lastInsertRowid } = this.run(
      "INSERT INTO series (task_id, at, value, unit, note) VALUES (?, ?, ?, ?, ?)",
      p.taskId,
      p.at,
      p.value,
      p.unit ?? null,
      p.note ?? null,
    );
    return toPoint(this.mustGet("series", "s", idOf("s", lastInsertRowid), "series point"));
  }

  async listSeries(taskId: string, filter: SeriesFilter = {}): Promise<SeriesPoint[]> {
    const points =
      filter.since === undefined
        ? this.all("SELECT * FROM series WHERE task_id = ? ORDER BY at, seq", taskId)
        : this.all("SELECT * FROM series WHERE task_id = ? AND at >= ? ORDER BY at, seq", taskId, filter.since);
    const kept = filter.limit === undefined ? points : points.slice(-filter.limit);
    return kept.map(toPoint);
  }
}
