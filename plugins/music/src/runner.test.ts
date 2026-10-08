import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createPartyRunner,
  MAX_MEMBER_FAILURES,
  type PartyRunner,
  type RunnerDeps,
  type TimerHandle,
  type TokenResult,
} from "./runner.js";
import {
  addMember,
  closeParty,
  commitParties,
  enqueue,
  freshParties,
  getParty,
  markStarted,
  openParty,
  partiesState,
  removeMember,
  resetPartiesForTest,
  type Party,
} from "./party.js";
import { PARTY_SCOPES, SPOTIFY_SCOPES, type SpotifyClient } from "./spotify.js";
import { makeRealStorage } from "../../../packages/testkit/index.js";

const NOW = 1_700_000_000_000;
const TRACK_MS = 180_000;

interface PlayCall {
  accessToken: string;
  uri: string;
  positionMs: number;
  deviceId?: string;
}

/** A manual clock and timer, so a whole party runs through several tracks in no real time at all. */
function fakeClock(start = NOW) {
  let now = start;
  const pending: { at: number; fn: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    schedule(ms: number, fn: () => void): TimerHandle {
      const entry = { at: now + ms, fn, cancelled: false };
      pending.push(entry);
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
    },
    /** Moves time forward and fires whatever was due, oldest first. */
    async advanceTo(target: number): Promise<void> {
      now = target;
      for (const entry of [...pending].sort((a, b) => a.at - b.at)) {
        if (entry.cancelled || entry.at > target) continue;
        entry.cancelled = true;
        entry.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    pendingCount: () => pending.filter((e) => !e.cancelled).length,
  };
}

function fakeSpotify(overrides: Partial<SpotifyClient> = {}): { client: SpotifyClient; plays: PlayCall[] } {
  const plays: PlayCall[] = [];
  const client: SpotifyClient = {
    exchangeCode: async () => ({ ok: false, error: "not used" }),
    refresh: async () => ({ ok: false, error: "not used" }),
    searchTracks: async () => ({ ok: true, value: [] }),
    createPlaylist: async () => ({ ok: false, error: "not used" }),
    addTracks: async () => ({ ok: false, error: "not used" }),
    play: async (accessToken, uri, positionMs, deviceId) => {
      const call: PlayCall = { accessToken, uri, positionMs };
      if (deviceId !== undefined) call.deviceId = deviceId;
      plays.push(call);
      return { ok: true, value: undefined };
    },
    playbackState: async () => ({ ok: true, value: undefined }),
    devices: async () => ({ ok: true, value: [] }),
    transfer: async () => ({ ok: true, value: undefined }),
    ...overrides,
  };
  return { client, plays };
}

function party(overrides: Partial<Party> = {}): Party {
  return {
    guildId: "G1",
    channelId: "C1",
    hostId: "host",
    members: ["host", "friend"],
    queue: [
      { uri: "spotify:track:one", name: "One", artist: "Band", durationMs: TRACK_MS },
      { uri: "spotify:track:two", name: "Two", artist: "Band", durationMs: TRACK_MS },
    ],
    index: 0,
    // Playing by default: most of these tests are about what happens to a member DURING a track.
    trackStartedAt: NOW,
    ...overrides,
  };
}

function makeRunner(
  spotify: SpotifyClient,
  clock: ReturnType<typeof fakeClock>,
  token: (id: string) => TokenResult = () => ({ ok: true, accessToken: "AT", scopes: PARTY_SCOPES }),
  /** Replaces the recording `notify`, e.g. with one that rejects. */
  notifyOverride?: RunnerDeps["notify"],
) {
  const notices: string[] = [];
  // The third `notify` argument, index-aligned with `notices`: who a message may ping, or undefined.
  const mentions: (string | undefined)[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  const errorCauses: unknown[] = [];
  const deps: RunnerDeps = {
    spotify,
    accessTokenFor: async (id) => token(id),
    now: clock.now,
    schedule: clock.schedule,
    notify:
      notifyOverride ??
      (async (_party, message, mention) => {
        notices.push(message);
        mentions.push(mention);
      }),
    log: {
      info(m) {
        infos.push(m);
      },
      warn(m) {
        warnings.push(m);
      },
      error(m, err) {
        errors.push(m);
        errorCauses.push(err);
      },
    },
  };
  return { runner: createPartyRunner(deps), notices, mentions, warnings, infos, errors, errorCauses };
}

// What `accessTokenFor` answers, by `kind`. The texts are copied from tokens.ts, whose own tests pin
// the substrings a person acts on; the runner only cares about `kind` and the trailing period.
const GOOD: TokenResult = { ok: true, accessToken: "AT", scopes: PARTY_SCOPES };
const UNAVAILABLE: TokenResult = {
  ok: false,
  kind: "unavailable",
  error:
    "Spotify couldn't refresh your connection right now (Spotify returned HTTP 503). " +
    "Your link is still saved -- try again in a moment, and if it keeps failing, run `/spotify connect` again.",
};
const REVOKED: TokenResult = {
  ok: false,
  kind: "revoked",
  error:
    "Your Spotify connection is no longer valid (Spotify returned HTTP 400: Refresh token revoked). " +
    "Run `/spotify connect` to reconnect.",
};
const NOT_CONNECTED: TokenResult = {
  ok: false,
  kind: "not-connected",
  error: "You haven't connected Spotify yet -- run `/spotify connect` first.",
};

/**
 * Answers `GOOD` for everyone but `id`, who gets `answers` in order and the last one thereafter (an
 * empty list means `GOOD` throughout).
 */
function tokenSequence(id: string, answers: TokenResult[]): (userId: string) => TokenResult {
  let calls = 0;
  return (userId) => {
    if (userId !== id) return GOOD;
    const answer = answers[Math.min(calls, answers.length - 1)] ?? GOOD;
    calls += 1;
    return answer;
  };
}

beforeEach(() => {
  resetPartiesForTest(openParty(freshParties(), party()));
});

describe("playing a party", () => {
  test("start plays the current track to every member at the same position", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock);

    const outcomes = await runner.start("G1");

    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(plays).toHaveLength(2);
    expect(plays.every((p) => p.uri === "spotify:track:one" && p.positionMs === 0)).toBe(true);
    runner.stopAll();
  });

  test("the timer advances the party at the end of the track, without a tick", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock);

    await runner.start("G1");
    await clock.advanceTo(NOW + TRACK_MS);

    expect(getParty(partiesState(), "G1")?.index).toBe(1);
    expect(plays.slice(2).every((p) => p.uri === "spotify:track:two")).toBe(true);
    runner.stopAll();
  });

  test("the queue running out leaves the party open and says so once", async () => {
    resetPartiesForTest(openParty(freshParties(), party({ index: 1 })));
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices, mentions } = makeRunner(client, clock);

    await runner.start("G1");
    await clock.advanceTo(NOW + TRACK_MS);

    expect(getParty(partiesState(), "G1")).toBeDefined();
    expect(getParty(partiesState(), "G1")?.trackStartedAt).toBeUndefined();
    expect(notices.join(" ")).toContain("last track");
    // About no one in particular, so it may ping no one.
    expect(mentions).toEqual([undefined]);
    runner.stopAll();
  });

  test("someone joining mid-track is dropped in at the right position, not at 0:00", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock);

    await runner.start("G1");
    plays.length = 0;
    await clock.advanceTo(NOW + 42_000);
    const outcome = await runner.syncMember("G1", "latecomer");

    expect(outcome.ok).toBe(true);
    expect(plays).toEqual([{ accessToken: "AT", uri: "spotify:track:one", positionMs: 42_000 }]);
    runner.stopAll();
  });

  test("skip is the same transition as a track ending", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock);

    await runner.start("G1");
    plays.length = 0;
    await runner.skip("G1", 0);

    expect(getParty(partiesState(), "G1")?.index).toBe(1);
    expect(plays.every((p) => p.uri === "spotify:track:two")).toBe(true);
    runner.stopAll();
  });
});

