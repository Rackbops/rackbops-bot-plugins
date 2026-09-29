import { ExecutorUnavailableError, type Clock, type Notifier, type OutgoingMessage, type Store } from "@rackbops/docket-core";
import type { HostApi, HostDelivery, HostMessage, PluginLog } from "../../../packages/api/contract.js";
import { hostButtons } from "./buttons.js";
import type { ClaimStore, DeliveryClaim } from "./claims.js";
import type { DeliveryHealth } from "./delivery-health.js";

/**
 * docket's Notifier port over `host.dm` (plan 5.5). docket addresses a tracker user; this looks up
 * their Discord id and DMs them as the bot. Every send docket's `deliver` makes carries a
 * `ref` naming the occurrence, and for those the (occurrence, user) pair is claimed in the tracker's
 * store before the DM goes out (claims.ts): a claim that already exists is never sent again.
 *
 * Buttons (rackbops-bot-plugins#79): `message.actions` (done, snooze, opt-out, ...) go out as
 * `HostMessage.buttons` (buttons.ts), with a Reply button on a message about one run. A host from
 * before rackbops-discord-bot#323 refuses buttons before sending anything; the DM is then sent again
 * without them, as the contract asks, under the same claim.
 *
 * Each refusal that says the person cannot be messaged counts toward pausing their delivery, and
 * each DM that goes through clears the count (delivery-health.ts).
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
  /** Counts refused DMs per person and pauses after three; absent, nothing is counted. */
  health?: DeliveryHealth;
}

/**
 * The host's own refusals of `buttons` (rackbops-discord-bot src/plugins/hostMessage.ts
 * `validateHostMessage`/`validateButtons`, and host.ts's check for an `interactions` handler), and
 * the pre-#323 host's "interactive buttons are not supported yet". The contract (contract.d.ts,
 * `HostMessage`) says a plugin that must work on either host "retries without `buttons` on any
 * refusal" -- and a refusal there is the host's validation, which runs before anything is sent.
 * So this matches only those texts, as plain host errors (no Discord `code`): a Discord API error,
 * a timeout, or anything else that may have come after a send is never retried, since the DM may
 * already have gone out and a retry would send it twice.
 */
const HOST_BUTTON_REFUSAL = /^(interactive buttons are not supported|buttons? (label|customId|customIds|style|must|is not valid|and links need|need this plugin))/;
export function isButtonRefusal(err: unknown): boolean {
  if (!(err instanceof Error) || (err as { code?: unknown }).code !== undefined) return false;
  return HOST_BUTTON_REFUSAL.test(err.message);
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

      // A person whose delivery paused earlier in this tick (or before) is held, not failed: the
      // run goes back to the queue, and the lane skips it while its task is paused.
      if (d.health?.isPaused(userId)) throw new ExecutorUnavailableError(`delivery to ${userId} is paused`);

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
        const buttons = hostButtons(message);
        let delivery: HostDelivery;
        try {
          delivery = await d.dm(discordId, buttons.length > 0 ? { ...hostMessage, buttons } : hostMessage);
        } catch (err) {
          if (buttons.length === 0 || !isButtonRefusal(err)) throw err;
          d.log.warn(`DM sent without buttons: the host refused them (${err instanceof Error ? err.message : String(err)})`);
          delivery = await d.dm(discordId, hostMessage);
        }
        d.health?.recordSuccess(userId);
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
        if (unreachable) {
          const counted = await d.health?.recordFailure(userId, reason, d.clock.now().toISOString());
          if (counted?.paused) d.log.warn(`paused delivery to ${userId}: ${counted.failures} DMs in a row could not be delivered`);
          throw new RecipientUnreachableError(userId);
        }
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
