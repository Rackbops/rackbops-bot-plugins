// #56: replays every non-high song from the 2026-09-25 match logs against the real matching code,
// serving each query's exact logged candidate page. It exists to pin down what today's code picks
// for these 27 songs so a later tuning PR can name what it changed instead of quietly re-breaking
// one of the causes #43 already diagnosed.
//
// What this does NOT replay (#193): the fallback-name chain. `findSong` is called without
// `artists`, so it searches under the default single name, the song's own `searchArtist`. The corpus
// keeps that one name per song and not the setlist-level performer, lead act or credited artist
// that `searchArtistsFor` tries first (its shape test below forbids extra keys), and the 2026-09-25
// logs hold no fallback-query pages. A replay of that chain would need a new corpus, which is its
// own piece of work if it is ever wanted.
import { afterAll, describe, expect, test } from "bun:test";
import corpusData from "./replay/corpus.json" with { type: "json" };
import { findSong } from "./build.js";
import type { SpotifyClient } from "./spotify.js";
import type { TrackCandidate } from "./matching.js";

interface CorpusCandidate {
  uri: string;
  name: string;
  artistNames: string[];
}
interface CorpusQuery {
  query: string;
  candidates: CorpusCandidate[];
}
// "high" included so a later child (#60) can move a song there without this harness's type
// needing to change under it.
type CorpusBaseline = { uri: string; confidence: "high" | "medium" | "low" } | "missing";
interface CorpusSong {
  name: string;
  searchArtist: string;
  isCover: boolean;
  queries: CorpusQuery[];
  right: string[];
  baseline: CorpusBaseline;
}

const corpus = corpusData as CorpusSong[];

/**
 * Queries `findSong` issued that no logged page covers, across every song -- printed, never guessed
 * at. Each song's test also asserts its own are exactly the expected ones: a query string that
 * changed would otherwise leave every page unserved (an empty answer) and still pass any song whose
 * baseline is "missing".
 */
const unserved: string[] = [];

/**
 * The queries a song's logged pages do NOT cover, pinned exactly rather than waived. The logs are
 * from 2026-09-25; #61 (2026-09-29, "keep searching past a non-confident first query") made
 * `findSong` run a second, loose query after a first query that picked something short of `high`,
 * and for these two songs the logs hold only the first query's page. The replay answers the loose
 * query with an empty page, so each pick is still the logged query's -- which is what the log
 * recorded. Anything else a song leaves unserved, these two included, fails its test.
 */
const EXPECTED_UNSERVED: Readonly<Record<string, readonly string[]>> = {
  "You Better Run": ["You Better Run The Rascals"],
  Heartbreaker: ["Heartbreaker Pat Benatar & Neil Giraldo"],
};

/**
 * A `SpotifyClient` keyed by the exact query string a song's page was logged under; every query it
 * has no page for is added to `missed`. Candidates carry `popularity: 0`: the real search never
 * returned one either (#43's finding 1 -- every candidate in these logs has `tieBreak: 0`), so this
 * is what actually happened, not a stand-in.
 */
function servePages(song: CorpusSong, missed: string[]): SpotifyClient {
  const pages = new Map<string, TrackCandidate[]>();
  for (const q of song.queries) {
    pages.set(
      q.query,
      q.candidates.map((c) => ({ uri: c.uri, name: c.name, artistNames: c.artistNames, popularity: 0 })),
    );
  }
  return {
    exchangeCode: async () => ({ ok: false, error: "not used" }),
    refresh: async () => ({ ok: false, error: "not used" }),
    searchTracks: async (_token, query) => {
      const page = pages.get(query);
      if (page === undefined) {
        missed.push(query);
        return { ok: true, value: [] };
      }
      return { ok: true, value: page };
    },
    createPlaylist: async () => ({ ok: false, error: "not used" }),
    addTracks: async () => ({ ok: false, error: "not used" }),
    play: async () => ({ ok: false, error: "not used" }),
    playbackState: async () => ({ ok: false, error: "not used" }),
    devices: async () => ({ ok: false, error: "not used" }),
    transfer: async () => ({ ok: false, error: "not used" }),
  };
}