// #152 (C): a skip, or a boundary, moves the party on from the track it was meant for and no other.
describe("a skip or a boundary from a track the party has left", () => {
  test("a skip from an index the party has left is refused and changes nothing", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner, infos } = makeRunner(client, clock);

    await runner.start("G1");
    await runner.skip("G1", 0);
    const playsAfterTheWinner = plays.length;
    // The advance that won armed a timer for the track it moved to.
    expect(clock.pendingCount()).toBe(1);

    const refused = await runner.skip("G1", 0);

    expect(refused).toBeUndefined();
    expect(plays).toHaveLength(playsAfterTheWinner);
    expect(getParty(partiesState(), "G1")?.index).toBe(1);
    // The refusal left the winner's timer alone: still pending, and still the one the runner knows of
    // (a sweep finds nothing to re-arm).
    expect(clock.pendingCount()).toBe(1);
    await runner.sweep();
    expect(infos).not.toContain("re-arming party in guild G1");
    expect(clock.pendingCount()).toBe(1);
    runner.stopAll();
  });

  test("two skips for the same track advance once", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock);

    await runner.start("G1");
    plays.length = 0;
    const results = await Promise.all([runner.skip("G1", 0), runner.skip("G1", 0)]);

    // One of them moved the party on; the other was refused.
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    expect(getParty(partiesState(), "G1")?.index).toBe(1);
    // One play of track two per member, and nothing else.
    expect(plays.map((p) => p.uri)).toEqual(["spotify:track:two", "spotify:track:two"]);
    runner.stopAll();
  });

  test("a skip during a boundary advances once", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock);

    await runner.start("G1");
    plays.length = 0;
    // The timer fires and starts moving the party; the skip arrives while it is still playing.
    const boundary = clock.advanceTo(NOW + TRACK_MS);
    const skipped = await runner.skip("G1", 0);
    await boundary;

    // The boundary got there first, so the skip meant for track one was refused.
    expect(skipped).toBeUndefined();
    expect(getParty(partiesState(), "G1")?.index).toBe(1);
    expect(plays.map((p) => p.uri)).toEqual(["spotify:track:two", "spotify:track:two"]);
    runner.stopAll();
  });

  test("a skip from an index the party has not reached is refused too", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock);

    await runner.start("G1");
    plays.length = 0;
    // The index is ahead of the party's own, so it was not decided against this party.
    const refused = await runner.skip("G1", 1);

    expect(refused).toBeUndefined();
    expect(plays).toEqual([]);
    expect(getParty(partiesState(), "G1")?.index).toBe(0);
    runner.stopAll();
  });

  test("a skip or a boundary for a party that is gone does nothing", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices, errors } = makeRunner(client, clock);

    await runner.start("G1");
    plays.length = 0;
    resetPartiesForTest(freshParties());
    await clock.advanceTo(NOW + TRACK_MS);

    expect(await runner.skip("G1", 0)).toBeUndefined();
    expect(plays).toEqual([]);
    expect(notices).toEqual([]);
    expect(errors).toEqual([]);
    runner.stopAll();
  });

  test("a refused boundary leaves no stale timer handle behind, so the sweep re-arms the party", async () => {
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner, infos } = makeRunner(client, clock);

    await runner.start("G1");
    // The party moves under the runner and is playing its second track; the timer armed for the first
    // fires and is refused.
    resetPartiesForTest(openParty(freshParties(), party({ index: 1, trackStartedAt: NOW })));
    await clock.advanceTo(NOW + TRACK_MS);
    expect(clock.pendingCount()).toBe(0);

    await runner.sweep();

    // Left in the map, the fired handle would pass for a live timer and the sweep would leave it be.
    expect(infos).toContain("re-arming party in guild G1");
    expect(clock.pendingCount()).toBe(1);
    runner.stopAll();
  });

  test("a boundary armed for a track the party has left does nothing", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices } = makeRunner(client, clock);

    await runner.start("G1");
    plays.length = 0;
    // The party moves under the runner, not through it: it is on the second track now, and the timer
    // armed for the first is still pending.
    resetPartiesForTest(openParty(freshParties(), party({ index: 1, trackStartedAt: NOW })));
    await clock.advanceTo(NOW + TRACK_MS);

    expect(plays).toEqual([]);
    // An unguarded advance from index 1 would run the two-track fixture off the end.
    expect(notices).toEqual([]);
    expect(getParty(partiesState(), "G1")?.index).toBe(1);
    expect(getParty(partiesState(), "G1")?.trackStartedAt).toBe(NOW);
    runner.stopAll();
  });
});

describe("members who can't play", () => {
  test("a connection without the playback scopes is told to reconnect, before any call is made", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices } = makeRunner(client, clock, (id) =>
      id === "friend"
        ? { ok: true, accessToken: "AT", scopes: SPOTIFY_SCOPES }
        : { ok: true, accessToken: "AT", scopes: PARTY_SCOPES },
    );

    const outcomes = await runner.start("G1");

    const friend = outcomes.find((o) => o.discordUserId === "friend");
    expect(friend?.ok).toBe(false);
    expect(friend?.error).toContain("/spotify connect");
    // The point of checking first: no 403 was ever provoked.
    expect(plays).toHaveLength(1);
    // This reason is a full sentence, and the drop-out line gives it no second period.
    expect(notices[0]?.endsWith("to grant it.")).toBe(true);
    runner.stopAll();
  });

  test("an idle device is woken by a transfer and retried, rather than losing the member", async () => {
    let firstPlay = true;
    const { client, plays } = fakeSpotify({
      play: async (accessToken, uri, positionMs, deviceId) => {
        if (firstPlay) {
          firstPlay = false;
          return { ok: false, error: "Player command failed: No active device found", status: 404 };
        }
        const call: PlayCall = { accessToken, uri, positionMs };
        if (deviceId !== undefined) call.deviceId = deviceId;
        plays.push(call);
        return { ok: true, value: undefined };
      },
      devices: async () => ({ ok: true, value: [{ id: "DEV1", name: "Phone", isActive: false }] }),
    });
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock);

    const outcome = await runner.syncMember("G1", "host");

    expect(outcome.ok).toBe(true);
    expect(plays.at(-1)?.deviceId).toBe("DEV1");
    runner.stopAll();
  });

  test("no device at all produces something the person can act on", async () => {
    const { client } = fakeSpotify({
      play: async () => ({ ok: false, error: "Player command failed: No active device found", status: 404 }),
      devices: async () => ({ ok: true, value: [] }),
    });
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock);

    const outcome = await runner.syncMember("G1", "host");

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("open Spotify");
    runner.stopAll();
  });

  test("a free account is dropped at once -- retrying a Premium wall never helps", async () => {
    const { client } = fakeSpotify({
      play: async () => ({ ok: false, error: "Player command failed: Premium required", status: 403 }),
    });
    const clock = fakeClock();
    const { runner, notices, mentions } = makeRunner(client, clock);

    await runner.syncMember("G1", "friend");

    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
    expect(notices.join(" ")).toContain("Premium");
    // A fragment reason gets its one period from the runner.
    expect(notices[0]?.endsWith("control playback.")).toBe(true);
    // The drop-out line can carry Spotify's own text, so only the member it is about may be pinged.
    expect(mentions).toEqual(["friend"]);
    runner.stopAll();
  });

  test("a transient failure costs a member their place only on the SECOND one", async () => {
    const { client } = fakeSpotify({
      // A fragment with a period INSIDE it: the drop-out line must still get its own at the end.
      play: async () => ({ ok: false, error: "Spotify returned HTTP 502: Bad gateway. Try later", status: 502 }),
    });
    const clock = fakeClock();
    const { runner, notices, warnings } = makeRunner(client, clock);

    await runner.syncMember("G1", "friend");
    expect(getParty(partiesState(), "G1")?.members).toContain("friend");
    // The first strike is visible in the log, since nothing else records it.
    expect(warnings).toEqual([`friend in guild G1 failed 1 of ${MAX_MEMBER_FAILURES}: Spotify returned HTTP 502: Bad gateway. Try later`]);

    // The second strike has to come from the party, not from another Join: a Join is a fresh start
    // for that member (#234), so a second syncMember would be a first strike again.
    await runner.skip("G1", 0);
    expect(getParty(partiesState(), "G1")?.members).not.toContain("friend");
    expect(notices[0]?.endsWith("Try later.")).toBe(true);
    runner.stopAll();
  });
});

