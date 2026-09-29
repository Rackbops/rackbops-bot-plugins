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
}

export class Sessions {
  constructor(private readonly db: Database) {}

  /** A new session for `userId`; answers the id for the cookie. Drops expired sessions on the way. */
  create(userId: string, now: Date): { id: string; session: Session } {
    const id = randomToken();
    const at = now.toISOString();
    const session: Session = { userId, csrf: randomToken(), expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString() };
    this.db.query("DELETE FROM web_sessions WHERE expires_at <= ?").run(at);
    this.db
      .query("INSERT INTO web_sessions (id_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(id), userId, session.csrf, at, session.expiresAt);
    return { id, session };
  }

  /** The live session behind a cookie value, or null. */
  find(id: string, now: Date): Session | null {
    if (!isTokenShape(id)) return null;
    const row = this.db
      .query("SELECT user_id, csrf, expires_at FROM web_sessions WHERE id_hash = ? AND expires_at > ?")
      .get(sha256(id), now.toISOString()) as { user_id: string; csrf: string; expires_at: string } | null;
    return row ? { userId: row.user_id, csrf: row.csrf, expiresAt: row.expires_at } : null;
  }

  /** Sign out: this session only. */
  delete(id: string): void {
    if (isTokenShape(id)) this.db.query("DELETE FROM web_sessions WHERE id_hash = ?").run(sha256(id));
  }

  /** Every session of a person who may no longer sign in. */
  deleteForUser(userId: string): void {
    this.db.query("DELETE FROM web_sessions WHERE user_id = ?").run(userId);
  }
}