test("the corpus is the 27 non-high songs of the 2026-09-25 logs", () => {
  expect(corpus.length).toBe(27);
});

// A guard that no fixture entry carries a key outside the shape the plan defines, so setlist
// identity (an id, url, date, venue, city, tour, timestamp) can't creep back in through a later
// edit.
test("no fixture entry carries a key outside the corpus shape", () => {
  const allowed = ["baseline", "isCover", "name", "queries", "right", "searchArtist"];
  for (const entry of corpus) {
    expect(Object.keys(entry).sort()).toEqual(allowed);
  }
});

/** `findSong` for one corpus entry against its logged pages, and the queries no page covered. */
async function replayEntry(entry: CorpusSong) {
  const missed: string[] = [];
  const found = await findSong(servePages(entry, missed), "TEST_TOKEN", {
    name: entry.name,
    searchArtist: entry.searchArtist,
    isCover: entry.isCover,
  });
  return { found, missed };
}

// `describe.each` needs a [name, entry] tuple, not the bare corpus entry, for `%s` to interpolate
// the song's name into the test path -- ["#56 deviation" in the PR] a plain array of objects
// renders the literal string "replay: %s" for every song (verified against bun 1.4.2), which would
// not match the specific test path the plan's own coverage table names
// (`replay: By-Tor & the Snow Dog > picks the baseline`).
describe.each(corpus.map((entry) => [entry.name, entry] as const))("replay: %s", (_name, entry) => {
  test("picks the baseline", async () => {
    const { found, missed } = await replayEntry(entry);
    unserved.push(...missed);
    // Every query `findSong` issued for this song was a page the logs carry (bar the pinned
    // exceptions above), so the pick below is the pick from real candidates and not from an empty
    // answer to a query nobody logged.
    expect(missed).toEqual([...(EXPECTED_UNSERVED[entry.name] ?? [])]);
    expect(found.ok).toBe(true);
    const match = found.ok ? found.match : undefined;

    if (entry.baseline === "missing") {
      expect(match).toBeUndefined();
      return;
    }
    // Pinned to the exact baseline, so a drift is caught as a broken test and named here.
    expect(match?.track.uri).toBe(entry.baseline.uri);
    expect(match?.confidence).toBe(entry.baseline.confidence);
  });
});

// Replays the whole corpus itself rather than reading counts the per-song tests left behind, so it
// does not depend on which tests ran before it, or in what order (`bun test --randomize` included).
// The tally is evidence independent of the baseline labels: it reads each replay's own pick against
// `right`, not the recorded baseline, so it stays honest if a baseline and its label were ever
// wrong together.
test("the tally is what the baselines say", async () => {
  const tally = { right: 0, wrong: 0, missing: 0 };
  for (const entry of corpus) {
    const { found } = await replayEntry(entry);
    expect(found.ok).toBe(true);
    const match = found.ok ? found.match : undefined;
    if (match === undefined) tally.missing++;
    else if (entry.right.includes(match.track.uri)) tally.right++;
    else tally.wrong++;
  }
  console.log(`replay: right ${tally.right}, wrong ${tally.wrong}, missing ${tally.missing}`);
  // #57: normalize() now reads "&"/"+" as "and", so By-Tor & the Snow Dog's studio cut is matched
  // at high instead of a live recording at low -- 12/5/10 -> 13/4/10.
  // #58: artist agreement is now a tier above title score, so Blondie's own remaster of Rip Her to
  // Shreds beats Boomkat's exact but unrelated title -- 13/4/10 -> 14/3/10, the only entry that
  // moved this time.
  // #66: a suite part's title now matches a recording that names the part, so all three 2112 parts
  // move from missing to medium picks -- 14/3/10 -> 17/3/7, no other entry moved.
  // #67: a one-character typo in setlist.fm's title text can now match at low, so Detroit 422
  // moves from missing to a right pick (Blondie's own "Detroit 442 - Remastered") -- 17/3/7 ->
  // 18/3/6, no other entry moved.
  expect(tally).toEqual({ right: 18, wrong: 3, missing: 6 });
});

afterAll(() => {
  console.log(`replay: ${unserved.length} queries had no logged page`);
  for (const q of unserved) console.log(`  unserved: ${q}`);
});