describe("a refresh Spotify couldn't do right now", () => {
  test("costs a member their place only on the SECOND one, like any other blip", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices, mentions, warnings } = makeRunner(client, clock, tokenSequence("friend", [UNAVAILABLE]));

    await runner.start("G1");
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);
    expect(plays).toHaveLength(1);
    expect(notices).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`friend in guild G1 failed 1 of ${MAX_MEMBER_FAILURES}`);

    await runner.skip("G1", 0);
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
    expect(notices).toHaveLength(1);
    expect(mentions).toEqual(["friend"]);
    expect(notices[0]).toContain("<@friend> has dropped out");
    expect(notices[0]).toContain("still saved");
    expect(notices[0]?.endsWith("again.")).toBe(true);
    expect(notices[0]).not.toContain("..");
    runner.stopAll();
  });

  test("on Join leaves the joiner in place and hands them the token's text", async () => {
    resetPartiesForTest(openParty(freshParties(), party({ members: ["host", "friend", "latecomer"] })));
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices } = makeRunner(client, clock, tokenSequence("latecomer", [UNAVAILABLE]));

    const outcome = await runner.syncMember("G1", "latecomer");
    expect(outcome.ok).toBe(false);
    expect(outcome.fatal).toBeUndefined();
    expect(outcome.error).toContain("still saved");
    expect(getParty(partiesState(), "G1")?.members).toContain("latecomer");
    expect(notices).toEqual([]);
    runner.stopAll();
  });

  test("in the sweep's resync counts one strike, not a drop", async () => {
    const { client, plays } = fakeSpotify({
      playbackState: async () => ({ ok: true, value: { isPlaying: true, progressMs: 0, trackUri: "spotify:track:one" } }),
    });
    const clock = fakeClock();
    // The sweep's own refresh succeeds and sees the drift; the resync's refresh is the one that fails.
    const { runner, notices, warnings } = makeRunner(client, clock, tokenSequence("friend", [GOOD, UNAVAILABLE]));

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep();

    expect(plays).toHaveLength(1);
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);
    expect(notices).toEqual([]);
    expect(warnings).toHaveLength(1);
    runner.stopAll();
  });

  test("does not close the party when it is the host's refresh that hit it", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices } = makeRunner(client, clock, tokenSequence("host", [UNAVAILABLE, GOOD]));

    await runner.start("G1");
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);
    expect(plays).toHaveLength(1);
    expect(notices).toEqual([]);

    await runner.skip("G1", 0);
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);
    expect(plays).toHaveLength(3);
    runner.stopAll();
  });

  test("is forgotten once the next boundary plays fine", async () => {
    const three = { uri: "spotify:track:three", name: "Three", artist: "Band", durationMs: TRACK_MS };
    resetPartiesForTest(openParty(freshParties(), party({ queue: [...party().queue, three] })));
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock, tokenSequence("friend", [UNAVAILABLE, GOOD, UNAVAILABLE]));

    await runner.start("G1");
    await runner.skip("G1", 0);
    await runner.skip("G1", 1);
    expect(getParty(partiesState(), "G1")?.index).toBe(2);
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);
    runner.stopAll();
  });

  test("a dead grant still drops the member at once, and the line ends in one period", async () => {
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices } = makeRunner(client, clock, tokenSequence("friend", [REVOKED]));

    await runner.start("G1");
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("no longer valid");
    expect(notices[0]?.endsWith("to reconnect.")).toBe(true);
    expect(notices[0]).not.toContain("..");
    runner.stopAll();
  });

  test("a member who disconnected mid-party is dropped at once", async () => {
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices } = makeRunner(client, clock, tokenSequence("friend", [NOT_CONNECTED]));

    await runner.start("G1");
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
    expect(notices.join(" ")).toContain("/spotify connect");
    expect(notices[0]?.endsWith("first.")).toBe(true);
    runner.stopAll();
  });
});

