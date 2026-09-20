// The pipeline: a resolved setlist in, a created Spotify playlist out. Kept apart from
// `commands.ts` so the whole behaviour -- matching, partial failure, naming -- is testable against
// a fake `SpotifyClient` with no Discord interaction anywhere near it.

import type { Setlist, SetlistSong } from "./setlistfm.js";
import { buildQueries, pickBestTrack, type Match } from "./matching.js";
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

export type BuildResult = { ok: true; outcome: BuildOutcome } | { ok: false; error: string };

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
): Promise<{ ok: true; match?: Match } | { ok: false; error: string }> {
  for (const query of buildQueries({ name: song.name, artist: song.searchArtist })) {
    const result = await spotify.searchTracks(accessToken, query);
    if (!result.ok) return result;
    const match = pickBestTrack({ name: song.name, artist: song.searchArtist }, result.value);
    if (match !== undefined) return { ok: true, match };
  }
  return { ok: true };
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
    return { ok: false, error: "that setlist has no songs on it yet" };
  }

  const resolved: ResolvedSong[] = [];
  const missing: string[] = [];
  for (const song of setlist.songs) {
    const found = await findSong(spotify, accessToken, song);
    if (!found.ok) return { ok: false, error: found.error };
    if (found.match === undefined) missing.push(song.name);
    else resolved.push({ song, match: found.match });
  }

  if (resolved.length === 0) {
    return { ok: false, error: "none of the songs on that setlist could be found on Spotify" };
  }

  const name = playlistName(setlist);
  const created = await spotify.createPlaylist(accessToken, name, playlistDescription(setlist));
  if (!created.ok) return { ok: false, error: created.error };

  // Duplicates are kept deliberately: a song played twice (a reprise, an encore repeat) is two
  // entries on the setlist, and the playlist mirrors the show rather than de-duplicating it.
  const uris = resolved.map((r) => r.match.track.uri);
  const added = await spotify.addTracks(accessToken, created.value.id, uris);
  if (!added.ok) return { ok: false, error: added.error };

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
  };
}
