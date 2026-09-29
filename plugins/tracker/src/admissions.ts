import type { Database } from "bun:sqlite";

/**
 * Who admitted each person and when they registered (plan 5.8): `/allow @user` writes the row, with
 * the admin's tracker id (null when the configuration did it, `TRACKER_ADMIN_DISCORD_IDS`), and
 * `/register` stamps `registered_at`. The person's own row lives in docket's `users` table; this is
 * the tracker-only part docket's `User` does not carry.
 *
 * A user row with no admissions row predates this table (0.1.0) and was made by `admit`, so it is
 * admitted and not registered: `get` answers that instead of null.
 */

export interface Admission {
  userId: string;
  /** The admin's tracker user id; null when the configuration admitted them. */
  admittedBy: string | null;
  admittedAt: string | null;
  registeredAt: string | null;
}

type Row = { user_id: string; admitted_by: string | null; admitted_at: string; registered_at: string | null };

export class Admissions {
  constructor(private readonly db: Database) {}

  get(userId: string): Admission {
    const r = this.db.query("SELECT * FROM admissions WHERE user_id = ?").get(userId) as Row | null;
    if (!r) return { userId, admittedBy: null, admittedAt: null, registeredAt: null };
    return { userId, admittedBy: r.admitted_by, admittedAt: r.admitted_at, registeredAt: r.registered_at };
  }

  /** Records the admission once; a second `/allow` of the same person keeps the first record. */
  record(userId: string, admittedBy: string | null, at: string): void {
    this.db
      .query("INSERT INTO admissions (user_id, admitted_by, admitted_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING")
      .run(userId, admittedBy, at);
  }

  /** Stamps the first registration; re-running `/register` changes settings, not this. */
  markRegistered(userId: string, at: string): void {
    this.db
      .query(
        `INSERT INTO admissions (user_id, admitted_by, admitted_at, registered_at) VALUES (?, NULL, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET registered_at = COALESCE(admissions.registered_at, excluded.registered_at)`,
      )
      .run(userId, at, at);
  }

  isRegistered(userId: string): boolean {
    return this.get(userId).registeredAt !== null;
  }
}