describe("a host who drops (#194)", () => {
  test("a host dropped at a boundary ends the party, and the notice says so", async () => {
    const { client } = fakeSpotify();
    const clock = fakeClock();
    // Fine for the start; the grant is dead by the first boundary.
    const { runner, notices, mentions } = makeRunner(client, clock, tokenSequence("host", [GOOD, REVOKED]));

    await runner.start("G1");
    expect(clock.pendingCount()).toBe(1);
    await clock.advanceTo(NOW + TRACK_MS);
    // The boundary's plays, the drop and the notice are several awaits past what `advanceTo` waits for.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getParty(partiesState(), "G1")).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("<@host> has dropped out of the party");
    expect(notices[0]).toContain("The party has ended");
    expect(notices[0]).toContain("`/party start` opens a new one.");
    // Still only the host is pinged (#190).
    expect(mentions).toEqual(["host"]);
    expect(clock.pendingCount()).toBe(0);
    runner.stopAll();
  });

  test("a host dropped by the sweep's resync ends the party and cancels its timer", async () => {
    // Both members report track one at 0:00, so both are drifted by the time the sweep looks.
    const { client } = fakeSpotify({
      playbackState: async () => ({ ok: true, value: { isPlaying: true, progressMs: 0, trackUri: "spotify:track:one" } }),
    });
    const clock = fakeClock();
    // Fine for the sweep's own playback check; dead when the resync asks for a token again.
    const { runner, notices, mentions } = makeRunner(client, clock, tokenSequence("host", [GOOD, REVOKED]));

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep();

    expect(getParty(partiesState(), "G1")).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("<@host> has dropped out of the party");
    expect(notices[0]).toContain("The party has ended");
    expect(mentions).toEqual(["host"]);
    // The sweep armed the party's timer before it resynced; the party it was for is gone.
    expect(clock.pendingCount()).toBe(0);
    runner.stopAll();
  });

  test("a fragment reason keeps its one period, and the other members' failures after the host's are not reported", async () => {
    // Everyone's play is refused for Premium, a fragment ("... to control playback") with no period of
    // its own. The host comes first in the list, so its drop closes the party before the friend's
    // failure is noted: the channel reads one notice, not a "dropped out" line after "ended".
    const { client } = fakeSpotify({
      play: async () => ({ ok: false, error: "Player command failed: Premium required", status: 403 }),
    });
    const clock = fakeClock();
    const { runner, notices } = makeRunner(client, clock);

    await runner.start("G1");

    expect(getParty(partiesState(), "G1")).toBeUndefined();
    expect(notices).toEqual([
      "<@host> has dropped out of the party: Spotify Premium is required to control playback. " +
        "The party has ended -- `/party start` opens a new one.",
    ]);
    expect(clock.pendingCount()).toBe(0);
    runner.stopAll();
  });

  test("a host drop is judged against the party as it is now, not the one the plays were for", async () => {
    // While the host's play is in flight the party is stopped and another party, under another host,
    // is started in the same guild. The old host's failure is no reason to say THAT party ended.
    let swapped = false;
    const { client } = fakeSpotify({
      play: async () => {
        if (!swapped) {
          swapped = true;
          await commitParties(
            openParty(closeParty(partiesState(), "G1"), party({ hostId: "other", members: ["other", "host"] })),
          );
        }
        return { ok: false, error: "Player command failed: Premium required", status: 403 };
      },
    });
    const clock = fakeClock();
    const { runner, notices } = makeRunner(client, clock);

    await runner.start("G1");

    expect(getParty(partiesState(), "G1")?.hostId).toBe("other");
    expect(notices.length).toBeGreaterThan(0);
    for (const notice of notices) expect(notice).not.toContain("The party has ended");
    runner.stopAll();
  });

  test("a member dropped by the sweep's resync leaves the party's timer armed", async () => {
    // The sweep arms the party's timer, then resyncs both drifted members; the friend's grant is dead
    // by the resync. Only a HOST drop takes the timer with it.
    const { client } = fakeSpotify({
      playbackState: async () => ({ ok: true, value: { isPlaying: true, progressMs: 0, trackUri: "spotify:track:one" } }),
    });
    const clock = fakeClock();
    const { runner, notices } = makeRunner(client, clock, tokenSequence("friend", [GOOD, REVOKED]));

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep();

    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("<@friend> has dropped out of the party");
    expect(notices[0]).not.toContain("The party has ended");
    expect(clock.pendingCount()).toBe(1);
    runner.stopAll();
  });

  test("a member who is not the host drops without ending anything", async () => {
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices } = makeRunner(client, clock, tokenSequence("friend", [REVOKED]));

    await runner.start("G1");

    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("<@friend> has dropped out of the party");
    expect(notices[0]).not.toContain("The party has ended");
    // The party plays on: its timer is still armed.
    expect(clock.pendingCount()).toBe(1);
    runner.stopAll();
  });
});

