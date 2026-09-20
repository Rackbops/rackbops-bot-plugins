// The listening party's data model, and the one decision every part of it turns on: THE BOT IS THE
// SEQUENCER. Spotify's own queue is never used. Each member's player is told exactly which track to
// be on and where, one explicit URI at a time, because per-user queues cannot be reconciled -- a
// member who had something queued already, or who skipped on their phone, would end up on a
// different track with no way back.
//
// Everything here is pure over a state value, like `store.ts`: the party is data, and `runner.ts`
// is the only part that talks to Spotify or to a clock. That is what lets `party.test.ts` cover
// drift, advance and the end of the queue without a network or a timer.

import type { HostApi, HostStorage } from "../../../packages/api/contract.js";
import type { PlaybackState } from "./spotify.js";

/**
 * How far out of step a member may be before the party corrects them.
 *
 * A re-issued `play` is audible -- it is a jump, not a nudge -- so correcting small drift sounds
 * worse than the drift itself. Two members a second apart is fine; a member 30 seconds behind
 * because their phone slept is not.
 */
export const DRIFT_TOLERANCE_MS = 3_000;

export interface PartyTrack {
  uri: string;
  name: string;
  artist: string;
  durationMs: number;
}

export interface Party {
  guildId: string;
  channelId: string;
  /** Who started it. Only they can stop it, and their leaving ends it. */
  hostId: string;
  /** Discord user ids, the host included. Order is join order. */
  members: string[];
  queue: PartyTrack[];
  /** Index into `queue` of the track that is playing (or would play on start). */
  index: number;
  /** ms epoch the current track began. Absent = the party exists but is not playing. */
  trackStartedAt?: number;
}

export interface PartiesState {
  /** Guild id -> that guild's one party. One per guild: a second would fight the first for the
   *  same people's players. */
  parties: Record<string, Party>;
}

export function freshParties(): PartiesState {
  return { parties: {} };
}

// ---------------------------------------------------------------------------------------------------
// Pure transitions
// ---------------------------------------------------------------------------------------------------

export function getParty(state: PartiesState, guildId: string): Party | undefined {
  return state.parties[guildId];
}

export function openParty(state: PartiesState, party: Party): PartiesState {
  return { ...state, parties: { ...state.parties, [party.guildId]: party } };
}

export function closeParty(state: PartiesState, guildId: string): PartiesState {
  const { [guildId]: _removed, ...rest } = state.parties;
  return { ...state, parties: rest };
}

function replace(state: PartiesState, party: Party): PartiesState {
  return { ...state, parties: { ...state.parties, [party.guildId]: party } };
}

/** Idempotent: pressing Join twice must not queue a member twice and double every play call. */
export function addMember(state: PartiesState, guildId: string, userId: string): PartiesState {
  const party = state.parties[guildId];
  if (party === undefined || party.members.includes(userId)) return state;
  return replace(state, { ...party, members: [...party.members, userId] });
}

export function removeMember(state: PartiesState, guildId: string, userId: string): PartiesState {
  const party = state.parties[guildId];
  if (party === undefined) return state;
  // The host leaving ends the party rather than orphaning it: they own stopping it, and a party
  // playing on into an empty channel is worse than one that closes.
  if (userId === party.hostId) return closeParty(state, guildId);
  return replace(state, { ...party, members: party.members.filter((id) => id !== userId) });
}

export function enqueue(state: PartiesState, guildId: string, tracks: readonly PartyTrack[]): PartiesState {
  const party = state.parties[guildId];
  if (party === undefined) return state;
  return replace(state, { ...party, queue: [...party.queue, ...tracks] });
}

export function currentTrack(party: Party): PartyTrack | undefined {
  return party.queue[party.index];
}

/** Marks the current track as starting now -- the transition `/party start` and every advance make. */
export function markStarted(state: PartiesState, guildId: string, now: number): PartiesState {
  const party = state.parties[guildId];
  if (party === undefined) return state;
  return replace(state, { ...party, trackStartedAt: now });
}

export interface AdvanceResult {
  state: PartiesState;
  /** The track now playing, or undefined when the queue ran out (the party is left stopped). */
  track?: PartyTrack;
}

