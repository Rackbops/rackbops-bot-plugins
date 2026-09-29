import type { Database } from "bun:sqlite";
import { isTokenShape, randomToken, sha256 } from "./secrets.js";

/**
 * Web sessions (rackbops-bot-plugins#80): a random id in an `HttpOnly; Secure; SameSite=Lax` cookie
 * scoped to the plugin's path, stored only as its SHA-256, good for `SESSION_TTL_MS` from sign-in
 * (not sliding). Each carries its own CSRF token for the forms. Whatever the sign-in method, it
 * ends here with a tracker user id.
 */

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Session {
  userId: string;
  csrf: string;
  expiresAt: string;
  /** When membership of `TRACKER_GUILD_ID` was last confirmed; null when never (or no gate). */
  memberCheckedAt: string | null;
}

export class Sessions {
  constructor(private readonly db: Database) {}

  /** A new session for `userId`; answers the id for the cookie. Drops expired sessions on the way. */
  create(userId: string, now: Date, memberCheckedAt: string | null = null): { id: string; session: Session } {
    const id = randomToken();
    const at = now.toISOString();
    const session: Session = { userId, csrf: randomToken(), expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(), memberCheckedAt };
    this.db.query("DELETE FROM web_sessions WHERE expires_at <= ?").run(at);
    this.db
      .query("INSERT INTO web_sessions (id_hash, user_id, csrf, created_at, expires_at, member_checked_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha256(id), userId, session.csrf, at, session.expiresAt, memberCheckedAt);
    return { id, session };
  }

  /** The live session behind a cookie value, or null. */
  find(id: string, now: Date): Session | null {
    if (!isTokenShape(id)) return null;
    const row = this.db
      .query("SELECT user_id, csrf, expires_at, member_checked_at FROM web_sessions WHERE id_hash = ? AND expires_at > ?")
      .get(sha256(id), now.toISOString()) as { user_id: string; csrf: string; expires_at: string; member_checked_at: string | null } | null;
    return row ? { userId: row.user_id, csrf: row.csrf, expiresAt: row.expires_at, memberCheckedAt: row.member_checked_at } : null;
  }

  /** Sign out: this session only. */
  delete(id: string): void {
    if (isTokenShape(id)) this.db.query("DELETE FROM web_sessions WHERE id_hash = ?").run(sha256(id));
  }

  /** Membership was confirmed again: every session of the person carries the new time. */
  confirmMember(userId: string, at: string): void {
    this.db.query("UPDATE web_sessions SET member_checked_at = ? WHERE user_id = ?").run(at, userId);
  }

  /** Every session of a person who may no longer sign in. */
  deleteForUser(userId: string): void {
    this.db.query("DELETE FROM web_sessions WHERE user_id = ?").run(userId);
  }
}
