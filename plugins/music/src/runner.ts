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
import type { TokenResult } from "./tokens.js";

/**
 * How many consecutive failures a member gets before the party stops calling their player. The count
 * starts fresh with every party and every Join (#234), so it normally spans one stint in one party.
 */
export const MAX_MEMBER_FAILURES = 2;

// The token lookup's real contract, re-exported for the tests' fakes: its failure `kind` is what
// decides below whether a refresh that failed is worth one more attempt.
export type { TokenResult };

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
  /**
   * True when the reason is one more attempt will not fix -- a missing scope, no Premium, a dead
   * grant, a member who disconnected. A refresh Spotify could not do right now is NOT one: it
   * counts like any other blip (#154).
   */
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
  /**
   * The host tick: re-arm anything that lost its timer, then check for drift. `signal` is the host's
   * own (its 30 s bound, or a shutdown): the sweep stops between steps once it fires, and its player
   * calls to Spotify (the playback read, play, devices, transfer) are cancelled with it (#147). The
   * token refresh is not: it is the single flight shared with commands, bounded at 10 s on its own,
   * and a rotated token it was about to store must not be lost.
   */
  sweep(signal?: AbortSignal): Promise<void>;
  /** Cancels every armed timer, and arms no new one afterwards. Called from `dispose()`. */
  stopAll(): void;
  /** Cancels one party's timer, for `/party stop`. */
  stop(guildId: string): void;
}

