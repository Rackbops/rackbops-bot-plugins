import { describe, expect, test } from "bun:test";
import { buildPlaylist, findSong, isoDate, playlistDescription, playlistName } from "./build.js";
import type { Setlist, SetlistSong } from "./setlistfm.js";
import type { SpotifyClient } from "./spotify.js";
import type { TrackCandidate } from "./matching.js";

function song(name: string, searchArtist = "Band", isCover = false): SetlistSong {
  return { name, searchArtist, isCover };
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
    songs: [song("One"), song("Two")],
    tapeCount: 0,
    ...overrides,
  };
}

function candidate(name: string, artist = "Band"): TrackCandidate {
  return { uri: `spotify:track:${name.toLowerCase()}`, name, artistNames: [artist], popularity: 50 };
}

/** A fake client whose search results are looked up by the song title in the query. */
function fakeSpotify(
  results: Record<string, TrackCandidate[]>,
  overrides: Partial<SpotifyClient> = {},
): { client: SpotifyClient; created: string[][]; addedUris: string[] } {
  const created: string[][] = [];
  const addedUris: string[] = [];
  const client: SpotifyClient = {
    exchangeCode: async () => ({ ok: false, error: "not used" }),
    refresh: async () => ({ ok: false, error: "not used" }),
    searchTracks: async (_token, query) => {
      for (const [title, tracks] of Object.entries(results)) {
        if (query.includes(title)) return { ok: true, value: tracks };
      }
      return { ok: true, value: [] };
    },
    createPlaylist: async (_token, name, description) => {
      created.push([name, description]);
      return { ok: true, value: { id: "PL1", url: "https://open.spotify.com/playlist/PL1" } };
    },
    addTracks: async (_token, _id, uris) => {
      addedUris.push(...uris);
      return { ok: true, value: uris.length };
    },
    // The player half exists for the listening party; nothing in the playlist build path calls it.
    play: async () => ({ ok: false, error: "not used" }),
    playbackState: async () => ({ ok: false, error: "not used" }),
    devices: async () => ({ ok: false, error: "not used" }),
    transfer: async () => ({ ok: false, error: "not used" }),
    ...overrides,
  };
  return { client, created, addedUris };
}

describe("isoDate", () => {
  test("turns setlist.fm's dd-MM-yyyy into an unambiguous yyyy-MM-dd", () => {
    expect(isoDate("08-09-2026")).toBe("2026-09-08");
  });

  test("passes anything unexpected through untouched rather than mangling it", () => {
    expect(isoDate("2026")).toBe("2026");
    expect(isoDate("")).toBe("");
  });
});

describe("playlistName", () => {
  test("reads as artist, venue, city and date", () => {
    expect(playlistName(setlist())).toBe("Band at The Venue, Leeds (2026-09-08)");
  });

  test("drops the parts a setlist doesn't have", () => {
    const name = playlistName(setlist({ venueName: undefined, cityName: undefined, tourName: undefined }));
    expect(name).toBe("Band (2026-09-08)");
  });

  test("clips to Spotify's 100-character limit", () => {
    const name = playlistName(setlist({ artistName: "A".repeat(150) }));
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith("…")).toBe(true);
  });
});

describe("playlistDescription", () => {
  test("carries the tour and links back to the setlist", () => {
    expect(playlistDescription(setlist())).toBe(
      "The Tour - Setlist from https://www.setlist.fm/setlist/band/2026/the-venue-abc123.html",
    );
  });

  test("omits the tour when there isn't one", () => {
    expect(playlistDescription(setlist({ tourName: undefined }))).toStartWith("Setlist from ");
  });
});

