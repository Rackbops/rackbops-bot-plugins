import type { Database } from "bun:sqlite";

/**
 * The tracker-only reads and the one delete docket's Store port has no method for
 * (rackbops-bot-plugins#80, slice 3; plan 5.8, 5.10): the admin view's list of people and of the
 * decline blocks in force, and forget-me's erasure of a person. docket's Store answers one person,
 * one task or one owner/recipient pair at a time and never deletes a person or a task, so these are
 * plain SQL over the tracker's own database, as admissions.ts and delivery-health.ts already are.
 * docket itself is not changed.
 */

/** One person as the admin view lists them. */
export interface PersonRow {
  id: string;
  discordId: string | null;
  displayName: string | null;
  timeZone: string;
  preferredHour: number;
  admin: boolean;
  createdAt: string;
  /** The admin's tracker id; null when the configuration admitted them; `FORGOTTEN` when that admin was forgotten. */
  admittedBy: string | null;
  registeredAt: string | null;
  /** When their delivery paused for failed DMs; null when it is not paused. */
  deliveryPausedAt: string | null;
  failures: number;
  /** Tasks they own, by status. */
  owned: { active: number; paused: number; done: number; archived: number };
  /** Tasks they accepted from someone else. */
  receiving: number;
}

/** A decline block in force (not lifted; permanent, or not yet expired). */
export interface BlockRow {
  id: string;
  ownerId: string;
  recipientId: string;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * What an audit column of someone else's row says once the person it named is forgotten: an admin
 * did it, and who is gone. Not an id (it has no `u` prefix and matches no user), and not null, which
 * already means "the configuration" in `admissions.admitted_by`.
 */
export const FORGOTTEN = "forgotten";

/** What the erasure removed, table by table, and the other people's tasks it freed of a pause. */
export interface Erased {
  rows: Record<string, number>;
  /** Other owners' tasks that were paused only because this person's DMs failed. */
  freed: string[];
}

type Count = { n: number };

/** The tables the erasure touches, in the order it deletes from them. Every table in the schema is here. */
export const ERASED_TABLES = [
  "events",
  "delivery_claims",
  "replies",
  "task_events",
  "series",
  "task_recipients",
  "delivery_pauses",
  "occurrences",
  "tasks",
  "invite_blocks",
  "admissions",
  "delivery_health",
  "web_sessions",
  "web_login_tokens",
  "users",
] as const;

/** Whether `text` names the tracker id `id` as a word of its own (so `u1` is not found in `u12`). */
export function mentions(text: string | null, id: string): boolean {
  if (text === null) return false;
  return new RegExp(`(^|[^A-Za-z0-9_])${id}(?![0-9A-Za-z_])`).test(text);
}

/** `text` with every mention of `id` replaced, for a row that is someone else's and stays. */
export function redact(text: string, id: string): string {
  return text.replace(new RegExp(`(^|[^A-Za-z0-9_])${id}(?![0-9A-Za-z_])`, "g"), `$1(${FORGOTTEN})`);
}

export class Roster {
  constructor(private readonly db: Database) {}

