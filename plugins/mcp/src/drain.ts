// One delivery attempt (Tooling#742 decision 5's drain bullet), plus the lock that keeps the tick's
// re-drive and an HTTP retry from ever draining the SAME request_id at once. `attemptDelivery` itself
// has no store access -- the caller persists whatever it returns. Never logs message content.
import type { HostApi, HostDelivery, PluginLog } from "../../../packages/api/contract.js";
import type { DeliveryBody, DeliveryKind, PostTarget, StoredDelivery } from "./protocol.js";

export type DrainOutcome =
  | { state: "delivered"; messageRef: string | null; url: string | null; delivery: HostDelivery | null }
  | { state: "failed"; code: "CAPABILITY_UNAVAILABLE" | "UPSTREAM_UNAVAILABLE" };

/**
 * Attempts one delivery of `body` to `target`, as `requestId`.
 * - `kind !== "post"` (`dm`/`edit`): always `CAPABILITY_UNAVAILABLE`, with NO call to `host.post` or
 *   `host.announce` -- this is the drain layer's own defense of decision 5's "dm/edit is immediately
 *   CAPABILITY_UNAVAILABLE" guarantee, independent of `http.ts` already enforcing it at creation
 *   time. Without this check here, a dm/edit record that somehow reached `unknown` (a process killed
 *   between `reserve`'s unconditional `pending` write and the immediate-failure `set` that follows
 *   it in `http.ts`, before the tick's next `activate()` ever runs) would be re-driven by the tick as
 *   an ordinary `post` -- actually reaching Discord for a capability the bridge advertises as
 *   unsupported (review finding, Tooling#742).
 * - `kind === "post"`, `host.post` present: sends content, card and links as given, and stores the
 *   real Discord identifiers. `message_ref` is the request's own id (decision 5, literally) -- the
 *   caller already has it, and the real message/channel/guild ids travel in `delivery`/`url` instead.
 * - `kind === "post"`, `host.post` absent: a card or links present is `CAPABILITY_UNAVAILABLE` with
 *   no Discord call -- the service already folds them into `content` once it sees `cards: false`, so
 *   their presence here means a caller that skipped that folding. Content alone falls back to
 *   `host.announce`, which has no notion of a delivered message: `message_ref`/`url` are `null`.
 * - A rejection from either delivery path is `UPSTREAM_UNAVAILABLE`; the thrown error is logged, the
 *   message content is not.
 */
export async function attemptDelivery(
  host: HostApi,
  requestId: string,
  kind: DeliveryKind,
  target: PostTarget,
  body: DeliveryBody,
  log: PluginLog,
): Promise<DrainOutcome> {
  if (kind !== "post") {
    return { state: "failed", code: "CAPABILITY_UNAVAILABLE" };
  }
  if (typeof host.post === "function") {
    try {
      const delivery = await host.post(target.guildId, target.destination, {
        content: body.content,
        ...(body.card !== undefined ? { card: body.card } : {}),
        ...(body.links !== undefined ? { links: body.links } : {}),
      });
      const url = `https://discord.com/channels/${delivery.guildId ?? "@me"}/${delivery.channelId}/${delivery.messageId}`;
      return { state: "delivered", messageRef: requestId, url, delivery };
    } catch (err) {
      log.error(`delivery ${requestId} failed`, err);
      return { state: "failed", code: "UPSTREAM_UNAVAILABLE" };
    }
  }

  if (body.card !== undefined || (body.links !== undefined && body.links.length > 0)) {
    return { state: "failed", code: "CAPABILITY_UNAVAILABLE" };
  }

  try {
    await host.announce(body.content, target.destination);
    return { state: "delivered", messageRef: null, url: null, delivery: null };
  } catch (err) {
    log.error(`delivery ${requestId} failed`, err);
    return { state: "failed", code: "UPSTREAM_UNAVAILABLE" };
  }
}

/**
 * Which `request_id`s currently have a drain in flight -- shared between http.ts's retry path and
 * index.ts's tick re-drive, the only two places that can independently decide to start a NEW
 * `attemptDelivery` for an id that is already reserved (a fresh `POST` never needs this: `store`'s
 * `reserve` is atomic per path, so only one caller can ever see `existing: false` for a given id in
 * the first place). Without this, a caller retrying an `unknown` entry while the tick's re-drive is
 * already mid-`attemptDelivery` for that SAME id would start a second one -- the tick doesn't update
 * the stored state until its attempt settles, so the retry would still see "unknown" and reset it to
 * pending itself.
 */
export interface DrainLock {
  /** `true` = acquired, this caller owns the drain; `false` = someone else already holds it. */
  tryStart(requestId: string): boolean;
  finish(requestId: string): void;
}

export function createDrainLock(): DrainLock {
  const inFlight = new Set<string>();
  return {
    tryStart(requestId) {
      if (inFlight.has(requestId)) return false;
      inFlight.add(requestId);
      return true;
    },
    finish(requestId) {
      inFlight.delete(requestId);
    },
  };
}

/**
 * Attempts delivery and persists the outcome via `setState`. Does NOT touch `DrainLock` itself --
 * the caller must hold it for `requestId` already (`tryStart` returned `true`) and release it
 * (`finish`) once this settles, in a `finally`; that split is what lets the tick await this
 * sequentially while http.ts fires it without awaiting (the `202` goes out first, decision 5) using
 * the exact same function either way.
 */
export async function drainAndPersist(
  host: HostApi,
  requestId: string,
  entry: { kind: DeliveryKind; target: PostTarget; body: DeliveryBody; createdAt: string },
  setState: (requestId: string, value: StoredDelivery) => Promise<void>,
  log: PluginLog,
): Promise<void> {
  const outcome = await attemptDelivery(host, requestId, entry.kind, entry.target, entry.body, log);
  const next: StoredDelivery =
    outcome.state === "delivered"
      ? { ...entry, state: "delivered", messageRef: outcome.messageRef, url: outcome.url, delivery: outcome.delivery }
      : { ...entry, state: "failed", code: outcome.code };
  await setState(requestId, next);
}
