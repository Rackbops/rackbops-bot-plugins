import { describe, expect, spyOn, test } from "bun:test";
import type { ChatInputCommandInteraction, MessageComponentInteraction } from "discord.js";
import {
  choiceFor,
  formatBuildReply,
  formatNotConfigured,
  formatPickPrompt,
  initCommands,
  musicCommands,
  musicInteractions,
  parsePickerCustomId,
  pickerCustomId,
} from "./commands.js";
import type { SetlistFmClient, SetlistFmResult, SetlistListResult } from "./setlistfm.js";
import type { SpotifyClient } from "./spotify.js";
import { freshState, putConnection, resetStoreForTest } from "./store.js";
import type { BuildOutcome } from "./build.js";
import type { MatchRun } from "./matchlog.js";
import type { TrackCandidate } from "./matching.js";
import type { Setlist } from "./setlistfm.js";

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

  test("says how many tape tracks were skipped, so the count isn't a silent mystery", () => {
    const reply = formatBuildReply(setlist({ tapeCount: 2 }), outcome());
    expect(reply).toContain("Skipped 2 played from tape");
  });

  test("says nothing about tape when there was none", () => {
    expect(formatBuildReply(setlist(), outcome())).not.toContain("tape");
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
            },
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

  test("a setlist with no venue still reads correctly", () => {
    const reply = formatBuildReply(
      setlist({ venueName: undefined, cityName: undefined, countryName: undefined }),
      outcome(),
    );
    expect(reply.split("\n")[0]).toBe("**Band**");
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
 */
function fakeCommand(options: Record<string, string>, userId = "user-1") {
  const edits: { content?: string; components?: unknown[] }[] = [];
  const replies: { content?: string }[] = [];
  const interaction = {
    user: { id: userId },
    deferred: false,
    replied: false,
    options: { getString: (name: string) => options[name] ?? null },
    deferReply: async () => {
      interaction.deferred = true;
    },
    reply: async (opts: { content?: string }) => {
      replies.push(opts);
      interaction.replied = true;
    },
    editReply: async (opts: { content?: string; components?: unknown[] }) => {
      edits.push(opts);
    },
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, edits, replies };
}

/** What the user is shown, wherever the handler chose to put it. */
function shown(run: { edits: { content?: string }[]; replies: { content?: string }[] }): string {
  return [...run.replies, ...run.edits].map((m) => m.content ?? "").join("\n");
}

function wire(showsOn: SetlistFmClient["showsOn"], latest?: SetlistFmClient["latestForArtist"]): void {
  const client: SetlistFmClient = {
    getSetlist: async (): Promise<SetlistFmResult> => ({ ok: false, error: "not used here" }),
    latestForArtist: latest ?? (async (): Promise<SetlistFmResult> => ({ ok: false, error: "not used here" })),
    showsOn,
  };
  resetStoreForTest(freshState());
  initCommands({
    config: { setlistFmKey: "KEY", missing: [] },
    setlistFm: client,
    // Never reached by these tests: every one of them stops at resolution, or at the "connect
    // Spotify first" check that comes before any Spotify call.
    spotify: {} as unknown as SpotifyClient,
    serverRunning: () => true,
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
  const replies: { content?: string }[] = [];
  const updates: { content?: string; components?: unknown[] }[] = [];
  const edits: { content?: string }[] = [];
  const interaction = {
    customId,
    values,
    user: { id: userId },
    isStringSelectMenu: () => isSelect,
    reply: async (opts: { content?: string }) => {
      replies.push(opts);
    },
    update: async (opts: { content?: string; components?: unknown[] }) => {
      updates.push(opts);
    },
    editReply: async (opts: { content?: string }) => {
      edits.push(opts);
    },
  };
  return { interaction: interaction as unknown as MessageComponentInteraction, replies, updates, edits };
}

function wirePicker(getSetlist: SetlistFmClient["getSetlist"]): void {
  resetStoreForTest(freshState());
  initCommands({
    config: { setlistFmKey: "KEY", missing: [] },
    setlistFm: {
      getSetlist,
      latestForArtist: async (): Promise<SetlistFmResult> => ({ ok: false, error: "not used here" }),
      showsOn: async (): Promise<SetlistListResult> => ({ ok: true, setlists: [] }),
    },
    spotify: {} as unknown as SpotifyClient,
    serverRunning: () => true,
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
  { connected = true }: { connected?: boolean } = {},
): void {
  const two = setlist({
    songs: [
      { name: "One", searchArtist: "Band", isCover: false },
      { name: "Two", searchArtist: "Band", isCover: false },
    ],
  });
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
    matchLog: { record },
    now: () => STAMP,
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
    expect(run.updates).toEqual([]);
    expect(fetched).toBe(false);
  });

  test("a control the plugin no longer recognises gets a sentence, not Discord's 'interaction failed'", async () => {
    wirePicker(async () => ({ ok: true, setlist: setlist() }));
    const run = fakePick("music:something-retired", ["abc123"], "user-1");
    await musicInteractions(run.interaction);
    expect(run.replies[0]!.content).toContain("older version of the bot");
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
});