describe("failures across a boundary, stop and the no-device rescue (#195)", () => {
  /** Settles what a fired timer leaves behind: `advanceTo` only waits two ticks, a boundary takes many. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * A token per member (so a play names who it was for). The friend's answers come from `answers` in
   * order, the last one repeating; everyone else is always fine.
   */
  function perMemberToken(answers: TokenResult[]): (id: string) => TokenResult {
    let calls = 0;
    return (id) => {
      if (id !== "friend") return { ok: true, accessToken: id, scopes: PARTY_SCOPES };
      const answer = answers[Math.min(calls, answers.length - 1)] ?? GOOD;
      calls += 1;
      return answer;
    };
  }
  const FRIEND_FINE: TokenResult = { ok: true, accessToken: "friend", scopes: PARTY_SCOPES };

  test("a dead grant at a boundary drops the member at once", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices, warnings } = makeRunner(client, clock, perMemberToken([FRIEND_FINE, REVOKED]));

    await runner.start("G1");
    expect(plays.map((p) => p.accessToken).sort()).toEqual(["friend", "host"]);
    plays.length = 0;

    await clock.advanceTo(NOW + TRACK_MS);
    await settle();

    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
    // Dropped, not counted: a revoked grant is not a blip, so there is no "1 of 2" warning first.
    expect(warnings).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("<@friend> has dropped out of the party");
    // Track two went to the host alone.
    expect(plays).toEqual([{ accessToken: "host", uri: "spotify:track:two", positionMs: 0 }]);
    runner.stopAll();
  });

  test("two transient failures across a boundary are the second strike", async () => {
    const { client } = fakeSpotify({
      play: async (accessToken) =>
        accessToken === "friend"
          ? { ok: false, error: "Spotify returned HTTP 502: Bad gateway", status: 502 }
          : { ok: true, value: undefined },
    });
    const clock = fakeClock();
    const { runner, notices, warnings } = makeRunner(client, clock, (id) => ({
      ok: true,
      accessToken: id,
      scopes: PARTY_SCOPES,
    }));

    await runner.start("G1");
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);
    expect(warnings).toEqual([
      `friend in guild G1 failed 1 of ${MAX_MEMBER_FAILURES}: Spotify returned HTTP 502: Bad gateway`,
    ]);
    expect(notices).toEqual([]);

    await clock.advanceTo(NOW + TRACK_MS);
    await settle();

    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("<@friend> has dropped out of the party");
    expect(notices[0]).toContain("Bad gateway");
    runner.stopAll();
  });

  test("stop cancels an armed timer", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock);

    await runner.start("G1");
    expect(clock.pendingCount()).toBe(1);
    const playsAtStart = plays.length;

    runner.stop("G1");
    expect(clock.pendingCount()).toBe(0);
    await clock.advanceTo(NOW + TRACK_MS);
    await settle();

    expect(plays).toHaveLength(playsAtStart);
    expect(getParty(partiesState(), "G1")?.index).toBe(0);
    runner.stopAll();
  });

  test("stop cancels only the named guild's timer", async () => {
    resetPartiesForTest(
      openParty(
        openParty(freshParties(), party()),
        party({ guildId: "G2", channelId: "C2", hostId: "host2", members: ["host2"] }),
      ),
    );
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock);

    await runner.start("G1");
    await runner.start("G2");
    expect(clock.pendingCount()).toBe(2);

    runner.stop("G1");

    // G2's party plays on.
    expect(clock.pendingCount()).toBe(1);
    runner.stopAll();
  });

  test("a notify that rejects does not take the boundary down", async () => {
    // `notify` promises never to throw (notify.ts), so a rejecting one is a fault the runner must
    // survive: the boundary's own catch logs it with its cause and re-arms the party.
    const boom = new Error("channel gone");
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner, errors, errorCauses } = makeRunner(
      client,
      clock,
      perMemberToken([FRIEND_FINE, REVOKED]),
      async () => {
        throw boom;
      },
    );

    await runner.start("G1");
    await clock.advanceTo(NOW + TRACK_MS);
    await settle();

    // The drop was committed before the notice was tried.
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
    expect(errors).toEqual(["party in guild G1: advancing to the next track failed; re-arming"]);
    expect(errorCauses).toEqual([boom]);
    // And the party is armed for its next boundary.
    expect(clock.pendingCount()).toBe(1);
    runner.stopAll();
  });

  describe("the no-device rescue's own failures end in the awake-your-player outcome", () => {
    const NO_DEVICE = { ok: false, error: "Player command failed: No active device found", status: 404 } as const;

    /** A host whose `play` always answers 404, recording which device each attempt named. */
    async function rescueOutcome(overrides: Partial<SpotifyClient>) {
      const attempts: string[] = [];
      const { client } = fakeSpotify({
        play: async (_accessToken, _uri, _positionMs, deviceId) => {
          attempts.push(deviceId ?? "active");
          return NO_DEVICE;
        },
        ...overrides,
      });
      const { runner } = makeRunner(client, fakeClock());
      const outcome = await runner.syncMember("G1", "host");
      runner.stopAll();
      return { outcome, attempts };
    }

    test("a devices read that fails", async () => {
      const { outcome, attempts } = await rescueOutcome({
        devices: async () => ({ ok: false, error: "Spotify returned HTTP 500" }),
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("no Spotify player is awake");
      // An idle player is a blip, not a verdict: it must not drop the member on the first miss.
      expect(outcome.fatal).toBeUndefined();
      expect(attempts).toEqual(["active"]);
    });

    test("a transfer that fails", async () => {
      const { outcome, attempts } = await rescueOutcome({
        devices: async () => ({ ok: true, value: [{ id: "DEV1", name: "Phone", isActive: false }] }),
        transfer: async () => ({ ok: false, error: "Spotify returned HTTP 502" }),
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("no Spotify player is awake");
      expect(outcome.fatal).toBeUndefined();
      // No retry once the transfer failed.
      expect(attempts).toEqual(["active"]);
    });

    test("a retried play that fails", async () => {
      const { outcome, attempts } = await rescueOutcome({
        devices: async () => ({ ok: true, value: [{ id: "DEV1", name: "Phone", isActive: false }] }),
        transfer: async () => ({ ok: true, value: undefined }),
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("no Spotify player is awake");
      expect(outcome.fatal).toBeUndefined();
      // The first attempt, then exactly one retry, on the device it woke.
      expect(attempts).toEqual(["active", "DEV1"]);
    });
  });
});

describe("a member's failure count", () => {
  test("a strike does not survive the party being stopped and started again", async () => {
    const { client } = fakeSpotify();
    const clock = fakeClock();
    // "friend" is unavailable on every call, so each start is exactly one strike for them.
    const { runner, notices, warnings } = makeRunner(client, clock, tokenSequence("friend", [UNAVAILABLE]));

    await runner.start("G1");
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);
    expect(warnings).toHaveLength(1);

    runner.stop("G1");
    // A new, unstarted party in the same guild, with the same members: the unit-level shape of a stale
    // strike meeting a new party. (In production `/party start` opens a party with the host alone and
    // `start` is reached through `/party add`; the host's case is the next test but one.)
    const { trackStartedAt: _started, ...unstarted } = party();
    resetPartiesForTest(openParty(freshParties(), unstarted));

    await runner.start("G1");
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);
    expect(notices).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain(`friend in guild G1 failed 1 of ${MAX_MEMBER_FAILURES}`);
    runner.stopAll();
  });

  test("an idle party restarted by adding a track, with no stop in between, starts its counts afresh", async () => {
    resetPartiesForTest(openParty(freshParties(), party({ queue: [party().queue[0]!] })));
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices } = makeRunner(client, clock, tokenSequence("friend", [UNAVAILABLE]));

    await runner.start("G1");
    // The queue runs out: the party stays open, idle, and the friend's strike stays on the books.
    await runner.skip("G1", 0);
    expect(getParty(partiesState(), "G1")?.trackStartedAt).toBeUndefined();

    // `/party add` on an idle party enqueues the track and calls `start`.
    await commitParties(
      enqueue(partiesState(), "G1", [{ uri: "spotify:track:three", name: "Three", artist: "Band", durationMs: TRACK_MS }]),
    );
    await runner.start("G1");

    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);
    // Only the queue running out was announced, not a drop.
    expect(notices.filter((m) => m.includes("dropped out"))).toEqual([]);
    runner.stopAll();
  });

  test("a host's strike from an earlier party does not close the next one", async () => {
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices } = makeRunner(client, clock, tokenSequence("host", [UNAVAILABLE]));

    await runner.start("G1");
    expect(getParty(partiesState(), "G1")).toBeDefined();

    runner.stop("G1");
    const { trackStartedAt: _started, ...unstarted } = party();
    resetPartiesForTest(openParty(freshParties(), unstarted));

    // One strike for the host in this party, not two: a second would drop them, and dropping the
    // host closes the whole party.
    await runner.start("G1");
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);
    expect(notices).toEqual([]);
    runner.stopAll();
  });

  test("pressing Join again starts a member's count afresh", async () => {
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices, warnings } = makeRunner(client, clock, tokenSequence("friend", [UNAVAILABLE]));

    await runner.start("G1");
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);

    // They leave, then press Join: the same code path as a first join.
    await commitParties(removeMember(partiesState(), "G1", "friend"));
    await commitParties(addMember(partiesState(), "G1", "friend"));
    const outcome = await runner.syncMember("G1", "friend");

    expect(outcome.ok).toBe(false);
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);
    expect(notices).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain(`friend in guild G1 failed 1 of ${MAX_MEMBER_FAILURES}`);
    runner.stopAll();
  });

  test("starting one guild's party leaves another guild's counts alone", async () => {
    // "G10" shares its first two characters with "G1": a prefix match without the separator would wipe it.
    const other = party({ guildId: "G10", channelId: "C10", hostId: "host10", members: ["host10", "friend"] });
    resetPartiesForTest(openParty(openParty(freshParties(), party()), other));
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock, tokenSequence("friend", [UNAVAILABLE]));

    await runner.start("G10");
    await runner.start("G1");
    await runner.skip("G10", 0);

    expect(getParty(partiesState(), "G10")?.members).toEqual(["host10"]);
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);
    runner.stopAll();
  });

  test("a Join clears only the joining member's count", async () => {
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock, tokenSequence("friend", [UNAVAILABLE]));

    await runner.start("G1");
    await runner.syncMember("G1", "latecomer");
    await runner.skip("G1", 0);

    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
    runner.stopAll();
  });
});

