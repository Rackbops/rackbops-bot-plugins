import type { Database } from "bun:sqlite";

/**
 * The task API's idempotent writes (rackbops-bot-plugins#369, for the ChatGPT client of #368): a
 * write that carries `Idempotency-Key` is done once per person and key. A retry of it -- the same
 * key, method, path and body, within `KEEP_MS` -- gets the first answer again instead of a second
 * task; the same key with a different request is refused (`409 idempotency_conflict`), and a retry
 * while the first is still running is told to wait (`409 idempotency_in_progress`).
 *
 * Only a 2xx answer is kept. Anything else -- a refusal, a 409 busy, a 429, a 5xx -- wrote nothing,
 * so its row is dropped and a retry with the same key runs again. A row whose request never
 * finished (the process stopped mid-write) stops blocking after `PENDING_MS`.
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

export type Begun =
  | { kind: "new" }
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
      this.db
        .query("INSERT INTO api_idempotency (user_id, key, request_hash, status, answer, created_at) VALUES (?, ?, ?, NULL, NULL, ?)")
        .run(userId, key, requestHash, at);
      return { kind: "new" };
    })();
  }

  /** Keeps a 2xx answer for replay; drops the claim for anything else, so a retry runs again. */
  finish(userId: string, key: string, answer: KeptAnswer): void {
    if (answer.status >= 200 && answer.status < 300) {
      this.db
        .query("UPDATE api_idempotency SET status = ?, answer = ? WHERE user_id = ? AND key = ?")
        .run(answer.status, JSON.stringify({ body: answer.body, headers: answer.headers }), userId, key);
    } else {
      this.abandon(userId, key);
    }
  }

  /** Drops the claim (the request threw before it answered). */
  abandon(userId: string, key: string): void {
    this.db.query("DELETE FROM api_idempotency WHERE user_id = ? AND key = ? AND status IS NULL").run(userId, key);
  }
}
