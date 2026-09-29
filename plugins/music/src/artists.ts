// Which artist name(s) a song should be searched under, beyond the one setlist.fm names it for
// (`SetlistSong.searchArtist`). Kept apart from matching.ts, which #57-#60/#66/#67 edit in series,
// so this and the scoring chain never touch the same file. Entirely pure -- no fetch, no host.

import { normalize } from "./matching.js";
import type { Setlist, SetlistSong } from "./setlistfm.js";

/** The setlist-level names a song could be searched under, computed once per setlist. */
export interface SetlistArtistNames {
  performer: string;
  lead?: string;
  credited?: string;
}

/**
 * The first act named in a performer name that joins two with " & " (spaces on both sides):
 * `Pat Benatar & Neil Giraldo` -> `Pat Benatar`. Undefined for a plain name, for `&` with no
 * surrounding spaces (`Hall&Oates`), or when the first segment is too short (under 2 characters)
 * to be a useful search term on its own.
 *
 * A single act whose own name happens to contain " & " (`Hall & Oates`) still yields a name
 * (`Hall`) -- a query under it costs nothing when the full name already matches `high`, and it
 * can only ever replace a weaker match, never a better one (decision 1, #63).
 */
export function leadArtist(performer: string): string | undefined {
  const parts = performer.split(/\s+&\s+/);
  if (parts.length < 2) return undefined;
  const first = parts[0]!.trim();
  return first.length >= 2 ? first : undefined;
}

/**
 * The artist a strict majority of the setlist's cover credits name, when there are at least 2 --
 * the signal that this show is (or is close to) a tribute set. Credits that normalise to the
 * performer itself are dropped before counting, so a #62 bracketed credit (already filed under
 * the performer) can never make a band look like it covers itself. Returns the credited spelling
 * of the top name, not the normalised one, so the result reads naturally in a query or a reply.
 */
export function creditedArtist(songs: readonly SetlistSong[], performer: string): string | undefined {
  const normalizedPerformer = normalize(performer);
  const credits = songs.filter((s) => s.isCover && normalize(s.searchArtist) !== normalizedPerformer);
  if (credits.length === 0) return undefined;

  const tally = new Map<string, { spelling: string; count: number }>();
  for (const credit of credits) {
    const key = normalize(credit.searchArtist);
    const entry = tally.get(key);
    if (entry === undefined) tally.set(key, { spelling: credit.searchArtist, count: 1 });
    else entry.count += 1;
  }

  let top: { spelling: string; count: number } | undefined;
  for (const entry of tally.values()) {
    if (top === undefined || entry.count > top.count) top = entry;
  }
  return top !== undefined && top.count >= 2 && top.count * 2 > credits.length ? top.spelling : undefined;
}

/** The setlist-level names for one show, derived once and reused for every song on it. */
export function artistNamesFor(setlist: Setlist): SetlistArtistNames {
  const performer = setlist.artistName;
  const names: SetlistArtistNames = { performer };
  const lead = leadArtist(performer);
  if (lead !== undefined) names.lead = lead;
  const credited = creditedArtist(setlist.songs, performer);
  if (credited !== undefined) names.credited = credited;
  return names;
}

/**
 * The ordered names to search one song under: the performer, then the lead act of a joined
 * performer name, then the artist most of the setlist's covers are credited to, then -- last --
 * the name setlist.fm actually gave this song (the performer again for an uncredited song, so it
 * drops out here as a duplicate; the original artist for a credited cover, #64). Empty names are
 * dropped and the list is de-duplicated by `normalize()`, keeping the first occurrence -- an
 * uncredited song on an ordinary band collapses back to exactly `[performer]`.
 */
export function searchArtistsFor(song: SetlistSong, names: SetlistArtistNames): string[] {
  const candidates = [names.performer, names.lead, names.credited, song.searchArtist];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of candidates) {
    if (name === undefined || name === "") continue;
    const key = normalize(name);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}