describe("the tick", () => {
  test("re-arms a party whose timer was lost to a restart", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    // A fresh runner has no timers -- exactly the state a process restart leaves behind.
    const { runner } = makeRunner(client, clock);

    await runner.sweep();
    expect(clock.pendingCount()).toBe(1);

    await clock.advanceTo(NOW + TRACK_MS);
    expect(getParty(partiesState(), "G1")?.index).toBe(1);
    expect(plays.length).toBeGreaterThan(0);
    runner.stopAll();
  });

  test("resyncs a drifted member and leaves a paused one alone", async () => {
    const { client, plays } = fakeSpotify({
      playbackState: async (accessToken) =>
        accessToken === "drifted"
          ? { ok: true, value: { isPlaying: true, progressMs: 0, trackUri: "spotify:track:one" } }
          : { ok: true, value: { isPlaying: false, progressMs: 0 } },
    });
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock, (id) => ({
      ok: true,
      accessToken: id === "host" ? "drifted" : "paused",
      scopes: PARTY_SCOPES,
    }));

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep();

    expect(plays).toHaveLength(1);
    expect(plays[0]?.positionMs).toBe(30_000);
    runner.stopAll();
  });

  /**
   * One sweep of a one-member party whose single playback check first runs `during`, then reports
   * the member still on track one at 0:00 -- drift against the snapshot the sweep took before it
   * started awaiting.
   */
  async function sweepInterruptedBy(during: (runner: PartyRunner) => Promise<void>) {
    resetPartiesForTest(openParty(freshParties(), party({ members: ["host"] })));
    const clock = fakeClock();
    let runner: PartyRunner;
    const { client, plays } = fakeSpotify({
      playbackState: async () => {
        await during(runner);
        return { ok: true, value: { isPlaying: true, progressMs: 0, trackUri: "spotify:track:one" } };
      },
    });
    const made = makeRunner(client, clock);
    runner = made.runner;

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep();
    runner.stopAll();
    return { plays, warnings: made.warnings, infos: made.infos.filter((m) => m.includes("moved during the sweep")) };
  }

  test("a boundary that fires during the sweep's checks cancels that tick's resync", async () => {
    const { plays, warnings, infos } = await sweepInterruptedBy(async (runner) => {
      await runner.skip("G1", 0);
    });

    expect(getParty(partiesState(), "G1")?.index).toBe(1);
    expect(plays).toEqual([{ accessToken: "AT", uri: "spotify:track:two", positionMs: 0 }]);
    expect(warnings).toEqual([]);
    expect(infos).toEqual(["party in guild G1 moved during the sweep; skipping resync"]);
  });

  test("a party that closes during the sweep's checks is left alone", async () => {
    const { plays, infos } = await sweepInterruptedBy(async () => {
      await commitParties(closeParty(partiesState(), "G1"));
    });

    expect(getParty(partiesState(), "G1")).toBeUndefined();
    expect(plays).toEqual([]);
    expect(infos).toHaveLength(1);
  });

  test("a party whose place in the queue changed during the sweep's checks is left alone", async () => {
    const { plays, infos } = await sweepInterruptedBy(async () => {
      await commitParties(openParty(partiesState(), { ...getParty(partiesState(), "G1")!, index: 1 }));
    });

    expect(plays).toEqual([]);
    expect(infos).toHaveLength(1);
  });

  test("a party whose current track restarted during the sweep's checks is left alone", async () => {
    const { plays, infos } = await sweepInterruptedBy(async () => {
      await commitParties(markStarted(partiesState(), "G1", NOW + 30_000));
    });

    expect(plays).toEqual([]);
    expect(infos).toHaveLength(1);
  });

  test("a party that did not move is still resynced", async () => {
    const { plays, infos } = await sweepInterruptedBy(async () => {});

    expect(plays).toEqual([{ accessToken: "AT", uri: "spotify:track:one", positionMs: 30_000 }]);
    expect(infos).toEqual([]);
  });

  test("a track queued during the sweep's checks is not a move", async () => {
    const { plays, infos } = await sweepInterruptedBy(async () => {
      await commitParties(
        enqueue(partiesState(), "G1", [{ uri: "spotify:track:three", name: "Three", artist: "Band", durationMs: TRACK_MS }]),
      );
    });

    expect(plays).toEqual([{ accessToken: "AT", uri: "spotify:track:one", positionMs: 30_000 }]);
    expect(infos).toEqual([]);
  });

  test("a boundary that fires during one member's resync cancels the resyncs after it", async () => {
    resetPartiesForTest(openParty(freshParties(), party({ members: ["host", "friend", "third"] })));
    const clock = fakeClock();
    const calls: { accessToken: string; uri: string; positionMs: number }[] = [];
    let runner: PartyRunner;
    let fired = false;
    const { client } = fakeSpotify({
      // Every member reports track one at 0:00, so all are drifted against the sweep's snapshot.
      playbackState: async () => ({ ok: true, value: { isPlaying: true, progressMs: 0, trackUri: "spotify:track:one" } }),
      // The first play is the host's resync; the boundary lands while it is in flight.
      play: async (accessToken, uri, positionMs) => {
        calls.push({ accessToken, uri, positionMs });
        if (!fired) {
          fired = true;
          await runner.skip("G1", 0);
        }
        return { ok: true, value: undefined };
      },
    });
    const made = makeRunner(client, clock, (id) => ({ ok: true, accessToken: id, scopes: PARTY_SCOPES }));
    runner = made.runner;

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep();
    runner.stopAll();

    // The host's resync (stale by the time the boundary lands), then the boundary's own plays for
    // every member -- and nothing that puts the friend or the third member back on track one. One
    // log line for the whole abandoned run of resyncs, not one per member left.
    expect(calls).toEqual([
      { accessToken: "host", uri: "spotify:track:one", positionMs: 30_000 },
      { accessToken: "host", uri: "spotify:track:two", positionMs: 0 },
      { accessToken: "friend", uri: "spotify:track:two", positionMs: 0 },
      { accessToken: "third", uri: "spotify:track:two", positionMs: 0 },
    ]);
    expect(made.infos.filter((m) => m.includes("moved during the sweep"))).toHaveLength(1);
  });

  test("a party that moved does not stop the sweep reaching the next party", async () => {
    const other = party({ guildId: "G2", channelId: "C2", hostId: "host2", members: ["host2"] });
    resetPartiesForTest(openParty(openParty(freshParties(), party({ members: ["host"] })), other));
    const clock = fakeClock();
    const calls: { accessToken: string; uri: string; positionMs: number }[] = [];
    let runner: PartyRunner;
    const { client } = fakeSpotify({
      // Only the first party's check lets its boundary land.
      playbackState: async (accessToken) => {
        if (accessToken === "host") await runner.skip("G1", 0);
        return { ok: true, value: { isPlaying: true, progressMs: 0, trackUri: "spotify:track:one" } };
      },
      play: async (accessToken, uri, positionMs) => {
        calls.push({ accessToken, uri, positionMs });
        return { ok: true, value: undefined };
      },
    });
    const made = makeRunner(client, clock, (id) => ({ ok: true, accessToken: id, scopes: PARTY_SCOPES }));
    runner = made.runner;

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep();
    runner.stopAll();

    expect(calls).toEqual([
      { accessToken: "host", uri: "spotify:track:two", positionMs: 0 },
      { accessToken: "host2", uri: "spotify:track:one", positionMs: 30_000 },
    ]);
  });
});

