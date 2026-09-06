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

// The three checks are ported from the bot's announce.ts (checkDmf/checkWeeklyReset/checkRealm), with
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
  await host.announce(`🎪 The **Darkmoon Faire** is open! It runs until <t:${closes}:F>.`);
  state.dmfAnnouncedFor = decision.key;
  await saveWowState();
}

// `now` defaulted for the same test seam as checkDmf — production passes nothing (→ new Date()).
export async function checkWeeklyReset(host: HostApi, now: Date = new Date()): Promise<void> {
  const last = lastWeeklyReset(now);
  if (now.getTime() - last.getTime() > RESET_ANNOUNCE_WINDOW_MS) return;
  const key = last.toISOString();
  const state = wowState();
  if (state.weeklyAnnouncedFor === key) return;
  await host.announce("📅 **Weekly reset!** Vault, lockouts, and quests have rolled over.");
  state.weeklyAnnouncedFor = key;
  await saveWowState();
}

// Continuously watch the realm and announce every UP↔DOWN transition, so an outage at any hour is
// reported — not only weekly-reset maintenance. A Blizzard error is swallowed: it must never
// masquerade as a DOWN, nor block the rest of the tick.
export async function checkRealm(host: HostApi): Promise<void> {
  if (!realmWatchConfigured()) return;
  if (Date.now() - lastRealmPollAt < REALM_POLL_GAP_MS) return;
  lastRealmPollAt = Date.now();
  const state = wowState();
  let status: RealmStatus;
  try {
    status = await realmStatus();
  } catch (err) {
    host.log.error("realm poll failed", err);
    return;
  }
  const transition = decideRealmTransition(state.realmStatus, status);
  if (transition === "down") {
    await host.announce(`🔴 **${config.realmSlug}** is down — servers are offline.`);
  } else if (transition === "up") {
    await host.announce(`🟢 **${config.realmSlug}** is back up — servers are live!`);
  }
  if (state.realmStatus !== status) {
    state.realmStatus = status;
    await saveWowState();
  }
}

/** The three WoW scheduler checks, in the bot's original order (dmf, weeklyReset, realm). The host
 *  wraps each in its own per-check try/catch and the plugin `running`-gate. */
export function wowTicks(host: HostApi): TickCheck[] {
  return [
    { name: "dmf", run: () => checkDmf(host) },
    { name: "weeklyReset", run: () => checkWeeklyReset(host) },
    { name: "realm", run: () => checkRealm(host) },
  ];
}

/** Test-only: reset the realm-poll throttle so a test can drive checkRealm on consecutive calls. */
export function _resetRealmPollThrottle(): void {
  lastRealmPollAt = 0;
}
