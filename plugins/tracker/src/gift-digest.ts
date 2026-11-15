import type { Database } from "bun:sqlite";
import { decideGiftDigest, type GiftLedger, giftBuckets, giftDigestKey, type Notifier, type Store, wallClock } from "@rackbops/docket-core";
import type { PluginLog } from "../../../packages/api/contract.js";
import type { DeliveryHealth } from "./delivery-health.js";
import { digestOwners, getDigestState, putDigestState } from "./gift-store.js";

/**
 * The opt-in gift digest (docket#103) on the notify tick, after the daily digest (digest.ts): for
 * each registered person with a live occasion carrying `digest: true`, docket's pure
 * `decideGiftDigest` says whether a DM is due now -- at most once a local day, at or after their
 * preferred hour in their zone, and only when it would say something new or the shop-by day is near
 * -- and its text, which names people and counts only: never a price, a note or an item's title.
 *
 * The state docket returns (a sent digest's, or a quiet `nothing`'s) is stored per occasion in
 * `gift_digest_state` (gift-store.ts), which forget-me erases with the rest of the ledger. A due
 * digest is claimed once with docket's `claimNotice` under `giftDigestKey(occasion, day)` before it
 * is sent, as the daily digest claims its day, so a second tick, a restart or a tick the host
 * abandoned never sends it twice; a DM that fails after the claim is logged and not resent, as the
 * daily digest's is. A person whose delivery is paused (delivery-health.ts) is passed by without a
 * claim, so the digest goes out once the pause lifts. Never calls a model; never waits on city-hall.
 * People with no opted-in occasion cost nothing: one read finds the rest (`digestOwners`), leaving
 * out an occasion whose date has passed in every zone. Before the owner's hour, and for an occasion
 * already sent today (its stored `sentOn`), nothing of the ledger is read either: docket would say
 * "not-yet" or "sent-today" with no state to store, so the outcome is the same.
 *
 * It runs only while the daily digest does: `options.digest: false` (index.ts) turns both off.
 */

export interface GiftDigestDeps {
  db: Database;
  store: Store;
  gifts: GiftLedger;
  notifier: Notifier;
  log: PluginLog;
  isRegistered: (userId: string) => boolean;
  health?: DeliveryHealth;
}

export interface GiftDigestResult {
  sent: number;
  failed: number;
}

export async function runGiftDigests(d: GiftDigestDeps, now: Date, signal?: AbortSignal): Promise<GiftDigestResult> {
  const result: GiftDigestResult = { sent: 0, failed: 0 };
  // A day no zone is still before (UTC-12 is at most a day behind): an occasion dated before it is past everywhere.
  const before = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  for (const { ownerId, occasionIds } of digestOwners(d.db, before)) {
    if (signal?.aborted) break;
    const user = await d.store.getUser(ownerId);
    if (!user || !d.isRegistered(user.id) || d.health?.isPaused(user.id)) continue;
    // Before any ledger read: docket would answer "not-yet" before the hour and "sent-today" after a
    // send (neither with a state to store), so those occasions are skipped here, as docket would.
    let local: ReturnType<typeof wallClock>;
    try {
      local = wallClock(now, user.timeZone);
    } catch (err) {
      d.log.warn(`gift digest: ${user.id} has a time zone the clock cannot read (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (local.hour < user.preferredHour) continue;
    const today = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
    const open = occasionIds.filter((id) => getDigestState(d.db, user.id, id)?.sentOn !== today);
    if (open.length === 0) continue;
    const all = { includeArchived: true };
    const occasions = (await d.gifts.list("occasion", user.id)).filter((o) => o.digest === true && open.includes(o.id));
    const [allocations, purchases, recipients, roster] = await Promise.all([
      d.gifts.list("allocation", user.id, all),
      d.gifts.list("purchase", user.id, all),
      d.gifts.list("recipient", user.id, all),
      d.gifts.list("occasionRecipient", user.id, all),
    ]);
    const buckets = giftBuckets(allocations, purchases);
    for (const occasion of occasions) {
      let decision: ReturnType<typeof decideGiftDigest>;
      try {
        const last = getDigestState(d.db, user.id, occasion.id);
        decision = decideGiftDigest({ occasion, roster, buckets, recipients, owner: user, now, last });
      } catch (err) {
        d.log.warn(`gift digest: ${occasion.id} of ${user.id} could not be decided (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      if (!decision.due) {
        if (decision.state) putDigestState(d.db, user.id, occasion.id, decision.state);
        continue;
      }
      const day = decision.state.sentOn ?? "";
      const claimed = await d.store.claimNotice(giftDigestKey(occasion.id, day), now.toISOString());
      putDigestState(d.db, user.id, occasion.id, decision.state);
      if (!claimed) continue;
      try {
        await d.notifier.sendDm(user.id, { text: decision.text });
        result.sent++;
      } catch (err) {
        // Claimed, so never resent: the notifier has counted a closed DM toward the person's pause.
        d.log.warn(`gift digest: ${occasion.id} to ${user.id} did not go out (${err instanceof Error ? err.message : String(err)}); it is not resent`);
        result.failed++;
      }
    }
  }
  return result;
}
