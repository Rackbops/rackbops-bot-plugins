import { ExecutorUnavailableError, type Clock, type Notifier, type OutgoingMessage, type Store } from "@rackbops/docket-core";
import type { HostApi, HostMessage, PluginLog } from "../../../packages/api/contract.js";
import type { ClaimStore } from "./claims.js";

/**
 * docket's Notifier port over `host.dm` (plan 5.5). docket addresses a tracker user; this looks up
 * their Discord id and DMs them as the bot. Every send docket's `deliver` makes carries a
 * `ref` naming the occurrence, and for those the (occurrence, user) pair is claimed in the tracker's
 * store before the DM goes out (claims.ts): a claim that already exists is never sent again.
 *
 * Buttons: `message.actions` (done, snooze, opt-out, ...) are not rendered yet -- the host refuses
 * `HostMessage.buttons` until rackbops-discord-bot#323 lands, and the commands that answer a run
 * are rackbops-bot-plugins#79. The text goes out alone.
 */

/** What the host rejects `dm` with when Discord says the user cannot be messaged (its code 50007). */
export const HOST_CANNOT_MESSAGE = "recipient cannot be messaged";

/** Discord's own cap on a message's content. */
export const MAX_CONTENT = 2000;

/** What a claim with no recorded send is written as in docket's `delivered` event (never a real id). */
export const UNCONFIRMED_MESSAGE_ID = "unconfirmed";

/**
 * A DM the host refused because the person's DMs are closed or they blocked the bot. docket fails
 * the run with this message (its delivery-failure outcome in 0.3.0: the occurrence is `failed`,
 * the error is on record, and the schedule's next run is still materialized).
 */
export class RecipientUnreachableError extends Error {
  override name = "RecipientUnreachableError";
  constructor(readonly userId: string) {
    super(`recipient ${userId} cannot be messaged (DMs closed, or the bot is blocked)`);
  }
}

export interface DmNotifierDeps {
  store: Store;
  claims: ClaimStore;
  dm: NonNullable<HostApi["dm"]>;
  clock: Clock;
  log: PluginLog;
  /** The tick's signal: once aborted, no new send starts. */
  signal?: AbortSignal;
}

export function toHostMessage(message: OutgoingMessage): HostMessage {
  const text = message.text.length > MAX_CONTENT ? `${message.text.slice(0, MAX_CONTENT - 3)}...` : message.text;
  return { content: text };
}

export function createDmNotifier(d: DmNotifierDeps): Notifier {
  return {
    async sendDm(userId, message) {
      const user = await d.store.getUser(userId);
      if (!user) throw new Error(`no user ${userId}`);
      if (!user.discordId) throw new Error(`user ${userId} has no Discord id`);
      const occurrenceId = message.ref?.occurrenceId ?? null;

      if (occurrenceId !== null) {
        const existing = d.claims.get(occurrenceId, userId);
        if (existing?.status === "sent" && existing.messageId) return { messageId: existing.messageId };
        if (existing && existing.status !== "failed") {
          // Claimed before, never settled: the DM may or may not have gone out. Not resent.
          d.claims.settle(occurrenceId, userId, "unconfirmed", d.clock.now().toISOString(), {
            error: existing.error ?? "the send never reported back",
          });
          d.log.warn(`delivery of ${occurrenceId} to ${userId} is unconfirmed (claimed ${existing.claimedAt}); not resending`);
          return { messageId: UNCONFIRMED_MESSAGE_ID };
        }
      }

      // docket 0.3.0 has no signal of its own: the error it requeues on (rather than failing the
      // run) is ExecutorUnavailableError, so an aborted tick leaves this run queued for the next.
      if (d.signal?.aborted) throw new ExecutorUnavailableError("the tick was aborted before this send");

      if (occurrenceId !== null) {
        const at = d.clock.now().toISOString();
        if (!d.claims.claim(occurrenceId, userId, user.discordId, at)) {
          // Someone claimed it between the read above and here; never send on their claim.
          return { messageId: UNCONFIRMED_MESSAGE_ID };
        }
      }

      try {
        const delivery = await d.dm(user.discordId, toHostMessage(message));
        if (occurrenceId !== null) {
          d.claims.settle(occurrenceId, userId, "sent", d.clock.now().toISOString(), {
            messageId: delivery.messageId,
            channelId: delivery.channelId,
          });
        }
        return { messageId: delivery.messageId };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const unreachable = reason === HOST_CANNOT_MESSAGE;
        if (occurrenceId !== null) {
          d.claims.settle(occurrenceId, userId, unreachable ? "failed" : "unconfirmed", d.clock.now().toISOString(), { error: reason });
        }
        if (unreachable) throw new RecipientUnreachableError(userId);
        throw err;
      }
    },
  };
}