  /** Everyone in the tracker's store, oldest first, with what the admin view shows of each. */
  people(): PersonRow[] {
    const rows = this.db
      .query(
        `SELECT u.seq, u.discord_id, u.display_name, u.time_zone, u.preferred_hour, u.admin, u.created_at,
                a.admitted_by, a.registered_at, h.paused_at, h.failures
         FROM users u
         LEFT JOIN admissions a ON a.user_id = 'u' || u.seq
         LEFT JOIN delivery_health h ON h.user_id = 'u' || u.seq
         ORDER BY u.seq`,
      )
      .all() as Record<string, unknown>[];
    const owned = this.db.query("SELECT owner_id, status, COUNT(*) AS n FROM tasks GROUP BY owner_id, status").all() as {
      owner_id: string;
      status: string;
      n: number;
    }[];
    const receiving = this.db
      .query(
        `SELECT r.user_id, COUNT(*) AS n FROM task_recipients r JOIN tasks t ON r.task_id = 't' || t.seq
         WHERE r.state = 'accepted' AND t.status IN ('active', 'paused') GROUP BY r.user_id`,
      )
      .all() as { user_id: string; n: number }[];
    return rows.map((r) => {
      const id = `u${Number(r.seq)}`;
      const counts = { active: 0, paused: 0, done: 0, archived: 0 };
      for (const o of owned) if (o.owner_id === id && o.status in counts) counts[o.status as keyof typeof counts] = Number(o.n);
      const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
      return {
        id,
        discordId: str(r.discord_id),
        displayName: str(r.display_name),
        timeZone: String(r.time_zone),
        preferredHour: Number(r.preferred_hour),
        admin: Number(r.admin) === 1,
        createdAt: String(r.created_at),
        admittedBy: str(r.admitted_by),
        registeredAt: str(r.registered_at),
        deliveryPausedAt: str(r.paused_at),
        failures: Number(r.failures ?? 0),
        owned: counts,
        receiving: Number(receiving.find((x) => x.user_id === id)?.n ?? 0),
      };
    });
  }

  /**
   * After an erasure: copies the write-ahead log back into the database file and truncates it, so
   * the erased pages (overwritten, with `secure_delete` on; schema.ts) do not linger in the log.
   * Best effort: a reader holding the log open leaves it for SQLite's next checkpoint.
   */
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  /** How many admins there are. */
  admins(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM users WHERE admin = 1").get() as Count).n;
  }

