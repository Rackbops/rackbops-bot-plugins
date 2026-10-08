import { describe, expect, test } from "bun:test";
import { artistNamesFor, searchArtistsFor } from "./artists.js";
import { betterMatch, buildPlaylist, findSong, isoDate, playlistDescription, playlistName } from "./build.js";
import type { Setlist, SetlistSong } from "./setlistfm.js";
import type { SpotifyClient } from "./spotify.js";
import type { Match, TrackCandidate } from "./matching.js";

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

  // Renamed for #61: it used to be true of ANY match on the first query; now only a `high` one
  // stops the search early, which is exactly what this case is (`candidate("One")` matches
  // `song("One")`'s exact artist and title).
  test("a high on the first query issues exactly one search", async () => {
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

  test("a medium on the first query keeps searching and a high on the second wins", async () => {
    const { client } = fakeSpotify({}, {
      // The filtered query's only candidate shares the title but not the artist -- medium, not
      // high -- so #61 tries the loose query too, whose candidate is the exact artist as well.
      searchTracks: async (_t, query) => ({
        ok: true,
        value: query.startsWith("track:") ? [candidate("One", "The Band")] : [candidate("One", "Band")],
      }),
    });
    const found = await findSong(client, "AT", song("One"));
    expect(found.ok).toBe(true);
    expect(found.ok === true && found.match?.confidence).toBe("high");
    expect(found.ok === true && found.match?.track.artistNames).toEqual(["Band"]);
    expect(found.trace.hitQuery).toBe(1);
    expect(found.trace.queries).toHaveLength(2);
    expect(found.trace.queries![0]!.candidates[0]).toMatchObject({ name: "One", artists: ["The Band"] });
  });

  test("two loose matches: the more confident wins, then the higher score, then the first", async () => {
    const match = (confidence: "high" | "medium" | "low", score: number): Match => ({
      track: { uri: `spotify:track:${confidence}-${score}`, name: "X", artistNames: ["X"], popularity: 0 },
      confidence,
      score,
    });

    // Confidence beats score even when the lower-confidence match scored higher.
    expect(betterMatch(match("medium", 50), match("low", 99))).toMatchObject({ confidence: "medium" });
    // Same confidence: the higher score wins.
    expect(betterMatch(match("low", 80), match("low", 40))).toMatchObject({ track: { uri: "spotify:track:low-80" } });
    // A full tie: the second argument (the one already held) stands.
    const a = match("low", 50);
    const b = match("low", 50);
    expect(betterMatch(a, b)).toBe(b);

    // End to end through findSong: the filtered query's candidate shares no artist overlap at all
    // (low, regardless of its score), the loose query's has partial overlap (medium) -- the more
    // confident one wins even though neither query reached "high".
    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) => ({
        ok: true,
        value: query.startsWith("track:")
          ? [candidate("One", "Totally Unrelated")]
          : [candidate("One", "A Completely Different Band")],
      }),
    });
    const found = await findSong(client, "AT", song("One"));
    expect(found.ok === true && found.match?.confidence).toBe("medium");
    expect(found.trace.hitQuery).toBe(1);
  });

  test("a search FAILURE is an error, never a miss -- they must not collapse", async () => {
    const { client } = fakeSpotify({}, {
      searchTracks: async () => ({ ok: false, error: "Spotify returned HTTP 429" }),
    });
    expect(await findSong(client, "AT", song("One"))).toMatchObject({ ok: false, error: "Spotify returned HTTP 429" });
  });

  test("a fatal search failure's trace ends with the failed query, marked", async () => {
    const asked: string[] = [];
    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) => {
        asked.push(query);
        return { ok: false, error: "Spotify returned HTTP 429" };
      },
    });
    const found = await findSong(client, "AT", song("One"));
    expect(found.ok).toBe(false);
    // The failed query, no candidates because none came back, and the reason on the entry itself.
    expect(found.trace.queries).toStrictEqual([
      { query: asked[0], candidates: [], error: "Spotify returned HTTP 429" },
    ]);
    expect(asked).toHaveLength(1);
  });

  test("a failure on the optional second query doesn't discard a match the first one already found", async () => {
    const asked: string[] = [];
    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) => {
        asked.push(query);
        return query.startsWith("track:")
          ? { ok: true, value: [candidate("One", "Someone Else")] } // a usable, if unconfident, match
          : { ok: false, error: "Spotify returned HTTP 429" };
      },
    });
    const found = await findSong(client, "AT", song("One"));
    // #61 made this second query possible where before it would never have run at all; a
    // transient failure on it must not turn an already-found low/medium pick into a fatal error.
    expect(found.ok).toBe(true);
    expect(found.ok === true && found.match?.confidence).toBe("low");
    expect(found.trace.hitQuery).toBe(0);
    // ...but it IS in the trace (#192), marked, as the last entry: the search was cut short, not
    // exhausted, and a reader of the match log can tell the two apart.
    expect(found.trace.queries).toHaveLength(2);
    expect(found.trace.queries![1]).toStrictEqual({ query: asked[1], candidates: [], error: "Spotify returned HTTP 429" });
    expect(found.trace.queries![0]!.error).toBeUndefined();
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

  test("a failed add names the playlist that was created", async () => {
    const { client, created } = fakeSpotify({ One: [candidate("One")], Two: [candidate("Two")] }, {
      addTracks: async () => ({ ok: false, error: "Spotify returned HTTP 500 (after adding 100 of 250)" }),
    });

    const result = await buildPlaylist(client, "AT", setlist());

    expect(created).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // On the result itself, for the match log...
    expect(result.playlistUrl).toBe("https://open.spotify.com/playlist/PL1");
    // ...and in the text the user is shown, after the failure it explains.
    expect(result.error).toContain("HTTP 500 (after adding 100 of 250)");
    expect(result.error).toContain("https://open.spotify.com/playlist/PL1");
    expect(result.error).toBe(
      "Spotify returned HTTP 500 (after adding 100 of 250). " +
        "The playlist was created and holds whatever landed before that: https://open.spotify.com/playlist/PL1",
    );
  });

  test("a failure before the playlist exists carries no playlist", async () => {
    // Nothing matched: no playlist was made.
    const none = await buildPlaylist(fakeSpotify({}).client, "AT", setlist());
    expect(none.ok).toBe(false);
    expect("playlistUrl" in none).toBe(false);

    // The playlist could not be created.
    const noPlaylist = fakeSpotify({ One: [candidate("One")] }, {
      createPlaylist: async () => ({ ok: false, error: "Spotify returned HTTP 403" }),
    });
    const refused = await buildPlaylist(noPlaylist.client, "AT", setlist());
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toBe("Spotify returned HTTP 403");
    expect("playlistUrl" in refused).toBe(false);
  });

  test("a successful build's playlist url is where it always was", async () => {
    const { client } = fakeSpotify({ One: [candidate("One")], Two: [candidate("Two")] });
    const result = await buildPlaylist(client, "AT", setlist());
    expect(result.ok && result.outcome.playlistUrl).toBe("https://open.spotify.com/playlist/PL1");
    expect(result.ok && "playlistUrl" in result).toBe(false);
  });

  // Updated for #63/#64: a cover is now searched under the performer-side names first, and the
  // original artist last -- so the performer's own recording (if Spotify has one) wins, and the
  // original artist is only reached when it doesn't.
  test("a cover is searched under the performer first, and its original artist last", async () => {
    const queries: string[] = [];
    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) => {
        queries.push(query);
        return { ok: true, value: [candidate("Cover Song", "The Originals")] };
      },
    });
    await buildPlaylist(client, "AT", setlist({ songs: [song("Cover Song", "The Originals", true)] }));
    expect(queries[0]).toContain('artist:"Band"');
    expect(queries.at(-1)).toContain('artist:"The Originals"');
  });

  // #66: three DIFFERENT titles all parse as parts of one suite and resolve to the same
  // whole-suite medley -- added once, the other two folded, the one add still surfaced as
  // uncertain (a suite match never reaches "high").
  test("three parts of one suite resolving to one track add it once and are counted as folded", async () => {
    const medley = candidate("Odyssey: Dawn / Voyage / Return - Medley");
    const { client, addedUris } = fakeSpotify({ Odyssey: [medley] });
    const result = await buildPlaylist(
      client,
      "AT",
      setlist({
        songs: [song("Odyssey Part I: Dawn"), song("Odyssey Part II: Voyage"), song("Odyssey Part III: Return")],
      }),
    );
    expect(result.ok).toBe(true);
    expect(addedUris).toEqual([medley.uri]);
    expect(result.ok === true && result.outcome.added).toBe(1);
    expect(result.ok === true && result.outcome.folded).toBe(2);
    expect(result.ok === true && result.outcome.uncertain.map((u) => u.song.name)).toEqual(["Odyssey Part I: Dawn"]);
  });

  // The SAME part repeated (an encore reprise) is a genuine duplicate, not a fold: it must add
  // twice exactly like any other repeated song, even though it resolves to the identical uri both
  // times -- guards against keying the fold set on (stem, uri) alone, which would wrongly treat a
  // repeat of the same part as a second, different part sharing a recording.
  test("the same song listed twice still adds twice", async () => {
    const medley = candidate("Odyssey: Dawn / Voyage / Return - Medley");
    const { client, addedUris } = fakeSpotify({ Odyssey: [medley] });
    const result = await buildPlaylist(
      client,
      "AT",
      setlist({ songs: [song("Odyssey Part I: Dawn"), song("Odyssey Part I: Dawn")] }),
    );
    expect(result.ok).toBe(true);
    expect(addedUris).toEqual([medley.uri, medley.uri]);
    expect(result.ok === true && result.outcome.added).toBe(2);
    expect(result.ok === true && result.outcome.folded).toBe(0);
  });

  test("two parts resolving to different tracks both add", async () => {
    const dawn = candidate("Odyssey Dawn - Single Edit");
    const voyage = candidate("Odyssey Voyage - Single Edit");
    const { client, addedUris } = fakeSpotify({ Dawn: [dawn], Voyage: [voyage] });
    const result = await buildPlaylist(
      client,
      "AT",
      setlist({ songs: [song("Odyssey Part I: Dawn"), song("Odyssey Part II: Voyage")] }),
    );
    expect(result.ok).toBe(true);
    expect(addedUris).toEqual([dawn.uri, voyage.uri]);
    expect(result.ok === true && result.outcome.added).toBe(2);
    expect(result.ok === true && result.outcome.folded).toBe(0);
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
      // No other candidate on the page shares "Karaoke Crew" as its primary artist (#59).
      tieBreak: 0,
      // Both the title ("Karaoke Version") and the artist name ("Karaoke Crew") independently
      // trip the 100-point karaoke rule (#99 added the artist-side one), so this candidate's
      // penalty is 200, not 100.
      penalty: 200,
      score: 0,
    });
    expect(two.queries![1]!.candidates.map((c) => c.name)).toEqual(["Nothing Relevant"]);
  });

  // #59: tieBreak counts OTHER candidates on the same page that share this one's primary artist and
  // still title-match, /100 -- not popularity, which a real search never sends. Calls findSong
  // directly (searches only song.searchArtist, #90's own documented contract for no `artists`
  // argument) so #90's setlist-level performer-name fallback can't find its own exact "Band" match
  // first and mask the partial-artist "medium" this test is about.
  test("a candidate's trace records tieBreak as its count of same-primary-artist editions on the page", async () => {
    const { client } = fakeSpotify({ One: [candidate("One"), candidate("One - Remastered")] });
    const found = await findSong(client, "AT", song("One", "Totally Band"));
    expect(found.ok).toBe(true);
    // Partial artist agreement ("Totally Band" contains "Band") keeps this below "high" confidence,
    // so the candidate list survives in the trace.
    expect(found.ok === true && found.match?.confidence).toBe("medium");
    const trace = found.trace.queries![0]!.candidates.find((c) => c.name === "One")!;
    expect(trace.tieBreak).toBe(0.01);
  });

  // Renamed for #61: `queries` used to be omitted whenever the outcome was "high", however many
  // queries ran; now it's kept whenever more than one did, since the page that missed matters too.
  test("a high reached by the second query keeps both pages in the trace", async () => {
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
    expect(one.queries).toHaveLength(2);
    expect(one.queries![0]!.candidates).toEqual([]);
    expect(one.queries![1]!.candidates.map((c) => c.name)).toEqual(["One", "One - Live"]);
  });

  test("a loose match keeps its candidate lists", async () => {
    const { client } = fakeSpotify({ One: [candidate("One", "Someone Else")] });
    const result = await buildPlaylist(client, "AT", setlist({ songs: [song("One")] }));
    expect(result.ok).toBe(true);
    const one = result.songs[0]!;
    expect(one.outcome).toBe("low");
    // Not high, so #61's loose query runs too; the fake client happens to repeat the identical
    // page, a full tie the earlier (filtered) query's match wins.
    expect(one.hitQuery).toBe(0);
    expect(one.picked?.artists).toEqual(["Someone Else"]);
    expect(one.queries).toHaveLength(2);
    expect(one.queries![0]!.candidates[0]).toMatchObject({ name: "One", title: 100, artist: 0, penalty: 0, score: 100 });
    expect(one.queries![1]!.candidates[0]).toMatchObject({ name: "One", title: 100, artist: 0, penalty: 0, score: 100 });
  });

  test("a medium match keeps its candidate lists too", async () => {
    // "A Completely Different Band" contains the searched artist, so the match is partial-artist: medium.
    const { client } = fakeSpotify({ One: [candidate("One", "A Completely Different Band")] });
    const result = await buildPlaylist(client, "AT", setlist({ songs: [song("One")] }));
    const one = result.songs[0]!;
    expect(one.outcome).toBe("medium");
    // Not high, so #61's loose query runs too; same tie as above, the earlier query wins.
    expect(one.hitQuery).toBe(0);
    expect(one.queries).toHaveLength(2);
    expect(one.queries![0]!.candidates[0]).toMatchObject({ name: "One", title: 100, artist: 22, score: 122 });
  });

  test("candidates are recorded in Spotify's order, not the order they scored in", async () => {
    // The better candidate comes SECOND, so a log that sorted by score would put it first. Two
    // DIFFERENT single-edition artists, so #59's tieBreak (same-primary-artist siblings) stays 0
    // for both and doesn't distract from what this test is actually about.
    const live = candidate("Hey Jude - Live", "Someone Else");
    const studio = candidate("Hey Jude", "A Different Artist");
    const { client } = fakeSpotify({}, { searchTracks: async () => ({ ok: true, value: [live, studio] }) });
    const result = await buildPlaylist(client, "AT", setlist({ songs: [song("Hey Jude")] }));
    const hey = result.songs[0]!;
    expect(hey.outcome).toBe("low");
    expect(hey.picked?.name).toBe("Hey Jude");
    const listed = hey.queries![0]!.candidates;
    expect(listed.map((c) => c.name)).toEqual(["Hey Jude - Live", "Hey Jude"]);
    expect(listed.map((c) => c.score)).toEqual([47, 100]);
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
    // The query that failed is recorded, with nothing returned for it and the reason on the entry.
    expect(failed.queries).toStrictEqual([
      { query: 'track:"Two" artist:"Band"', candidates: [], error: "Spotify returned HTTP 429" },
    ]);
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

// ---------------------------------------------------------------------------------------------------
// #63/#64: search each song under every artist name it could be filed under
// ---------------------------------------------------------------------------------------------------

describe("findSong / buildPlaylist: artist fallback (#63/#64)", () => {
  test("an uncredited song by a performer Spotify doesn't know is found under the artist most credits name", async () => {
    // 3 of 4 cover credits name "Originals" -- a strict majority, so it becomes the credited
    // fallback for every song on this setlist, including the uncredited one under test.
    const tributeSet = {
      artistName: "Tribute Act",
      songs: [
        song("Signature Song", "Tribute Act", false),
        song("Cover A", "Originals", true),
        song("Cover B", "Originals", true),
        song("Cover C", "Originals", true),
        song("Cover D", "Other", true),
      ],
    } as Setlist;
    const names = artistNamesFor(tributeSet);
    expect(names.credited).toBe("Originals");

    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) =>
        query.includes("Originals")
          ? { ok: true, value: [candidate("Signature Song", "Originals")] }
          : { ok: true, value: [] },
    });
    const target = tributeSet.songs[0]!;
    const found = await findSong(client, "AT", target, searchArtistsFor(target, names));
    expect(found.ok).toBe(true);
    expect(found.ok === true && found.match?.confidence).toBe("high");
    expect(found.trace.foundUnder).toBe("Originals");
    // The performer's two queries (nothing found) come first, then the credited artist's.
    expect(found.trace.queries!.map((q) => q.query)).toEqual([
      'track:"Signature Song" artist:"Tribute Act"',
      "Signature Song Tribute Act",
      'track:"Signature Song" artist:"Originals"',
    ]);
  });

  test("a band on Spotify with covers of several artists gets no fallback search", async () => {
    const tributeSet = {
      artistName: "Band",
      songs: [
        song("Uncredited Song", "Band", false),
        song("Cover A", "Artist A", true),
        song("Cover B", "Artist B", true),
      ],
    } as Setlist;
    const names = artistNamesFor(tributeSet);
    // Two credits split between two different artists -- neither is a majority, so no fallback name.
    expect(names.credited).toBeUndefined();

    const queries: string[] = [];
    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) => {
        queries.push(query);
        return { ok: true, value: [candidate("Uncredited Song", "Someone Else")] }; // a low match
      },
    });
    const target = tributeSet.songs[0]!;
    const found = await findSong(client, "AT", target, searchArtistsFor(target, names));
    expect(found.ok === true && found.match?.confidence).toBe("low");
    // Only the performer's own two queries -- there was no fallback name to try.
    expect(queries).toHaveLength(2);
  });

  test("a band whose own song matches high keeps it even when most credits name one other artist", async () => {
    const tributeSet = {
      artistName: "Band",
      songs: [
        song("Own Song", "Band", false),
        song("Cover A", "Originals", true),
        song("Cover B", "Originals", true),
        song("Cover C", "Originals", true),
      ],
    } as Setlist;
    const names = artistNamesFor(tributeSet);
    expect(names.credited).toBe("Originals");

    let calls = 0;
    const { client } = fakeSpotify({}, {
      searchTracks: async () => {
        calls += 1;
        return { ok: true, value: [candidate("Own Song")] }; // exact artist "Band", exact title -> high
      },
    });
    const target = tributeSet.songs[0]!;
    const found = await findSong(client, "AT", target, searchArtistsFor(target, names));
    expect(found.ok === true && found.match?.confidence).toBe("high");
    expect(found.trace.foundUnder).toBe("Band");
    // The performer's first query was high -- "Originals" is never even queried.
    expect(calls).toBe(1);
  });

  test("an 'A & B' performer whose full name finds no high match is searched under the lead act", async () => {
    // The same candidate scores differently under each artist: partial overlap under the full
    // joined name (medium), exact under the lead act alone (high).
    const { client } = fakeSpotify({ "Duet Song": [candidate("Duet Song", "Duo A")] });
    const result = await buildPlaylist(
      client,
      "AT",
      setlist({ artistName: "Duo A & Duo B", songs: [song("Duet Song", "Duo A & Duo B")] }),
    );
    expect(result.ok).toBe(true);
    const one = result.songs[0]!;
    expect(one.outcome).toBe("high");
    expect(one.foundUnder).toBe("Duo A");
    expect(one.queries!.map((q) => q.query)).toEqual([
      'track:"Duet Song" artist:"Duo A & Duo B"',
      "Duet Song Duo A & Duo B",
      'track:"Duet Song" artist:"Duo A"',
    ]);
    expect(result.ok === true && result.outcome.foundElsewhere.map((r) => r.song.name)).toEqual(["Duet Song"]);
  });

  test("a fallback name replaces the performer's match only when it is more confident", async () => {
    const performerCandidate: TrackCandidate = {
      uri: "spotify:track:perf",
      name: "One",
      artistNames: ["A Performer Band"],
      popularity: 50,
    };
    const creditedMedium: TrackCandidate = {
      uri: "spotify:track:cred-med",
      name: "One",
      artistNames: ["A Credited Band"],
      popularity: 100, // scores higher than performerCandidate, but stays medium confidence
    };
    const creditedHigh: TrackCandidate = { uri: "spotify:track:cred-high", name: "One", artistNames: ["Credited"], popularity: 0 };

    // Same confidence tier (medium): the credited name's higher score does NOT replace the performer's pick.
    {
      const { client } = fakeSpotify({}, {
        searchTracks: async (_t, query) => ({
          ok: true,
          value: query.includes("Credited") ? [creditedMedium] : [performerCandidate],
        }),
      });
      const found = await findSong(client, "AT", song("One", "Performer"), ["Performer", "Credited"]);
      expect(found.ok === true && found.match?.confidence).toBe("medium");
      expect(found.trace.foundUnder).toBe("Performer");
    }

    // Strictly more confident (high): it does replace.
    {
      const { client } = fakeSpotify({}, {
        searchTracks: async (_t, query) => ({
          ok: true,
          value: query.includes("Credited") ? [creditedHigh] : [performerCandidate],
        }),
      });
      const found = await findSong(client, "AT", song("One", "Performer"), ["Performer", "Credited"]);
      expect(found.ok === true && found.match?.confidence).toBe("high");
      expect(found.trace.foundUnder).toBe("Credited");
    }
  });

  test("a cover the performer has recorded picks the performer's recording", async () => {
    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) =>
        query.includes("Band") ? { ok: true, value: [candidate("Cover Song", "Band")] } : { ok: true, value: [] },
    });
    const result = await buildPlaylist(client, "AT", setlist({ songs: [song("Cover Song", "Originals", true)] }));
    expect(result.ok).toBe(true);
    const one = result.songs[0]!;
    expect(one.outcome).toBe("high");
    expect(one.foundUnder).toBe("Band");
    expect(one.searchArtist).toBe("Originals"); // setlist.fm's own credit, unchanged
    // The performer's query was high -- the original artist is never even queried.
    expect(one.queries).toBeUndefined();
    expect(result.ok === true && result.outcome.foundElsewhere.map((r) => r.song.name)).toEqual(["Cover Song"]);
  });

  test("a cover the performer never recorded falls back to the original artist's", async () => {
    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) =>
        query.includes("Originals") ? { ok: true, value: [candidate("Cover Song", "Originals")] } : { ok: true, value: [] },
    });
    const result = await buildPlaylist(client, "AT", setlist({ songs: [song("Cover Song", "Originals", true)] }));
    expect(result.ok).toBe(true);
    const one = result.songs[0]!;
    expect(one.outcome).toBe("high");
    expect(one.foundUnder).toBe("Originals");
    // Found under exactly the name setlist.fm already gave it -- nothing to disclose.
    expect(result.ok === true && result.outcome.foundElsewhere).toEqual([]);
  });

  test("a cover's performer-side medium is overtaken by the original's high", async () => {
    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) =>
        query.includes("Originals")
          ? { ok: true, value: [candidate("Cover Song", "Originals")] } // exact -> high
          : { ok: true, value: [candidate("Cover Song", "A Band Sort Of Like It")] }, // partial -> medium
    });
    const result = await buildPlaylist(client, "AT", setlist({ songs: [song("Cover Song", "Originals", true)] }));
    expect(result.ok).toBe(true);
    const one = result.songs[0]!;
    expect(one.outcome).toBe("high");
    expect(one.foundUnder).toBe("Originals");
  });

  test("a high match reached under a fallback name keeps its queries", async () => {
    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) =>
        query.includes("Fallback") ? { ok: true, value: [candidate("One", "Fallback")] } : { ok: true, value: [] },
    });
    const found = await findSong(client, "AT", song("One", "Performer"), ["Performer", "Fallback"]);
    expect(found.ok === true && found.match?.confidence).toBe("high");
    expect(found.trace.foundUnder).toBe("Fallback");
    // Performer's two (nothing found) plus Fallback's one (high) -- the path is visible.
    expect(found.trace.queries).toHaveLength(3);
  });

  test("a search failure under a fallback name doesn't discard a match found under an earlier name", async () => {
    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) =>
        query.includes("Fallback")
          ? { ok: false, error: "Spotify returned HTTP 429" }
          : { ok: true, value: [candidate("One", "Someone Else")] }, // a usable, low-confidence match
    });
    const found = await findSong(client, "AT", song("One", "Performer"), ["Performer", "Fallback"]);
    // #61's failure rule carries across names: once a match exists (here, from "Performer"), a
    // later name's failure just stops the search there instead of discarding it.
    expect(found.ok).toBe(true);
    expect(found.ok === true && found.match?.confidence).toBe("low");
    expect(found.trace.foundUnder).toBe("Performer");
    // Performer's two queries, then the fallback name's first, which failed: marked, last, no candidates.
    expect(found.trace.queries).toHaveLength(3);
    const last = found.trace.queries![2]!;
    expect(last.query).toContain("Fallback");
    expect(last.candidates).toEqual([]);
    expect(last.error).toBe("Spotify returned HTTP 429");
  });

  test("called with no artists argument, findSong searches only song.searchArtist -- the replay's contract", async () => {
    const queries: string[] = [];
    const { client } = fakeSpotify({}, {
      searchTracks: async (_t, query) => {
        queries.push(query);
        return { ok: true, value: [] };
      },
    });
    await findSong(client, "AT", song("One", "Some Artist"));
    expect(queries.every((q) => q.includes("Some Artist"))).toBe(true);
    expect(queries).toHaveLength(2); // just the one name's two query shapes
  });
});