describe("findSong", () => {
  test("falls back to the loose query when the field-filtered one finds nothing", async () => {
    const queries: string[] = [];
    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) => {
        queries.push(query);
        return { ok: true, value: query.startsWith("track:") ? [] : [candidate("One")] };
      },
    });
    const found = await findSong(client, "AT", song("One"));
    expect(found.ok === true && found.match?.track.name).toBe("One");
    expect(queries).toHaveLength(2);
    expect(queries[0]).toStartWith("track:");
  });

  test("stops at the first query that matches, so a hit costs one call", async () => {
    let calls = 0;
    const { client } = fakeSpotify({}, {
      searchTracks: async () => {
        calls += 1;
        return { ok: true, value: [candidate("One")] };
      },
    });
    await findSong(client, "AT", song("One"));
    expect(calls).toBe(1);
  });

  test("a search FAILURE is an error, never a miss -- they must not collapse", async () => {
    const { client } = fakeSpotify({}, {
      searchTracks: async () => ({ ok: false, error: "Spotify returned HTTP 429" }),
    });
    expect(await findSong(client, "AT", song("One"))).toMatchObject({ ok: false, error: "Spotify returned HTTP 429" });
  });
});

describe("buildPlaylist", () => {
  test("creates the playlist and adds every matched track in setlist order", async () => {
    const { client, created, addedUris } = fakeSpotify({ One: [candidate("One")], Two: [candidate("Two")] });
    const result = await buildPlaylist(client, "AT", setlist());
    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]![0]).toBe("Band at The Venue, Leeds (2026-09-08)");
    expect(addedUris).toEqual(["spotify:track:one", "spotify:track:two"]);
    expect(result.ok === true && result.outcome.added).toBe(2);
  });

  test("reports unmatched songs by name while still adding the rest", async () => {
    const { client, addedUris } = fakeSpotify({ One: [candidate("One")] });
    const result = await buildPlaylist(client, "AT", setlist());
    expect(result.ok === true && result.outcome.missing).toEqual(["Two"]);
    expect(result.ok === true && result.outcome.attempted).toBe(2);
    expect(addedUris).toEqual(["spotify:track:one"]);
  });

  test("a loosely-matched track is surfaced as uncertain, not silently trusted", async () => {
    const { client } = fakeSpotify({
      One: [candidate("One")],
      Two: [candidate("Two", "A Completely Different Band")],
    });
    const result = await buildPlaylist(client, "AT", setlist());
    expect(result.ok === true && result.outcome.uncertain.map((u) => u.song.name)).toEqual(["Two"]);
  });

  test("a repeated song stays repeated -- the playlist mirrors the show", async () => {
    const { client, addedUris } = fakeSpotify({ One: [candidate("One")] });
    const result = await buildPlaylist(client, "AT", setlist({ songs: [song("One"), song("One")] }));
    expect(result.ok).toBe(true);
    expect(addedUris).toEqual(["spotify:track:one", "spotify:track:one"]);
  });

  test("NO playlist is created when a search fails midway", async () => {
    let calls = 0;
    const { client, created } = fakeSpotify({}, {
      searchTracks: async () => {
        calls += 1;
        return calls > 1 ? { ok: false, error: "Spotify returned HTTP 401" } : { ok: true, value: [candidate("One")] };
      },
    });
    const result = await buildPlaylist(client, "AT", setlist());
    expect(result).toMatchObject({ ok: false, error: "Spotify returned HTTP 401" });
    expect(created).toEqual([]);
  });

  test("NO playlist is created when nothing at all matched", async () => {
    const { client, created } = fakeSpotify({});
    const result = await buildPlaylist(client, "AT", setlist());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("none of the songs");
    expect(created).toEqual([]);
  });

  test("an empty setlist is refused before any Spotify call", async () => {
    let calls = 0;
    const { client } = fakeSpotify({}, {
      searchTracks: async () => {
        calls += 1;
        return { ok: true, value: [] };
      },
    });
    const result = await buildPlaylist(client, "AT", setlist({ songs: [] }));
    expect(result).toEqual({ ok: false, error: "that setlist has no songs on it yet", songs: [] });
    expect(calls).toBe(0);
  });

  test("a failed add is reported rather than claimed as success", async () => {
    const { client } = fakeSpotify({ One: [candidate("One")], Two: [candidate("Two")] }, {
      addTracks: async () => ({ ok: false, error: "Spotify returned HTTP 500 (after adding 0 of 2)" }),
    });
    const result = await buildPlaylist(client, "AT", setlist());
    expect(result.ok).toBe(false);
  });

  test("a cover is searched under its original artist", async () => {
    const queries: string[] = [];
    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) => {
        queries.push(query);
        return { ok: true, value: [candidate("Cover Song", "The Originals")] };
      },
    });
    await buildPlaylist(client, "AT", setlist({ songs: [song("Cover Song", "The Originals", true)] }));
    expect(queries[0]).toContain('artist:"The Originals"');
  });
});