  /** Every decline block in force at `now`, newest first. */
  activeBlocks(now: Date): BlockRow[] {
    const rows = this.db
      .query(
        `SELECT seq, owner_id, recipient_id, expires_at, created_at FROM invite_blocks
         WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY seq DESC`,
      )
      .all(now.toISOString()) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: `b${Number(r.seq)}`,
      ownerId: String(r.owner_id),
      recipientId: String(r.recipient_id),
      expiresAt: r.expires_at === null ? null : String(r.expires_at),
      createdAt: String(r.created_at),
    }));
  }

  /**
   * Erases the person `userId` from the tracker's store, in one transaction (plan 5.8, "Forget
   * me"): their tasks, whatever their status, and everything under them -- runs, run events,
   * replies (anyone's), history, series, recipients, delivery claims and pauses; on everyone
   * else's tasks, their recipient rows, their replies, the history rows they made or that name
   * them, the run events and claims of DMs to them, and their pauses; every decline block they
   * are either side of; their admission, delivery health, web sessions and sign-in links; and
   * their person row. Where another person's row keeps an audit column that named them (who
   * admitted someone, who lifted a block), it is set to `FORGOTTEN`; where another person's run
   * says their id in its error or summary, the id is redacted. Nothing is archived. Returns the
   * rows removed per table and the other owners' tasks now held by no pause.
   *
   * Synchronous: a `bun:sqlite` transaction cannot span an `await`, so nothing else on the event
   * loop can see the person half gone. Throws (and changes nothing) when there is no such person.
   */
  erase(userId: string): Erased {
    const seq = /^u([1-9][0-9]*)$/.exec(userId)?.[1];
    if (seq === undefined) throw new Error(`no user ${userId}`);
    return this.db.transaction((): Erased => {
      const person = this.db.query("SELECT display_name FROM users WHERE seq = ?").get(Number(seq)) as { display_name: string | null } | null;
      if (!person) throw new Error(`no user ${userId}`);
      const rows: Record<string, number> = {};
      const del = (table: string, where: string, ...params: (string | number)[]) => {
        rows[table] = (rows[table] ?? 0) + this.db.query(`DELETE FROM ${table} WHERE ${where}`).run(...params).changes;
      };
      const THEIR_TASKS = "SELECT 't' || seq FROM tasks WHERE owner_id = ?";
      const THEIR_RUNS = `SELECT 'o' || seq FROM occurrences WHERE task_id IN (${THEIR_TASKS})`;

      // Other owners' tasks paused for this person, before their pause rows go.
      const pausedFor = (
        this.db.query(`SELECT task_id FROM delivery_pauses WHERE user_id = ? AND task_id NOT IN (${THEIR_TASKS})`).all(userId, userId) as {
          task_id: string;
        }[]
      ).map((r) => r.task_id);

      // Other owners' tasks they had a part in: only there can a pause's text name them by name.
      const taskIds = (sql: string) => (this.db.query(sql).all(userId) as { t: string }[]).map((r) => r.t);
      const involved = new Set([
        ...pausedFor,
        ...taskIds("SELECT task_id AS t FROM task_recipients WHERE user_id = ?"),
        ...taskIds("SELECT task_id AS t FROM task_events WHERE actor_id = ?"),
        ...(this.db.query("SELECT task_id AS t, detail FROM task_events WHERE instr(detail, ?) > 0").all(userId) as { t: string; detail: string }[])
          .filter((r) => mentions(r.detail, userId))
          .map((r) => r.t),
      ]);

      // Everything under their own tasks, then the rows that are theirs on anyone's.
      del("events", `occurrence_id IN (${THEIR_RUNS})`, userId);
      del("delivery_claims", `occurrence_id IN (${THEIR_RUNS}) OR user_id = ?`, userId, userId);
      del("replies", `task_id IN (${THEIR_TASKS}) OR user_id = ?`, userId, userId);
      del("task_events", `task_id IN (${THEIR_TASKS}) OR actor_id = ?`, userId, userId);
      del("series", `task_id IN (${THEIR_TASKS})`, userId);
      del("task_recipients", `task_id IN (${THEIR_TASKS}) OR user_id = ?`, userId, userId);
      del("delivery_pauses", `task_id IN (${THEIR_TASKS}) OR user_id = ?`, userId, userId);
      del("occurrences", `task_id IN (${THEIR_TASKS})`, userId);
      del("tasks", "owner_id = ?", userId);

      // What is left names them only in text: a delivery to them, an invitation of them, a pause
      // for them. The id is a word of its own there (`u5`, `u5 24h`, `u5: ...`); a pause names them
      // by display name (delivery-health.ts).
      const named = (table: string, column: string) =>
        (this.db.query(`SELECT seq, ${column} AS text FROM ${table} WHERE instr(${column}, ?) > 0`).all(userId) as {
          seq: number;
          text: string;
        }[]).filter((r) => mentions(r.text, userId));
      for (const r of named("events", "text")) del("events", "seq = ?", r.seq);
      for (const r of named("task_events", "detail")) del("task_events", "seq = ?", r.seq);
      if (person.display_name !== null) {
        const paused = `delivery to ${person.display_name} paused:`;
        const rowsNaming = this.db.query("SELECT seq, task_id, detail FROM task_events WHERE kind = 'paused' AND actor_id IS NULL").all() as {
          seq: number;
          task_id: string;
          detail: string;
        }[];
        for (const r of rowsNaming) if (involved.has(r.task_id) && r.detail.startsWith(paused)) del("task_events", "seq = ?", r.seq);
      }
      for (const column of ["error", "summary"]) {
        for (const r of named("occurrences", column)) {
          this.db.query(`UPDATE occurrences SET ${column} = ? WHERE seq = ?`).run(redact(r.text, userId), r.seq);
        }
      }

      del("invite_blocks", "owner_id = ? OR recipient_id = ?", userId, userId);
      this.db.query("UPDATE invite_blocks SET lifted_by = ? WHERE lifted_by = ?").run(FORGOTTEN, userId);
      del("admissions", "user_id = ?", userId);
      this.db.query("UPDATE admissions SET admitted_by = ? WHERE admitted_by = ?").run(FORGOTTEN, userId);
      del("delivery_health", "user_id = ?", userId);
      del("web_sessions", "user_id = ?", userId);
      del("web_login_tokens", "user_id = ?", userId);
      del("users", "seq = ?", Number(seq));

      const held = this.db.query("SELECT 1 FROM delivery_pauses WHERE task_id = ? LIMIT 1");
      const freed = [...new Set(pausedFor)].filter((t) => held.get(t) === null);
      return { rows, freed };
    })();
  }
}