/**
 * Moves to the next track. Running off the end leaves the party OPEN but not playing, so the queue
 * can be topped up with `/party add` and started again -- ending it there would throw away the
 * membership over something as ordinary as the last song finishing.
 */
export function advance(state: PartiesState, guildId: string, now: number): AdvanceResult {
  const party = state.parties[guildId];
  if (party === undefined) return { state };
  const index = party.index + 1;
  const track = party.queue[index];
  if (track === undefined) {
    const { trackStartedAt: _stopped, ...stopped } = party;
    return { state: replace(state, { ...stopped, index: party.queue.length }) };
  }
  return { state: replace(state, { ...party, index, trackStartedAt: now }), track };
}

/** Where a member should be in the current track right now. */
export function expectedPositionMs(party: Party, now: number): number {
  if (party.trackStartedAt === undefined) return 0;
  return Math.max(0, now - party.trackStartedAt);
}

/**
 * How long until the current track ends. `undefined` when the party is not playing. Never negative
 * and never zero: a timer armed for 0 would fire inside the same tick that armed it and burn
 * through the queue, so an already-overdue track is advanced on the next event loop turn instead.
 */
export function msUntilAdvance(party: Party, now: number): number | undefined {
  const track = currentTrack(party);
  if (track === undefined || party.trackStartedAt === undefined) return undefined;
  return Math.max(1, party.trackStartedAt + track.durationMs - now);
}

export type SyncVerdict =
  | { action: "ok" }
  /** Their player is somewhere else, or too far out: send them the current track at the right spot. */
  | { action: "resync"; positionMs: number }
  /** They paused or closed Spotify. Left alone deliberately -- see below. */
  | { action: "paused" };

/**
 * What to do about one member's reported playback.
 *
 * A member who PAUSED is not corrected. The bot must never fight the person holding the phone: if
 * they wanted silence, restarting their music is the worst possible answer. They are marked paused
 * and picked up again at the next track boundary, which is a natural place to rejoin.
 *
 * A member on the wrong track, or more than `DRIFT_TOLERANCE_MS` out on the right one, is resynced
 * -- that is a real desync rather than a preference.
 */
export function decideSync(
  party: Party,
  playback: PlaybackState | undefined,
  now: number,
  toleranceMs: number = DRIFT_TOLERANCE_MS,
): SyncVerdict {
  const track = currentTrack(party);
  if (track === undefined || party.trackStartedAt === undefined) return { action: "ok" };
  const expected = expectedPositionMs(party, now);
  if (playback === undefined || !playback.isPlaying) return { action: "paused" };
  if (playback.trackUri !== track.uri) return { action: "resync", positionMs: expected };
  if (Math.abs(playback.progressMs - expected) > toleranceMs) return { action: "resync", positionMs: expected };
  return { action: "ok" };
}

// ---------------------------------------------------------------------------------------------------
// The live singleton
// ---------------------------------------------------------------------------------------------------
//
// Parties live in their OWN file, not in `music.json`. That file holds refresh tokens, and a party
// rewrites its state on every track; keeping volatile state out of the credentials file means the
// thing that would hurt to lose is written only when someone actually connects or disconnects.

let current: PartiesState = freshParties();
let writer: { save: (data: PartiesState) => Promise<void> } | undefined;

export function partiesState(): PartiesState {
  return current;
}

export async function commitParties(next: PartiesState): Promise<void> {
  current = next;
  if (writer) await writer.save(current);
}

export async function initParties(host: HostApi): Promise<void> {
  const path = `${host.dataDir}/parties.json`;
  current = await host.storage.readJsonOrFresh<PartiesState>(path, freshParties, "music:parties");
  if (typeof current.parties !== "object" || current.parties === null) current.parties = {};
  writer = host.storage.createJsonWriter<PartiesState>(path);
}

/** Test seam, mirroring `resetStoreForTest`. */
export function resetPartiesForTest(state: PartiesState, storage?: HostStorage, path?: string): void {
  current = state;
  writer = storage && path ? storage.createJsonWriter<PartiesState>(path) : undefined;
}
