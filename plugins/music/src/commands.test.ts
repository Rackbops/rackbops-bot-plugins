import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { MessageFlags, type ChatInputCommandInteraction, type MessageComponentInteraction } from "discord.js";
import {
  choiceFor,
  formatBuildReply,
  formatJoinReply,
  formatNotConfigured,
  formatOutcomes,
  formatPickPrompt,
  initCommands,
  musicCommands,
  musicInteractions,
  PARTY_JOIN_ID,
  parsePickerCustomId,
  pickerCustomId,
  PRIVATE_FAILURE_NOTE,
} from "./commands.js";
import {
  advance,
  closeParty,
  commitParties,
  enqueue,
  freshParties,
  getParty,
  openParty,
  partiesState,
  removeMember,
  resetPartiesForTest,
  type Party,
  type PartyTrack,
} from "./party.js";
import { resetClientForTest } from "./notify.js";
import type { MemberOutcome, PartyRunner } from "./runner.js";
import type { SetlistFmClient, SetlistFmResult, SetlistListResult } from "./setlistfm.js";
import { PARTY_SCOPES, SPOTIFY_SCOPES, type SpotifyClient } from "./spotify.js";
import { freshState, musicState, putConnection, resetStoreForTest } from "./store.js";
import type { BuildOutcome } from "./build.js";
import type { MatchRun } from "./matchlog.js";
import type { TrackCandidate } from "./matching.js";
import type { Setlist } from "./setlistfm.js";

// ---------------------------------------------------------------------------------------------------
// #55: every log line a wiring emits, captured so a test can assert on stop lines
// ---------------------------------------------------------------------------------------------------

let logged: string[] = [];
const captureLog = {
  info: (m: string) => {
    logged.push(m);
  },
  warn() {},
  error() {},
};

/** A Discord id that would be tempting to log -- every stop-line test below checks it never is. */
const USER = "424242424242424242";

/** Every captured line that is a stop line, in order. */
function stops(): string[] {
  return logged.filter((l) => l.startsWith("setlist stopped"));
}

/** Asserts exactly one stop line was logged, and that it carries `stage`. */
function expectOneStop(stage: string): void {
  const found = stops();
  expect(found).toHaveLength(1);
  expect(found[0]).toContain(`stage=${stage}:`);
}

function setlist(overrides: Partial<Setlist> = {}): Setlist {
  return {
    id: "abc123",
    artistName: "Band",
    eventDate: "08-09-2026",
    venueName: "The Venue",
    cityName: "Leeds",
    countryName: "United Kingdom",
    tourName: "The Tour",
    url: "https://www.setlist.fm/setlist/band/2026/the-venue-abc123.html",
    songs: [],
    tapeCount: 0,
    ...overrides,
  };
}

function outcome(overrides: Partial<BuildOutcome> = {}): BuildOutcome {
  return {
    playlistUrl: "https://open.spotify.com/playlist/PL1",
    playlistName: "Band at The Venue, Leeds (2026-09-08)",
    added: 2,
    attempted: 2,
    uncertain: [],
    missing: [],
    foundElsewhere: [],
    folded: 0,
    ...overrides,
  };
}

describe("formatNotConfigured", () => {
  test("names every key an admin still has to set", () => {
    const reply = formatNotConfigured(["SETLISTFM_API_KEY", "SPOTIFY_CLIENT_ID"]);
    expect(reply).toContain("`SETLISTFM_API_KEY`");
    expect(reply).toContain("`SPOTIFY_CLIENT_ID`");
  });
});

describe("formatBuildReply", () => {
  test("leads with the show and the playlist link", () => {
    const reply = formatBuildReply(setlist(), outcome());
    const lines = reply.split("\n");
    expect(lines[0]).toContain("Band - The Venue, Leeds, United Kingdom");
    expect(lines[1]).toBe("https://open.spotify.com/playlist/PL1");
    expect(lines[2]).toBe("Added 2 of 2 songs.");
  });

  test("names the show date after the venue, in the playlist name's ISO form", () => {
    const reply = formatBuildReply(setlist(), outcome());
    expect(reply.split("\n")[0]).toContain("United Kingdom (2026-09-08)**");
  });

  test("omits the date when the setlist has none", () => {
    const reply = formatBuildReply(setlist({ eventDate: "" }), outcome());
    expect(reply.split("\n")[0]).toEndWith("United Kingdom**");
  });

  test("says how many tape tracks were skipped, so the count isn't a silent mystery", () => {
    const reply = formatBuildReply(setlist({ tapeCount: 2 }), outcome());
    expect(reply).toContain("Skipped 2 played from tape");
  });

  test("says nothing about tape when there was none", () => {
    expect(formatBuildReply(setlist(), outcome())).not.toContain("tape");
  });

  // #66: without this note, "Added 22 of 24" would read as two silent misses.
  test("names how many suite parts shared an already-added recording", () => {
    const reply = formatBuildReply(setlist(), outcome({ folded: 2 }));
    expect(reply).toContain("2 suite part(s) share a recording already added.");
  });

  test("says nothing about folded parts when there were none", () => {
    expect(formatBuildReply(setlist(), outcome())).not.toContain("suite part");
  });

  test("names the songs it couldn't find", () => {
    const reply = formatBuildReply(setlist(), outcome({ added: 1, missing: ["Rare B-Side"] }));
    expect(reply).toContain("Couldn't find on Spotify: Rare B-Side.");
  });

  test("names loose matches as worth a check, showing what it picked", () => {
    const reply = formatBuildReply(
      setlist(),
      outcome({
        uncertain: [
          {
            song: { name: "Yesterday", searchArtist: "The Beatles", isCover: false },
            match: {
              track: { uri: "u", name: "Yesterday - Live", artistNames: ["The Beatles"], popularity: 1 },
              confidence: "low",
              score: 0, // unused by formatBuildReply -- only confidence and the track matter here
            },
            foundUnder: "The Beatles", // unused here too -- only outcome.foundElsewhere reads it
          },
        ],
      }),
    );
    expect(reply).toContain("Yesterday -> Yesterday - Live");
  });

  test("a long missing list is summarised rather than dumped", () => {
    const missing = Array.from({ length: 20 }, (_, i) => `Song ${i}`);
    const reply = formatBuildReply(setlist(), outcome({ missing }));
    expect(reply).toContain("and 12 more");
    expect(reply).not.toContain("Song 19");
  });

  test("stays under Discord's 2000-character limit even at full spread", () => {
    const missing = Array.from({ length: 40 }, (_, i) => `A Very Long Song Title Number ${i}`);
    const reply = formatBuildReply(setlist({ artistName: "B".repeat(200), tapeCount: 5 }), outcome({ missing }));
    expect(reply.length).toBeLessThanOrEqual(2000);
  });

  test("names which songs were matched under a different artist than setlist.fm gave", () => {
    const reply = formatBuildReply(
      setlist(),
      outcome({
        foundElsewhere: [
          {
            song: { name: "Heartbreaker", searchArtist: "Pat Benatar & Neil Giraldo", isCover: false },
            match: {
              track: { uri: "u", name: "Heartbreaker", artistNames: ["Pat Benatar"], popularity: 50 },
              confidence: "high",
              score: 140,
            },
            foundUnder: "Pat Benatar",
          },
        ],
      }),
    );
    expect(reply).toContain("Matched under a different artist than setlist.fm names: Heartbreaker -> Pat Benatar.");
  });

  test("says nothing about a different artist when every song matched under its own", () => {
    expect(formatBuildReply(setlist(), outcome())).not.toContain("Matched under a different artist");
  });

  test("the artist-mismatch note is the first dropped at the character ceiling", () => {
    // A long enough artist name that the tape and missing notes still fit, but there's no room
    // left for the (last-tried) artist-mismatch note too.
    const missing = Array.from({ length: 40 }, (_, i) => `A Very Long Song Title Number ${i}`);
    const reply = formatBuildReply(
      setlist({ artistName: "B".repeat(1480), tapeCount: 5 }),
      outcome({
        missing,
        foundElsewhere: [
          {
            song: { name: "Heartbreaker", searchArtist: "Pat Benatar & Neil Giraldo", isCover: false },
            match: {
              track: { uri: "u", name: "Heartbreaker", artistNames: ["Pat Benatar"], popularity: 50 },
              confidence: "high",
              score: 140,
            },
            foundUnder: "Pat Benatar",
          },
        ],
      }),
    );
    expect(reply.length).toBeLessThanOrEqual(2000);
    expect(reply).toContain("Skipped 5 played from tape");
    expect(reply).toContain("Couldn't find on Spotify");
    expect(reply).not.toContain("Matched under a different artist");
  });

  test("a setlist with no venue still reads correctly", () => {
    const reply = formatBuildReply(
      setlist({ venueName: undefined, cityName: undefined, countryName: undefined }),
      outcome(),
    );
    // #92: the date still follows, even with no venue to put it after.
    expect(reply.split("\n")[0]).toBe("**Band (2026-09-08)**");
  });

  test("names the artist used when it is not the one asked for", () => {
    const reply = formatBuildReply(setlist({ artistName: "Some Kind of Band" }), outcome(), "Band");
    expect(reply.split("\n")[0]).toBe('setlist.fm has no exact "Band"; this is the nearest match, Some Kind of Band.');
  });

  test("says nothing extra when the artist matches, whatever the case", () => {
    const reply = formatBuildReply(setlist({ artistName: "Band" }), outcome(), "band");
    expect(reply).not.toContain("no exact");
    expect(reply.split("\n")[0]).toContain("Band - The Venue");
  });
});

// ---------------------------------------------------------------------------------------------------
// #38: choosing between two shows on the same night
// ---------------------------------------------------------------------------------------------------

describe("the picker's customId", () => {
  test("starts with the plugin's own prefix, which is how the host routes it back to us", () => {
    expect(pickerCustomId("1234567890")).toStartWith("music:");
  });

  test("round-trips the user it belongs to", () => {
    expect(parsePickerCustomId(pickerCustomId("1234567890"))).toBe("1234567890");
  });

  test("stays inside Discord's 100-character ceiling with a real snowflake", () => {
    expect(pickerCustomId("123456789012345678".repeat(1)).length).toBeLessThanOrEqual(100);
  });

  test("another plugin's -- or an older version's -- id is not ours", () => {
    expect(parsePickerCustomId("warbandeer:link:1")).toBeUndefined();
    expect(parsePickerCustomId("music:something-else:1")).toBeUndefined();
    expect(parsePickerCustomId("music:setlist-pick:")).toBeUndefined();
  });
});

describe("choiceFor", () => {
  test("labels the option with the venue, the only thing that tells two same-night shows apart", () => {
    const choice = choiceFor(setlist({ venueName: "Leeds Festival", cityName: "Leeds" }));
    expect(choice.label).toBe("Leeds Festival, Leeds, United Kingdom");
  });

  test("carries the song count and the tour, which is what separates two duplicate entries", () => {
    const choice = choiceFor(
      setlist({ songs: [{ name: "Song", searchArtist: "Band", isCover: false }], tourName: "The Tour" }),
    );
    expect(choice.description).toBe("1 song - The Tour");
  });

  test("says 'songs' for anything but one", () => {
    expect(choiceFor(setlist({ tourName: undefined })).description).toBe("0 songs");
  });

  test("the value is the setlist id, which is what the handler re-fetches by", () => {
    expect(choiceFor(setlist()).value).toBe("abc123");
  });

  test("a setlist with no venue at all still gets a label, because Discord rejects an empty one", () => {
    const choice = choiceFor(setlist({ venueName: undefined, cityName: undefined, countryName: undefined }));
    expect(choice.label).toBe("Band");
  });

  test("an overlong venue or tour is clipped to Discord's 100-character limit", () => {
    const long = "x".repeat(200);
    const choice = choiceFor(setlist({ venueName: long, tourName: long }));
    expect(choice.label.length).toBe(100);
    expect(choice.description.length).toBe(100);
    expect(choice.label).toEndWith("...");
  });
});

