import { ExecutorUnavailableError, type Clock, type Notifier, type OutgoingMessage, type Store } from "@rackbops/docket-core";
import type { HostApi, HostMessage, PluginLog } from "../../../packages/api/contract.js";
import type { ClaimStore, DeliveryClaim } from "./claims.js";

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

/** Discord's own cap on a message's content, as the host checks it: after wrapping bare links. */
export const MAX_CONTENT = 2000;

/** What a claim with no recorded send is written as in docket's `delivered` event (never a real id). */
export const UNCONFIRMED_MESSAGE_ID = "unconfirmed";

/** The host's own id check (rackbops-discord-bot src/routing/model.ts SNOWFLAKE_RE). */
const HOST_SNOWFLAKE = /^[0-9]{5,25}$/;

/** The host's link wrapping (hostMessage.ts wrapBareUrls): its length is what the host bounds. */
const URL_OR_WRAPPED = /<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<>]+)/g;
export function wrapBareUrls(content: string): string {
  return content.replace(URL_OR_WRAPPED, (whole: string, wrapped: string | undefined, bare: string | undefined) =>
    wrapped !== undefined ? whole : `<${bare}>`,
  );
}

/**
 * Errors `host.dm` raises before anything reaches Discord: its own id and message checks
 * (rackbops-discord-bot src/plugins/host.ts `dm`, hostMessage.ts `validateHostMessage`) and a
 * `users.fetch` that finds no such user (delivery.ts `sendPayloadDm`, Discord code 10013). Nothing
 * went out, so the claim is released (`failed`, which a later run may take again).
 */
export function isPreSendError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === 10013) return true;
  const message = err instanceof Error ? err.message : String(err);
  return (
    message === "userId is not a valid id" ||
    message === "message must be an object" ||
    message === "content must be a string" ||
    message === "content is empty" ||
    message === "interactive buttons are not supported yet" ||
    message === "Unknown User" ||
    message.startsWith("content is longer than")
  );
}

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

/** A DM that could never be sent as it stands (a bad Discord id, an empty message); nothing was claimed. */
export class UndeliverableError extends Error {
  override name = "UndeliverableError";
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

/** The host message for `message`, cut to fit the host's bound; null when it has no text to send. */
export function toHostMessage(message: OutgoingMessage): HostMessage | null {
  if (message.text.trim().length === 0) return null;
  let text = message.text;
  let keep = text.length;
  // Cut until the wrapped form fits: a cut can split a link, which the host then wraps again.
  while (wrapBareUrls(text).length > MAX_CONTENT) {
    keep -= Math.max(1, wrapBareUrls(text).length - MAX_CONTENT);
    text = `${message.text.slice(0, Math.max(0, keep - 3))}...`;
  }
  return { content: text };
}

export function createDmNotifier(d: DmNotifierDeps): Notifier {
  return {
    async sendDm(userId, message) {
      const user = await d.store.getUser(userId);
      if (!user) throw new UndeliverableError(`no user ${userId}`);
      const discordId = user.discordId;
      if (!discordId || !HOST_SNOWFLAKE.test(discordId)) throw new UndeliverableError(`user ${userId} has no valid Discord id`);
      const hostMessage = toHostMessage(message);
      if (!hostMessage) throw new UndeliverableError("the message has no text");
      const occurrenceId = message.ref?.occurrenceId ?? null;

      if (occurrenceId !== null) {
        const existing = d.claims.get(occurrenceId, userId);
        // Sent before (the crash came before docket recorded it): record it, never send again.
        if (existing?.status === "sent") return { messageId: existing.messageId || UNCONFIRMED_MESSAGE_ID };
        if (existing && existing.status !== "failed") {
          // Claimed and never settled, or settled unconfirmed: it may have gone out. Not resent.
          if (existing.status === "claimed") {
            d.claims.settle(occurrenceId, userId, "unconfirmed", d.clock.now().toISOString(), { error: "claimed, never settled" });
          }
          reportUnconfirmed(d.claims, d.log, existing, d.clock.now().toISOString());
          return { messageId: UNCONFIRMED_MESSAGE_ID };
        }
      }

      // docket 0.3.0 has no signal of its own: the error it requeues on (rather than failing the
      // run) is ExecutorUnavailableError, so an aborted tick leaves this run queued for the next.
      if (d.signal?.aborted) throw new ExecutorUnavailableError("the tick was aborted before this send");

      if (occurrenceId !== null) {
        const at = d.clock.now().toISOString();
        if (!d.claims.claim(occurrenceId, userId, discordId, at)) {
          // Someone claimed it between the read above and here; never send on their claim.
          return { messageId: UNCONFIRMED_MESSAGE_ID };
        }
      }

      try {
        const delivery = await d.dm(discordId, hostMessage);
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
        const nothingSent = unreachable || isPreSendError(err);
        if (occurrenceId !== null) {
          d.claims.settle(occurrenceId, userId, nothingSent ? "failed" : "unconfirmed", d.clock.now().toISOString(), { error: reason });
        }
        if (unreachable) throw new RecipientUnreachableError(userId);
        throw err;
      }
    },
  };
}

/** Logs a claim that may or may not have been delivered, once per claim. */
export function reportUnconfirmed(claims: ClaimStore, log: PluginLog, claim: DeliveryClaim, at: string): void {
  if (claim.reportedAt !== null) return;
  const what =
    claim.status === "claimed" ? `claimed ${claim.claimedAt}, never settled` : `unconfirmed since ${claim.claimedAt} (${claim.error ?? "no detail"})`;
  log.warn(`delivery of ${claim.occurrenceId} to ${claim.userId} was ${what}; it will not be resent`);
  claims.markReported(claim.occurrenceId, claim.userId, at);
}
