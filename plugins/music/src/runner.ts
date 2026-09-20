// Drives a party: plays the current track on every member's own Spotify, arms a timer for the end
// of it, and corrects drift on the host's tick. Every dependency is injected -- the Spotify client,
// the token lookup, the clock, the timer, the way a message reaches the channel -- so
// `runner.test.ts` runs a whole party through several tracks, a paused member and a dropped one,
// with no network, no Discord and no real time passing.
//
// Two host facts shape this file:
//
//   1. The host's tick is one shared 60-second loop that runs every plugin's checks SEQUENTIALLY,
//      and a tick that overruns makes the next one skip. So the tick here only decides and repairs;
//      the actual track-boundary work rides on this runner's own timers, and every Spotify call is
//      bounded by the client's own AbortSignal.timeout.
//   2. A plugin gets no way to post to an arbitrary channel -- `HostApi.announce` posts to the one
//      announce channel. So the party's own messages go through an injected `notify`, which the
//      plugin fills in from the `/party start` interaction's channel (the documented escape hatch).
//      It is best-effort by design: if it is unavailable, playback still works and the party simply
//      says less.

import {
  advance,
  commitParties,
  currentTrack,
  decideSync,
  expectedPositionMs,
  getParty,
  msUntilAdvance,
  partiesState,
  removeMember,
  markStarted,
  type Party,
} from "./party.js";
import { classifyPlayerError, hasScopes, PARTY_SCOPES, type SpotifyClient } from "./spotify.js";

/** How many consecutive failures a member gets before the party stops calling their player. */
export const MAX_MEMBER_FAILURES = 2;

export type TokenResult =
  | { ok: true; accessToken: string; scopes?: string }
  | { ok: false; error: string };

export interface TimerHandle {
  cancel(): void;
}

export interface RunnerDeps {
  spotify: SpotifyClient;
  /** Refreshes and returns a usable access token for one Discord user, or says why it cannot. */
  accessTokenFor(discordUserId: string): Promise<TokenResult>;
  now(): number;
  /** Defaults to setTimeout; tests pass a manual one so a party can be stepped through instantly. */
  schedule(ms: number, fn: () => void): TimerHandle;
  /** Best-effort message into the party's channel. Never throws -- see the header. */
  notify(party: Party, message: string): Promise<void>;
  log: { info(m: string): void; warn(m: string): void; error(m: string, err?: unknown): void };
}

export interface MemberOutcome {
  discordUserId: string;
  ok: boolean;
  /** Why it failed, already phrased for a person. */
  error?: string;
  /** True when the reason is one more attempt will not fix -- a missing scope, no Premium. */
  fatal?: boolean;
}

export interface PartyRunner {
  /** Plays the party's current track on every member, from `positionMs` (0 at a track boundary). */
  playCurrent(guildId: string): Promise<MemberOutcome[]>;
  /** Starts the party at its current track and keeps it going to the end of the queue. */
  start(guildId: string): Promise<MemberOutcome[]>;
  /** Moves to the next track now. The same transition a track ending naturally makes. */
  skip(guildId: string): Promise<MemberOutcome[]>;
  /** One member only -- used by Join, so someone arriving mid-track lands in the right place. */
  syncMember(guildId: string, discordUserId: string): Promise<MemberOutcome>;
  /** The host tick: re-arm anything that lost its timer, then check for drift. */
  sweep(): Promise<void>;
  /** Cancels every armed timer. Called from `dispose()`. */
  stopAll(): void;
  /** Cancels one party's timer, for `/party stop`. */
  stop(guildId: string): void;
}

