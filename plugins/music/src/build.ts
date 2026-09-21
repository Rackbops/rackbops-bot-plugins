// The pipeline: a resolved setlist in, a created Spotify playlist out. Kept apart from
// `commands.ts` so the whole behaviour -- matching, partial failure, naming -- is testable against
// a fake `SpotifyClient` with no Discord interaction anywhere near it.

import type { Setlist, SetlistSong } from "./setlistfm.js";
import {
  buildQueries,
  explainCandidate,
  pickBestTrack,
  type Match,
  type MatchConfidence,
  type ScoreBreakdown,
} from "./matching.js";
import type { SpotifyClient } from "./spotify.js";

/** Spotify rejects a playlist name longer than this. */
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 300;

export interface ResolvedSong {
  song: SetlistSong;
  match: Match;
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
 * What the search did for one song -- the raw material of `match-log.json`. It is a record of the
 * search only: nothing in `buildPlaylist` reads it back, so it cannot change which track is picked.
 */
export interface SongTrace {
  name: string;
  searchArtist: string;
  outcome: SongOutcome;
  picked?: { name: string; artists: string[]; uri: string };
  /** Index, among the queries issued, of the one that produced the pick. */
  hitQuery?: number;
  /**
   * Every query issued, in order. Omitted when the outcome is "high": a confident match needs no
   * second look, and a 25-song setlist is ~500 candidates. On an "error" outcome the last entry is
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

/**
 * Finds one song, trying each query shape in turn and taking the first that yields a credible
 * match. The distinction that matters: a search that FAILS (a 429, an expired token) is an error
 * that aborts the whole run, while a search that simply finds nothing is a missing song -- the two
 * must never collapse into each other, or a rate-limited run would silently report a setlist whose
 * every song is "not on Spotify".
 */
export async function findSong(
  spotify: SpotifyClient,
  accessToken: string,
  song: SetlistSong,
): Promise<FindSongResult> {
  const wanted = { name: song.name, artist: song.searchArtist };
  const queries: QueryTrace[] = [];
  for (const query of buildQueries(wanted)) {
    const result = await spotify.searchTracks(accessToken, query);
    if (!result.ok) {
      queries.push({ query, candidates: [] });
      return {
        ok: false,
        error: result.error,
        trace: { name: song.name, searchArtist: song.searchArtist, outcome: "error", queries, error: result.error },
      };
    }
    queries.push({
      query,
      candidates: result.value.map((c) => ({
        name: c.name,
        artists: c.artistNames,
        uri: c.uri,
        ...explainCandidate(wanted, c),
      })),
    });
    const match = pickBestTrack(wanted, result.value);
    if (match !== undefined) {
      const trace: SongTrace = {
        name: song.name,
        searchArtist: song.searchArtist,
        outcome: match.confidence,
        picked: { name: match.track.name, artists: match.track.artistNames, uri: match.track.uri },
        hitQuery: queries.length - 1,
      };
      if (match.confidence !== "high") trace.queries = queries;
      return { ok: true, match, trace };
    }
  }
  return { ok: true, trace: { name: song.name, searchArtist: song.searchArtist, outcome: "missing", queries } };
}

/**
 * The whole job. Searches sequentially on purpose: a 25-song setlist is up to 50 requests, and
 * firing those in parallel is the quickest way to earn a 429 on an account whose entire quota is
 * shared with every other dev-mode app the same developer owns (Spotify pooled quota per developer
 * account in July 2026).
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

  const resolved: ResolvedSong[] = [];
  const missing: string[] = [];
  const songs: SongTrace[] = [];
  for (const song of setlist.songs) {
    const found = await findSong(spotify, accessToken, song);
    songs.push(found.trace);
    if (!found.ok) return { ok: false, error: found.error, songs };
    if (found.match === undefined) missing.push(song.name);
    else resolved.push({ song, match: found.match });
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
    },
    songs,
  };
}
