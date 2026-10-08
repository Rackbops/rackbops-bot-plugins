import { beforeEach, describe, expect, test } from "bun:test";
import { createPartyRunner, MAX_MEMBER_FAILURES, type RunnerDeps, type TimerHandle, type TokenResult } from "./runner.js";
import { freshParties, getParty, openParty, partiesState, resetPartiesForTest, type Party } from "./party.js";
import { PARTY_SCOPES, SPOTIFY_SCOPES, type SpotifyClient } from "./spotify.js";

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
) {
  const notices: string[] = [];
  const warnings: string[] = [];
  const deps: RunnerDeps = {
    spotify,
    accessTokenFor: async (id) => token(id),
    now: clock.now,
    schedule: clock.schedule,
    notify: async (_party, message) => {
      notices.push(message);
    },
    log: {
      info() {},
      warn(m) {
        warnings.push(m);
      },
      error() {},
    },
  };
  return { runner: createPartyRunner(deps), notices, warnings };
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
    const { runner, notices } = makeRunner(client, clock);

    await runner.start("G1");
    await clock.advanceTo(NOW + TRACK_MS);

    expect(getParty(partiesState(), "G1")).toBeDefined();
    expect(getParty(partiesState(), "G1")?.trackStartedAt).toBeUndefined();
    expect(notices.join(" ")).toContain("last track");
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
    await runner.skip("G1");

    expect(getParty(partiesState(), "G1")?.index).toBe(1);
    expect(plays.every((p) => p.uri === "spotify:track:two")).toBe(true);
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
    const { runner, notices } = makeRunner(client, clock);

    await runner.syncMember("G1", "friend");

    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
    expect(notices.join(" ")).toContain("Premium");
    // A fragment reason gets its one period from the runner.
    expect(notices[0]?.endsWith("control playback.")).toBe(true);
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

    await runner.syncMember("G1", "friend");
    expect(getParty(partiesState(), "G1")?.members).not.toContain("friend");
    expect(notices[0]?.endsWith("Try later.")).toBe(true);
    runner.stopAll();
  });
});

describe("a refresh Spotify couldn't do right now", () => {
  test("costs a member their place only on the SECOND one, like any other blip", async () => {
    const { client, plays } = fakeSpotify();
    const clock = fakeClock();
    const { runner, notices, warnings } = makeRunner(client, clock, tokenSequence("friend", [UNAVAILABLE]));

    await runner.start("G1");
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", "friend"]);
    expect(plays).toHaveLength(1);
    expect(notices).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`friend in guild G1 failed 1 of ${MAX_MEMBER_FAILURES}`);

    await runner.skip("G1");
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
    expect(notices).toHaveLength(1);
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

    await runner.skip("G1");
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
    await runner.skip("G1");
    await runner.skip("G1");
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
});
