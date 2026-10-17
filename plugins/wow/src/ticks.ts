import type { HostApi, TickCheck } from "../../../packages/api/contract.js";
import { config } from "./config.js";
import { decideDmfAnnouncement } from "./dmf.js";
import { lastWeeklyReset } from "./reset.js";
import { realmStatus, realmWatchConfigured, decideRealmTransition, type RealmStatus } from "./realm.js";
import { wowState, saveWowState } from "./store.js";

const RESET_ANNOUNCE_WINDOW_MS = 10 * 60 * 1000;
// Poll the realm continuously (not only around reset) so an unscheduled outage at any hour is caught.
// The gap keeps the Blizzard call cadence gentle while still catching short outages.
const REALM_POLL_GAP_MS = 2 * 60 * 1000;
let lastRealmPollAt = 0;

// The three checks are ported from the bot's old announce.ts (checkDmf/checkWeeklyReset/checkRealm), with
// `announce(client, kind, msg)` → `host.announce(msg)` (the same ANNOUNCE_CHANNEL_ID the bot posted to)
// and the `state.X`/`saveState()` singleton → the plugin's own wow.json store. Announcement text is
// byte-identical to the baked-in bot. Exported so their wiring is unit-tested directly.

// `now` is a defaulted parameter (production always uses `new Date()`, via wowTicks) purely so a test
// can drive the announce-then-persist path at a fixed instant — the same seam the bot's own pure
// decide* functions expose. It does not change runtime behaviour.
export async function checkDmf(host: HostApi, now: Date = new Date()): Promise<void> {
  const state = wowState();
  const decision = decideDmfAnnouncement(now, state.dmfAnnouncedFor);
  if (!decision) return;
  const closes = Math.floor(decision.window.end.getTime() / 1000);
  await announceOnce(host, `🎪 The **Darkmoon Faire** is open! It runs until <t:${closes}:F>.`, () => {
    const previous = state.dmfAnnouncedFor;
    state.dmfAnnouncedFor = decision.key;
    return () => void (state.dmfAnnouncedFor = previous);
  });
}

/**
 * Records the dedup key and persists it BEFORE `host.announce` (README: "Write your dedup key before you
 * announce"), so a stop that outlasts the grace while the post is in flight cannot re-announce after the
 * restart. If the save or the announce rejects, the key is put back (and persisted again, best effort),
 * so the next tick retries and the original error is the one that surfaces. A hard kill between the save
 * and the post loses that one announcement (at most once across a kill); a rejection after Discord did
 * deliver the post (a timeout, say) retries it. `mark` sets the key and returns how to undo it.
 */
async function announceOnce(host: HostApi, message: string, mark: () => () => void): Promise<void> {
  const undo = mark();
  try {
    await saveWowState();
    await host.announce(message);
  } catch (err) {
    undo();
    await saveWowState().catch((saveErr) => host.log.error("wow: could not restore the dedup key", saveErr));
    throw err;
  }
}

// `now` defaulted for the same test seam as checkDmf — production passes nothing (→ new Date()).
export async function checkWeeklyReset(host: HostApi, now: Date = new Date()): Promise<void> {
  const last = lastWeeklyReset(now);
  if (now.getTime() - last.getTime() > RESET_ANNOUNCE_WINDOW_MS) return;
  const key = last.toISOString();
  const state = wowState();
  if (state.weeklyAnnouncedFor === key) return;
  await announceOnce(host, "📅 **Weekly reset!** Vault, lockouts, and quests have rolled over.", () => {
    const previous = state.weeklyAnnouncedFor;
    state.weeklyAnnouncedFor = key;
    return () => void (state.weeklyAnnouncedFor = previous);
  });
}

// Continuously watch the realm and announce every UP↔DOWN transition, so an outage at any hour is
// reported — not only weekly-reset maintenance. A Blizzard error is swallowed: it must never
// masquerade as a DOWN, nor block the rest of the tick.
export async function checkRealm(host: HostApi, signal?: AbortSignal): Promise<void> {
  if (!realmWatchConfigured()) return;
  if (Date.now() - lastRealmPollAt < REALM_POLL_GAP_MS) return;
  lastRealmPollAt = Date.now();
  const state = wowState();
  let status: RealmStatus;
  try {
    status = await realmStatus(signal);
  } catch (err) {
    host.log.error("realm poll failed", err);
    return;
  }
  // The host abandoned this run (shutdown): announce and persist nothing, the next poll redoes it.
  if (signal?.aborted) return;
  // A status stored for another realm or region is no previous reading at all: seed silently rather than
  // announce a transition between two different realms. A file without a key predates it: the realm
  // configured now.
  const realmKey = `${config.region}/${config.realmSlug}`;
  const previous = state.realmKey === undefined || state.realmKey === realmKey ? state.realmStatus : undefined;
  const transition = decideRealmTransition(previous, status);
  const message =
    transition === "down"
      ? `🔴 **${config.realmSlug}** is down — servers are offline.`
      : transition === "up"
        ? `🟢 **${config.realmSlug}** is back up — servers are live!`
        : undefined;
  const mark = () => {
    const before = { realmStatus: state.realmStatus, realmKey: state.realmKey };
    state.realmStatus = status;
    state.realmKey = realmKey;
    return () => {
      state.realmStatus = before.realmStatus;
      state.realmKey = before.realmKey;
    };
  };
  if (message !== undefined) {
    await announceOnce(host, message, mark);
  } else if (state.realmStatus !== status || state.realmKey !== realmKey) {
    mark();
    await saveWowState();
  }
}

/** The three WoW scheduler checks, in the bot's original order (dmf, weeklyReset, realm). The host
 *  wraps each in its own per-check try/catch and the plugin `running`-gate. */
export function wowTicks(host: HostApi): TickCheck[] {
  return [
    { name: "dmf", run: () => checkDmf(host) },
    { name: "weeklyReset", run: () => checkWeeklyReset(host) },
    { name: "realm", run: (signal) => checkRealm(host, signal) },
  ];
}

/** Test-only: reset the realm-poll throttle so a test can drive checkRealm on consecutive calls. */
export function _resetRealmPollThrottle(): void {
  lastRealmPollAt = 0;
}