describe("formatPickPrompt", () => {
  test("says how many shows there were, so the choice doesn't look arbitrary", () => {
    expect(formatPickPrompt("Band", 2, 2)).toContain("2 Band shows");
  });

  test("says so when there are more than the menu will hold", () => {
    expect(formatPickPrompt("Band", 25, 31)).toContain("Showing the first 25");
  });

  test("says nothing about truncation when nothing was truncated", () => {
    expect(formatPickPrompt("Band", 3, 3)).not.toContain("Showing the first");
  });
});

// ---------------------------------------------------------------------------------------------------
// #38: how /setlist routes url / artist / date
// ---------------------------------------------------------------------------------------------------

/**
 * A stand-in for the one slash-command interaction, carrying only what `handleSetlist` touches.
 * `edits` is what the user would end up seeing, since the handler defers first and then edits.
 * `followUps` are separate messages (public unless they carry the ephemeral flag themselves), and
 * `calls` is every call in the order it happened -- Discord resolves a deferred reply with the first
 * message sent after the defer, so the order decides whether a follow-up lands as its own message.
 */
function fakeCommand(options: Record<string, string>, userId = "user-1") {
  const edits: { content?: string; components?: unknown[] }[] = [];
  const replies: { content?: string }[] = [];
  const followUps: { content?: string; flags?: unknown }[] = [];
  const calls: string[] = [];
  const interaction = {
    user: { id: userId },
    deferred: false,
    replied: false,
    options: { getString: (name: string) => options[name] ?? null },
    deferReply: async () => {
      calls.push("defer");
      interaction.deferred = true;
    },
    reply: async (opts: { content?: string }) => {
      calls.push("reply");
      replies.push(opts);
      interaction.replied = true;
    },
    editReply: async (opts: { content?: string; components?: unknown[] }) => {
      calls.push("edit");
      edits.push(opts);
    },
    followUp: async (opts: { content?: string; flags?: unknown }) => {
      calls.push("followUp");
      followUps.push(opts);
    },
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, edits, replies, followUps, calls };
}

/**
 * What the user is shown, wherever the handler chose to put it. An ephemeral follow-up is shown to
 * the caller, so it counts; which of these were PUBLIC is for the tests that assert placement.
 */
function shown(run: {
  edits: { content?: string }[];
  replies: { content?: string }[];
  followUps: { content?: string }[];
}): string {
  return [...run.replies, ...run.edits, ...run.followUps].map((m) => m.content ?? "").join("\n");
}

function wire(showsOn: SetlistFmClient["showsOn"], latest?: SetlistFmClient["latestForArtist"]): void {
  const client: SetlistFmClient = {
    getSetlist: async (): Promise<SetlistFmResult> => ({ ok: false, error: "not used here" }),
    latestForArtist: latest ?? (async (): Promise<SetlistFmResult> => ({ ok: false, error: "not used here" })),
    showsOn,
  };
  logged = [];
  resetStoreForTest(freshState());
  initCommands({
    config: { setlistFmKey: "KEY", missing: [] },
    setlistFm: client,
    // Never reached by these tests: every one of them stops at resolution, or at the "connect
    // Spotify first" check that comes before any Spotify call.
    spotify: {} as unknown as SpotifyClient,
    serverRunning: () => true,
    log: captureLog,
  });
}

const handleSetlist = () => musicCommands().find((c) => c.name === "setlist")!.handle;

function dated(id: string, venue: string, songCount: number) {
  return setlist({
    id,
    venueName: venue,
    songs: Array.from({ length: songCount }, (_, i) => ({
      name: `Song ${i + 1}`,
      searchArtist: "Band",
      isCover: false,
    })),
  });
}

describe("/setlist with a date", () => {
  test("a date with no artist is refused before any request goes out", async () => {
    let called = false;
    wire(async () => {
      called = true;
      return { ok: true, setlists: [] };
    });
    const run = fakeCommand({ date: "2026-09-08" });
    await handleSetlist()(run.interaction);
    expect(shown(run)).toContain("needs an `artist`");
    expect(called).toBe(false);
  });

  test("an unreadable date is answered with the two spellings that work", async () => {
    wire(async () => ({ ok: true, setlists: [] }));
    const run = fakeCommand({ artist: "Band", date: "last tuesday" });
    await handleSetlist()(run.interaction);
    expect(shown(run)).toContain("2026-09-08");
    expect(shown(run)).toContain("08-09-2026");
  });

  test("the date reaches setlist.fm in its own dd-MM-yyyy, whatever the user typed", async () => {
    let seen = "";
    wire(async (_artist, date) => {
      seen = date;
      return { ok: true, setlists: [] };
    });
    await handleSetlist()(fakeCommand({ artist: "Band", date: "2026-09-08" }).interaction);
    expect(seen).toBe("08-09-2026");
  });

  test("no show that night says so plainly", async () => {
    wire(async () => ({ ok: true, setlists: [] }));
    const run = fakeCommand({ artist: "Band", date: "2026-09-08" });
    await handleSetlist()(run.interaction);
    expect(shown(run)).toContain("no \"Band\" show on 08-09-2026");
  });

  test("shows that exist but have no song list read differently from no show at all", async () => {
    wire(async () => ({ ok: true, setlists: [dated("aaa111", "The Cave", 0), dated("bbb222", "Big Field", 0)] }));
    const run = fakeCommand({ artist: "Band", date: "2026-09-08" });
    await handleSetlist()(run.interaction);
    expect(shown(run)).toContain("2 \"Band\" shows");
    expect(shown(run)).toContain("none with a song list filled in yet");
  });

  test("one filled-in show is used straight away, with no menu to click", async () => {
    wire(async () => ({ ok: true, setlists: [dated("aaa111", "The Cave", 3), dated("bbb222", "Big Field", 0)] }));
    const run = fakeCommand({ artist: "Band", date: "2026-09-08" });
    await handleSetlist()(run.interaction);
    expect(run.edits.some((e) => e.components !== undefined)).toBe(false);
    // Got past resolution and on to the user's own Spotify link, which is the next thing needed.
    expect(shown(run)).toContain("/spotify connect");
  });

  test("two filled-in shows put the choice to the user instead of guessing", async () => {
    wire(async () => ({ ok: true, setlists: [dated("aaa111", "The Cave", 12), dated("bbb222", "Big Field", 9)] }));
    const run = fakeCommand({ artist: "Band", date: "2026-09-08" });
    await handleSetlist()(run.interaction);
    const menu = run.edits.find((e) => e.components !== undefined);
    expect(menu).toBeDefined();
    expect(menu!.content).toContain("Pick the one you were at");
  });

  test("a setlist.fm failure is reported, not turned into an empty day", async () => {
    wire(async (): Promise<SetlistListResult> => ({ ok: false, error: "setlist.fm returned HTTP 503" }));
    const run = fakeCommand({ artist: "Band", date: "2026-09-08" });
    await handleSetlist()(run.interaction);
    expect(shown(run)).toContain("HTTP 503");
  });

  test("an artist with no date still takes their latest show, unchanged", async () => {
    let latestCalled = false;
    wire(
      async () => ({ ok: true, setlists: [] }),
      async (): Promise<SetlistFmResult> => {
        latestCalled = true;
        return { ok: false, error: "no setlists on setlist.fm for \"Band\"" };
      },
    );
    const run = fakeCommand({ artist: "Band" });
    await handleSetlist()(run.interaction);
    expect(latestCalled).toBe(true);
    expect(shown(run)).toContain("no setlists on setlist.fm");
  });
});

// ---------------------------------------------------------------------------------------------------
// #38: the picker's other half
// ---------------------------------------------------------------------------------------------------

/** A stand-in for the select-menu interaction, carrying only what `handlePick` touches. */
function fakePick(
  customId: string,
  values: string[],
  userId: string,
  isSelect = true,
) {
  const replies: { content?: string; flags?: unknown }[] = [];
  const updates: { content?: string; components?: unknown[] }[] = [];
  const edits: { content?: string }[] = [];
  const followUps: { content?: string; flags?: unknown }[] = [];
  // Every call in the order it happened, as in `fakeCommand`.
  const calls: string[] = [];
  const interaction = {
    customId,
    values,
    user: { id: userId },
    isStringSelectMenu: () => isSelect,
    reply: async (opts: { content?: string; flags?: unknown }) => {
      calls.push("reply");
      replies.push(opts);
    },
    update: async (opts: { content?: string; components?: unknown[] }) => {
      calls.push("update");
      updates.push(opts);
    },
    editReply: async (opts: { content?: string }) => {
      calls.push("edit");
      edits.push(opts);
    },
    followUp: async (opts: { content?: string; flags?: unknown }) => {
      calls.push("followUp");
      followUps.push(opts);
    },
  };
  return {
    interaction: interaction as unknown as MessageComponentInteraction,
    replies,
    updates,
    edits,
    followUps,
    calls,
  };
}

/**
 * Wires the picker's second half. By default nobody is connected and Spotify is a stand-in nothing
 * calls; `connected` stores a connection for "user-1" and `spotify` replaces the stand-in, for the
 * tests that need the build to get past (or fail at) the token.
 */
function wirePicker(
  getSetlist: SetlistFmClient["getSetlist"],
  { connected = false, spotify }: { connected?: boolean; spotify?: SpotifyClient } = {},
): void {
  logged = [];
  resetStoreForTest(connected ? putConnection(freshState(), "user-1", "RT", 1) : freshState());
  initCommands({
    config: { setlistFmKey: "KEY", missing: [] },
    setlistFm: {
      getSetlist,
      latestForArtist: async (): Promise<SetlistFmResult> => ({ ok: false, error: "not used here" }),
      showsOn: async (): Promise<SetlistListResult> => ({ ok: true, setlists: [] }),
    },
    spotify: spotify ?? ({} as unknown as SpotifyClient),
    serverRunning: () => true,
    log: captureLog,
  });
}

// ---------------------------------------------------------------------------------------------------
// #45: every build that actually ran is written to the match log
// ---------------------------------------------------------------------------------------------------

const STAMP = new Date("2026-09-20T12:00:00.000Z");

function track(name: string, artist = "Band"): TrackCandidate {
  return { uri: `spotify:track:${name.toLowerCase()}`, name, artistNames: [artist], popularity: 50 };
}

function buildSpotify(overrides: Partial<SpotifyClient> = {}): SpotifyClient {
  return {
    exchangeCode: async () => ({ ok: false, error: "not used" }),
    refresh: async () => ({ ok: true, value: { accessToken: "AT" } }),
    searchTracks: async (_token, query) => ({
      ok: true,
      value: query.includes("One") ? [track("One")] : [],
    }),
    createPlaylist: async () => ({ ok: true, value: { id: "PL1", url: "https://open.spotify.com/playlist/PL1" } }),
    addTracks: async (_token, _id, uris) => ({ ok: true, value: uris.length }),
    play: async () => ({ ok: false, error: "not used" }),
    playbackState: async () => ({ ok: false, error: "not used" }),
    devices: async () => ({ ok: false, error: "not used" }),
    transfer: async () => ({ ok: false, error: "not used" }),
    ...overrides,
  };
}