describe("the tick, when the host aborts it", () => {
  const DRIFTED = { ok: true, value: { isPlaying: true, progressMs: 0, trackUri: "spotify:track:one" } } as const;
  const abortedLines = (infos: string[]) => infos.filter((m) => m.includes("aborted"));

  test("an already-aborted signal makes the sweep do nothing", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    let tokenCalls = 0;
    const { runner, notices, infos } = makeRunner(client, clock, () => {
      tokenCalls += 1;
      return GOOD;
    });

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep(AbortSignal.abort());

    expect(tokenCalls).toBe(0);
    expect(plays).toEqual([]);
    expect(notices).toEqual([]);
    expect(abortedLines(infos)).toEqual(["party sweep aborted by the host; 1 parties left unchecked"]);
    runner.stopAll();
  });

  test("a sweep that was never aborted still checks and resyncs", async () => {
    const { client, plays } = fakeSpotify({ playbackState: async () => DRIFTED });
    const clock = fakeClock();
    const { runner, infos } = makeRunner(client, clock);

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep(new AbortController().signal);

    expect(plays.map((p) => p.uri)).toEqual(["spotify:track:one", "spotify:track:one"]);
    expect(abortedLines(infos)).toEqual([]);
    runner.stopAll();
  });

  test("a sweep stops before the resync once the host aborts during its checks", async () => {
    const controller = new AbortController();
    const { client, plays } = fakeSpotify({
      playbackState: async () => {
        controller.abort();
        return DRIFTED;
      },
    });
    const clock = fakeClock();
    const { runner, infos } = makeRunner(client, clock);

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep(controller.signal);

    expect(plays).toEqual([]);
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);
    expect(abortedLines(infos)).toHaveLength(1);
    runner.stopAll();
  });

  test("an abort between two resyncs stops the second one", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const { client } = fakeSpotify({
      playbackState: async () => DRIFTED,
      play: async (accessToken) => {
        calls.push(accessToken);
        controller.abort();
        return { ok: true, value: undefined };
      },
    });
    const clock = fakeClock();
    const { runner, infos } = makeRunner(client, clock, (id) => ({ ok: true, accessToken: id, scopes: PARTY_SCOPES }));

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep(controller.signal);

    expect(calls).toEqual(["host"]);
    expect(abortedLines(infos)).toHaveLength(1);
    runner.stopAll();
  });

  test("an abort that cancels a resync's play does not count a strike against the member", async () => {
    resetPartiesForTest(openParty(freshParties(), party({ members: ["host"] })));
    const controller = new AbortController();
    const { client } = fakeSpotify({
      playbackState: async () => DRIFTED,
      // What the client reports for a call the host's signal cancelled.
      play: async () => {
        controller.abort();
        return { ok: false, error: "couldn't reach Spotify" };
      },
    });
    const clock = fakeClock();
    const { runner, warnings, notices, infos } = makeRunner(client, clock);

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep(controller.signal);

    expect(warnings).toEqual([]);
    expect(notices).toEqual([]);
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
    expect(abortedLines(infos)).toHaveLength(1);
    runner.stopAll();
  });

  test("a resync that succeeded as the host aborted still clears the member's earlier strike", async () => {
    resetPartiesForTest(openParty(freshParties(), party({ members: ["friend"] })));
    const controller = new AbortController();
    const { client } = fakeSpotify({
      playbackState: async () => DRIFTED,
      // The play lands, then the host's signal fires: the resync worked.
      play: async () => {
        controller.abort();
        return { ok: true, value: undefined };
      },
    });
    const clock = fakeClock();
    // Strike one comes from `start`; the sweep's check and its resync get a token each; the boundary
    // after it is the next blip.
    const { runner, notices } = makeRunner(
      client,
      clock,
      tokenSequence("friend", [UNAVAILABLE, GOOD, GOOD, UNAVAILABLE]),
    );

    await runner.start("G1");
    await clock.advanceTo(NOW + 30_000);
    await runner.sweep(controller.signal);
    await runner.skip("G1", 0);

    // The success cleared the strike, so this blip is a first strike again, not a second.
    expect(getParty(partiesState(), "G1")?.members).toEqual(["friend"]);
    expect(notices.filter((m) => m.includes("dropped out"))).toEqual([]);
    runner.stopAll();
  });

  /**
   * One sweep over three one-member parties, G1..G3 (members h1..h3, each their own party's host),
   * with the host's signal firing inside the call `abort` names. A member listed in `drifted` reports
   * track one at 0:00 (drift at NOW + 30 s); the others are in sync. Records which members the sweep
   * asked for a token and which it played to.
   */
  async function sweepThree(
    abort: { in: "playbackState" | "play" | "moved"; member: string; failPlay?: boolean },
    drifted: string[],
  ) {
    const guilds = ["G1", "G2", "G3"];
    resetPartiesForTest(
      guilds.reduce(
        (state, guildId, i) =>
          openParty(state, party({ guildId, channelId: `C${i + 1}`, hostId: `h${i + 1}`, members: [`h${i + 1}`] })),
        freshParties(),
      ),
    );
    const controller = new AbortController();
    const tokenCalls: string[] = [];
    const plays: string[] = [];
    let runner: PartyRunner;
    const { client } = fakeSpotify({
      playbackState: async (accessToken) => {
        if (abort.in === "playbackState" && accessToken === abort.member) controller.abort();
        if (abort.in === "moved" && accessToken === abort.member) {
          // A track boundary lands in the same window the host's abort does.
          await runner.skip(`G${accessToken.slice(1)}`, 0);
          controller.abort();
        }
        const inSync = !drifted.includes(accessToken);
        return {
          ok: true,
          value: { isPlaying: true, progressMs: inSync ? 30_000 : 0, trackUri: "spotify:track:one" },
        };
      },
      play: async (accessToken) => {
        plays.push(accessToken);
        if (abort.in === "play" && accessToken === abort.member) {
          controller.abort();
          if (abort.failPlay === true) return { ok: false, error: "couldn't reach Spotify" };
        }
        return { ok: true, value: undefined };
      },
    });
    const clock = fakeClock();
    const made = makeRunner(client, clock, (id) => {
      tokenCalls.push(id);
      return { ok: true, accessToken: id, scopes: PARTY_SCOPES };
    });
    runner = made.runner;

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep(controller.signal);
    runner.stopAll();
    return {
      tokenCalls,
      plays,
      warnings: made.warnings,
      aborted: abortedLines(made.infos),
      moved: made.infos.filter((m) => m.includes("moved during the sweep")),
    };
  }

  test("an abort during one party's last resync stops the sweep before the next party's checks", async () => {
    const { tokenCalls, aborted } = await sweepThree({ in: "play", member: "h1" }, ["h1"]);

    // h1 was asked for a token for its check and its resync; h2 and h3 never were.
    expect(tokenCalls).toEqual(["h1", "h1"]);
    expect(aborted).toEqual(["party sweep aborted by the host; 2 parties left unchecked"]);
  });

  test("an abort during the second party's checks counts it and the third as unchecked", async () => {
    const { tokenCalls, plays, aborted } = await sweepThree({ in: "playbackState", member: "h2" }, ["h2"]);

    expect(tokenCalls).toEqual(["h1", "h2"]);
    expect(plays).toEqual([]);
    expect(aborted).toEqual(["party sweep aborted by the host; 2 parties left unchecked"]);
  });

  test("an abort that cancels the second party's resync play counts it and the third, and is not a strike", async () => {
    const { tokenCalls, warnings, aborted } = await sweepThree({ in: "play", member: "h2", failPlay: true }, ["h2"]);

    expect(tokenCalls).toEqual(["h1", "h2", "h2"]);
    expect(warnings).toEqual([]);
    expect(aborted).toEqual(["party sweep aborted by the host; 2 parties left unchecked"]);
  });

  test("a host abort wins over a party that moved in the same window", async () => {
    const { plays, aborted, moved } = await sweepThree({ in: "moved", member: "h1" }, ["h1"]);

    // The boundary's own plays happened; the sweep then saw the abort, not the move.
    expect(plays).toEqual(["h1"]);
    expect(aborted).toEqual(["party sweep aborted by the host; 3 parties left unchecked"]);
    expect(moved).toEqual([]);
  });

  test("the sweep's playback read and the resync's play carry the host's signal", async () => {
    resetPartiesForTest(openParty(freshParties(), party({ members: ["host"] })));
    const controller = new AbortController();
    const seen: { read?: AbortSignal; play?: AbortSignal } = {};
    const { client } = fakeSpotify({
      playbackState: async (_accessToken, signal) => {
        if (signal !== undefined) seen.read = signal;
        return DRIFTED;
      },
      play: async (_accessToken, _uri, _positionMs, _deviceId, signal) => {
        if (signal !== undefined) seen.play = signal;
        return { ok: true, value: undefined };
      },
    });
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock);

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep(controller.signal);

    expect(seen.read).toBe(controller.signal);
    expect(seen.play).toBe(controller.signal);
    runner.stopAll();
  });

  test("the no-device rescue's devices read, transfer and retry carry it too", async () => {
    resetPartiesForTest(openParty(freshParties(), party({ members: ["host"] })));
    const controller = new AbortController();
    const seen: Record<string, AbortSignal | undefined> = {};
    let firstPlay = true;
    const { client } = fakeSpotify({
      playbackState: async () => DRIFTED,
      play: async (_accessToken, _uri, _positionMs, deviceId, signal) => {
        if (firstPlay) {
          firstPlay = false;
          return { ok: false, error: "Player command failed: No active device found", status: 404 };
        }
        seen[`retry:${deviceId}`] = signal;
        return { ok: true, value: undefined };
      },
      devices: async (_accessToken, signal) => {
        seen.devices = signal;
        return { ok: true, value: [{ id: "d1", name: "Phone", isActive: false }] };
      },
      transfer: async (_accessToken, _deviceId, signal) => {
        seen.transfer = signal;
        return { ok: true, value: undefined };
      },
    });
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock);

    await clock.advanceTo(NOW + 30_000);
    await runner.sweep(controller.signal);

    expect(seen.devices).toBe(controller.signal);
    expect(seen.transfer).toBe(controller.signal);
    expect(seen["retry:d1"]).toBe(controller.signal);
    runner.stopAll();
  });

  test("no timer is armed after dispose", async () => {
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner } = makeRunner(client, clock);

    await runner.start("G1");
    expect(clock.pendingCount()).toBe(1);
    runner.stopAll();
    expect(clock.pendingCount()).toBe(0);

    await runner.skip("G1", 0);
    expect(clock.pendingCount()).toBe(0);
  });

  test("a start that is mid-play when the plugin is disposed arms no timer afterwards", async () => {
    const clock = fakeClock();
    let runner: PartyRunner;
    let disposed = false;
    const { client } = fakeSpotify({
      play: async () => {
        if (!disposed) {
          disposed = true;
          runner.stopAll();
        }
        return { ok: true, value: undefined };
      },
    });
    const made = makeRunner(client, clock);
    runner = made.runner;

    await runner.start("G1");

    expect(disposed).toBe(true);
    expect(clock.pendingCount()).toBe(0);
  });
});

