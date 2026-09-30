import { DeliveryFailedError, ExecutorUnavailableError, type Clock, type Notifier, type OutgoingMessage, type Store } from "@rackbops/docket-core";
import type { HostApi, HostDelivery, HostMessage, PluginLog } from "../../../packages/api/contract.js";
import { hostButtons } from "./buttons.js";
import type { DeliveryHealth } from "./delivery-health.js";

/**
 * docket's Notifier port over `host.dm` (plan 5.5). docket addresses a tracker user; this looks up
 * their Discord id and DMs them as the bot. It keeps no claim of its own (docket 0.4.0): docket's
 * `deliver` claims each (run, person) in the Store's `deliveries` before it calls `sendDm` and
 * settles the claim from how `sendDm` ends -- so how a failure is thrown decides what comes next:
 *
 * - `DeliveryFailedError(message, true)`: the person cannot be messaged at all -- the host's
 *   "recipient cannot be messaged" (Discord 50007: DMs closed, the bot blocked), Discord's unknown
 *   user (10013), or no tracker user or Discord id to send to. Failed for good at once.
 * - `DeliveryFailedError(message)`: the host refused this message before sending anything (its own
 *   checks of the id, the content, the buttons). docket tries twice more, then gives up.
 * - `ExecutorUnavailableError`: the person's delivery is paused (delivery-health.ts). Nothing went
 *   out and no attempt is counted; docket defers the send, and holds it while the task is paused.
 * - anything else (a Discord API error, a timeout): it may have gone out. docket settles it
 *   `unconfirmed` and never resends it; this logs it once, as the admin's notice (plan 5.5).
 *
 * Buttons (rackbops-bot-plugins#79): `message.actions` (done, snooze, opt-out, ...) go out as
 * `HostMessage.buttons` (buttons.ts), with a Reply button on a message about one run. A host from
 * before rackbops-discord-bot#323 refuses buttons before sending anything; the DM is then sent again
 * without them, as the contract asks, under docket's same claim.
 *
 * Each "cannot be messaged" counts toward pausing the person's delivery, and each DM that goes
 * through clears the count (delivery-health.ts). Nothing else counts: not a refused message, not a
 * deferral, not an unconfirmed send.
 */

/** What the host rejects `dm` with when Discord says the user cannot be messaged (its code 50007). */
export const HOST_CANNOT_MESSAGE = "recipient cannot be messaged";

/** Discord's own cap on a message's content, as the host checks it: after wrapping bare links. */
export const MAX_CONTENT = 2000;

/** The host's own id check (rackbops-discord-bot src/routing/model.ts SNOWFLAKE_RE). */
const HOST_SNOWFLAKE = /^[0-9]{5,25}$/;

/** The host's link wrapping (hostMessage.ts wrapBareUrls): its length is what the host bounds. */
const URL_OR_WRAPPED = /<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<>]+)/g;
export function wrapBareUrls(content: string): string {
  return content.replace(URL_OR_WRAPPED, (whole: string, wrapped: string | undefined, bare: string | undefined) =>
    wrapped !== undefined ? whole : `<${bare}>`,
  );
}

/** Discord's "unknown user": the account is gone, so no send can ever reach it. */
const UNKNOWN_USER = 10013;

function isUnknownUser(err: unknown): boolean {
  if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === UNKNOWN_USER) return true;
  return (err instanceof Error ? err.message : String(err)) === "Unknown User";
}

/**
 * The host's own checks, which refuse a DM before anything reaches Discord (rackbops-discord-bot
 * src/plugins/host.ts `dm`, hostMessage.ts `validateHostMessage`): nothing went out.
 */
export function isHostRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message === "userId is not a valid id" ||
    message === "message must be an object" ||
    message === "content must be a string" ||
    message === "content is empty" ||
    message === "interactive buttons are not supported yet" ||
    message.startsWith("content is longer than") ||
    isButtonRefusal(err)
  );
}

/**
 * docket's error for a failed `host.dm`, from what the host said: `DeliveryFailedError` only when
 * nothing went out (`unreachable` when the person can never be messaged); otherwise the error
 * itself, unchanged -- the DM may have gone out, and docket settles it unconfirmed, never resent.
 */
export function deliveryError(err: unknown): unknown {
  const reason = err instanceof Error ? err.message : String(err);
  if (reason === HOST_CANNOT_MESSAGE || isUnknownUser(err)) return new DeliveryFailedError(reason, true);
  if (isHostRefusal(err)) return new DeliveryFailedError(reason);
  return err;
}

/** Whether `err` says the person cannot be messaged at all: what an invitation is withdrawn on. */
export function isUnreachable(err: unknown): boolean {
  return err instanceof DeliveryFailedError && err.unreachable;
}

export interface DmNotifierDeps {
  store: Store;
  dm: NonNullable<HostApi["dm"]>;
  clock: Clock;
  log: PluginLog;
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
      if (!user) throw new DeliveryFailedError(`no user ${userId}`, true);
      const discordId = user.discordId;
      if (!discordId || !HOST_SNOWFLAKE.test(discordId)) throw new DeliveryFailedError(`user ${userId} has no valid Discord id`, true);
      const hostMessage = toHostMessage(message);
      if (!hostMessage) throw new DeliveryFailedError("the message has no text");

      // A person whose delivery paused (earlier in this tick, or before) is held, not failed: docket
      // defers the send, and once their tasks are paused it waits there for the resume.
      if (d.health?.isPaused(userId)) throw new ExecutorUnavailableError(`delivery to ${userId} is paused`);

      const buttons = hostButtons(message);
      let delivery: HostDelivery;
      try {
        try {
          delivery = await d.dm(discordId, buttons.length > 0 ? { ...hostMessage, buttons } : hostMessage);
        } catch (err) {
          if (buttons.length === 0 || !isButtonRefusal(err)) throw err;
          d.log.warn(`DM sent without buttons: the host refused them (${err instanceof Error ? err.message : String(err)})`);
          delivery = await d.dm(discordId, hostMessage);
        }
      } catch (err) {
        const mapped = deliveryError(err);
        const reason = err instanceof Error ? err.message : String(err);
        if (reason === HOST_CANNOT_MESSAGE) {
          const counted = await d.health?.recordFailure(userId, reason, d.clock.now().toISOString());
          if (counted?.paused) d.log.warn(`paused delivery to ${userId}: ${counted.failures} DMs in a row could not be delivered`);
        } else if (!(mapped instanceof DeliveryFailedError)) {
          const what = message.ref?.occurrenceId ? `delivery of ${message.ref.occurrenceId}` : "a DM";
          d.log.warn(`${what} to ${userId} is unconfirmed (${reason}); it will not be resent`);
        }
        throw mapped;
      }
      d.health?.recordSuccess(userId);
      return { messageId: delivery.messageId };
    },
  };
}
