import type { Database } from "bun:sqlite";
import { randomToken, sha256 } from "./secrets.js";

/**
 * Personal API tokens for the task API (rackbops-bot-plugins#80, slice 4; plan 5.10, E10): a person
 * makes and revokes their own on the web area's `/tokens` page, and an admin can revoke anyone's
 * from the admin view. A token's secret is sent once, by Discord DM, never in a web response (a
 * script of another plugin on the shared origin could read a page), and stored only as its
 * SHA-256, so a copy of the database authenticates nobody. It acts as its owner, with the owner's
 * rights only; api.ts re-reads the owner (registration, membership) on every request, as the web
 * does a session.
 *
 * Not a cookie: the web area shares one browser origin with every other plugin, so a
 * cookie-authenticated JSON API would be callable by any script on that origin. A bearer token has
 * to be sent on purpose.
 */

/** Every token starts with this, so a leaked one is recognisable (and greppable) for what it is. */
export const TOKEN_PREFIX = "trk_";
/** Live tokens one person may hold at once. */
export const MAX_TOKENS_PER_PERSON = 10;
/** A token's name, as the person types it. */
export const MAX_TOKEN_NAME = 50;
/** The expiries offered, in days. Every token expires: a year at most. */
export const TOKEN_EXPIRY_DAYS = [30, 90, 365] as const;
export const DEFAULT_EXPIRY_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
/** How stale `last_used_at` may be before a use writes it again. */
export const TOUCH_EVERY_MS = 60 * 1000;

export interface ApiToken {
  /** `k<n>`: the token's public id, for listing and revoking. Never the secret. */
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  /** Null only for a row made some other way: every token made here expires. */
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** When the owner's membership of `TRACKER_GUILD_ID` was last confirmed; null when never (or no gate). */
  memberCheckedAt: string | null;
}

/** A token as `create` makes it; anything else is refused before a lookup. */
export function isApiTokenShape(value: string): boolean {
  return /^trk_[A-Za-z0-9_-]{43}$/.test(value);
}

/** The `k<n>` id shape; anything else names no token. */
export function isTokenId(id: string): boolean {
  return /^k[1-9][0-9]{0,15}$/.test(id);
}

/** An expiry choice from a form (`30`, `90` or `365`) as days; undefined when not one of them. */
export function expiryChoice(raw: string): number | undefined {
  const days = Number(raw);
  return (TOKEN_EXPIRY_DAYS as readonly number[]).includes(days) ? days : undefined;
}

type Row = {
  seq: number;
  user_id: string;
  name: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  member_checked_at: string | null;
};

const COLUMNS = "seq, user_id, name, created_at, expires_at, last_used_at, member_checked_at";

function toToken(r: Row): ApiToken {
  return {
    id: `k${Number(r.seq)}`,
    userId: r.user_id,
    name: r.name,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    memberCheckedAt: r.member_checked_at,
  };
}

export type Made = { ok: true; token: string; row: ApiToken } | { ok: false; error: string };

export class ApiTokens {
  constructor(private readonly db: Database) {}