describe("a boundary whose disk write fails", () => {
  /** One macrotask: the rejection path has more awaits than `advanceTo`'s two microtask turns. */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  // Several tests here install a rejecting writer in the parties singleton; leave it clean.
  afterEach(() => {
    resetPartiesForTest(freshParties());
  });

  /**
   * A storage whose parties writer rejects on every save after the first `okSaves`, as a full or
   * read-only disk does. `onSave` runs inside each save, before it settles.
   */
  function failingStorage(onSave: () => void = () => {}, okSaves = 0) {
    let saves = 0;
    return {
      ...makeRealStorage(),
      createJsonWriter: () => ({
        save: async (): Promise<void> => {
          saves += 1;
          onSave();
          if (saves > okSaves) throw new Error("disk full");
        },
      }),
    };
  }

  test("is logged, does not escape the timer, and re-arms the party", async () => {
    resetPartiesForTest(openParty(freshParties(), party()), failingStorage(), "unused.json");
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner, errors, errorCauses } = makeRunner(client, clock);
    const escaped: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      escaped.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // A fresh runner re-arms a timerless party without writing anything.
      await runner.sweep();
      expect(clock.pendingCount()).toBe(1);

      await clock.advanceTo(NOW + TRACK_MS);
      await flush();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(escaped).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("advancing to the next track failed");
    expect(errors[0]).toContain("G1");
    // The error itself reaches the logger, not just its text, so the host keeps the stack.
    expect(errorCauses[0]).toBeInstanceOf(Error);
    expect((errorCauses[0] as Error).message).toBe("disk full");
    // The in-memory state moved on before the write failed, and the next boundary has a timer.
    expect(getParty(partiesState(), "G1")?.index).toBe(1);
    expect(clock.pendingCount()).toBe(1);
    runner.stopAll();
  });

  test("a persistent failure is logged once per boundary, never in a loop", async () => {
    resetPartiesForTest(openParty(freshParties(), party()), failingStorage(), "unused.json");
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner, errors } = makeRunner(client, clock);

    await runner.sweep();
    await clock.advanceTo(NOW + TRACK_MS);
    await flush();
    expect(errors).toHaveLength(1);

    // Nothing retries the failed boundary on its own: no further error, no play, until the next one.
    await flush();
    await flush();
    await clock.advanceTo(NOW + TRACK_MS + 1_000);
    await flush();
    expect(errors).toHaveLength(1);
    expect(plays).toEqual([]);
    expect(clock.pendingCount()).toBe(1);

    // The next boundary is the last track's end: it fails too, once, and the queue is spent.
    await clock.advanceTo(NOW + 2 * TRACK_MS);
    await flush();
    expect(errors).toHaveLength(2);
    expect(getParty(partiesState(), "G1")?.index).toBe(2);
    expect(clock.pendingCount()).toBe(0);
    runner.stopAll();
  });

  test("a boundary that succeeds logs no error", async () => {
    // The default parties store has no writer, so nothing rejects.
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner, errors } = makeRunner(client, clock);

    await runner.sweep();
    await clock.advanceTo(NOW + TRACK_MS);
    await flush();

    expect(errors).toEqual([]);
    expect(getParty(partiesState(), "G1")?.index).toBe(1);
    expect(plays.length).toBeGreaterThan(0);
    expect(clock.pendingCount()).toBe(1);
    runner.stopAll();
  });

  test("a token refresh that cannot save at the boundary is caught the same way", async () => {
    const { client } = fakeSpotify();
    const clock = fakeClock();
    let refusing = false;
    const { runner, errors, errorCauses } = makeRunner(client, clock, () => {
      if (refusing) throw new Error("disk full");
      return GOOD;
    });

    await runner.sweep();
    refusing = true;
    await clock.advanceTo(NOW + TRACK_MS);
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("G1");
    expect((errorCauses[0] as Error).message).toBe("disk full");
    expect(getParty(partiesState(), "G1")?.index).toBe(1);
    expect(clock.pendingCount()).toBe(1);
    runner.stopAll();
  });

  test("a member's removal that cannot save at the boundary is caught the same way", async () => {
    // The boundary's own write lands; the drop-out's write is the one that fails.
    resetPartiesForTest(openParty(freshParties(), party()), failingStorage(() => {}, 1), "unused.json");
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const { runner, errors, errorCauses } = makeRunner(client, clock, tokenSequence("friend", [REVOKED]));

    await runner.sweep();
    await clock.advanceTo(NOW + TRACK_MS);
    await flush();

    expect(errors).toHaveLength(1);
    expect((errorCauses[0] as Error).message).toBe("disk full");
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
    expect(clock.pendingCount()).toBe(1);
    runner.stopAll();
  });

  test("a plugin disposed while the write is failing is not re-armed", async () => {
    let runner: PartyRunner;
    // Dispose lands inside the failing write, before the catch runs.
    resetPartiesForTest(openParty(freshParties(), party()), failingStorage(() => runner.stopAll()), "unused.json");
    const { client } = fakeSpotify();
    const clock = fakeClock();
    const made = makeRunner(client, clock);
    runner = made.runner;

    await runner.sweep();
    expect(clock.pendingCount()).toBe(1);
    await clock.advanceTo(NOW + TRACK_MS);
    await flush();

    expect(made.errors).toHaveLength(1);
    expect(clock.pendingCount()).toBe(0);
  });
});
