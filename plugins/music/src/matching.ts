// Turning "the band played a song called X" into "this exact Spotify track". Entirely pure -- no
// fetch, no host -- so `matching.test.ts` covers the cases that actually bite (live versions,
// karaoke uploads, remasters, covers) as plain data.
//
// Why this file exists at all: Spotify's search caps `limit` at 10 since the February 2026 dev-mode
// changes, so we can no longer ask for 50 candidates and trust the first hit. Ten results for
// "track:Yesterday artist:The Beatles" routinely lead with a karaoke rendition or a live cut, and
// picking result[0] produces a playlist full of the wrong recordings. So we score what we get.

/** The fields of a Spotify track object this module needs; `spotify.ts` maps the API shape onto it. */
export interface TrackCandidate {
  uri: string;
  name: string;
  artistNames: string[];
  /**
   * 0-100 as Spotify reports it. Kept on the shape because `spotify.ts` still maps it from the API
   * response, but nothing in this module reads it for scoring any more (#59): a search made with a
   * connected user's token sends 0 for every candidate, so it never actually separated a tie.
   */
  popularity: number;
  /**
   * Track length in ms. Nothing in this module reads it -- it rides along because the listening
   * party has to know when a track ends to start the next one, and `/search` is where the number
   * comes from. Optional so a candidate built by an older caller (or a test) stays valid.
   */
  durationMs?: number;
}

export interface SongQuery {
  name: string;
  artist: string;
}

export type MatchConfidence = "high" | "medium" | "low";

export interface Match {
  track: TrackCandidate;
  confidence: MatchConfidence;
  /** The winning candidate's `scoreCandidate` -- carried over so a caller comparing two matches
   *  (across queries) never has to re-score. */
  score: number;
}

/**
 * Lowercase, strip accents, drop punctuation, collapse whitespace. Deliberately aggressive: the
 * difference between "Dont Stop Me Now" (setlist.fm, typed by a human at a gig) and "Don't Stop Me
 * Now" (Spotify) must not cost a match, and neither must "Mötley" vs "Motley", nor "By-Tor & the
 * Snow Dog" (setlist.fm) vs "By-Tor And The Snow Dog" (Spotify).
 */