  /**
   * A new token for `userId`, named `name`, expiring `days` from now. Answers the
   * token itself once; only its hash is kept. Drops every expired token on the way. At most
   * `MAX_TOKENS_PER_PERSON` live at once.
   */
  create(userId: string, input: { name: string; days: number }, now: Date, memberCheckedAt: string | null): Made {
    const name = input.name.trim();
    if (name.length === 0) return { ok: false, error: "Give the token a name, such as the program that will use it." };
    if (name.length > MAX_TOKEN_NAME) return { ok: false, error: `That name is longer than ${MAX_TOKEN_NAME} characters.` };
    // Shown on pages and in logs by id only, but kept printable all the same.
    if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: "That name has a control character in it." };
    if (!(TOKEN_EXPIRY_DAYS as readonly number[]).includes(input.days)) return { ok: false, error: "Choose when the token expires." };
    const at = now.toISOString();
    return this.db.transaction((): Made => {
      // Checked in the same synchronous transaction as the insert: a forget-me (itself one
      // synchronous transaction) that ran since the request was authenticated leaves no token behind.
      const seq = /^u([1-9][0-9]*)$/.exec(userId)?.[1];
      if (seq === undefined || this.db.query("SELECT 1 FROM users WHERE seq = ?").get(Number(seq)) === null) {
        return { ok: false, error: "You are no longer on this tracker's list." };
      }
      this.db.query("DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?").run(at);
      const live = (this.db.query("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?").get(userId) as { n: number }).n;
      if (live >= MAX_TOKENS_PER_PERSON) {
        return { ok: false, error: `You already have ${MAX_TOKENS_PER_PERSON} API tokens, the most one person may. Revoke one first.` };
      }
      const token = `${TOKEN_PREFIX}${randomToken()}`;
      const expiresAt = new Date(now.getTime() + input.days * DAY_MS).toISOString();
      const r = this.db
        .query(
          `INSERT INTO api_tokens (token_hash, user_id, name, created_at, expires_at, last_used_at, member_checked_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?) RETURNING ${COLUMNS}`,
        )
        .get(sha256(token), userId, name, at, expiresAt, memberCheckedAt) as Row;
      return { ok: true, token, row: toToken(r) };
    })();
  }

  /**
   * The live token behind a bearer value, or null (unknown, revoked, expired, or not a token's
   * shape). Looked up by the SHA-256 of what was sent: the comparison is the index's, over a hash
   * the sender cannot steer, so its timing says nothing about any stored token.
   */
  find(token: string, now: Date): ApiToken | null {
    if (!isApiTokenShape(token)) return null;
    const r = this.db
      .query(`SELECT ${COLUMNS} FROM api_tokens WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > ?)`)
      .get(sha256(token), now.toISOString()) as Row | null;
    return r ? toToken(r) : null;
  }

  /** One token by id, whoever's; null when there is none. */
  get(id: string): ApiToken | null {
    if (!isTokenId(id)) return null;
    const r = this.db.query(`SELECT ${COLUMNS} FROM api_tokens WHERE seq = ?`).get(Number(id.slice(1))) as Row | null;
    return r ? toToken(r) : null;
  }

  /** A person's live tokens, oldest first. */
  listFor(userId: string, now: Date): ApiToken[] {
    const rows = this.db
      .query(`SELECT ${COLUMNS} FROM api_tokens WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY seq`)
      .all(userId, now.toISOString()) as Row[];
    return rows.map(toToken);
  }

  /**
   * Records a use, at most once a minute per token (`TOUCH_EVERY_MS`): a write on every request
   * would be one outside the write queue for each call. Answers whether it wrote.
   */
  touch(token: ApiToken, now: Date): boolean {
    if (!isTokenId(token.id)) return false;
    if (token.lastUsedAt !== null && now.getTime() - Date.parse(token.lastUsedAt) < TOUCH_EVERY_MS && Date.parse(token.lastUsedAt) <= now.getTime()) return false;
    const cutoff = new Date(now.getTime() - TOUCH_EVERY_MS).toISOString();
    return (
      this.db
        .query("UPDATE api_tokens SET last_used_at = ? WHERE seq = ? AND (last_used_at IS NULL OR last_used_at <= ? OR last_used_at > ?)")
        .run(now.toISOString(), Number(token.id.slice(1)), cutoff, now.toISOString()).changes > 0
    );
  }

  /** Revokes (deletes) token `id` if it is `userId`'s; false for anyone else's and for an unknown id alike. */
  revokeOwn(userId: string, id: string): boolean {
    if (!isTokenId(id)) return false;
    return this.db.query("DELETE FROM api_tokens WHERE seq = ? AND user_id = ?").run(Number(id.slice(1)), userId).changes > 0;
  }

  /** Revokes (deletes) token `id`, whoever's: the admin's act. Answers whose it was, or null. */
  revokeAny(id: string): string | null {
    if (!isTokenId(id)) return null;
    const r = this.db.query("DELETE FROM api_tokens WHERE seq = ? RETURNING user_id").get(Number(id.slice(1))) as { user_id: string } | null;
    return r ? r.user_id : null;
  }

  /** Every token of a person who may no longer use the tracker. */
  deleteForUser(userId: string): void {
    this.db.query("DELETE FROM api_tokens WHERE user_id = ?").run(userId);
  }

  /** Membership was confirmed again: every token of the person carries the new time. */
  confirmMember(userId: string, at: string): void {
    this.db.query("UPDATE api_tokens SET member_checked_at = ? WHERE user_id = ?").run(at, userId);
  }
}
