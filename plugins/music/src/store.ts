// The plugin's own persistent state in `${dataDir}/music.json`: who has connected Spotify, and
// which OAuth handshakes are in flight. Every state transition is a PURE function over a state
// value (`beginPendingAuth`, `redeemPendingAuth`, ...) so `store.test.ts` exercises expiry,
// single-use and replacement as plain data; the module-level singleton and the host-backed writer
// are the only stateful parts, mirroring warbandeer's `links.ts`.
//
// On secrets: a Spotify refresh token is stored in PLAINTEXT, unlike warbandeer's Device Tokens,
// which are hashed. That is forced, not sloppy -- a device token only ever has to be COMPARED, so a
// hash suffices, whereas a refresh token has to be REPLAYED to Spotify, so the bot must hold the
// real value. It therefore has the same handling rules as `DISCORD_TOKEN`: never logged, never put
// in a Discord reply, and `data/` is as sensitive as the config `.env` for as long as one exists.

import type { HostApi, HostStorage } from "../../../packages/api/contract.js";

/** How long a `/spotify connect` link stays usable before the user has to ask for a new one. */
export const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

export interface Connection {
  refreshToken: string;
  /** ms epoch, for `/spotify status`. */
  connectedAt: number;
  /**
   * The space-separated scopes Spotify says this grant carries, recorded so a feature can check
   * before it calls. Absent on a connection made before scopes were recorded, which is playlist-only
   * by construction -- `hasScopes` treats it that way rather than guessing.
   */
  scopes?: string;
}

export interface PendingAuth {
  discordUserId: string;
  expiresAt: number;
  /** What this handshake asked Spotify for, so the callback can record a grant even if Spotify's
   *  token response omits `scope`. */
  scopes?: string;
}

export interface MusicState {
  /** Discord user id -> their Spotify connection. */
  connections: Record<string, Connection>;
  /** OAuth `state` token -> the handshake it belongs to. */
  pending: Record<string, PendingAuth>;
}

export function freshState(): MusicState {
  return { connections: {}, pending: {} };
}

// ---------------------------------------------------------------------------------------------------
// Pure transitions
// ---------------------------------------------------------------------------------------------------

/**
 * Drops every expired handshake. Called on each begin/redeem rather than on a timer: the map only
 * grows when someone runs `/spotify connect`, so sweeping at those two moments is enough to keep it
 * from accumulating abandoned handshakes forever.
 */
export function prunePending(state: MusicState, now: number): MusicState {
  const pending: Record<string, PendingAuth> = {};
  for (const [token, entry] of Object.entries(state.pending)) {
    if (entry.expiresAt > now) pending[token] = entry;
  }
  return { ...state, pending };
}

/**
 * Records a new handshake for a user, REPLACING any earlier one of theirs. One pending handshake
 * per user at a time: a second `/spotify connect` invalidates the first link, so an abandoned link
 * left open in a browser tab cannot be completed later to attach an account the user has since
 * thought better of.
 */
export function beginPendingAuth(
  state: MusicState,
  stateToken: string,
  discordUserId: string,
  now: number,
  scopes?: string,
): MusicState {
  const swept = prunePending(state, now);
  const pending: Record<string, PendingAuth> = {};
  for (const [token, entry] of Object.entries(swept.pending)) {
    if (entry.discordUserId !== discordUserId) pending[token] = entry;
  }
  const entry: PendingAuth = { discordUserId, expiresAt: now + PENDING_AUTH_TTL_MS };
  if (scopes !== undefined) entry.scopes = scopes;
  pending[stateToken] = entry;
  return { ...swept, pending };
}

export type RedeemResult =
  | { ok: true; discordUserId: string; scopes?: string; state: MusicState }
  | { ok: false; reason: "unknown" | "expired"; state: MusicState };

/**
 * Consumes a handshake token. Single-use: the token is removed whether or not it was still valid,
 * so a callback URL that leaks (a shared browser's history, a referrer header) cannot be replayed
 * to attach someone else's Spotify account to the original user's Discord id.
 */
export function redeemPendingAuth(state: MusicState, stateToken: string, now: number): RedeemResult {
  const swept = prunePending(state, now);
  const entry = state.pending[stateToken];
  const { [stateToken]: _removed, ...rest } = swept.pending;
  const without: MusicState = { ...swept, pending: rest };
  if (entry === undefined) return { ok: false, reason: "unknown", state: without };
  if (entry.expiresAt <= now) return { ok: false, reason: "expired", state: without };
  const redeemed: RedeemResult = { ok: true, discordUserId: entry.discordUserId, state: without };
  if (entry.scopes !== undefined) redeemed.scopes = entry.scopes;
  return redeemed;
}

/**
 * Records (or rotates) a connection. `scopes` left out KEEPS whatever the stored connection already
 * had -- the token-rotation path knows nothing new about the grant, and dropping the recorded
 * scopes there would silently demote a party-capable connection back to playlist-only on the next
 * refresh.
 */
export function putConnection(
  state: MusicState,
  discordUserId: string,
  refreshToken: string,
  now: number,
  scopes?: string,
): MusicState {
  const next: Connection = { refreshToken, connectedAt: now };
  const carried = scopes ?? state.connections[discordUserId]?.scopes;
  if (carried !== undefined) next.scopes = carried;
  return {
    ...state,
    connections: { ...state.connections, [discordUserId]: next },
  };
}

export function removeConnection(state: MusicState, discordUserId: string): MusicState {
  const { [discordUserId]: _removed, ...rest } = state.connections;
  return { ...state, connections: rest };
}

// ---------------------------------------------------------------------------------------------------
// The live singleton
// ---------------------------------------------------------------------------------------------------

let current: MusicState = freshState();
let writer: { save: (data: MusicState) => Promise<void> } | undefined;

export function musicState(): MusicState {
  return current;
}

/** Replaces the live state and persists it through the host's serialized atomic writer. */
export async function commit(next: MusicState): Promise<void> {
  current = next;
  if (writer) await writer.save(current);
}

/** Loads (or creates) `setlist.json`. Runs in `activate()`, never in `createPlugin`. */
export async function initStore(host: HostApi): Promise<void> {
  const path = `${host.dataDir}/music.json`;
  current = await host.storage.readJsonOrFresh<MusicState>(path, freshState, "music");
  // A file written by an older version, or one hand-edited into the wrong shape, must not make
  // every later access throw on a missing map.
  if (typeof current.connections !== "object" || current.connections === null) current.connections = {};
  if (typeof current.pending !== "object" || current.pending === null) current.pending = {};
  writer = host.storage.createJsonWriter<MusicState>(path);
}

/** Test seam: point the singleton at a given state and storage without a real `HostApi`. */
export function resetStoreForTest(state: MusicState, storage?: HostStorage, path?: string): void {
  current = state;
  writer = storage && path ? storage.createJsonWriter<MusicState>(path) : undefined;
}

/**
 * A 32-byte URL-safe random token, used as the OAuth `state`. `crypto.randomUUID` would be too
 * short to be a CSRF token on its own, and this is the only thing standing between the callback
 * and an attacker-chosen Discord id.
 */
export function generateStateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}