describe("buildPlaylist traces", () => {
  test("a missing song records every query issued with its candidates and score parts", async () => {
    const karaoke = candidate("Two (Karaoke Version)", "Karaoke Crew");
    const { client } = fakeSpotify({ One: [candidate("One")] }, {
      searchTracks: async (_t, query) => {
        if (query.includes("One")) return { ok: true, value: [candidate("One")] };
        return {
          ok: true,
          value: query.startsWith("track:") ? [karaoke, candidate("Unrelated")] : [candidate("Nothing Relevant")],
        };
      },
    });
    const result = await buildPlaylist(client, "AT", setlist());
    expect(result.ok).toBe(true);
    const two = result.songs[1]!;
    expect(two.outcome).toBe("missing");
    expect(two.searchArtist).toBe("Band");
    expect(two.picked).toBeUndefined();
    expect(two.queries!.map((q) => q.query)).toEqual(['track:"Two" artist:"Band"', "Two Band"]);
    // Spotify's order is preserved, and a rejected karaoke upload keeps the parts that sank it.
    expect(two.queries![0]!.candidates.map((c) => c.name)).toEqual(["Two (Karaoke Version)", "Unrelated"]);
    expect(two.queries![0]!.candidates[0]).toEqual({
      name: "Two (Karaoke Version)",
      artists: ["Karaoke Crew"],
      uri: karaoke.uri,
      title: 72,
      artist: 0,
      tieBreak: 0.5,
      penalty: 100,
      score: 0,
    });
    expect(two.queries![1]!.candidates.map((c) => c.name)).toEqual(["Nothing Relevant"]);
  });

  test("a high match records the pick and hitQuery but no candidate lists", async () => {
    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) => ({
        ok: true,
        value: query.startsWith("track:") ? [] : [candidate("One"), candidate("One - Live")],
      }),
    });
    const result = await buildPlaylist(client, "AT", setlist({ songs: [song("One")] }));
    expect(result.ok).toBe(true);
    const one = result.songs[0]!;
    expect(one.outcome).toBe("high");
    expect(one.searchArtist).toBe("Band");
    expect(one.picked).toEqual({ name: "One", artists: ["Band"], uri: "spotify:track:one" });
    // The first query found nothing, so the second one is the hit.
    expect(one.hitQuery).toBe(1);
    expect(one.queries).toBeUndefined();
  });

  test("a loose match keeps its candidate lists", async () => {
    const { client } = fakeSpotify({ One: [candidate("One", "Someone Else")] });
    const result = await buildPlaylist(client, "AT", setlist({ songs: [song("One")] }));
    expect(result.ok).toBe(true);
    const one = result.songs[0]!;
    expect(one.outcome).toBe("low");
    expect(one.hitQuery).toBe(0);
    expect(one.picked?.artists).toEqual(["Someone Else"]);
    expect(one.queries).toHaveLength(1);
    expect(one.queries![0]!.candidates[0]).toMatchObject({ name: "One", title: 100, artist: 0, penalty: 0, score: 100.5 });
  });

  test("a medium match keeps its candidate lists too", async () => {
    // "A Completely Different Band" contains the searched artist, so the match is partial-artist: medium.
    const { client } = fakeSpotify({ One: [candidate("One", "A Completely Different Band")] });
    const result = await buildPlaylist(client, "AT", setlist({ songs: [song("One")] }));
    const one = result.songs[0]!;
    expect(one.outcome).toBe("medium");
    expect(one.queries).toHaveLength(1);
    expect(one.queries![0]!.candidates[0]).toMatchObject({ name: "One", title: 100, artist: 22, score: 122.5 });
  });

  test("candidates are recorded in Spotify's order, not the order they scored in", async () => {
    // The better candidate comes SECOND, so a log that sorted by score would put it first.
    const live = candidate("Hey Jude - Live", "Someone Else");
    const studio = candidate("Hey Jude", "Someone Else");
    const { client } = fakeSpotify({}, { searchTracks: async () => ({ ok: true, value: [live, studio] }) });
    const result = await buildPlaylist(client, "AT", setlist({ songs: [song("Hey Jude")] }));
    const hey = result.songs[0]!;
    expect(hey.outcome).toBe("low");
    expect(hey.picked?.name).toBe("Hey Jude");
    const listed = hey.queries![0]!.candidates;
    expect(listed.map((c) => c.name)).toEqual(["Hey Jude - Live", "Hey Jude"]);
    expect(listed.map((c) => c.score)).toEqual([47.5, 100.5]);
  });

  test("a cover is traced under the original artist it was searched for", async () => {
    const { client } = fakeSpotify({ "Cover Song": [candidate("Cover Song", "The Originals")] });
    const result = await buildPlaylist(client, "AT", setlist({ songs: [song("Cover Song", "The Originals", true)] }));
    expect(result.songs[0]!.searchArtist).toBe("The Originals");
    expect(result.songs[0]!.outcome).toBe("high");
  });

  test("an API error part-way returns the traces so far, the failing song marked error", async () => {
    let calls = 0;
    const { client, created } = fakeSpotify({}, {
      searchTracks: async () => {
        calls += 1;
        return calls > 1 ? { ok: false, error: "Spotify returned HTTP 429" } : { ok: true, value: [candidate("One")] };
      },
    });
    const result = await buildPlaylist(client, "AT", setlist());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("Spotify returned HTTP 429");
    expect(created).toEqual([]);
    expect(result.songs.map((s) => [s.name, s.outcome])).toEqual([
      ["One", "high"],
      ["Two", "error"],
    ]);
    const failed = result.songs[1]!;
    expect(failed.searchArtist).toBe("Band");
    expect(failed.error).toBe("Spotify returned HTTP 429");
    // The query that failed is recorded, with nothing returned for it.
    expect(failed.queries).toEqual([{ query: 'track:"Two" artist:"Band"', candidates: [] }]);
  });

  test("a failed build still returns its traces", async () => {
    // Nothing matched at all: the "none of the songs" arm.
    const nothing = fakeSpotify({});
    const none = await buildPlaylist(nothing.client, "AT", setlist());
    expect(none.ok).toBe(false);
    expect(none.songs.map((s) => [s.name, s.outcome])).toEqual([
      ["One", "missing"],
      ["Two", "missing"],
    ]);
    expect(none.songs[0]!.queries).toHaveLength(2);

    // The playlist could not be created or filled: every song was searched and is traced.
    const noPlaylist = fakeSpotify({ One: [candidate("One")], Two: [candidate("Two")] }, {
      createPlaylist: async () => ({ ok: false, error: "Spotify returned HTTP 403" }),
    });
    const created = await buildPlaylist(noPlaylist.client, "AT", setlist());
    expect(created.ok).toBe(false);
    expect(created.songs.map((s) => s.outcome)).toEqual(["high", "high"]);

    const noAdd = fakeSpotify({ One: [candidate("One")], Two: [candidate("Two")] }, {
      addTracks: async () => ({ ok: false, error: "Spotify returned HTTP 500 (after adding 0 of 2)" }),
    });
    const added = await buildPlaylist(noAdd.client, "AT", setlist());
    expect(added.ok).toBe(false);
    expect(added.songs.map((s) => s.outcome)).toEqual(["high", "high"]);
  });

  test("a song played twice is traced twice", async () => {
    const { client } = fakeSpotify({ One: [candidate("One")] });
    const result = await buildPlaylist(client, "AT", setlist({ songs: [song("One"), song("One")] }));
    expect(result.songs.map((s) => s.name)).toEqual(["One", "One"]);
  });
});