/** Wires a build that gets as far as Spotify, for a caller who has connected. */
function wireBuild(
  record: (run: MatchRun) => Promise<void>,
  spotify: SpotifyClient,
  {
    connected = true,
    songs = [
      { name: "One", searchArtist: "Band", isCover: false },
      { name: "Two", searchArtist: "Band", isCover: false },
    ],
    wired = true,
    artistName,
  }: { connected?: boolean; songs?: Setlist["songs"]; wired?: boolean; artistName?: string } = {},
): void {
  const two = setlist({ songs, ...(artistName !== undefined ? { artistName } : {}) });
  logged = [];
  resetStoreForTest(connected ? putConnection(freshState(), "user-1", "RT", 1) : freshState());
  initCommands({
    config: { setlistFmKey: "KEY", missing: [] },
    setlistFm: {
      getSetlist: async (): Promise<SetlistFmResult> => ({ ok: true, setlist: two }),
      latestForArtist: async (): Promise<SetlistFmResult> => ({ ok: true, setlist: two }),
      showsOn: async (): Promise<SetlistListResult> => ({ ok: true, setlists: [] }),
    },
    spotify,
    serverRunning: () => true,
    // `wired: false` is a plugin whose match log was never handed over: builds must still work.
    ...(wired ? { matchLog: { record } } : {}),
    now: () => STAMP,
    log: captureLog,
  });
}

