// The pipeline: a resolved setlist in, a created Spotify playlist out. Kept apart from
// `commands.ts` so the whole behaviour -- matching, partial failure, naming -- is testable against
// a fake `SpotifyClient` with no Discord interaction anywhere near it.

import { artistNamesFor, searchArtistsFor } from "./artists.js";
import type { Setlist, SetlistSong } from "./setlistfm.js";
import {
  buildQueries,
  explainCandidate,
  normalize,
  pickBestTrack,
  type Match,
  type MatchConfidence,
  type ScoreBreakdown,
} from "./matching.js";
import type { SpotifyClient } from "./spotify.js";

/** Confidence's ranking for `betterMatch`, and for choosing between artist names (#63/#64):
 *  `high` beats `medium` beats `low`. */
const CONFIDENCE_RANK: Record<MatchConfidence, number> = { high: 2, medium: 1, low: 0 };

/**
 * The better of two matches for the same song: higher confidence first, then higher score. On a
 * full tie `b` stands -- callers accumulate with `betterMatch(candidate, current)`, so a tie keeps
 * whichever was found first (the filtered query is more precise than the loose one that follows
 * it). Exported so #63/#64 can reuse the same comparator across artist names.
 */
export function betterMatch(a: Match, b: Match): Match {
  if (CONFIDENCE_RANK[a.confidence] !== CONFIDENCE_RANK[b.confidence]) {
    return CONFIDENCE_RANK[a.confidence] > CONFIDENCE_RANK[b.confidence] ? a : b;
  }
  return a.score > b.score ? a : b;
}

/** Spotify rejects a playlist name longer than this. */
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 300;

export interface ResolvedSong {
  song: SetlistSong;
  match: Match;
  /** The artist name the winning query actually used (#63/#64) -- see `SongTrace.foundUnder`. */
  foundUnder: string;
}

export interface BuildOutcome {
  playlistUrl: string;
  playlistName: string;
  /** Tracks actually added. */
  added: number;
  /** Songs on the setlist we tried to find (tape tracks already excluded upstream). */
  attempted: number;
  /** Matched, but not confidently -- worth the user eyeballing. */
  uncertain: ResolvedSong[];
  /** Song titles nothing credible was found for. */
  missing: string[];
  /** Added songs whose winning name wasn't the one setlist.fm gave (`song.searchArtist`) --
   *  a fallback name (#63) or the performer's own recording of a credited cover (#64). */
  foundElsewhere: ResolvedSong[];
}

/** One track Spotify returned for a query, with how it scored. The match log's unit of evidence. */
export interface CandidateTrace extends ScoreBreakdown {
  name: string;
  artists: string[];
  uri: string;
}

/** One search that was issued, with everything Spotify returned for it, in Spotify's order. */
export interface QueryTrace {
  query: string;
  candidates: CandidateTrace[];
}

export type SongOutcome = MatchConfidence | "missing" | "error";

/**
 * What the search did for one song -- the raw material of `music-match-log.json`. It is a record
 * of the search only: nothing in `buildPlaylist` reads it back, so it cannot change which track is
 * picked.
 */
export interface SongTrace {
  name: string;
  /** The artist name setlist.fm gave this song -- the performer, or a credited cover's original
   *  artist. Unchanged by #63/#64: which names were actually SEARCHED, and in what order, is
   *  `foundUnder` and `queries` below, not this field. */
  searchArtist: string;
  outcome: SongOutcome;
  picked?: { name: string; artists: string[]; uri: string };
  /** The artist name the winning query actually used -- `searchArtist` itself for a song with no
   *  fallback, one of #63's fallback names, or (#64) the performer for a cover it turns out to
   *  have recorded. Present exactly when `picked` is. */
  foundUnder?: string;
  /** Index, among the queries issued, of the one that produced the pick. */
  hitQuery?: number;
  /**
   * Every query issued, in order, across every artist name tried. Omitted only when a single,
   * confident ("high") query settled it -- that needs no second look, and a 25-song setlist can
   * run to ~500 candidates per name. Present whenever more than one query ran, even if the
   * winning one was "high" (#61): the page that a first `medium`/`low` came from, and the page
   * that then beat it, both matter to whoever reads the trace -- including a `high` reached only
   * after falling back to a second artist name (#63/#64). On an "error" outcome the last entry is
   * the query that failed, with no candidates.
   */
  queries?: QueryTrace[];
  /** Present when the outcome is "error". */
  error?: string;
}