export function createPartyRunner(deps: RunnerDeps): PartyRunner {
  const timers = new Map<string, TimerHandle>();
  // Not persisted: a restart is a fine moment to give a member another chance, and the alternative
  // is carrying a grudge in the file that holds the party.
  const failures = new Map<string, number>();

  function failureKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
  }

  function arm(guildId: string): void {
    timers.get(guildId)?.cancel();
    timers.delete(guildId);
    const party = getParty(partiesState(), guildId);
    if (party === undefined) return;
    const delay = msUntilAdvance(party, deps.now());
    if (delay === undefined) return;
    timers.set(
      guildId,
      deps.schedule(delay, () => {
        void advanceParty(guildId);
      }),
    );
  }

  async function advanceParty(guildId: string): Promise<MemberOutcome[]> {
    timers.get(guildId)?.cancel();
    timers.delete(guildId);
    const result = advance(partiesState(), guildId, deps.now());
    await commitParties(result.state);
    const party = getParty(partiesState(), guildId);
    if (party === undefined) return [];
    if (result.track === undefined) {
      await deps.notify(party, "That was the last track. The party is still open -- `/party add` something to start it again.");
      return [];
    }
    const outcomes = await playCurrent(guildId);
    arm(guildId);
    return outcomes;
  }

  /**
   * Plays one track on one member. Every failure path ends in something a person could act on:
   * a missing scope says reconnect, a free account says Premium, an idle Spotify says press play.
   */
  async function playFor(party: Party, discordUserId: string, positionMs: number): Promise<MemberOutcome> {
    const track = currentTrack(party);
    if (track === undefined) return { discordUserId, ok: false, error: "there's nothing queued" };

    // Refreshed every time, with no cache: a cached token would carry cached SCOPES with it, so
    // someone who had just reconnected to grant playback access would keep being told to reconnect
    // until the cache aged out -- the exact failure this feature exists to avoid. It is one call,
    // it runs in parallel with every other member's, and it is nowhere near Spotify's limits.
    const token = await deps.accessTokenFor(discordUserId);
    if (!token.ok) return { discordUserId, ok: false, error: token.error, fatal: true };

    // Checked BEFORE the call, not after a 403: a connection made before the party existed simply
    // does not carry the playback scopes, and "reconnect" is a far better answer than an HTTP code.
    if (!hasScopes(token.scopes, PARTY_SCOPES)) {
      return {
        discordUserId,
        ok: false,
        fatal: true,
        error:
          "Spotify needs one more permission before the bot can drive your player. " +
          "Run `/spotify connect` again to grant it.",
      };
    }

    const played = await deps.spotify.play(token.accessToken, track.uri, positionMs);
    if (played.ok) return { discordUserId, ok: true };

    const problem = classifyPlayerError(played.status, played.error);
    if (problem === "no-device") {
      // One rescue attempt: if they have a player that is merely idle rather than gone, make it the
      // active one and try again. Anything else needs them to open Spotify themselves.
      const devices = await deps.spotify.devices(token.accessToken);
      const target = devices.ok ? devices.value[0] : undefined;
      if (target !== undefined) {
        const moved = await deps.spotify.transfer(token.accessToken, target.id);
        if (moved.ok) {
          const retry = await deps.spotify.play(token.accessToken, track.uri, positionMs, target.id);
          if (retry.ok) return { discordUserId, ok: true };
        }
      }
      return {
        discordUserId,
        ok: false,
        error: "no Spotify player is awake -- open Spotify and press play on anything once, then rejoin",
      };
    }
    if (problem === "scope") {
      return {
        discordUserId,
        ok: false,
        fatal: true,
        error: "Spotify refused the command -- run `/spotify connect` again to re-grant playback access.",
      };
    }
    if (problem === "premium") {
      return { discordUserId, ok: false, fatal: true, error: "Spotify Premium is required to control playback" };
    }
    return { discordUserId, ok: false, error: played.error };
  }

  /** Records a failure and drops the member once they have failed twice running. */
  async function noteOutcome(party: Party, outcome: MemberOutcome): Promise<void> {
    const key = failureKey(party.guildId, outcome.discordUserId);
    if (outcome.ok) {
      failures.delete(key);
      return;
    }
    const count = (failures.get(key) ?? 0) + 1;
    failures.set(key, count);
    if (!outcome.fatal && count < MAX_MEMBER_FAILURES) return;
    failures.delete(key);
    await commitParties(removeMember(partiesState(), party.guildId, outcome.discordUserId));
    await deps.notify(
      party,
      `<@${outcome.discordUserId}> has dropped out of the party: ${outcome.error ?? "their Spotify stopped responding"}.`,
    );
  }

  async function playCurrent(guildId: string): Promise<MemberOutcome[]> {
    const party = getParty(partiesState(), guildId);
    if (party === undefined) return [];
    const positionMs = expectedPositionMs(party, deps.now());
    // In parallel on purpose: sequential calls would stack their round trips into an audible gap
    // between the first member and the last.
    const outcomes = await Promise.all(party.members.map((id) => playFor(party, id, positionMs)));
    for (const outcome of outcomes) await noteOutcome(party, outcome);
    return outcomes;
  }

  return {
    playCurrent,

    async start(guildId) {
      await commitParties(markStarted(partiesState(), guildId, deps.now()));
      const outcomes = await playCurrent(guildId);
      arm(guildId);
      return outcomes;
    },

    async skip(guildId) {
      return advanceParty(guildId);
    },

    async syncMember(guildId, discordUserId) {
      const party = getParty(partiesState(), guildId);
      if (party === undefined) return { discordUserId, ok: false, error: "there's no party here" };
      if (party.trackStartedAt === undefined) return { discordUserId, ok: true };
      const outcome = await playFor(party, discordUserId, expectedPositionMs(party, deps.now()));
      await noteOutcome(party, outcome);
      return outcome;
    },

    async sweep() {
      for (const party of Object.values(partiesState().parties)) {
        if (party.trackStartedAt === undefined) continue;

        // A timer is lost whenever the process restarts mid-party. Re-arming here is what makes a
        // party survive a self-update instead of stalling on whatever track it was on.
        if (!timers.has(party.guildId)) {
          const overdue = msUntilAdvance(party, deps.now());
          if (overdue === undefined) continue;
          deps.log.info(`re-arming party in guild ${party.guildId}`);
          arm(party.guildId);
        }

        // In parallel, and deliberately: this runs inside the host's ONE shared 60-second tick,
        // which executes every plugin's checks in sequence and skips the next tick if this one
        // overruns. Five members checked one after another, each bounded at ten seconds, could eat
        // most of that budget on its own.
        const drifted = await Promise.all(
          party.members.map(async (discordUserId) => {
            const token = await deps.accessTokenFor(discordUserId);
            if (!token.ok || !hasScopes(token.scopes, PARTY_SCOPES)) return undefined;
            const state = await deps.spotify.playbackState(token.accessToken);
            if (!state.ok) return undefined;
            const verdict = decideSync(party, state.value, deps.now());
            return verdict.action === "resync" ? { discordUserId, positionMs: verdict.positionMs } : undefined;
          }),
        );

        for (const entry of drifted) {
          if (entry === undefined) continue;
          deps.log.info(`resyncing ${entry.discordUserId} in guild ${party.guildId}`);
          const outcome = await playFor(party, entry.discordUserId, entry.positionMs);
          await noteOutcome(party, outcome);
        }
      }
    },

    stopAll() {
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
    },

    stop(guildId) {
      timers.get(guildId)?.cancel();
      timers.delete(guildId);
    },
  };
}

/** The production timer. Kept here so `createPartyRunner`'s callers don't each re-wrap setTimeout. */
export function realScheduler(ms: number, fn: () => void): TimerHandle {
  const handle = setTimeout(fn, ms);
  return {
    cancel() {
      clearTimeout(handle);
    },
  };
}
