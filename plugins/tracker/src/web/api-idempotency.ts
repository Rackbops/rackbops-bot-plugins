import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

/**
 * The task API's idempotent writes (rackbops-bot-plugins#369, for the ChatGPT client of #368): a
 * write that carries `Idempotency-Key` is done once per person and key. A retry of it -- the same
 * key, method, path and body, within `KEEP_MS` -- gets the first answer again instead of a second
 * task; the same key with a different request is refused (`409 idempotency_conflict`), and a retry
 * while the first is still running is told to wait (`409 idempotency_in_progress`).
 *
 * Only a 2xx answer is kept. Any other answer -- a refusal, a 409 busy, a 429 -- wrote nothing, so
 * its row is dropped and a retry with the same key runs again. A request that threw may have saved
 * its change before it did, so its key answers `500 outcome_unknown` until it expires rather than
 * run a second time. A row whose request never finished (the process stopped mid-write) stops
 * blocking after `PENDING_MS`; each claim carries its own random id, so a request that was only
 * slow cannot then finish or drop the row of the request that took its key over.
 *
 * Rows live in `api_idempotency` (schema migration 13), keyed by the owner, so one person's key never
 * meets another's; forget-me deletes them (roster.ts).
 */

/** How long a key is remembered. */
export const KEEP_MS = 24 * 60 * 60 * 1000;
/** How long a request that never finished holds its key. */
export const PENDING_MS = 2 * 60 * 1000;

/** A key as a client sends it: 8 to 128 of letters, digits and `-_.:`. A UUID fits. */
export function isIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{8,128}$/.test(value);
}

/** An answer as replayed: its status, JSON body and the headers it carried (`Location`, `ETag`). */
export interface KeptAnswer {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export const OUTCOME_UNKNOWN =
  "That request failed partway and may have made its change. Read your tasks before you send it again, under a new Idempotency-Key.";

export type Begun =
  | { kind: "new"; claim: string }
  | { kind: "replay"; answer: KeptAnswer }
  | { kind: "conflict" }
  | { kind: "in_progress" };

type Row = { request_hash: string; status: number | null; answer: string | null; created_at: string };

export class ApiIdempotency {
  constructor(private readonly db: Database) {}

  /**
   * Claims `key` for this request, or says why not. One synchronous transaction, so two requests
   * with the same key cannot both be `new`. Drops every row past `KEEP_MS` on the way.
   */
  begin(userId: string, key: string, requestHash: string, now: Date): Begun {
    const at = now.toISOString();
    return this.db.transaction((): Begun => {
      this.db.query("DELETE FROM api_idempotency WHERE created_at <= ?").run(new Date(now.getTime() - KEEP_MS).toISOString());
      const row = this.db
        .query("SELECT request_hash, status, answer, created_at FROM api_idempotency WHERE user_id = ? AND key = ?")
        .get(userId, key) as Row | null;
      if (row !== null) {
        const stale = row.status === null && Date.parse(row.created_at) <= now.getTime() - PENDING_MS;
        if (!stale) {
          if (row.request_hash !== requestHash) return { kind: "conflict" };
          if (row.status === null || row.answer === null) return { kind: "in_progress" };
          const kept = JSON.parse(row.answer) as { body: unknown; headers: Record<string, string> };
          return { kind: "replay", answer: { status: row.status, body: kept.body, headers: kept.headers } };
        }
        this.db.query("DELETE FROM api_idempotency WHERE user_id = ? AND key = ?").run(userId, key);
      }
      const claim = randomBytes(16).toString("hex");
      this.db
        .query("INSERT INTO api_idempotency (user_id, key, request_hash, claim, status, answer, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)")
        .run(userId, key, requestHash, claim, at);
      return { kind: "new", claim };
    })();
  }

  /** Keeps a 2xx answer for replay; drops the claim for anything else, so a retry runs again. */
  finish(userId: string, key: string, claim: string, answer: KeptAnswer): void {
    if (answer.status >= 200 && answer.status < 300) this.keep(userId, key, claim, answer);
    else this.abandon(userId, key, claim);
  }

  /** The request threw: it may have saved its change, so a retry is answered "outcome unknown". */
  fail(userId: string, key: string, claim: string): void {
    this.keep(userId, key, claim, { status: 500, body: { error: { code: "outcome_unknown", message: OUTCOME_UNKNOWN } }, headers: {} });
  }

  /** Drops the claim, if it is still this request's and unanswered. */
  abandon(userId: string, key: string, claim: string): void {
    this.db.query("DELETE FROM api_idempotency WHERE user_id = ? AND key = ? AND claim = ? AND status IS NULL").run(userId, key, claim);
  }

  private keep(userId: string, key: string, claim: string, answer: KeptAnswer): void {
    this.db
      .query("UPDATE api_idempotency SET status = ?, answer = ? WHERE user_id = ? AND key = ? AND claim = ? AND status IS NULL")
      .run(answer.status, JSON.stringify({ body: answer.body, headers: answer.headers }), userId, key, claim);
  }
}
