// #56: replays every non-high song from the 2026-09-25 match logs against the real matching code,
// serving each query's exact logged candidate page. It exists to pin down what today's code picks
// for these 27 songs so a later tuning PR can name what it changed instead of quietly re-breaking
// one of the causes #43 already diagnosed.
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
type CorpusBaseline = { uri: string; confidence: "medium" | "low" } | "missing";
interface CorpusSong {
  name: string;
  searchArtist: string;
  isCover: boolean;
  queries: CorpusQuery[];
  right: string[];
  baseline: CorpusBaseline;
}

const corpus = corpusData as CorpusSong[];

/** Queries `findSong` issued that no logged page covers -- printed, never guessed at. */
const unserved: string[] = [];

/**
 * A `SpotifyClient` keyed by the exact query string a song's page was logged under. Candidates
 * carry `popularity: 0`: the real search never returned one either (#43's finding 1 -- every
 * candidate in these logs has `tieBreak: 0`), so this is what actually happened, not a stand-in.
 */
function servePages(song: CorpusSong): SpotifyClient {
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
        unserved.push(query);
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

const tally = { right: 0, wrong: 0, missing: 0 };

// `describe.each` needs a [name, entry] tuple, not the bare corpus entry, for `%s` to interpolate
// the song's name into the test path -- ["#56 deviation" in the PR] a plain array of objects
// renders the literal string "replay: %s" for every song (verified against bun 1.4.2), which would
// not match the specific test path the plan's own coverage table names
// (`replay: By-Tor & the Snow Dog > picks the baseline`).
describe.each(corpus.map((entry) => [entry.name, entry] as const))("replay: %s", (_name, entry) => {
  test("picks the baseline", async () => {
    const client = servePages(entry);
    const found = await findSong(client, "TEST_TOKEN", {
      name: entry.name,
      searchArtist: entry.searchArtist,
      isCover: entry.isCover,
    });
    expect(found.ok).toBe(true);
    const match = found.ok ? found.match : undefined;

    if (entry.baseline === "missing") {
      expect(match).toBeUndefined();
      tally.missing++;
      return;
    }
    expect(match?.track.uri).toBe(entry.baseline.uri);
    expect(match?.confidence).toBe(entry.baseline.confidence);
    if (entry.right.includes(entry.baseline.uri)) tally.right++;
    else tally.wrong++;
  });
});

afterAll(() => {
  console.log(`replay: right ${tally.right}, wrong ${tally.wrong}, missing ${tally.missing}`);
  console.log(`replay: ${unserved.length} queries had no logged page`);
  for (const q of unserved) console.log(`  unserved: ${q}`);
  expect(tally).toEqual({ right: 12, wrong: 5, missing: 10 });
});