export function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining marks left behind by NFD
    .toLowerCase()
    // Apostrophes are DELETED, not turned into a space like other punctuation: "Don't" and "Dont"
    // have to normalise identically, and replacing the quote with a space would split the word into
    // "don t" and lose the match against Spotify's own spelling. Covers the typographic apostrophe
    // too, which is what a copy-paste from a web page actually carries.
    .replace(/['\u2018\u2019\u02bc`]/g, "")
    // "&" and "+" between two words read as "and": setlist.fm has "By-Tor & the Snow Dog", Spotify
    // "By-Tor And The Snow Dog", and turning the symbol into a space made them different titles.
    // Only between non-space characters, so a symbol on its own edge is still just punctuation.
    .replace(/(?<=\S)\s*[&+]\s*(?=\S)/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Variant markers that make a recording the WRONG one for a setlist playlist, and how much each
 * costs. A live cut is a near-miss (some bands only ever released the live version, so it stays a
 * candidate); a karaoke upload is never what anyone wanted.
 *
 * Applied only when the marker is absent from the song title itself -- an artist who genuinely
 * released a track called "Live and Let Die" must not be penalised for the word "live".
 */
const VARIANT_PENALTIES: ReadonlyArray<{ pattern: RegExp; penalty: number }> = [
  { pattern: /\bkaraoke\b/, penalty: 100 },
  { pattern: /\b(made popular by|in the style of|tribute)\b/, penalty: 100 },
  { pattern: /\bcommentary\b/, penalty: 60 },
  { pattern: /\binstrumental\b/, penalty: 45 },
  { pattern: /\b(remix|rmx)\b/, penalty: 30 },
  { pattern: /\b(live|concert)\b/, penalty: 25 },
  { pattern: /\b(demo|rehearsal)\b/, penalty: 20 },
  { pattern: /\b(sped up|slowed|nightcore)\b/, penalty: 50 },
];

function variantPenalty(candidateTitle: string, songTitle: string): number {
  let total = 0;
  for (const { pattern, penalty } of VARIANT_PENALTIES) {
    if (pattern.test(candidateTitle) && !pattern.test(songTitle)) total += penalty;
  }
  return total;
}

/**
 * How well a candidate's title matches, 0-100. An exact match is the only full score; a candidate
 * that merely STARTS with the song title scores well because that is what every remaster and
 * edition suffix looks like ("Hey Jude - Remastered 2015"). A candidate that merely contains the
 * title somewhere scores low -- it is usually a medley or a mashup.
 */
function titleScore(candidate: string, song: string): number {
  if (candidate === song) return 100;
  if (song.length >= 3 && candidate.startsWith(`${song} `)) return 72;
  if (song.length >= 4 && candidate.includes(song)) return 40;
  return 0;
}

/** How well any of the candidate's artists matches the one we searched for, 0-40. */
function artistScore(candidateArtists: string[], wanted: string): number {
  if (wanted === "") return 0;
  let best = 0;
  for (const artist of candidateArtists) {
    if (artist === wanted) return 40;
    if (artist.includes(wanted) || wanted.includes(artist)) best = Math.max(best, 22);
  }
  return best;
}

/**
 * The parts of one candidate's score, for the match log. `score` is what `scoreCandidate` returns.
 * Read the total as the score and the parts as how it was reached, not as a sum to trust: a
 * candidate whose title misses gets all zeros whatever its artist, and a penalty larger than the
 * rest is clamped, so `score` is `max(0, title + artist + tieBreak - penalty)` and can be 0 while
 * the parts are not.
 */
export interface ScoreBreakdown {
  title: number;
  artist: number;
  tieBreak: number;
  penalty: number;
  score: number;
}

/**
 * One candidate's score split into its parts. `scoreCandidate` is defined as this function's
 * `score`, so the parts the match log records can never drift from the number that actually picked
 * the track.
 *
 * `page` is every candidate Spotify returned for this query, used only to compute `tieBreak` (see
 * below); it defaults to empty so a caller with no page handy -- the replay harness, a direct test
 * -- gets `tieBreak: 0`, exactly the value `popularity / 100` always produced in practice anyway.
 */
export function explainCandidate(
  song: SongQuery,
  candidate: TrackCandidate,
  page: readonly TrackCandidate[] = [],
): ScoreBreakdown {
  const songTitle = normalize(song.name);
  const candidateTitle = normalize(candidate.name);
  const title = titleScore(candidateTitle, songTitle);
  // A candidate whose title doesn't match at all is never the right track, however well the artist
  // lines up -- returning 0 here (rather than a small positive) is what lets pickBestTrack reject
  // an entire result page instead of shipping its least-bad row.
  if (title === 0) return { title: 0, artist: 0, tieBreak: 0, penalty: 0, score: 0 };
  const artist = artistScore(candidate.artistNames.map(normalize), normalize(song.artist));
  // Ties survive title and artist scoring only between candidates that agree on both -- in
  // practice, several editions of the SAME artist's own recording (the album cut, a remaster, a
  // compilation). `popularity` used to break these, but a search made with a connected user's
  // token sends 0 for every candidate, so it never actually separated anything (#59). Counting how
  // many OTHER rows on the page share this candidate's primary artist and still title-match is a
  // field the response genuinely carries: the artist whose recording exists in several editions is
  // the catalogue artist, and a one-off cover by someone else appears once. Divided by 100 so it
  // can never cross a title (100/72/40) or artist (40/22) step -- a page has at most 10 rows.
  const primaryArtist = candidate.artistNames[0] !== undefined ? normalize(candidate.artistNames[0]) : "";
  const editions =
    primaryArtist === ""
      ? 0
      : page.filter((other) => {
          if (other === candidate) return false;
          const otherPrimary = other.artistNames[0] !== undefined ? normalize(other.artistNames[0]) : "";
          return otherPrimary === primaryArtist && titleScore(normalize(other.name), songTitle) > 0;
        }).length;
  const tieBreak = editions / 100;
  const penalty = variantPenalty(candidateTitle, songTitle);
  return { title, artist, tieBreak, penalty, score: Math.max(0, title + artist + tieBreak - penalty) };
}

/** Exported for the tests -- the score one candidate earns for one song. */
export function scoreCandidate(song: SongQuery, candidate: TrackCandidate, page: readonly TrackCandidate[] = []): number {
  return explainCandidate(song, candidate, page).score;
}

/**
 * The best candidate for a song, or `undefined` when none is credible.
 *
 * `high` means the title matched exactly AND the artist matched exactly -- the caller can add it
 * without comment. Anything softer is surfaced to the user as "check these", because a wrong track
 * silently added to a playlist is worse than a named uncertainty.
 *
 * Ranking is by TIER first, score second: any candidate with artist agreement (`artist > 0`)
 * outranks every candidate with none, whatever the titles score. An exact title alone scores 100,
 * comfortably ahead of a 94 for the right artist's remaster (72 title + 22 partial artist) -- so
 * ranking by score alone would hand the win to an unrelated artist's exact title over the right
 * artist's own recording. A tier changes which candidate wins and nothing else: `scoreCandidate`'s
 * numbers, the match log, and the `score >= 90` floor for `medium` are all unaffected.
 */
export function pickBestTrack(song: SongQuery, candidates: readonly TrackCandidate[]): Match | undefined {
  let best: { track: TrackCandidate; score: number; tier: number } | undefined;
  for (const candidate of candidates) {
    const breakdown = explainCandidate(song, candidate, candidates);
    if (breakdown.score <= 0) continue;
    const tier = breakdown.artist > 0 ? 1 : 0;
    // Strictly greater on both counts, so the first candidate on a full tie (page order) is kept.
    if (best === undefined || tier > best.tier || (tier === best.tier && breakdown.score > best.score)) {
      best = { track: candidate, score: breakdown.score, tier };
    }
  }
  if (best === undefined) return undefined;

  const songTitle = normalize(song.name);
  const exactTitle = normalize(best.track.name) === songTitle;
  const exactArtist = best.track.artistNames.some((a) => normalize(a) === normalize(song.artist));

  // A partial artist match is the floor for "medium": an exact title under a completely unrelated
  // artist scores 100 on title alone, and calling that medium would quietly wave through every
  // cover, tribute and same-named song. Artist agreement is what makes a title match trustworthy.
  const someArtistOverlap = artistScore(best.track.artistNames.map(normalize), normalize(song.artist)) > 0;

  let confidence: MatchConfidence;
  if (exactTitle && exactArtist) confidence = "high";
  else if (someArtistOverlap && best.score >= 90) confidence = "medium";
  else confidence = "low";
  return { track: best.track, confidence, score: best.score };
}

/**
 * The ordered search queries to try for one song. `findSong` (build.ts) stops early once one of
 * them is confident (#61) -- it no longer stops at merely the first that yields any match.
 *
 * The field-filtered query is precise but brittle -- Spotify's `track:"..."` filter matches poorly
 * when the title carries punctuation the indexer normalised differently -- so a loose query is
 * always queued behind it. Quotes are stripped from the values rather than escaped: an unbalanced
 * quote inside a filter makes Spotify reject the whole query with a 400.
 */
export function buildQueries(song: SongQuery): string[] {
  const name = song.name.replace(/"/g, " ").trim();
  const artist = song.artist.replace(/"/g, " ").trim();
  if (artist === "") return [name];
  return [`track:"${name}" artist:"${artist}"`, `${name} ${artist}`];
}
