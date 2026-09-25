// One delivery attempt (Tooling#742 decision 5's drain bullet, extended by Tooling#746 decisions 1-5
// for dm/edit), plus the lock that keeps the tick's re-drive and an HTTP retry from ever draining the
// SAME request_id at once. `attemptDelivery` itself does not persist -- the caller (`drainAndPersist`)
// does, via `deps.store`. Never logs message content.
import type { HostApi, HostDelivery, PluginLog } from "../../../packages/api/contract.js";
import type { RegistryStore } from "./registry.js";
import type { DeliveryStore } from "./store.js";
import { isDmTarget, isEditTarget, isPostTarget, type DeliveryBody, type DeliveryKind, type DeliveryTarget, type StoredDelivery } from "./protocol.js";

/** Discord's own closed-DMs refusal, rewritten by the host to this exact string (rackbops-discord-bot
 *  `src/plugins/delivery.ts:42`, pinned by that repo's `delivery.test.ts:75`) -- the one host error
 *  every caller of `host.dm` needs to tell apart from "something else went wrong". Anything else
 *  `host.dm` rejects with is `UPSTREAM_UNAVAILABLE`, unrewritten. */
export const RECIPIENT_UNREACHABLE_MESSAGE = "recipient cannot be messaged";

export type DrainOutcome =
  | { state: "delivered"; messageRef: string | null; url: string | null; delivery: HostDelivery | null; applied?: boolean }
  | { state: "failed"; code: "CAPABILITY_UNAVAILABLE" | "UPSTREAM_UNAVAILABLE" | "RECIPIENT_UNREACHABLE" | "NOT_FOUND" };

/**
 * Serializes edit application per `message_ref` (Tooling#746 decision 3): `HostStorage`'s mutator
 * callback is synchronous, so it cannot wrap the async `host.edit` call plus the read that precedes
 * it -- this is the seam that does instead. A per-key promise chain, the same shape
 * `createKeyedJsonMutator` (packages/testkit) uses for its own per-path chains: `run` always executes
 * `fn`, whichever way the PREVIOUS call for that key settled (`.then(fn, fn)`), so one key's failure
 * never breaks its chain for a later caller: the chain map keeps a `.catch(() => {})`'d copy so the
 * next `run` for that key starts from a resolved promise, while the caller of THIS `run` still gets
 * `fn`'s own real outcome (resolution or rejection), unswallowed.
 */
export interface EditQueue {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function createEditQueue(): EditQueue {
  const chains = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prior = chains.get(key) ?? Promise.resolve();
      const next = prior.then(fn, fn);
      chains.set(key, next.catch(() => {}));
      return next;
    },
  };
}

/** Tooling#746 decision 8: the drain layer's dependencies, collected into one object so
 *  `attemptDelivery`/`drainAndPersist` take one parameter instead of a growing positional list.
 *  `HttpDeps` (http.ts) extends this, so the same object index.ts builds for HTTP is passed straight
 *  through to the tick's re-drive too. */
export interface DrainDeps {
  host: HostApi;
  store: DeliveryStore;
  registry: RegistryStore;
  editQueue: EditQueue;
  log: PluginLog;
}

/** One delivered `post`/`dm` original, as `attemptEdit` needs to see it -- the subset of
 *  `StoredDelivery`'s `delivered` variant that matters for applying an edit against it. */
type DeliveredOriginal = Extract<StoredDelivery, { state: "delivered" }>;