export function createPartyRunner(deps: RunnerDeps): PartyRunner {
  const timers = new Map<string, TimerHandle>();
  // Not persisted: a restart is a fine moment to give a member another chance, and the alternative
  // is carrying a grudge in the file that holds the party.
  const failures = new Map<string, number>();
  // Set by `stopAll` (dispose). A `start`, `skip` or timer-driven advance that was already awaiting
  // its plays when the plugin was disposed would otherwise arm a fresh timer afterwards (#147).
  let stopped = false;

  function failureKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
  }

  /** True once the host has aborted the sweep; says so once, with how many parties it left unchecked. */
  function sweepAborted(signal: AbortSignal | undefined, partiesLeft: number): boolean {
    if (signal?.aborted !== true) return false;
    deps.log.info(`party sweep aborted by the host; ${partiesLeft} parties left unchecked`);
    return true;
  }

  /** A party's counts start fresh: a strike taken in an earlier party must not follow a member (#234). */
  function forgetGuild(guildId: string): void {
    const prefix = `${guildId}:`;
    for (const key of [...failures.keys()]) {
      if (key.startsWith(prefix)) failures.delete(key);
    }
  }

  function arm(guildId: string): void {
    if (stopped) return;
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
  async function playFor(
    party: Party,
    discordUserId: string,
    positionMs: number,
    signal?: AbortSignal,
  ): Promise<MemberOutcome> {
    const track = currentTrack(party);
    if (track === undefined) return { discordUserId, ok: false, error: "there's nothing queued" };

    // Refreshed every time, with no cache beyond a refresh already in flight for this member
    // (tokens.ts shares one for the few hundred milliseconds it takes): a cached token would carry
    // cached SCOPES with it, so someone who had just reconnected to grant playback access would keep
    // being told to reconnect until the cache aged out -- the exact failure this feature exists to
    // avoid. A call landing inside an in-flight refresh can see scopes one refresh old; the next
    // call sees the new ones. It is one call, it runs in parallel with every other member's, and it
    // is nowhere near Spotify's limits.
    const token = await deps.accessTokenFor(discordUserId);
    if (!token.ok) {
      // A refresh Spotify could not do right now (unreachable, slow, 429, 5xx) is the same kind of
      // blip as a failed play call and gets the same two-strike treatment below; a dead grant or a
      // disconnect is something another attempt cannot fix, so those drop the member at once (#154).
      const outcome: MemberOutcome = { discordUserId, ok: false, error: token.error };
      if (token.kind !== "unavailable") outcome.fatal = true;
      return outcome;
    }

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

    const played = await deps.spotify.play(token.accessToken, track.uri, positionMs, undefined, signal);
    if (played.ok) return { discordUserId, ok: true };

    const problem = classifyPlayerError(played.status, played.error);
    if (problem === "no-device") {
      // One rescue attempt: if they have a player that is merely idle rather than gone, make it the
      // active one and try again. Anything else needs them to open Spotify themselves.
      const devices = await deps.spotify.devices(token.accessToken, signal);
      const target = devices.ok ? devices.value[0] : undefined;
      if (target !== undefined) {
        const moved = await deps.spotify.transfer(token.accessToken, target.id, signal);
        if (moved.ok) {
          const retry = await deps.spotify.play(token.accessToken, track.uri, positionMs, target.id, signal);
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

  /** Records a failure and drops the member once they have failed twice running (since the party started or their last Join). */
  async function noteOutcome(party: Party, outcome: MemberOutcome): Promise<void> {
    const key = failureKey(party.guildId, outcome.discordUserId);
    if (outcome.ok) {
      failures.delete(key);
      return;
    }
    const count = (failures.get(key) ?? 0) + 1;
    failures.set(key, count);
    const reason = outcome.error ?? "their Spotify stopped responding";
    if (!outcome.fatal && count < MAX_MEMBER_FAILURES) {
      // Not dropped yet, and a timer-driven boundary has nobody to reply to, so the log is the only
      // place a first strike shows up at all.
      deps.log.warn(`${outcome.discordUserId} in guild ${party.guildId} failed ${count} of ${MAX_MEMBER_FAILURES}: ${reason}`);
      return;
    }
    failures.delete(key);
    await commitParties(removeMember(partiesState(), party.guildId, outcome.discordUserId));
    // Some reasons are fragments (Premium, no player, a bare HTTP status), others full sentences
    // (the token lookup's, the two scope messages). One period either way.
    const stop = reason.endsWith(".") ? "" : ".";
    await deps.notify(party, `<@${outcome.discordUserId}> has dropped out of the party: ${reason}${stop}`);
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
      forgetGuild(guildId);
      await commitParties(markStarted(partiesState(), guildId, deps.now()));
      const outcomes = await playCurrent(guildId);
      arm(guildId);
      return outcomes;
    },

    async skip(guildId) {
      return advanceParty(guildId);
    },

    async syncMember(guildId, discordUserId) {
      // Pressing Join is a fresh start for that member, and Join is idempotent: an earlier strike
      // (from a previous stint in this party, or an earlier party) must not make this attempt their second.
      failures.delete(failureKey(guildId, discordUserId));
      const party = getParty(partiesState(), guildId);
      if (party === undefined) return { discordUserId, ok: false, error: "there's no party here" };
      if (party.trackStartedAt === undefined) return { discordUserId, ok: true };
      const outcome = await playFor(party, discordUserId, expectedPositionMs(party, deps.now()));
      await noteOutcome(party, outcome);
      return outcome;
    },

    async sweep(signal) {
      const parties = Object.values(partiesState().parties);
      for (const [index, party] of parties.entries()) {
        // The host's signal fires at its 30 s bound and on shutdown, and README.md asks a tick to
        // stop between steps once it does. This is the check before each party AND before its
        // per-member phase (nothing in between awaits), so an aborted sweep makes no Spotify or token
        // call at all. The count includes the party it stopped in.
        if (sweepAborted(signal, parties.length - index)) return;

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
        // most of that budget on its own. (`accessTokenFor` takes no signal, on purpose: see `sweep`'s
        // doc comment above. The playback read after it does.)
        const drifted = await Promise.all(
          party.members.map(async (discordUserId) => {
            const token = await deps.accessTokenFor(discordUserId);
            if (!token.ok || !hasScopes(token.scopes, PARTY_SCOPES)) return undefined;
            const state = await deps.spotify.playbackState(token.accessToken, signal);
            if (!state.ok) return undefined;
            const verdict = decideSync(party, state.value, deps.now());
            return verdict.action === "resync" ? { discordUserId, positionMs: verdict.positionMs } : undefined;
          }),
        );

        for (const entry of drifted) {
          if (entry === undefined) continue;

          // The host may have aborted during the checks above, or during the resync before this one.
          // A resync is a play (and possibly a devices read, a transfer and a retry), then a write if
          // the member is dropped; none of it starts after an abort was observed. This comes before
          // the re-read below so a host abort wins over everything else.
          if (sweepAborted(signal, parties.length - index)) return;

          // The checks above are network awaits and so is every resync below, and the track
          // boundary rides on its own timer: it can fire inside any of them and play everyone the
          // next track. `party` is the snapshot from before the awaits, so resyncing against it would
          // put a member back on the track that just ended. Re-read before EACH resync; if the party
          // moved (or closed) the verdicts still to act on are stale -- drop them, the next sweep
          // checks again. A boundary landing inside the one member's resync already in flight (its
          // token refresh and play call) still slips through: one stale resync, corrected by the
          // next sweep.
          const current = getParty(partiesState(), party.guildId);
          if (current === undefined || current.index !== party.index || current.trackStartedAt !== party.trackStartedAt) {
            deps.log.info(`party in guild ${party.guildId} moved during the sweep; skipping resync`);
            break;
          }

          deps.log.info(`resyncing ${entry.discordUserId} in guild ${party.guildId}`);
          const outcome = await playFor(party, entry.discordUserId, entry.positionMs, signal);
          // A failure once the host's signal has fired is as likely the abort's doing (the cancelled
          // call reads as "couldn't reach Spotify") as the member's: counting it would be a strike,
          // and perhaps a drop and a post, nobody earned. So no failure is noted after an abort,
          // including one the abort did not cause (a token problem found in this same resync); that
          // member is dealt with at the next track boundary, like any member the checks above skip.
          // The next sweep resyncs the rest again.
          if (!outcome.ok && sweepAborted(signal, parties.length - index)) return;
          await noteOutcome(party, outcome);
        }
      }
    },

    stopAll() {
      stopped = true;
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
