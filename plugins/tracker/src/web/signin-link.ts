import type { Database } from "bun:sqlite";
import { isTokenShape, randomToken, sha256 } from "./secrets.js";

/**
 * Sign-in by one-time link (plan 5.10, item 41; rackbops-bot-plugins#80): `/web` issues a token,
 * valid `LINK_TTL_MS` and good once, and the person follows `<TRACKER_WEB_URL>/tracker/login?t=...`.
 * Only the token's SHA-256 is stored. This is one sign-in method; what it yields is a tracker user
 * id, which sessions.ts turns into a session, so another method (Discord OAuth2) can sit beside it
 * and feed the same sessions.
 *
 * Opening the link does not use it up (`peek`): a link preview or a prefetcher would burn it. Only
 * the form the page shows, posted back, does (`consume`), in one UPDATE, so two posts of the same
 * token cannot both win.
 */

export const LINK_TTL_MS = 10 * 60 * 1000;

export class LoginLinks {
  constructor(private readonly db: Database) {}

  /** A fresh token for `userId`; the caller builds the link. Drops expired tokens on the way. */
  issue(userId: string, now: Date): string {
    const token = randomToken();
    const at = now.toISOString();
    this.db.query("DELETE FROM web_login_tokens WHERE expires_at <= ?").run(at);
    this.db
      .query("INSERT INTO web_login_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(sha256(token), userId, at, new Date(now.getTime() + LINK_TTL_MS).toISOString());
    return token;
  }

  /** Whether the token would sign someone in now, without using it. */
  peek(token: string, now: Date): boolean {
    if (!isTokenShape(token)) return false;
    const row = this.db
      .query("SELECT 1 AS ok FROM web_login_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
      .get(sha256(token), now.toISOString());
    return row !== null;
  }

  /** Uses the token up and answers whose it was; null when unknown, used or expired. */
  consume(token: string, now: Date): string | null {
    if (!isTokenShape(token)) return null;
    const at = now.toISOString();
    const row = this.db
      .query("UPDATE web_login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id")
      .get(at, sha256(token), at) as { user_id: string } | null;
    return row?.user_id ?? null;
  }
}