describe("recording a build", () => {
  test("a successful build records one run matching the outcome", async () => {
    const recorded: MatchRun[] = [];
    wireBuild(async (run) => void recorded.push(run), buildSpotify());
    const run = fakeCommand({ artist: "Band" });
    await handleSetlist()(run.interaction);
    // The reply is the usual one: one song found, one not.
    expect(shown(run)).toContain("Added 1 of 2 songs.");
    expect(recorded).toHaveLength(1);
    const made = recorded[0]!;
    expect(made.at).toBe(STAMP.toISOString());
    expect(made.setlistId).toBe("abc123");
    expect(made.ok).toBe(true);
    expect(made.attempted).toBe(2);
    expect(made.added).toBe(1);
    expect(made.songs.map((s) => [s.name, s.outcome])).toEqual([
      ["One", "high"],
      ["Two", "missing"],
    ]);
  });

  test("a failed build is recorded too", async () => {
    const recorded: MatchRun[] = [];
    // Nothing matches, so the build fails with "none of the songs...".
    wireBuild(async (run) => void recorded.push(run), buildSpotify({ searchTracks: async () => ({ ok: true, value: [] }) }));
    const run = fakeCommand({ artist: "Band" });
    await handleSetlist()(run.interaction);
    expect(shown(run)).toContain("none of the songs");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.ok).toBe(false);
    expect(recorded[0]!.error).toContain("none of the songs");
    expect(recorded[0]!.added).toBe(0);
    expect(recorded[0]!.songs.map((s) => s.outcome)).toEqual(["missing", "missing"]);
  });

  test("a failed add tells the user where the half-filled playlist is", async () => {
    const recorded: MatchRun[] = [];
    wireBuild(
      async (run) => void recorded.push(run),
      buildSpotify({
        addTracks: async () => ({ ok: false, error: "Spotify returned HTTP 500 (after adding 100 of 250)" }),
      }),
    );
    const run = fakeCommand({ artist: "Band" });

    await handleSetlist()(run.interaction);

    // The reply is the failure text, and it now says where the playlist that was created is...
    expect(shown(run)).toContain("open.spotify.com/playlist/PL1");
    expect(shown(run)).toContain("HTTP 500");
    // ...and so does the log, apart from the error text, so the playlist can be found from the log.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.ok).toBe(false);
    expect(recorded[0]!.added).toBe(0);
    expect(recorded[0]!.playlistUrl).toBe("https://open.spotify.com/playlist/PL1");
  });

  test("a build picked from the same-day menu is recorded too", async () => {
    const recorded: MatchRun[] = [];
    wireBuild(async (run) => void recorded.push(run), buildSpotify());
    const run = fakePick(pickerCustomId("user-1"), ["abc123"], "user-1");
    await musicInteractions(run.interaction);
    expect(run.edits[0]!.content).toContain("Added 1 of 2 songs.");
    expect(recorded).toHaveLength(1);
  });

  test("a rejecting recorder never disturbs the reply", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const good = fakeCommand({ artist: "Band" });
      wireBuild(async () => {
        throw new Error("disk on fire");
      }, buildSpotify());
      await handleSetlist()(good.interaction);

      const failed = fakeCommand({ artist: "Band" });
      wireBuild(() => {
        // Throws before it can even return a promise.
        throw new Error("recorder exploded");
      }, buildSpotify({ searchTracks: async () => ({ ok: true, value: [] }) }));
      await handleSetlist()(failed.interaction);

      // Exactly what an unrecorded build would have said, on both arms.
      expect(good.edits).toEqual([{ content: expect.stringContaining("Added 1 of 2 songs.") }]);
      expect(failed.edits).toEqual([{ content: "none of the songs on that setlist could be found on Spotify" }]);
      // Never silent: the failure is reported somewhere.
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("a build whose reply fails to send is still recorded", async () => {
    const recorded: MatchRun[] = [];
    wireBuild(async (run) => void recorded.push(run), buildSpotify());
    const run = fakeCommand({ artist: "Band" });
    (run.interaction as unknown as { editReply: () => Promise<void> }).editReply = async () => {
      throw new Error("Unknown interaction");
    };
    // The failure still propagates as it always did -- only the record is added.
    await expect(handleSetlist()(run.interaction)).rejects.toThrow("Unknown interaction");
    expect(recorded).toHaveLength(1);
  });

  test("the reply goes out before the record is written, so a slow recorder cannot delay it", async () => {
    // Both arms: the success reply, and the failure text.
    for (const search of [
      buildSpotify(),
      buildSpotify({ searchTracks: async () => ({ ok: true, value: [] }) }),
    ]) {
      const events: string[] = [];
      wireBuild(async () => void events.push("record"), search);
      const run = fakeCommand({ artist: "Band" });
      const interaction = run.interaction as unknown as { editReply: (o: { content?: string }) => Promise<void> };
      const realEdit = interaction.editReply;
      interaction.editReply = async (opts) => {
        events.push("reply");
        await realEdit(opts);
      };
      await handleSetlist()(run.interaction);
      expect(events).toEqual(["reply", "record"]);
    }
  });

  test("a build with no match log wired replies normally and warns about nothing", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      wireBuild(async () => {}, buildSpotify(), { wired: false });
      const run = fakeCommand({ artist: "Band" });
      await handleSetlist()(run.interaction);
      expect(shown(run)).toContain("Added 1 of 2 songs.");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("a setlist with no songs is recorded as a failed run with none", async () => {
    const recorded: MatchRun[] = [];
    wireBuild(async (run) => void recorded.push(run), buildSpotify(), { songs: [] });
    const run = fakeCommand({ artist: "Band" });
    await handleSetlist()(run.interaction);
    expect(shown(run)).toContain("no songs on it yet");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ ok: false, attempted: 0, added: 0, songs: [] });
  });

  test("nothing is recorded when the Spotify connection no longer refreshes", async () => {
    const recorded: MatchRun[] = [];
    wireBuild(
      async (run) => void recorded.push(run),
      buildSpotify({
        refresh: async () => ({ ok: false, status: 400, code: "invalid_grant", error: "Refresh token revoked" }),
      }),
    );
    const run = fakeCommand({ artist: "Band" });
    await handleSetlist()(run.interaction);
    expect(shown(run)).toContain("no longer valid");
    expect(recorded).toEqual([]);
  });

  test("nothing is recorded and the connection is kept when Spotify cannot refresh it right now", async () => {
    const recorded: MatchRun[] = [];
    wireBuild(
      async (run) => void recorded.push(run),
      buildSpotify({ refresh: async () => ({ ok: false, status: 503, error: "Spotify returned HTTP 503" }) }),
    );
    const run = fakeCommand({ artist: "Band" });
    await handleSetlist()(run.interaction);
    expect(shown(run)).toContain("still saved");
    expect(shown(run)).not.toContain("no longer valid");
    expect(recorded).toEqual([]);
    expect(musicState().connections["user-1"]?.refreshToken).toBe("RT");
  });

  test("nothing is recorded when Spotify is not connected", async () => {
    const recorded: MatchRun[] = [];
    let searched = false;
    wireBuild(
      async (run) => void recorded.push(run),
      buildSpotify({
        searchTracks: async () => {
          searched = true;
          return { ok: true, value: [] };
        },
      }),
      { connected: false },
    );
    const run = fakeCommand({ artist: "Band" });
    await handleSetlist()(run.interaction);
    expect(shown(run)).toContain("/spotify connect");
    expect(searched).toBe(false);
    expect(recorded).toEqual([]);
  });

  test("nothing is recorded when Spotify isn't configured at all", async () => {
    const recorded: MatchRun[] = [];
    resetStoreForTest(freshState());
    initCommands({
      config: { setlistFmKey: "KEY", missing: ["SPOTIFY_CLIENT_ID"] },
      setlistFm: {
        getSetlist: async (): Promise<SetlistFmResult> => ({ ok: false, error: "not used here" }),
        latestForArtist: async (): Promise<SetlistFmResult> => ({ ok: false, error: "not used here" }),
        showsOn: async (): Promise<SetlistListResult> => ({ ok: true, setlists: [] }),
      },
      serverRunning: () => true,
      matchLog: { record: async (r) => void recorded.push(r) },
    });
    const run = fakeCommand({ artist: "Band" });
    await handleSetlist()(run.interaction);
    expect(recorded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// #65: naming the artist actually used, when it wasn't the one asked for
// ---------------------------------------------------------------------------------------------------

describe("naming the artist used", () => {
  test("/setlist artist: built from a loose match names the artist it used", async () => {
    wireBuild(async () => {}, buildSpotify(), { artistName: "Some Kind of Band" });
    const run = fakeCommand({ artist: "Band" });
    await handleSetlist()(run.interaction);
    expect(shown(run)).toContain('no exact "Band"');
    expect(shown(run)).toContain("Some Kind of Band");
  });

  test("/setlist url: never adds the note", async () => {
    wireBuild(async () => {}, buildSpotify(), { artistName: "Some Kind of Band" });
    const run = fakeCommand({ url: "https://www.setlist.fm/setlist/band/2026/the-venue-abc123.html" });
    await handleSetlist()(run.interaction);
    expect(shown(run)).not.toContain("no exact");
  });

  test("/setlist url: with a mismatched artist: still never adds the note -- the url wins for resolution", async () => {
    wireBuild(async () => {}, buildSpotify(), { artistName: "Band" });
    const run = fakeCommand({
      url: "https://www.setlist.fm/setlist/band/2026/the-venue-abc123.html",
      artist: "Totally Different Artist",
    });
    await handleSetlist()(run.interaction);
    expect(shown(run)).not.toContain("no exact");
  });
});

// ---------------------------------------------------------------------------------------------------
// #239: a failed Spotify refresh is the caller's business, not the channel's
// ---------------------------------------------------------------------------------------------------

/** What a Spotify refresh answers when the stored grant is dead (HTTP 400 `invalid_grant`). */
const DEAD_GRANT_REFRESH: SpotifyClient["refresh"] = async () => ({
  ok: false,
  status: 400,
  code: "invalid_grant",
  error: "Refresh token revoked",
});

/**
 * The one shape every token failure shares: the public reply is resolved with a neutral line, and
 * the reason -- the caller's own connection state -- arrives afterwards in a follow-up that only
 * they can see. `first` is whatever the handler did before the build (`defer` for a command,
 * `update` for the picker).
 */
function expectPrivateFailure(
  run: {
    edits: { content?: string }[];
    followUps: { content?: string; flags?: unknown }[];
    calls: string[];
  },
  first: string,
  reason: string,
): void {
  expect(run.edits).toHaveLength(1);
  expect(run.edits[0]?.content).toBe(PRIVATE_FAILURE_NOTE);
  expect(run.followUps).toHaveLength(1);
  expect(run.followUps[0]?.flags).toBe(MessageFlags.Ephemeral);
  expect(run.followUps[0]?.content).toContain(reason);
  expect(run.calls).toEqual([first, "edit", "followUp"]);
  expectOneStop("token");
}

describe("a failed Spotify refresh during /setlist stays with the caller", () => {
  test("a caller who hasn't connected is told privately", async () => {
    wireBuild(async () => {}, buildSpotify(), { connected: false });
    const run = fakeCommand({ artist: "Band" });
    await handleSetlist()(run.interaction);

    expectPrivateFailure(run, "defer", "/spotify connect");
  });

  test("a dead grant is told privately", async () => {
    wireBuild(async () => {}, buildSpotify({ refresh: DEAD_GRANT_REFRESH }));
    const run = fakeCommand({ artist: "Band" });
    await handleSetlist()(run.interaction);

    expectPrivateFailure(run, "defer", "no longer valid");
  });

  test("a refresh Spotify can't do right now is told privately too", async () => {
    wireBuild(
      async () => {},
      buildSpotify({ refresh: async () => ({ ok: false, status: 503, error: "Spotify returned HTTP 503" }) }),
    );
    const run = fakeCommand({ artist: "Band" });
    await handleSetlist()(run.interaction);

    expectPrivateFailure(run, "defer", "still saved");
  });

  test("a successful build still answers in the channel", async () => {
    wireBuild(async () => {}, buildSpotify());
    const run = fakeCommand({ artist: "Band" });
    await handleSetlist()(run.interaction);

    expect(run.edits).toHaveLength(1);
    expect(run.edits[0]?.content).toContain("Added 1 of 2 songs.");
    expect(run.followUps).toEqual([]);
    expect(run.calls).toEqual(["defer", "edit"]);
  });

  test("the public note says nothing about the caller's connection", () => {
    // It is the one thing the channel reads on a token failure; the reason is in the private note.
    expect(PRIVATE_FAILURE_NOTE).not.toMatch(/connect|valid|saved|refresh|spotify/i);
  });
});

describe("the show picker", () => {
  test("someone else's click is turned away, since the playlist would be built on their account", async () => {
    let fetched = false;
    wirePicker(async () => {
      fetched = true;
      return { ok: true, setlist: setlist() };
    });
    const run = fakePick(pickerCustomId("user-1"), ["abc123"], "user-2");
    await musicInteractions(run.interaction);
    expect(run.replies[0]!.content).toContain("belongs to whoever ran the command");
    expect(run.replies[0]!.flags).toBe(MessageFlags.Ephemeral);
    expect(run.updates).toEqual([]);
    expect(fetched).toBe(false);
  });

  test("a control the plugin no longer recognises gets a sentence, not Discord's 'interaction failed'", async () => {
    wirePicker(async () => ({ ok: true, setlist: setlist() }));
    const run = fakePick("music:something-retired", ["abc123"], "user-1");
    await musicInteractions(run.interaction);
    expect(run.replies[0]!.content).toContain("older version of the bot");
    expect(run.replies[0]!.flags).toBe(MessageFlags.Ephemeral);
  });

  test("the owner's pick takes the menu away before the build starts, so it can't be clicked twice", async () => {
    let asked = "";
    wirePicker(async (id) => {
      asked = id;
      return { ok: true, setlist: setlist({ id }) };
    });
    const run = fakePick(pickerCustomId("user-1"), ["bbb222"], "user-1");
    await musicInteractions(run.interaction);
    expect(run.updates[0]!.components).toEqual([]);
    // Re-fetched by id rather than held in memory between the two interactions.
    expect(asked).toBe("bbb222");
  });

  test("a setlist.fm failure after the pick is reported in the same message", async () => {
    wirePicker(async (): Promise<SetlistFmResult> => ({ ok: false, error: "setlist.fm returned HTTP 503" }));
    const run = fakePick(pickerCustomId("user-1"), ["bbb222"], "user-1");
    await musicInteractions(run.interaction);
    expect(run.edits[0]!.content).toContain("HTTP 503");
  });

  test("a picked show whose caller hasn't connected is told privately", async () => {
    wirePicker(async () => ({ ok: true, setlist: setlist() }));
    const run = fakePick(pickerCustomId("user-1"), ["abc123"], "user-1");
    await musicInteractions(run.interaction);

    expect(run.updates).toHaveLength(1);
    expect(run.updates[0]?.content).toBe("Building the playlist...");
    expectPrivateFailure(run, "update", "/spotify connect");
  });

  test("a picked show whose grant is dead is told privately", async () => {
    wirePicker(async () => ({ ok: true, setlist: setlist() }), {
      connected: true,
      spotify: buildSpotify({ refresh: DEAD_GRANT_REFRESH }),
    });
    const run = fakePick(pickerCustomId("user-1"), ["abc123"], "user-1");
    await musicInteractions(run.interaction);

    expect(run.updates).toHaveLength(1);
    expectPrivateFailure(run, "update", "no longer valid");
  });

  test("a picked show that builds still answers in the channel", async () => {
    wirePicker(
      async () => ({
        ok: true,
        setlist: setlist({
          songs: [
            { name: "One", searchArtist: "Band", isCover: false },
            { name: "Two", searchArtist: "Band", isCover: false },
          ],
        }),
      }),
      { connected: true, spotify: buildSpotify() },
    );
    const run = fakePick(pickerCustomId("user-1"), ["abc123"], "user-1");
    await musicInteractions(run.interaction);

    expect(run.edits).toHaveLength(1);
    expect(run.edits[0]?.content).toContain("Added 1 of 2 songs.");
    expect(run.followUps).toEqual([]);
    expect(run.calls).toEqual(["update", "edit"]);
  });

  test("an unconfigured Spotify is still answered in the channel, with no private note", async () => {
    // Configuration, not the caller's own state: the note-and-whisper treatment is for a connection
    // problem. (Only the picker reaches this: /setlist itself refuses first, before it defers.)
    logged = [];
    resetStoreForTest(freshState());
    initCommands({
      config: { setlistFmKey: "KEY", missing: ["SPOTIFY_CLIENT_ID"] },
      setlistFm: {
        getSetlist: async (): Promise<SetlistFmResult> => ({ ok: true, setlist: setlist() }),
        latestForArtist: async (): Promise<SetlistFmResult> => ({ ok: false, error: "not used here" }),
        showsOn: async (): Promise<SetlistListResult> => ({ ok: true, setlists: [] }),
      },
      serverRunning: () => true,
      log: captureLog,
    });
    const run = fakePick(pickerCustomId("user-1"), ["abc123"], "user-1");
    await musicInteractions(run.interaction);

    expect(run.edits).toHaveLength(1);
    expect(run.edits[0]?.content).toContain("SPOTIFY_CLIENT_ID");
    expect(run.followUps).toEqual([]);
    expect(run.calls).toEqual(["update", "edit"]);
    expectOneStop("not-configured");
  });
});

// ---------------------------------------------------------------------------------------------------
// #234: the Join button's reply is read from the party AFTER the first sync
// ---------------------------------------------------------------------------------------------------

describe("formatJoinReply", () => {
  const blocked: MemberOutcome = {
    discordUserId: USER,
    ok: false,
    error: "no Spotify player is awake -- open Spotify and press play on anything once, then rejoin",
  };

  test("a member whose Spotify took the command is told they're in", () => {
    const reply = formatJoinReply({ discordUserId: USER, ok: true }, true);
    expect(reply).toContain("You're in");
    expect(reply).not.toContain("Joined, but");
    expect(reply).not.toContain("Couldn't join");
  });

  test("a member who is still in the party but whose player didn't answer is told they joined, but", () => {
    const reply = formatJoinReply(blocked, true);
    expect(reply).toContain("Joined, but");
    expect(reply).toContain(blocked.error!);
    expect(reply).not.toContain("Couldn't join");
  });

  test("a member the first sync dropped is told they couldn't join, not that they joined", () => {
    const reply = formatJoinReply(blocked, false);
    expect(reply).toContain("Couldn't join");
    expect(reply).toContain(blocked.error!);
    expect(reply).not.toContain("Joined, but");
  });

  test("an outcome with no reason still says something, in both failure texts", () => {
    const silent: MemberOutcome = { discordUserId: USER, ok: false };
    expect(formatJoinReply(silent, true)).toContain("unknown reason");
    expect(formatJoinReply(silent, false)).toContain("unknown reason");
  });
});

/** A stand-in for the Join button's interaction, carrying only what `handlePartyJoin` touches. */
function fakeButton(customId: string, userId: string, guildId: string | null) {
  const replies: { content?: string }[] = [];
  const deferred: unknown[] = [];
  const edits: { content?: string }[] = [];
  const interaction = {
    customId,
    guildId,
    channelId: "C1",
    client: {},
    user: { id: userId },
    reply: async (opts: { content?: string }) => {
      replies.push(opts);
    },
    deferReply: async (opts: unknown) => {
      deferred.push(opts);
    },
    editReply: async (opts: { content?: string }) => {
      edits.push(opts);
    },
  };
  return { interaction: interaction as unknown as MessageComponentInteraction, replies, deferred, edits };
}

/** A runner that does nothing but what the Join handler asks of it: sync the joiner. */
function runnerWhoSyncs(syncMember: PartyRunner["syncMember"]): PartyRunner {
  return {
    playCurrent: async () => [],
    start: async () => [],
    skip: async () => [],
    syncMember,
    sweep: async () => {},
    stopAll() {},
    stop() {},
  };
}

// ---------------------------------------------------------------------------------------------------
// #189: /spotify connect
// ---------------------------------------------------------------------------------------------------

describe("/spotify connect", () => {
  test("the reply says not to share the link, and no longer claims it is only for the requester", async () => {
    resetStoreForTest(freshState());
    initCommands({
      config: {
        spotify: {
          clientId: "cid",
          clientSecret: "csecret",
          redirectUri: "https://bot.example.com/spotify/callback",
          callbackPath: "/spotify/callback",
        },
        missing: [],
      },
      serverRunning: () => true,
      log: captureLog,
    });
    const replies: { content?: string }[] = [];
    const interaction = {
      user: { id: USER },
      deferred: false,
      replied: false,
      options: { getSubcommand: () => "connect" },
      reply: async (opts: { content?: string }) => {
        replies.push(opts);
      },
    } as unknown as ChatInputCommandInteraction;

    await musicCommands().find((c) => c.name === "spotify")!.handle(interaction);

    expect(replies).toHaveLength(1);
    const content = replies[0]?.content ?? "";
    expect(content).toContain("[Connect your Spotify account](");
    expect(content).toContain("Don't share it");
    expect(content).toContain("whoever finishes it attaches their Spotify to your Discord account");
    expect(content).toContain("10 minutes");
    expect(content).toContain("Asking again replaces it");
    expect(content).not.toContain("only for you");
  });
});

/** A party mid-track with one member, and a joiner whose Spotify is connected with the party scopes. */
function wireJoin(syncMember: PartyRunner["syncMember"]): void {
  logged = [];
  resetStoreForTest(
    putConnection(putConnection(freshState(), USER, "RT", 1, PARTY_SCOPES), "host", "RT", 1, PARTY_SCOPES),
  );
  resetPartiesForTest(
    openParty(freshParties(), {
      guildId: "G1",
      channelId: "C1",
      hostId: "host",
      members: ["host"],
      queue: [{ uri: "spotify:track:one", name: "One", artist: "Band", durationMs: 180_000 }],
      index: 0,
      trackStartedAt: 1,
    }),
  );
  initCommands({
    config: { setlistFmKey: "KEY", missing: [] },
    spotify: buildSpotify({
      refresh: async () => ({ ok: true, value: { accessToken: "AT", scopes: PARTY_SCOPES } }),
    }),
    runner: runnerWhoSyncs(syncMember),
    serverRunning: () => true,
    log: captureLog,
  });
}

describe("the Join button", () => {
  afterEach(() => {
    resetPartiesForTest(freshParties());
    resetClientForTest();
  });

  test("a first sync that dropped the joiner is answered with 'Couldn't join', never 'Joined, but'", async () => {
    wireJoin(async (guildId, userId) => {
      // What the runner does to a fatal outcome before it hands the outcome back.
      await commitParties(removeMember(partiesState(), guildId, userId));
      return { discordUserId: userId, ok: false, fatal: true, error: "Spotify Premium is required to control playback" };
    });
    const run = fakeButton(PARTY_JOIN_ID, USER, "G1");

    await musicInteractions(run.interaction);

    expect(run.edits).toHaveLength(1);
    expect(run.edits[0]!.content).toContain("Couldn't join");
    expect(run.edits[0]!.content).toContain("Spotify Premium is required to control playback");
    expect(run.edits[0]!.content).not.toContain("Joined, but");
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host"]);
  });

  test("a first sync that left the joiner in is still answered with 'Joined, but'", async () => {
    const error = "no Spotify player is awake -- open Spotify and press play on anything once, then rejoin";
    wireJoin(async (_guildId, userId) => ({ discordUserId: userId, ok: false, error }));
    const run = fakeButton(PARTY_JOIN_ID, USER, "G1");

    await musicInteractions(run.interaction);

    expect(run.edits).toHaveLength(1);
    expect(run.edits[0]!.content).toContain("Joined, but");
    expect(run.edits[0]!.content).toContain(error);
    expect(run.edits[0]!.content).not.toContain("Couldn't join");
    expect(getParty(partiesState(), "G1")?.members).toEqual(["host", USER]);
  });

  test("the host dropped by their own Join, which closes the party, is told they couldn't join", async () => {
    wireJoin(async (guildId, userId) => {
      // Removing the host closes the party rather than orphaning it, so there is no party left to read.
      await commitParties(removeMember(partiesState(), guildId, userId));
      return { discordUserId: userId, ok: false, fatal: true, error: "Spotify Premium is required to control playback" };
    });
    const run = fakeButton(PARTY_JOIN_ID, "host", "G1");

    await musicInteractions(run.interaction);

    expect(getParty(partiesState(), "G1")).toBeUndefined();
    expect(run.edits).toHaveLength(1);
    expect(run.edits[0]!.content).toContain("Couldn't join");
    expect(run.edits[0]!.content).not.toContain("Joined, but");
  });
});

// ---------------------------------------------------------------------------------------------------
// #55: every /setlist run that stops before a build leaves exactly one line, id-free
// ---------------------------------------------------------------------------------------------------

describe("/setlist stop lines", () => {
  test("not configured", async () => {
    logged = [];
    resetStoreForTest(freshState());
    initCommands({
      config: { missing: ["SETLISTFM_API_KEY"] },
      serverRunning: () => true,
      log: captureLog,
    });
    const run = fakeCommand({ artist: "Band" }, USER);
    await handleSetlist()(run.interaction);
    expectOneStop("not-configured");
  });

  test("usage: neither url nor artist", async () => {
    wire(async () => ({ ok: true, setlists: [] }));
    const run = fakeCommand({}, USER);
    await handleSetlist()(run.interaction);
    expectOneStop("usage");
  });

  test("usage: a lone date with no artist", async () => {
    wire(async () => ({ ok: true, setlists: [] }));
    const run = fakeCommand({ date: "2026-09-08" }, USER);
    await handleSetlist()(run.interaction);
    expectOneStop("usage");
  });

  const LOOKUP_CASES: [name: string, options: Record<string, string>, setup: () => void][] = [
    ["a bad link", { url: "nope" }, () => wire(async () => ({ ok: true, setlists: [] }))],
    ["a getSetlist failure", { url: "abc123" }, () => wire(async () => ({ ok: true, setlists: [] }))],
    [
      "an unreadable date",
      { artist: "Band", date: "last tuesday" },
      () => wire(async () => ({ ok: true, setlists: [] })),
    ],
    [
      "no show on that date",
      { artist: "Band", date: "2026-09-08" },
      () => wire(async () => ({ ok: true, setlists: [] })),
    ],
    [
      "shows but no song list",
      { artist: "Band", date: "2026-09-08" },
      () => wire(async () => ({ ok: true, setlists: [dated("aaa111", "The Cave", 0)] })),
    ],
    [
      "a latestForArtist failure",
      { artist: "Band" },
      () => wire(async () => ({ ok: true, setlists: [] })),
    ],
  ];
  test.each(LOOKUP_CASES)("lookup: %s", async (_name, options, setup) => {
    setup();
    const run = fakeCommand(options, USER);
    await handleSetlist()(run.interaction);
    expectOneStop("lookup");
    expect(stops()[0]).toBe(`setlist stopped stage=lookup: ${shown(run)}`);
  });

  test("picker offered: not a stop, but still exactly one line", async () => {
    wire(async () => ({ ok: true, setlists: [dated("aaa111", "The Cave", 3), dated("bbb222", "Big Field", 5)] }));
    const run = fakeCommand({ artist: "Band", date: "2026-09-08" }, USER);
    await handleSetlist()(run.interaction);
    expect(logged).toEqual(["setlist picker offered: 2 of 2 shows"]);
    expect(stops()).toEqual([]);
  });

  test("handlePick: stale-control", async () => {
    wirePicker(async () => ({ ok: true, setlist: setlist() }));
    const run = fakePick(pickerCustomId(USER), ["abc123"], USER, false);
    await musicInteractions(run.interaction);
    expectOneStop("stale-control");
  });

  test("handlePick: not-owner", async () => {
    wirePicker(async () => ({ ok: true, setlist: setlist() }));
    const run = fakePick(pickerCustomId("someone-else"), ["abc123"], USER);
    await musicInteractions(run.interaction);
    expectOneStop("not-owner");
  });

  test("handlePick: a valid pick logs 'setlist picked'", async () => {
    wirePicker(async () => ({ ok: true, setlist: setlist() }));
    const run = fakePick(pickerCustomId(USER), ["abc123"], USER);
    await musicInteractions(run.interaction);
    expect(logged).toContain("setlist picked");
  });

  test("handlePick: not-configured", async () => {
    logged = [];
    resetStoreForTest(freshState());
    initCommands({
      config: { missing: ["SETLISTFM_API_KEY"] },
      serverRunning: () => true,
      log: captureLog,
    });
    const run = fakePick(pickerCustomId(USER), ["abc123"], USER);
    await musicInteractions(run.interaction);
    expectOneStop("not-configured");
  });

  test("handlePick: no-pick", async () => {
    wirePicker(async () => ({ ok: true, setlist: setlist() }));
    const run = fakePick(pickerCustomId(USER), [], USER);
    await musicInteractions(run.interaction);
    expectOneStop("no-pick");
  });

  test("handlePick: lookup", async () => {
    wirePicker(async (): Promise<SetlistFmResult> => ({ ok: false, error: "setlist.fm returned HTTP 503" }));
    const run = fakePick(pickerCustomId(USER), ["abc123"], USER);
    await musicInteractions(run.interaction);
    expectOneStop("lookup");
  });

  test("buildInto: not-configured, via the picker path with spotify undefined", async () => {
    logged = [];
    resetStoreForTest(freshState());
    initCommands({
      config: { setlistFmKey: "KEY", missing: ["SPOTIFY_CLIENT_ID"] },
      setlistFm: {
        getSetlist: async (): Promise<SetlistFmResult> => ({ ok: true, setlist: setlist() }),
        latestForArtist: async (): Promise<SetlistFmResult> => ({ ok: false, error: "not used here" }),
        showsOn: async (): Promise<SetlistListResult> => ({ ok: true, setlists: [] }),
      },
      serverRunning: () => true,
      log: captureLog,
    });
    const run = fakePick(pickerCustomId(USER), ["abc123"], USER);
    await musicInteractions(run.interaction);
    expectOneStop("not-configured");
  });

  test("buildInto: token, via the command path with a filled-in show and no Spotify connection", async () => {
    wire(async () => ({ ok: true, setlists: [dated("aaa111", "The Cave", 3), dated("bbb222", "Big Field", 0)] }));
    const run = fakeCommand({ artist: "Band", date: "2026-09-08" }, USER);
    await handleSetlist()(run.interaction);
    expectOneStop("token");
  });

  test("no stop line ever carries the user's id", async () => {
    const allLogged: string[] = [];

    async function exercise(act: () => Promise<void>): Promise<void> {
      logged = [];
      await act();
      allLogged.push(...logged);
    }

    // handleSetlist: not-configured
    await exercise(async () => {
      resetStoreForTest(freshState());
      initCommands({ config: { missing: ["SETLISTFM_API_KEY"] }, serverRunning: () => true, log: captureLog });
      await handleSetlist()(fakeCommand({ artist: "Band" }, USER).interaction);
    });

    // handleSetlist: usage, both sub-cases (neither url nor artist; a lone date with no artist)
    await exercise(async () => {
      wire(async () => ({ ok: true, setlists: [] }));
      await handleSetlist()(fakeCommand({}, USER).interaction);
    });
    await exercise(async () => {
      wire(async () => ({ ok: true, setlists: [] }));
      await handleSetlist()(fakeCommand({ date: "2026-09-08" }, USER).interaction);
    });

    // handleSetlist: lookup, every LOOKUP_CASES row -- not just one representative case
    for (const [, options, setup] of LOOKUP_CASES) {
      await exercise(async () => {
        setup();
        await handleSetlist()(fakeCommand(options, USER).interaction);
      });
    }

    // handleSetlist: picker offered (not a stop, but still a line that must be id-free)
    await exercise(async () => {
      wire(async () => ({ ok: true, setlists: [dated("aaa111", "The Cave", 3), dated("bbb222", "Big Field", 5)] }));
      await handleSetlist()(fakeCommand({ artist: "Band", date: "2026-09-08" }, USER).interaction);
    });

    // handleSetlist -> buildInto: token
    await exercise(async () => {
      wire(async () => ({ ok: true, setlists: [dated("aaa111", "The Cave", 3), dated("bbb222", "Big Field", 0)] }));
      await handleSetlist()(fakeCommand({ artist: "Band", date: "2026-09-08" }, USER).interaction);
    });

    // handlePick: stale-control
    await exercise(async () => {
      wirePicker(async () => ({ ok: true, setlist: setlist() }));
      await musicInteractions(fakePick(pickerCustomId(USER), ["abc123"], USER, false).interaction);
    });

    // handlePick: not-owner
    await exercise(async () => {
      wirePicker(async () => ({ ok: true, setlist: setlist() }));
      await musicInteractions(fakePick(pickerCustomId("someone-else"), ["abc123"], USER).interaction);
    });

    // handlePick: picked, then not-configured
    await exercise(async () => {
      resetStoreForTest(freshState());
      initCommands({ config: { missing: ["SETLISTFM_API_KEY"] }, serverRunning: () => true, log: captureLog });
      await musicInteractions(fakePick(pickerCustomId(USER), ["abc123"], USER).interaction);
    });

    // handlePick: picked, then no-pick
    await exercise(async () => {
      wirePicker(async () => ({ ok: true, setlist: setlist() }));
      await musicInteractions(fakePick(pickerCustomId(USER), [], USER).interaction);
    });

    // handlePick: picked, then lookup
    await exercise(async () => {
      wirePicker(async (): Promise<SetlistFmResult> => ({ ok: false, error: "setlist.fm returned HTTP 503" }));
      await musicInteractions(fakePick(pickerCustomId(USER), ["abc123"], USER).interaction);
    });

    // handlePick -> buildInto: not-configured
    await exercise(async () => {
      resetStoreForTest(freshState());
      initCommands({
        config: { setlistFmKey: "KEY", missing: ["SPOTIFY_CLIENT_ID"] },
        setlistFm: {
          getSetlist: async (): Promise<SetlistFmResult> => ({ ok: true, setlist: setlist() }),
          latestForArtist: async (): Promise<SetlistFmResult> => ({ ok: false, error: "not used here" }),
          showsOn: async (): Promise<SetlistListResult> => ({ ok: true, setlists: [] }),
        },
        serverRunning: () => true,
        log: captureLog,
      });
      await musicInteractions(fakePick(pickerCustomId(USER), ["abc123"], USER).interaction);
    });

    expect(allLogged.length).toBeGreaterThan(0);
    for (const line of allLogged) {
      expect(line).not.toContain(USER);
    }
  });

  test("a build that ran logs no stop line, whether it succeeded or failed", async () => {
    const recorded: MatchRun[] = [];

    // wireBuild connects "user-1" by default -- these run all the way to a build, unlike the
    // stop-line tests above which deliberately leave USER disconnected.
    wireBuild(async (run) => void recorded.push(run), buildSpotify());
    const good = fakeCommand({ artist: "Band" });
    await handleSetlist()(good.interaction);
    expect(stops()).toEqual([]);
    expect(recorded).toHaveLength(1);

    wireBuild(
      async (run) => void recorded.push(run),
      buildSpotify({ searchTracks: async () => ({ ok: false, error: "Spotify returned HTTP 429" }) }),
    );
    const failed = fakeCommand({ artist: "Band" });
    await handleSetlist()(failed.interaction);
    expect(stops()).toEqual([]);
    expect(recorded).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------
// #134: /party add checks access under an ephemeral reply; only the queue result is public
// ---------------------------------------------------------------------------------------------------

/**
 * A stand-in for a `/party <sub>` interaction. Records what the handler does with the reply, because
 * the whole point of #134 is WHICH replies are public: `defers` keeps the flags it deferred with (an
 * ephemeral defer makes the edit private), `edits` is the deferred reply, `followUps` are separate
 * messages (public unless they carry their own ephemeral flag), `replies` are direct answers.
 *
 * `calls` is every call in the order it happened. Order matters: Discord resolves a deferred reply
 * with the first message sent after the defer, so a follow-up sent BEFORE the edit would take over
 * the private reply's place instead of landing in the channel; and #153 is about what happens before
 * the defer. Pass the array `wireParty` returned and the token fake's refreshes and the runner's
 * skips land in the same sequence.
 *
 * `onDefer` runs inside `deferReply`, after the "defer" is recorded: what happens to the party during
 * the round trip to Discord that a real defer is (#152).
 */
function fakePartyCommand(
  sub: string,
  options: Record<string, string>,
  userId: string,
  guildId = "G1",
  calls: string[] = [],
  onDefer?: () => Promise<void>,
) {
  const defers: { flags?: unknown }[] = [];
  const edits: { content?: string }[] = [];
  const followUps: { content?: string; flags?: unknown }[] = [];
  const replies: { content?: string; flags?: unknown }[] = [];
  const interaction = {
    guildId,
    channelId: "C1",
    client: {},
    user: { id: userId },
    options: {
      getSubcommand: () => sub,
      getString: (name: string, required?: boolean) => {
        const value = options[name];
        if (value !== undefined) return value;
        if (required) throw new Error(`missing required option ${name}`);
        return null;
      },
    },
    deferReply: async (opts: { flags?: unknown } = {}) => {
      calls.push("defer");
      defers.push(opts);
      await onDefer?.();
    },
    editReply: async (opts: { content?: string }) => {
      calls.push("edit");
      edits.push(opts);
    },
    followUp: async (opts: { content?: string; flags?: unknown }) => {
      calls.push("followUp");
      followUps.push(opts);
    },
    reply: async (opts: { content?: string; flags?: unknown }) => {
      calls.push("reply");
      replies.push(opts);
    },
  };
  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    defers,
    edits,
    followUps,
    replies,
    calls,
  };
}

/**
 * A runner whose `start` records the guilds it was asked to start and answers with `outcomes`, and
 * whose `skip` records `skip:<guild>:<fromIndex>` on `calls` and answers with `skipOutcomes` -- or
 * `undefined`, a refusal, when `skipRefuses`.
 */
function partyRunnerDouble(
  started: string[],
  outcomes: MemberOutcome[],
  calls: string[] = [],
  skipOutcomes: MemberOutcome[] = [],
  skipRefuses = false,
): PartyRunner {
  return {
    playCurrent: async () => [],
    start: async (guildId): Promise<MemberOutcome[]> => {
      started.push(guildId);
      return outcomes;
    },
    skip: async (guildId, fromIndex): Promise<MemberOutcome[] | undefined> => {
      calls.push(`skip:${guildId}:${fromIndex}`);
      return skipRefuses ? undefined : skipOutcomes;
    },
    syncMember: async (_guildId, discordUserId): Promise<MemberOutcome> => ({ discordUserId, ok: true }),
    sweep: async () => {},
    stopAll() {},
    stop() {},
  };
}

/** A queued track for the party fixtures below. */
function partyTrack(name: string): PartyTrack {
  return { uri: `spotify:track:${name.toLowerCase()}`, name, artist: "Band", durationMs: 180_000 };
}

/**
 * `n` members the runner could not play for, each with an error sentence. A line is 88 characters
 * (89 with its newline), so 40 of them are about 3580 -- far past Discord's 2000, whatever line leads
 * them; 23 lines are enough on their own. The ids are built as strings: a number this size is past
 * 2^53, where neighbouring integers are the same double.
 */
function failures(n: number): MemberOutcome[] {
  return Array.from({ length: n }, (_, i) => ({
    discordUserId: `1000000000000000${String(i).padStart(2, "0")}`,
    ok: false,
    error: "their Spotify didn't take the command: no active device was found",
  }));
}

/**
 * Wires `/party` for USER in guild G1, with a party that is playing (default) or idle.
 *
 * Returns `calls`, one array in which the token fake's refreshes ("refresh") and the runner's skips
 * ("skip:<guild>:<fromIndex>") are recorded as they happen; hand it to `fakePartyCommand` and the interaction's
 * own calls join them, so a test can assert the exact order of everything the handler did.
 */
function wireParty({
  scopes,
  connected = true,
  searchHit = true,
  searchError,
  noDuration = false,
  party = "playing",
  outcomes = [{ discordUserId: USER, ok: true }],
  members = ["host"],
  queue,
  configured = true,
  skipOutcomes = [],
  skipRefuses = false,
  index = 0,
  search,
  noClock = false,
}: {
  scopes: string;
  connected?: boolean;
  searchHit?: boolean;
  searchError?: string;
  /** The one hit has no `durationMs`: Spotify didn't say how long the track is. */
  noDuration?: boolean;
  party?: "playing" | "idle";
  /** What the runner double reports back from `start`. */
  outcomes?: MemberOutcome[];
  /** Who is in the party; the host is "host". */
  members?: string[];
  /** The party's queue; by default one track when playing and none when idle. */
  queue?: PartyTrack[];
  /** False wires a bot with no Spotify app configured: no client, no runner. */
  configured?: boolean;
  /** What the runner double reports back from `skip`. */
  skipOutcomes?: MemberOutcome[];
  /** The runner double refuses every `skip` (answers `undefined`): the party had moved past it. */
  skipRefuses?: boolean;
  /** The seeded party's `index`: the track it is on, or the queue's length once it has run off the end. */
  index?: number;
  /** Replaces the Spotify search fake, to run something while a `/party add` is waiting on it. */
  search?: SpotifyClient["searchTracks"];
  /** Leaves the wiring's clock out, as production does: a started party is stamped with the real time. */
  noClock?: boolean;
}): { started: string[]; calls: string[] } {
  const started: string[] = [];
  const calls: string[] = [];
  logged = [];
  resetStoreForTest(connected ? putConnection(freshState(), USER, "RT", 1, scopes) : freshState());
  const seeded: Party = {
    guildId: "G1",
    channelId: "C1",
    hostId: "host",
    members,
    queue: queue ?? (party === "playing" ? [partyTrack("Zero")] : []),
    index,
    ...(party === "playing" ? { trackStartedAt: 1 } : {}),
  };
  resetPartiesForTest(openParty(freshParties(), seeded));
  initCommands({
    config: configured
      ? {
          setlistFmKey: "KEY",
          missing: [],
          spotify: {
            clientId: "cid",
            clientSecret: "csecret",
            redirectUri: "https://bot.example.com/spotify/callback",
            callbackPath: "/spotify/callback",
          },
        }
      : { setlistFmKey: "KEY", missing: ["SPOTIFY_CLIENT_ID"] },
    setlistFm: {
      getSetlist: async (): Promise<SetlistFmResult> => ({ ok: false, error: "not used here" }),
      latestForArtist: async (): Promise<SetlistFmResult> => ({ ok: false, error: "not used here" }),
      showsOn: async (): Promise<SetlistListResult> => ({ ok: true, setlists: [] }),
    },
    ...(configured
      ? {
          spotify: buildSpotify({
            refresh: async () => {
              calls.push("refresh");
              return { ok: true, value: { accessToken: "AT", scopes } };
            },
            searchTracks:
              search ??
              (async () =>
                searchError !== undefined
                  ? { ok: false, error: searchError }
                  : {
                      ok: true,
                      value: searchHit ? [noDuration ? track("One") : { ...track("One"), durationMs: 180_000 }] : [],
                    }),
          }),
          runner: partyRunnerDouble(started, outcomes, calls, skipOutcomes, skipRefuses),
        }
      : {}),
    serverRunning: () => true,
    // The clock a party an add starts is stamped with (a Date, as `Wiring.now` is).
    ...(noClock ? {} : { now: () => new Date(PARTY_NOW) }),
    log: captureLog,
  });
  return { started, calls };
}

/** The instant `wireParty`'s clock reports, as a number: what a started party's `trackStartedAt` is. */
const PARTY_NOW = 1_700_000_000_000;

/** The one Spotify hit for "One", with the length a party needs. */
const ONE_HIT = [{ ...track("One"), durationMs: 180_000 }];

const handleParty = () => musicCommands().find((c) => c.name === "party")!.handle;

describe("the party's add command", () => {
  test("a caller without the party scopes gets the authorize link ephemerally and the channel sees nothing", async () => {
    wireParty({ scopes: SPOTIFY_SCOPES });
    const run = fakePartyCommand("add", { query: "One" }, USER);
    await handleParty()(run.interaction);

    expect(run.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(run.edits).toHaveLength(1);
    expect(run.edits[0]?.content).toContain("Grant it here");
    // The link is the real one: it carries the single-use state token that was just minted for USER.
    const tokens = Object.keys(musicState().pending);
    expect(tokens).toHaveLength(1);
    expect(run.edits[0]?.content).toContain(`state=${tokens[0]}`);
    expect(run.followUps).toEqual([]);
    expect(run.replies).toEqual([]);
  });

  test("a caller who hasn't connected is told so ephemerally", async () => {
    wireParty({ scopes: PARTY_SCOPES, connected: false });
    const run = fakePartyCommand("add", { query: "One" }, USER);
    await handleParty()(run.interaction);

    expect(run.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(run.edits).toHaveLength(1);
    expect(run.edits[0]?.content).toContain("/spotify connect");
    expect(run.followUps).toEqual([]);
    expect(run.replies).toEqual([]);
  });

  test("a queued track is announced to the channel without any link", async () => {
    wireParty({ scopes: PARTY_SCOPES });
    const run = fakePartyCommand("add", { query: "One" }, USER);
    await handleParty()(run.interaction);

    expect(run.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(run.edits).toHaveLength(1);
    expect(run.edits[0]?.content).toContain("Queued **One**");
    expect(run.followUps).toHaveLength(1);
    expect(run.followUps[0]?.content).toContain(`<@${USER}> queued **One**`);
    // A follow-up with no flags of its own is a public message; one flagged ephemeral would hide the
    // announcement from the channel.
    expect(run.followUps[0]?.flags).toBeUndefined();
    expect(run.calls).toEqual(["defer", "edit", "followUp"]);
    for (const text of [run.edits[0]?.content, run.followUps[0]?.content]) {
      expect(text).not.toContain("authorize");
      expect(text).not.toContain("Grant it here");
    }
    expect(getParty(partiesState(), "G1")?.queue.map((t) => t.name)).toEqual(["Zero", "One"]);
    // A plain add to a playing party leaves its clock alone: re-stamping it would send the next
    // sweep to resync every member to the top of a track that is already well under way.
    expect(getParty(partiesState(), "G1")?.trackStartedAt).toBe(1);
  });

  test("adding to an idle party starts it and the channel hears who queued what", async () => {
    const { started } = wireParty({ scopes: PARTY_SCOPES, party: "idle" });
    const run = fakePartyCommand("add", { query: "One" }, USER);
    await handleParty()(run.interaction);

    expect(started).toEqual(["G1"]);
    expect(run.edits).toHaveLength(1);
    expect(run.edits[0]?.content).toContain("Started the party with **One**");
    expect(run.followUps).toHaveLength(1);
    expect(run.followUps[0]?.content).toContain(`<@${USER}> queued **One**`);
    expect(run.followUps[0]?.content).toContain("Playing for 1 person.");
    expect(run.followUps[0]?.flags).toBeUndefined();
    expect(run.calls).toEqual(["defer", "edit", "followUp"]);
  });

  test("the channel is told which party members the start could not reach", async () => {
    wireParty({
      scopes: PARTY_SCOPES,
      party: "idle",
      outcomes: [
        { discordUserId: USER, ok: true },
        { discordUserId: "friend", ok: false, error: "they need Spotify Premium" },
      ],
    });
    const run = fakePartyCommand("add", { query: "One" }, USER);
    await handleParty()(run.interaction);

    expect(run.followUps).toHaveLength(1);
    expect(run.followUps[0]?.content).toContain("Playing for 1 person.");
    expect(run.followUps[0]?.content).toContain("<@friend>: they need Spotify Premium");
    // The private confirmation carries no member problems -- those belong to the channel.
    expect(run.edits[0]?.content).not.toContain("friend");
  });

  test("an idle add's announcement fits Discord's limit when many members fail", async () => {
    wireParty({ scopes: PARTY_SCOPES, party: "idle", outcomes: failures(40) });
    const run = fakePartyCommand("add", { query: "One" }, USER);
    await handleParty()(run.interaction);

    expect(run.followUps).toHaveLength(1);
    const content = run.followUps[0]?.content ?? "";
    expect(content.length).toBeLessThanOrEqual(2000);
    // The lead survives the cut, and so does the start of the member list; the tail is what goes.
    expect(content.startsWith(`<@${USER}> queued **One** -- Band\nPlaying for 0 people.\n`)).toBe(true);
    expect(content).toContain("<@100000000000000000>:");
    expect(content.endsWith("...")).toBe(true);
  });

  // #152 (A) and (B): the decision to start is made from the party as it is after the search.

  test("an add to a party that ran off the end starts it, index and all", async () => {
    // The shape `advance` leaves when the queue runs out: index at the queue's length, nothing playing.
    const { started } = wireParty({
      scopes: PARTY_SCOPES,
      party: "idle",
      index: 1,
      queue: [partyTrack("Zero")],
    });
    const run = fakePartyCommand("add", { query: "One" }, USER);
    await handleParty()(run.interaction);

    expect(started).toEqual(["G1"]);
    expect(run.edits[0]?.content).toContain("Started the party with **One**");
    const after = getParty(partiesState(), "G1");
    expect(after?.index).toBe(1);
    expect(after?.queue.map((t) => t.name)).toEqual(["Zero", "One"]);
    expect(after?.trackStartedAt).toBe(PARTY_NOW);
  });

  test("a party left open but not playing, with a track still waiting, is started by the next add", async () => {
    // The wedged shape an earlier late add left behind (and may have saved to parties.json): not
    // playing, but `index` short of the queue's end, which the old test read as "something to play".
    // The start plays the track it was stuck on ("Stuck"), the new one waits behind it; the reply
    // still names the track just added, an oddity of this one-off recovery.
    const { started } = wireParty({
      scopes: PARTY_SCOPES,
      party: "idle",
      index: 1,
      queue: [partyTrack("Zero"), partyTrack("Stuck")],
    });
    const run = fakePartyCommand("add", { query: "One" }, USER);
    await handleParty()(run.interaction);

    expect(started).toEqual(["G1"]);
    expect(run.edits[0]?.content).toContain("Started the party with");
    const after = getParty(partiesState(), "G1");
    expect(after?.index).toBe(1);
    expect(after?.queue.map((t) => t.name)).toEqual(["Zero", "Stuck", "One"]);
    expect(after?.trackStartedAt).toBe(PARTY_NOW);
  });

  test("an add that lands while the last track ends starts the party instead of wedging it", async () => {
    const { started } = wireParty({
      scopes: PARTY_SCOPES,
      // The boundary timer firing while the add waits on Spotify: the queue runs out, `index` is
      // parked at its end and the party stops playing.
      search: async () => {
        await commitParties(advance(partiesState(), "G1", PARTY_NOW).state);
        return { ok: true, value: ONE_HIT };
      },
    });
    const run = fakePartyCommand("add", { query: "One" }, USER);
    await handleParty()(run.interaction);

    expect(started).toEqual(["G1"]);
    expect(run.edits[0]?.content).toContain("Started the party with **One**");
    const after = getParty(partiesState(), "G1");
    expect(after?.index).toBe(1);
    expect(after?.queue.map((t) => t.name)).toEqual(["Zero", "One"]);
    expect(after?.trackStartedAt).toBe(PARTY_NOW);
  });

  test("two adds racing on an idle party start it once, and the second is told its track is queued", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = 0;
    let bothArrived!: () => void;
    const both = new Promise<void>((resolve) => {
      bothArrived = resolve;
    });
    const { started } = wireParty({
      scopes: PARTY_SCOPES,
      party: "idle",
      // Both adds park here, past their access checks, until the test has seen both arrive and lets
      // them go together.
      search: async () => {
        arrived += 1;
        if (arrived === 2) bothArrived();
        await gate;
        return { ok: true, value: ONE_HIT };
      },
    });
    const first = fakePartyCommand("add", { query: "One" }, USER);
    const second = fakePartyCommand("add", { query: "One" }, USER);
    const pending = [handleParty()(first.interaction), handleParty()(second.interaction)];
    await both;
    expect(started).toEqual([]);
    release();
    await Promise.all(pending);

    // One start; one add told it started the party and the other told its track was queued.
    expect(started).toEqual(["G1"]);
    const edits = [first.edits[0]?.content ?? "", second.edits[0]?.content ?? ""];
    expect(edits.filter((e) => e.includes("Started the party with **One**"))).toHaveLength(1);
    expect(edits.filter((e) => e.includes("Queued **One**"))).toHaveLength(1);
    const queuedRun = first.edits[0]?.content?.includes("Queued") ? first : second;
    expect(queuedRun.followUps).toHaveLength(1);
    expect(queuedRun.followUps[0]?.content).not.toContain("Playing for");
    expect(getParty(partiesState(), "G1")?.queue.map((t) => t.name)).toEqual(["One", "One"]);
  });

  test("without a wiring clock, as in production, the started party is stamped with the real time", async () => {
    wireParty({ scopes: PARTY_SCOPES, party: "idle", noClock: true });
    const before = Date.now();
    const run = fakePartyCommand("add", { query: "One" }, USER);
    await handleParty()(run.interaction);
    const after = Date.now();

    const stamped = getParty(partiesState(), "G1")?.trackStartedAt;
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  test("an add whose party ended while it was searching says so", async () => {
    const { started } = wireParty({
      scopes: PARTY_SCOPES,
      // `/party stop`, or a host dropping out, while the add waits on Spotify.
      search: async () => {
        await commitParties(closeParty(partiesState(), "G1"));
        return { ok: true, value: ONE_HIT };
      },
    });
    const run = fakePartyCommand("add", { query: "One" }, USER);
    await handleParty()(run.interaction);

    expect(run.edits).toHaveLength(1);
    expect(run.edits[0]?.content).toContain("The party ended");
    expect(run.followUps).toEqual([]);
    expect(started).toEqual([]);
  });

  test("a track Spotify gave no length for stays with the invoker", async () => {
    const { started } = wireParty({ scopes: PARTY_SCOPES, party: "idle", noDuration: true });
    const run = fakePartyCommand("add", { query: "One" }, USER);
    await handleParty()(run.interaction);

    expect(run.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(run.edits).toHaveLength(1);
    expect(run.edits[0]?.content).toContain("didn't say how long");
    expect(run.followUps).toEqual([]);
    expect(started).toEqual([]);
    expect(getParty(partiesState(), "G1")?.queue).toEqual([]);
  });

  test("a search failure stays with the invoker", async () => {
    wireParty({ scopes: PARTY_SCOPES, searchError: "Spotify returned HTTP 503" });
    const run = fakePartyCommand("add", { query: "One" }, USER);
    await handleParty()(run.interaction);

    expect(run.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(run.edits).toHaveLength(1);
    expect(run.edits[0]?.content).toContain("search failed");
    expect(run.followUps).toEqual([]);
  });

  test("a query nothing matched stays with the invoker", async () => {
    wireParty({ scopes: PARTY_SCOPES, searchHit: false });
    const run = fakePartyCommand("add", { query: "One" }, USER);
    await handleParty()(run.interaction);

    expect(run.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(run.edits).toHaveLength(1);
    expect(run.edits[0]?.content).toContain("Nothing on Spotify matched");
    expect(run.followUps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// #153: /party skip acknowledges Discord first and needs none of the skipper's own Spotify
// ---------------------------------------------------------------------------------------------------

describe("the party's skip command", () => {
  test("a member's skip is acknowledged before anything is awaited, with no refresh of their token ahead of it", async () => {
    // USER is connected with the party scopes, so the old access check WOULD have refreshed their
    // token ahead of the defer. The runner here is a double that refreshes nothing, so "refresh"
    // appearing anywhere in the sequence would mean the command layer did it.
    const { calls } = wireParty({
      scopes: PARTY_SCOPES,
      members: ["host", USER],
      queue: [partyTrack("One"), partyTrack("Two")],
    });
    const run = fakePartyCommand("skip", {}, USER, "G1", calls);
    const pending = handleParty()(run.interaction);
    // Synchronously, before the first microtask turn: the defer is already out. An await of anything
    // -- a refresh, a store commit, a bare Promise.resolve() -- ahead of it would leave `calls` empty.
    expect(calls).toEqual(["defer"]);
    await pending;

    // The runner is told which track this skip is for: the index the skipper saw.
    expect(calls).toEqual(["defer", "skip:G1:0", "edit"]);
    // A public defer: the "Skipped to" line is for the channel.
    expect(run.defers).toEqual([{}]);
    expect(run.edits[0]?.content).toContain("Skipped to **Two** -- Band");
  });

  test("a skip's reply fits Discord's limit when many members fail", async () => {
    const { calls } = wireParty({
      scopes: PARTY_SCOPES,
      members: ["host", USER],
      queue: [partyTrack("One"), partyTrack("Two")],
      skipOutcomes: failures(40),
    });
    const run = fakePartyCommand("skip", {}, USER, "G1", calls);
    await handleParty()(run.interaction);

    expect(run.edits).toHaveLength(1);
    const content = run.edits[0]?.content ?? "";
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content.startsWith("Skipped to **Two** -- Band\nPlaying for 0 people.\n")).toBe(true);
    expect(content).toContain("<@100000000000000000>:");
    expect(content.endsWith("...")).toBe(true);
  });

  test("a skip in a server with no party is refused without a defer", async () => {
    const { calls } = wireParty({ scopes: PARTY_SCOPES, members: ["host", USER] });
    // The party is in G1; this interaction comes from G2.
    const run = fakePartyCommand("skip", {}, USER, "G2", calls);
    await handleParty()(run.interaction);

    expect(calls).toEqual(["reply"]);
    expect(run.replies[0]?.content).toContain("No party here");
    expect(run.replies[0]?.flags).toBe(MessageFlags.Ephemeral);
  });

  test("a non-member is refused without a defer", async () => {
    const { calls } = wireParty({
      scopes: PARTY_SCOPES,
      members: ["host"],
      queue: [partyTrack("One"), partyTrack("Two")],
    });
    const run = fakePartyCommand("skip", {}, USER, "G1", calls);
    await handleParty()(run.interaction);

    expect(calls).toEqual(["reply"]);
    expect(run.replies[0]?.content).toContain("Only people in the party can skip");
    expect(run.replies[0]?.flags).toBe(MessageFlags.Ephemeral);
  });

  test("the last track answers after the defer and does not advance", async () => {
    const { calls } = wireParty({ scopes: PARTY_SCOPES, members: ["host", USER] });
    const run = fakePartyCommand("skip", {}, USER, "G1", calls);
    await handleParty()(run.interaction);

    expect(calls).toEqual(["defer", "edit"]);
    expect(run.edits[0]?.content).toContain("last track");
  });

  test("a skip when the feature is not configured is refused ephemerally", async () => {
    const { calls } = wireParty({
      scopes: PARTY_SCOPES,
      configured: false,
      members: ["host", USER],
      queue: [partyTrack("One"), partyTrack("Two")],
    });
    const run = fakePartyCommand("skip", {}, USER, "G1", calls);
    await handleParty()(run.interaction);

    expect(calls).toEqual(["reply"]);
    expect(run.replies[0]?.content).toContain("SPOTIFY_CLIENT_ID");
    expect(run.replies[0]?.flags).toBe(MessageFlags.Ephemeral);
  });

  // #152 (C): the party moves while the defer is in flight; the skip is decided from the party as it
  // is after it, and the runner is told which track the skip was for.

  test("a skip from a later track tells the runner that track's index", async () => {
    const { calls } = wireParty({
      scopes: PARTY_SCOPES,
      members: ["host", USER],
      index: 1,
      queue: [partyTrack("One"), partyTrack("Two"), partyTrack("Three")],
    });
    const run = fakePartyCommand("skip", {}, USER, "G1", calls);
    await handleParty()(run.interaction);

    expect(calls).toEqual(["defer", "skip:G1:1", "edit"]);
    expect(run.edits[0]?.content).toContain("Skipped to **Three**");
  });

  test("a skip whose party stopped on another track during the defer says nothing is playing", async () => {
    const { calls } = wireParty({
      scopes: PARTY_SCOPES,
      members: ["host", USER],
      queue: [partyTrack("One"), partyTrack("Two")],
    });
    const run = fakePartyCommand("skip", {}, USER, "G1", calls, async () => {
      // Not playing, and on another track: the shape a party has when a run-off party has had a track
      // queued behind its index and nothing has started it yet.
      const { trackStartedAt: _stopped, ...stopped } = getParty(partiesState(), "G1")!;
      await commitParties(openParty(partiesState(), { ...stopped, index: 1 }));
    });
    await handleParty()(run.interaction);

    expect(calls).toEqual(["defer", "edit"]);
    expect(run.edits[0]?.content).toContain("The track changed just now");
    expect(run.edits[0]?.content).toContain("nothing playing");
    // The track at the party's index is not named: nothing is playing it.
    expect(run.edits[0]?.content).not.toContain("**Two**");
  });

  test("a skip whose track changed during the defer is refused", async () => {
    const { calls } = wireParty({
      scopes: PARTY_SCOPES,
      members: ["host", USER],
      queue: [partyTrack("One"), partyTrack("Two"), partyTrack("Three")],
    });
    // The track ends on its own, or another member skips, while this skip's defer is out.
    const run = fakePartyCommand("skip", {}, USER, "G1", calls, async () => {
      await commitParties(advance(partiesState(), "G1", 2).state);
    });
    await handleParty()(run.interaction);

    expect(calls).toEqual(["defer", "edit"]);
    expect(run.edits[0]?.content).toContain("The track changed just now");
    expect(run.edits[0]?.content).toContain("**Two**");
    expect(run.edits[0]?.content).not.toContain("Skipped to");
  });

  test("a skip whose track ran out during the defer says nothing is playing", async () => {
    const { calls } = wireParty({ scopes: PARTY_SCOPES, members: ["host", USER] });
    // The party has one track, and it ends while the defer is out: the party is parked off the end.
    const run = fakePartyCommand("skip", {}, USER, "G1", calls, async () => {
      await commitParties(advance(partiesState(), "G1", 2).state);
    });
    await handleParty()(run.interaction);

    expect(calls).toEqual(["defer", "edit"]);
    expect(run.edits[0]?.content).toContain("The track changed just now");
    expect(run.edits[0]?.content).toContain("nothing playing");
  });

  test("a track queued during the defer is skipped to", async () => {
    const { calls } = wireParty({ scopes: PARTY_SCOPES, members: ["host", USER], queue: [partyTrack("One")] });
    const run = fakePartyCommand("skip", {}, USER, "G1", calls, async () => {
      await commitParties(enqueue(partiesState(), "G1", [partyTrack("Two")]));
    });
    await handleParty()(run.interaction);

    expect(calls).toEqual(["defer", "skip:G1:0", "edit"]);
    expect(run.edits[0]?.content).toContain("Skipped to **Two**");
  });

  test("a skip whose party ended during the defer says so", async () => {
    const { calls } = wireParty({
      scopes: PARTY_SCOPES,
      members: ["host", USER],
      queue: [partyTrack("One"), partyTrack("Two")],
    });
    const run = fakePartyCommand("skip", {}, USER, "G1", calls, async () => {
      await commitParties(closeParty(partiesState(), "G1"));
    });
    await handleParty()(run.interaction);

    expect(calls).toEqual(["defer", "edit"]);
    expect(run.edits[0]?.content).toContain("The party ended just now");
  });

  test("a skip the runner refused is answered with the current track", async () => {
    const { calls } = wireParty({
      scopes: PARTY_SCOPES,
      members: ["host", USER],
      queue: [partyTrack("One"), partyTrack("Two")],
      skipRefuses: true,
    });
    const run = fakePartyCommand("skip", {}, USER, "G1", calls);
    await handleParty()(run.interaction);

    expect(calls).toEqual(["defer", "skip:G1:0", "edit"]);
    expect(run.edits[0]?.content).toContain("The track changed just now");
    expect(run.edits[0]?.content).toContain("**One**");
    expect(run.edits[0]?.content).not.toContain("Skipped to");
  });
});

// ---------------------------------------------------------------------------------------------------
// #240: formatOutcomes clips the whole reply, the caller's lead line included
// ---------------------------------------------------------------------------------------------------

describe("formatOutcomes with a leading line", () => {
  const ONE_PLAYED = [{ discordUserId: USER, ok: true }];

  test("the whole message, lead included, fits Discord's limit", () => {
    const lead = "<@1> queued **One** -- Band";
    // The fixture really is 40 different members, not 40 copies of a few.
    expect(new Set(failures(40).map((o) => o.discordUserId)).size).toBe(40);
    const text = formatOutcomes(failures(40), lead);

    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.startsWith(`${lead}\nPlaying for 0 people.\n`)).toBe(true);
    expect(text.endsWith("...")).toBe(true);
  });

  test("a message that fits is untouched", () => {
    expect(formatOutcomes(ONE_PLAYED, "Skipped to **Two** -- Band")).toBe(
      "Skipped to **Two** -- Band\nPlaying for 1 person.",
    );
  });

  test("without a lead it reads as before", () => {
    expect(formatOutcomes(ONE_PLAYED)).toBe("Playing for 1 person.");
  });

  test("a message of exactly 2000 characters is untouched, and one more is cut to 2000", () => {
    // lead + "\n" + "Playing for 1 person." (21 characters)
    const fits = "x".repeat(2000 - 1 - 21);
    expect(formatOutcomes(ONE_PLAYED, fits)).toBe(`${fits}\nPlaying for 1 person.`);
    expect(formatOutcomes(ONE_PLAYED, fits).length).toBe(2000);

    const over = formatOutcomes(ONE_PLAYED, `${fits}x`);
    expect(over.length).toBe(2000);
    expect(over.endsWith("...")).toBe(true);
    expect(over.startsWith(`${fits}x`)).toBe(true);
  });

  test("a lead too long to fit on its own is cut with the rest, never sent over the limit", () => {
    const text = formatOutcomes(ONE_PLAYED, "x".repeat(2500));

    expect(text.length).toBe(2000);
    expect(text).toBe(`${"x".repeat(1997)}...`);
  });
});
