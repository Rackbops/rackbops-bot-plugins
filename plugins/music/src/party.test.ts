import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMember,
  advance,
  closeParty,
  currentTrack,
  decideSync,
  enqueue,
  expectedPositionMs,
  freshParties,
  getParty,
  initParties,
  markStarted,
  msUntilAdvance,
  openParty,
  partiesState,
  removeMember,
  type Party,
  type PartiesState,
  type PartyTrack,
} from "./party.js";
import { makeFakeHost, makeRealStorage } from "../../../packages/testkit/index.js";

const NOW = 1_700_000_000_000;

function track(name: string, durationMs = 180_000): PartyTrack {
  return { uri: `spotify:track:${name}`, name, artist: "Band", durationMs };
}

function party(overrides: Partial<Party> = {}): Party {
  return {
    guildId: "G1",
    channelId: "C1",
    hostId: "host",
    members: ["host"],
    queue: [track("one"), track("two")],
    index: 0,
    trackStartedAt: NOW,
    ...overrides,
  };
}

function stateWith(p: Party): PartiesState {
  return openParty(freshParties(), p);
}

describe("membership", () => {
  test("joining twice does not double a member, so nobody gets two play calls", () => {
    let state = stateWith(party());
    state = addMember(state, "G1", "friend");
    state = addMember(state, "G1", "friend");
    expect(getParty(state, "G1")?.members).toEqual(["host", "friend"]);
  });

  test("a member leaving keeps the party; the host leaving ends it", () => {
    let state = stateWith(party({ members: ["host", "friend"] }));
    state = removeMember(state, "G1", "friend");
    expect(getParty(state, "G1")?.members).toEqual(["host"]);

    state = removeMember(state, "G1", "host");
    expect(getParty(state, "G1")).toBeUndefined();
  });

  test("closing a party leaves other guilds' parties alone", () => {
    let state = stateWith(party());
    state = openParty(state, party({ guildId: "G2" }));
    state = closeParty(state, "G1");
    expect(getParty(state, "G1")).toBeUndefined();
    expect(getParty(state, "G2")).toBeDefined();
  });
});

describe("the queue", () => {
  test("advancing moves to the next track and restarts its clock", () => {
    const result = advance(stateWith(party()), "G1", NOW + 5_000);
    expect(result.track?.name).toBe("two");
    expect(getParty(result.state, "G1")?.index).toBe(1);
    expect(getParty(result.state, "G1")?.trackStartedAt).toBe(NOW + 5_000);
  });

  test("running off the end leaves the party OPEN but stopped, so it can be topped up", () => {
    const result = advance(stateWith(party({ index: 1 })), "G1", NOW + 5_000);
    expect(result.track).toBeUndefined();
    const after = getParty(result.state, "G1");
    expect(after).toBeDefined();
    expect(after?.trackStartedAt).toBeUndefined();
    // Index parked at the end, so a later `/party add` + start plays the NEW track, not a repeat.
    expect(after?.index).toBe(2);
    const topped = enqueue(result.state, "G1", [track("three")]);
    expect(currentTrack(getParty(topped, "G1") as Party)?.name).toBe("three");
  });

  test("a timer is never armed for zero, which would burn through the queue in one tick", () => {
    const overdue = party({ trackStartedAt: NOW - 500_000 });
    expect(msUntilAdvance(overdue, NOW)).toBe(1);
  });

  test("a stopped party has nothing to arm", () => {
    const { trackStartedAt: _unused, ...stopped } = party();
    expect(msUntilAdvance(stopped, NOW)).toBeUndefined();
  });

  test("marking started sets the clock the whole party is measured against", () => {
    const { trackStartedAt: _unused, ...stopped } = party();
    const state = markStarted(stateWith(stopped), "G1", NOW + 9);
    expect(expectedPositionMs(getParty(state, "G1") as Party, NOW + 1_009)).toBe(1_000);
  });
});

describe("decideSync", () => {
  const playing = party();

  test("a member in the right place is left alone", () => {
    const verdict = decideSync(
      playing,
      { isPlaying: true, progressMs: 10_000, trackUri: "spotify:track:one" },
      NOW + 10_000,
    );
    expect(verdict).toEqual({ action: "ok" });
  });

  test("drift inside the tolerance is left alone -- a resync is audible", () => {
    const verdict = decideSync(
      playing,
      { isPlaying: true, progressMs: 8_000, trackUri: "spotify:track:one" },
      NOW + 10_000,
    );
    expect(verdict).toEqual({ action: "ok" });
  });

  test("drift past the tolerance is corrected to where the party actually is", () => {
    const verdict = decideSync(
      playing,
      { isPlaying: true, progressMs: 1_000, trackUri: "spotify:track:one" },
      NOW + 10_000,
    );
    expect(verdict).toEqual({ action: "resync", positionMs: 10_000 });
  });

  test("a member on a different track is pulled back, however aligned their clock looks", () => {
    const verdict = decideSync(
      playing,
      { isPlaying: true, progressMs: 10_000, trackUri: "spotify:track:something-else" },
      NOW + 10_000,
    );
    expect(verdict).toEqual({ action: "resync", positionMs: 10_000 });
  });

  test("a paused member is reported paused, NOT resynced -- the bot never fights the phone", () => {
    expect(decideSync(playing, { isPlaying: false, progressMs: 0 }, NOW + 10_000)).toEqual({ action: "paused" });
    expect(decideSync(playing, undefined, NOW + 10_000)).toEqual({ action: "paused" });
  });

  test("a party with nothing playing asks nothing of anyone", () => {
    const { trackStartedAt: _unused, ...stopped } = party();
    expect(decideSync(stopped, { isPlaying: false, progressMs: 0 }, NOW)).toEqual({ action: "ok" });
  });
});

describe("initParties", () => {
  test("a missing file and a valid state load without a warning", async () => {
    for (const content of [undefined, JSON.stringify(freshParties())]) {
      const dir = await mkdtemp(join(tmpdir(), "music-parties-"));
      const warnings: string[] = [];
      try {
        if (content !== undefined) await Bun.write(join(dir, "parties.json"), content);
        await initParties(
          makeFakeHost({
            name: "music",
            dataDir: dir,
            storage: makeRealStorage(),
            log: { info() {}, warn: (m) => warnings.push(m), error() {} },
          }),
        );
        expect(partiesState()).toEqual(freshParties());
        expect(warnings).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("a parties file that is not an object is replaced by a fresh state", async () => {
    // Valid JSON the host's reader hands back as-is: it parses, so it is never treated as corrupt.
    for (const content of ["null", "[]", "42"]) {
      const dir = await mkdtemp(join(tmpdir(), "music-parties-"));
      const warnings: string[] = [];
      try {
        await Bun.write(join(dir, "parties.json"), content);
        await initParties(
          makeFakeHost({
            name: "music",
            dataDir: dir,
            storage: makeRealStorage(),
            log: { info() {}, warn: (m) => warnings.push(m), error() {} },
          }),
        );
        expect(partiesState()).toEqual(freshParties());
        // The replacement is announced, since the file is overwritten on the next write.
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("parties.json");
        expect(warnings[0]).toContain("not an object");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
