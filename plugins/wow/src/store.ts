import type { HostApi } from "../../../packages/api/contract.js";
import type { RealmStatus } from "./realm.js";

/**
 * The plugin's own dedup state, kept in `${dataDir}/wow.json` — the three keys the bot used to keep in
 * `state.json` (`dmfAnnouncedFor` / `weeklyAnnouncedFor` / `realmStatus`), now owned here so the bot
 * core knows nothing WoW-specific.
 */
export interface WowState {
  dmfAnnouncedFor?: string;
  weeklyAnnouncedFor?: string;
  realmStatus?: RealmStatus;
}

let current: WowState = {};
let writer: { save: (data: WowState) => Promise<void> } | undefined;

/**
 * The live in-memory dedup state — the ticks read and mutate it, exactly as the bot's ticks read the
 * `state` singleton. Empty until `initWowStore` runs (in `activate`, before any tick can fire).
 */
export function wowState(): WowState {
  return current;
}

/**
 * Persist the current dedup state through the host's serialized writer (atomic temp-then-rename, one
 * in-flight write at a time) — the plugin analog of the bot's `saveState()`.
 */
export async function saveWowState(): Promise<void> {
  if (writer) await writer.save(current);
}

/**
 * Prepare the dedup store on first activation. If `wow.json` doesn't exist yet, seed it ONCE from the
 * bot's `state.json` (the three legacy keys the bot used to write) so an existing instance keeps its
 * "already announced" history across the extraction and never re-announces. Read `state.json` RAW
 * (`Bun.file().json()` in a try/catch), NOT `host.storage.readJsonOrFresh` — that moves a corrupt file
 * aside for inspection, and `state.json` is the bot's file, not ours. An absent or corrupt `state.json`
 * seeds empty (a fresh install: `realmStatus` undefined ⇒ the first realm reading is silent). Idempotent:
 * once `wow.json` exists it's loaded as-is and the seed never runs again.
 */
export async function initWowStore(host: HostApi): Promise<void> {
  const wowPath = `${host.dataDir}/wow.json`;
  if (await Bun.file(wowPath).exists()) {
    current = await host.storage.readJsonOrFresh<WowState>(wowPath, () => ({}), "wow");
  } else {
    current = await seedFromBotState(`${host.dataDir}/state.json`);
    await host.storage.writeJsonAtomic(wowPath, current);
  }
  writer = host.storage.createJsonWriter<WowState>(wowPath);
}

async function seedFromBotState(statePath: string): Promise<WowState> {
  try {
    const raw = (await Bun.file(statePath).json()) as Record<string, unknown>;
    const seed: WowState = {};
    if (typeof raw.dmfAnnouncedFor === "string") seed.dmfAnnouncedFor = raw.dmfAnnouncedFor;
    if (typeof raw.weeklyAnnouncedFor === "string") seed.weeklyAnnouncedFor = raw.weeklyAnnouncedFor;
    if (raw.realmStatus === "UP" || raw.realmStatus === "DOWN") seed.realmStatus = raw.realmStatus;
    return seed;
  } catch {
    // Absent, unreadable, or not JSON — a fresh install. Seed empty; the realm watch stays silent
    // until its first observed transition (decideRealmTransition seeds on an undefined previous).
    return {};
  }
}

/** Test-only: reset the module singletons so each test starts from a clean, unbound store. */
export function _resetWowStore(): void {
  current = {};
  writer = undefined;
}