/** Both arms carry `songs`: a failed build is exactly the one whose search record matters most. */
export type BuildResult =
  | { ok: true; outcome: BuildOutcome; songs: SongTrace[] }
  | { ok: false; error: string; songs: SongTrace[] };

export type FindSongResult =
  | { ok: true; match?: Match; trace: SongTrace }
  | { ok: false; error: string; trace: SongTrace };

/**
 * `dd-MM-yyyy` (setlist.fm's format) -> `yyyy-MM-dd`. A playlist called "... (08-09-2026)" reads as
 * two different dates depending on the reader's country; an ISO date reads as one. Anything that
 * isn't in the expected shape is passed through untouched rather than mangled.
 */
export function isoDate(eventDate: string): string {
  const m = eventDate.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : eventDate;
}

/** `<Artist> at <Venue>, <City> (<date>)`, with the parts that exist, clipped to Spotify's limit. */
export function playlistName(setlist: Setlist): string {
  const where = [setlist.venueName, setlist.cityName].filter((p) => p !== undefined && p !== "").join(", ");
  const date = isoDate(setlist.eventDate);
  let name = setlist.artistName;
  if (where !== "") name += ` at ${where}`;
  if (date !== "") name += ` (${date})`;
  return name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…` : name;
}

export function playlistDescription(setlist: Setlist): string {
  const tour = setlist.tourName !== undefined && setlist.tourName !== "" ? `${setlist.tourName} - ` : "";
  const description = `${tour}Setlist from ${setlist.url}`;
  return description.length > MAX_DESCRIPTION_LENGTH
    ? `${description.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`
    : description;
}

/** The best match found so far, and which artist name's query produced it. */
interface BestSoFar {
  match: Match;
  artist: string;
  hitQuery: number;
}

/**
 * Folds one artist name's result into the running best, across-name rule (#63/#64): the new one
 * replaces the old only when it is STRICTLY more confident -- score is never compared here, unlike
 * `betterMatch`'s within-one-name tie-break. A band on Spotify keeps its own `medium` over a
 * fallback name's `medium`, however much better that fallback's score; only a fallback that is
 * more confident is allowed to override the artist setlist.fm actually named.
 */
function betterAcrossNames(current: BestSoFar | undefined, found: { match: Match; hitQuery: number } | undefined, artist: string): BestSoFar | undefined {
  if (found === undefined) return current;
  if (current === undefined || CONFIDENCE_RANK[found.match.confidence] > CONFIDENCE_RANK[current.match.confidence]) {
    return { match: found.match, artist, hitQuery: found.hitQuery };
  }
  return current;
}

/**
 * Finds one song, trying each artist name in turn (`artists`, in order -- #63/#64's fallback
 * chain; defaults to just `song.searchArtist`, the pre-#63 behaviour #56's replay still relies
 * on), and within each name every query shape in turn (`buildQueries`, #61's rule: every query up
 * to and including the first `high` runs).
 *
 * Two different comparisons are in play. WITHIN one name, `betterMatch` picks between that name's
 * queries (confidence first, then score). ACROSS names, only a STRICTLY more confident result
 * replaces the one already in hand (`betterAcrossNames`) -- so the performer's own recording is
 * never displaced by a same-confidence fallback, and the search moves to the next name only while
 * the best found so far is not `high`. A `high` under any name ends the search immediately; the
 * name it was found under is `foundUnder` on the returned trace.
 *
 * A search that FAILS (a 429, an expired token) is fatal only when NO match exists yet under any
 * name tried so far -- that is a missing song and an error must never collapse into each other, or
 * a rate-limited run would silently report a setlist whose every song is "not on Spotify". Once
 * any match is in hand, a later failure (the same name's next query, or a later name's) just stops
 * the whole search there and reports the best already found, exactly as if the failed query, and
 * every name after it, had never been attempted (#61, carried across names).
 */
export async function findSong(
  spotify: SpotifyClient,
  accessToken: string,
  song: SetlistSong,
  artists: readonly string[] = [song.searchArtist],
): Promise<FindSongResult> {
  const queries: QueryTrace[] = [];
  let best: BestSoFar | undefined;

  artistLoop: for (const artist of artists) {
    const wanted = { name: song.name, artist };
    let nameBest: { match: Match; hitQuery: number } | undefined;

    for (const query of buildQueries(wanted)) {
      const result = await spotify.searchTracks(accessToken, query);
      if (!result.ok) {
        if (best === undefined && nameBest === undefined) {
          queries.push({ query, candidates: [] });
          return {
            ok: false,
            error: result.error,
            trace: { name: song.name, searchArtist: song.searchArtist, outcome: "error", queries, error: result.error },
          };
        }
        best = betterAcrossNames(best, nameBest, artist);
        break artistLoop;
      }
      queries.push({
        query,
        candidates: result.value.map((c) => ({
          name: c.name,
          artists: c.artistNames,
          uri: c.uri,
          ...explainCandidate(wanted, c, result.value),
        })),
      });
      const found = pickBestTrack(wanted, result.value);
      if (found !== undefined) {
        nameBest =
          nameBest === undefined || betterMatch(found, nameBest.match) === found
            ? { match: found, hitQuery: queries.length - 1 }
            : nameBest;
        if (nameBest.match.confidence === "high") break;
      }
    }

    best = betterAcrossNames(best, nameBest, artist);
    if (best !== undefined && best.match.confidence === "high") break;
  }

  if (best === undefined) {
    return { ok: true, trace: { name: song.name, searchArtist: song.searchArtist, outcome: "missing", queries } };
  }
  const trace: SongTrace = {
    name: song.name,
    searchArtist: song.searchArtist,
    outcome: best.match.confidence,
    picked: { name: best.match.track.name, artists: best.match.track.artistNames, uri: best.match.track.uri },
    foundUnder: best.artist,
    hitQuery: best.hitQuery,
  };
  // More than one query ran, or the winning one wasn't confident -- either way, the pages matter
  // to whoever reads the trace later (the operator step; a later tuning PR).
  if (queries.length > 1 || best.match.confidence !== "high") trace.queries = queries;
  return { ok: true, match: best.match, trace };
}

/**
 * The whole job. Searches sequentially on purpose: a 25-song setlist is up to 50 requests per
 * artist name tried -- unchanged for a song whose first query is `high` (still 1) or an ordinary
 * band matching under its own name (still up to 50 for the whole setlist), but up to 4 names x 2
 * queries = 8 for a cover on a duo tribute set, 200 worst case for 25 such covers (#63/#64).
 * Firing these in parallel is the quickest way to earn a 429 on an account whose entire quota is
 * shared with every other dev-mode app the same developer owns (Spotify pooled quota per developer
 * account in July 2026), so they stay sequential regardless.
 *
 * The playlist is created only AFTER the searches, so a run that dies half way through matching
 * leaves nothing behind in the user's library.
 */
export async function buildPlaylist(
  spotify: SpotifyClient,
  accessToken: string,
  setlist: Setlist,
): Promise<BuildResult> {
  if (setlist.songs.length === 0) {
    return { ok: false, error: "that setlist has no songs on it yet", songs: [] };
  }

  const names = artistNamesFor(setlist);
  const resolved: ResolvedSong[] = [];
  const missing: string[] = [];
  const songs: SongTrace[] = [];
  for (const song of setlist.songs) {
    const found = await findSong(spotify, accessToken, song, searchArtistsFor(song, names));
    songs.push(found.trace);
    if (!found.ok) return { ok: false, error: found.error, songs };
    if (found.match === undefined) missing.push(song.name);
    else resolved.push({ song, match: found.match, foundUnder: found.trace.foundUnder ?? song.searchArtist });
  }

  if (resolved.length === 0) {
    return { ok: false, error: "none of the songs on that setlist could be found on Spotify", songs };
  }

  const name = playlistName(setlist);
  const created = await spotify.createPlaylist(accessToken, name, playlistDescription(setlist));
  if (!created.ok) return { ok: false, error: created.error, songs };

  // Duplicates are kept deliberately: a song played twice (a reprise, an encore repeat) is two
  // entries on the setlist, and the playlist mirrors the show rather than de-duplicating it.
  const uris = resolved.map((r) => r.match.track.uri);
  const added = await spotify.addTracks(accessToken, created.value.id, uris);
  if (!added.ok) return { ok: false, error: added.error, songs };

  return {
    ok: true,
    outcome: {
      playlistUrl: created.value.url,
      playlistName: name,
      added: added.value,
      attempted: setlist.songs.length,
      uncertain: resolved.filter((r) => r.match.confidence !== "high"),
      missing,
      foundElsewhere: resolved.filter((r) => normalize(r.foundUnder) !== normalize(r.song.searchArtist)),
    },
    songs,
  };
}