/**
 * Applies one edit against `messageRef`'s original, inside `deps.editQueue` (decision 3's ordered
 * steps, in order):
 * 1. `NOT_FOUND` -- no record for `messageRef`, the record isn't `delivered`, or it is itself an edit
 *    (an edit's own record is never a valid edit target -- `kind: "edit"` never chains).
 * 2. `CAPABILITY_UNAVAILABLE` -- `host.edit` is absent, or the original was delivered by `announce`
 *    (`delivery: null`, #742's no-`host.post` fallback, which has no message to find again).
 * 3. `RECIPIENT_UNREACHABLE` -- the original was a `dm` and its recipient is no longer registered.
 * 4. `seq < (original.lastEditSeq ?? 0)`: already superseded by a later edit -- `delivered{applied:
 *    false}`, with NO `host.edit` call (decision 3's ordering point: a lower seq must never reach the
 *    host, even to reapply the same content, once a higher one has already landed).
 * 5. Otherwise: call `host.edit(original.delivery, body)`, persist `lastEditSeq = seq` on the
 *    original's OWN record (`deps.store.recordEditSeq`, not this edit's own record -- see store.ts),
 *    and answer `delivered{applied:true}`. An equal `seq` re-applies (decision 3: only happens when a
 *    re-drive repeats an edit that had already applied, with the same content).
 */
async function attemptEdit(deps: DrainDeps, requestId: string, target: DeliveryTarget, body: DeliveryBody): Promise<DrainOutcome> {
  if (!isEditTarget(target)) {
    // A legacy #742 record (kind "edit", target coerced to a PostTarget) -- never delivered
    // (Tooling#746 decision 5), no host call.
    return { state: "failed", code: "NOT_FOUND" };
  }
  const { messageRef, seq } = target;
  return deps.editQueue.run(messageRef, async (): Promise<DrainOutcome> => {
    const original = await deps.store.get(messageRef);
    if (original === undefined || original.state !== "delivered" || original.kind === "edit") {
      return { state: "failed", code: "NOT_FOUND" };
    }
    const delivered: DeliveredOriginal = original;
    if (typeof deps.host.edit !== "function" || delivered.delivery === null) {
      return { state: "failed", code: "CAPABILITY_UNAVAILABLE" };
    }
    if (delivered.kind === "dm") {
      const userId = isDmTarget(delivered.target) ? delivered.target.userId : undefined;
      const generation = userId !== undefined ? await deps.registry.generationOf(userId) : undefined;
      if (generation === undefined) {
        return { state: "failed", code: "RECIPIENT_UNREACHABLE" };
      }
    }
    if (seq < (delivered.lastEditSeq ?? 0)) {
      return { state: "delivered", messageRef: delivered.messageRef, url: delivered.url, delivery: delivered.delivery, applied: false };
    }
    try {
      await deps.host.edit(delivered.delivery, body);
    } catch (err) {
      deps.log.error(`edit ${requestId} (of ${messageRef}) failed`, err);
      return { state: "failed", code: "UPSTREAM_UNAVAILABLE" };
    }
    await deps.store.recordEditSeq(messageRef, seq);
    return { state: "delivered", messageRef: delivered.messageRef, url: delivered.url, delivery: delivered.delivery, applied: true };
  });
}

/**
 * DMs `target.userId` (Tooling#746 decisions 1-2). Registration is checked at drain time, right
 * before `host.dm` -- `undefined` (never registered, or unregistered since the caller's own check) is
 * `RECIPIENT_UNREACHABLE` with NO host call. A legacy #742 record (target coerced to a PostTarget) is
 * the same `RECIPIENT_UNREACHABLE`, also with no host call (decision 5) -- indistinguishable from an
 * unregistered user from the caller's point of view, and correctly so: neither has anyone to deliver
 * to. The one Discord rejection every caller must tell apart, the closed-DMs message, is matched by
 * exact string (decision 1); anything else is `UPSTREAM_UNAVAILABLE`.
 */
