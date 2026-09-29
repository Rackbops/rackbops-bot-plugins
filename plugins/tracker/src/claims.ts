import type { Database } from "bun:sqlite";

/**
 * Delivery claims (plan 5.5, "Delivery idempotency"). docket's `deliver` writes its `delivered`
 * event AFTER each send, so a send the process never got to record would go out again once
 * `recover()` requeues the run. The bot host also abandons -- but does not stop -- a tick past
 * 30 s, and a restart exits under a tick that ignores its signal. So the tracker claims each
 * (occurrence, recipient) pair BEFORE it sends and settles the claim after:
 *
 * - `sent`: the send returned a message id.
 * - `failed`: the host said the recipient cannot be messaged -- nothing went out.
 * - `unconfirmed`: claimed, and the send never reported back (a crash, an abandoned tick, or an
 *   error that does not say whether Discord took the message). Never resent automatically; the
 *   admin is told rather than a guess made (plan 5.5).
 */

export type ClaimStatus = "claimed" | "sent" | "failed" | "unconfirmed";

export interface DeliveryClaim {
  occurrenceId: string;
  userId: string;
  discordId: string;
  status: ClaimStatus;
  messageId: string | null;
  channelId: string | null;
  error: string | null;
  claimedAt: string;
  settledAt: string | null;
}

type Row = Record<string, unknown>;

function toClaim(r: Row): DeliveryClaim {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    occurrenceId: String(r.occurrence_id),
    userId: String(r.user_id),
    discordId: String(r.discord_id),
    status: String(r.status) as ClaimStatus,
    messageId: s(r.message_id),
    channelId: s(r.channel_id),
    error: s(r.error),
    claimedAt: String(r.claimed_at),
    settledAt: s(r.settled_at),
  };
}

export class ClaimStore {
  constructor(private readonly db: Database) {}

  get(occurrenceId: string, userId: string): DeliveryClaim | null {
    const r = this.db.query("SELECT * FROM delivery_claims WHERE occurrence_id = ? AND user_id = ?").get(occurrenceId, userId) as Row | null;
    return r ? toClaim(r) : null;
  }

  /**
   * True when this call holds the claim: a new one, or a `failed` one taken again (nothing went out
   * that time, so sending is safe). False when any other claim exists; nothing changes then.
   */
  claim(occurrenceId: string, userId: string, discordId: string, at: string): boolean {
    const { changes } = this.db
      .query(
        `INSERT INTO delivery_claims (occurrence_id, user_id, discord_id, status, claimed_at)
         VALUES (?, ?, ?, 'claimed', ?)
         ON CONFLICT (occurrence_id, user_id) DO UPDATE SET
           discord_id = excluded.discord_id, status = 'claimed', claimed_at = excluded.claimed_at,
           message_id = NULL, channel_id = NULL, error = NULL, settled_at = NULL
         WHERE delivery_claims.status = 'failed'`,
      )
      .run(occurrenceId, userId, discordId, at);
    return changes === 1;
  }

  settle(
    occurrenceId: string,
    userId: string,
    status: Exclude<ClaimStatus, "claimed">,
    at: string,
    detail: { messageId?: string; channelId?: string; error?: string } = {},
  ): void {
    this.db
      .query(
        `UPDATE delivery_claims SET status = ?, message_id = ?, channel_id = ?, error = ?, settled_at = ?
         WHERE occurrence_id = ? AND user_id = ?`,
      )
      .run(status, detail.messageId ?? null, detail.channelId ?? null, detail.error ?? null, at, occurrenceId, userId);
  }

  /** Claims no send ever settled, and ones marked unconfirmed: what the admin is shown. */
  listUnsettled(): DeliveryClaim[] {
    return (this.db.query("SELECT * FROM delivery_claims WHERE status IN ('claimed', 'unconfirmed') ORDER BY claimed_at").all() as Row[]).map(
      toClaim,
    );
  }
}