async function attemptDm(deps: DrainDeps, requestId: string, target: DeliveryTarget, body: DeliveryBody): Promise<DrainOutcome> {
  if (!isDmTarget(target)) {
    return { state: "failed", code: "RECIPIENT_UNREACHABLE" };
  }
  const generation = await deps.registry.generationOf(target.userId);
  if (generation === undefined) {
    return { state: "failed", code: "RECIPIENT_UNREACHABLE" };
  }
  try {
    const delivery = await deps.host.dm!(target.userId, {
      content: body.content ?? "",
      ...(body.card !== undefined ? { card: body.card } : {}),
      ...(body.links !== undefined ? { links: body.links } : {}),
    });
    const url = `https://discord.com/channels/@me/${delivery.channelId}/${delivery.messageId}`;
    return { state: "delivered", messageRef: requestId, url, delivery };
  } catch (err) {
    if (err instanceof Error && err.message === RECIPIENT_UNREACHABLE_MESSAGE) {
      return { state: "failed", code: "RECIPIENT_UNREACHABLE" };
    }
    deps.log.error(`delivery ${requestId} failed`, err);
    return { state: "failed", code: "UPSTREAM_UNAVAILABLE" };
  }
}

/**
 * Attempts one delivery of `body` to `target`, as `requestId`.
 * - `kind === "post"`: unchanged from #742 (behaviour preserved by Tooling#746 decision 8) --
 *   `host.post` present: sends content, card and links as given, and stores the real Discord
 *   identifiers (`message_ref` is the request's own id, decision 5 of #742, literally); absent: a
 *   card or non-empty links is `CAPABILITY_UNAVAILABLE` with no Discord call, content alone falls back
 *   to `host.announce` (no delivered message, so `message_ref`/`url` are `null`). A rejection from
 *   either path is `UPSTREAM_UNAVAILABLE`, logged without the message content.
 * - `kind === "dm"`: see `attemptDm`.
 * - `kind === "edit"`: see `attemptEdit`, serialized through `deps.editQueue` per `message_ref`.
 */
export async function attemptDelivery(
  deps: DrainDeps,
  requestId: string,
  entry: { kind: DeliveryKind; target: DeliveryTarget; body: DeliveryBody; createdAt: string },
): Promise<DrainOutcome> {
  const { kind, target, body } = entry;
  if (kind === "dm") return attemptDm(deps, requestId, target, body);
  if (kind === "edit") return attemptEdit(deps, requestId, target, body);

  // kind === "post": unchanged from #742 (Tooling#746 decision 8). validateCreateRequest only ever
  // produces a real PostTarget for "post" (never coerced, unlike the old dm/edit path), so this guard
  // is a pure type-narrowing formality against the wider DeliveryTarget union `entry.target` now
  // carries -- never a behaviour change for any request that reached here through validation.
  if (!isPostTarget(target)) {
    return { state: "failed", code: "CAPABILITY_UNAVAILABLE" };
  }
  const { host, log } = deps;
  if (typeof host.post === "function") {
    try {
      const delivery = await host.post(target.guildId, target.destination, {
        content: body.content ?? "",
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
    await host.announce(body.content ?? "", target.destination);
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
 * Attempts delivery and persists the outcome via `deps.store.set`. Does NOT touch `DrainLock` itself
 * -- the caller must hold it for `requestId` already (`tryStart` returned `true`) and release it
 * (`finish`) once this settles, in a `finally`; that split is what lets the tick await this
 * sequentially while http.ts fires it without awaiting (the `202` goes out first, decision 5 of #742)
 * using the exact same function either way.
 */
export async function drainAndPersist(
  deps: DrainDeps,
  requestId: string,
  entry: { kind: DeliveryKind; target: DeliveryTarget; body: DeliveryBody; createdAt: string },
): Promise<void> {
  const outcome = await attemptDelivery(deps, requestId, entry);
  const next: StoredDelivery =
    outcome.state === "delivered"
      ? {
          ...entry,
          state: "delivered",
          messageRef: outcome.messageRef,
          url: outcome.url,
          delivery: outcome.delivery,
          ...(outcome.applied !== undefined ? { applied: outcome.applied } : {}),
        }
      : { ...entry, state: "failed", code: outcome.code };
  await deps.store.set(requestId, next);
}
