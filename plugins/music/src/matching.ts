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
 *
 * The letters and digits of EVERY script survive (#150): a Japanese, Cyrillic or Hangul title
 * compares as itself. Keeping only a-z0-9 turned each of those into "", and every empty string
 * equals every other, so an all-kanji candidate by the right artist matched an all-kanji song as an
 * exact title whatever either said. A Latin letter with no accent decomposition (ø, ß, æ, ł) is
 * kept as itself for the same reason, instead of becoming a gap in the word.
 *
 * A word is a letter or digit followed by any run of letters, digits and combining marks. The marks
 * matter outside Latin: NFD splits a kana with a voiced mark (ガ = カ + U+3099), and Indic vowel
 * signs and Thai tone marks are marks too, so treating them as punctuation made バンド and バント
 * (or ไม่ and ไม้) the same word and put a gap inside the word. A mark with no letter before it
 * (an emoji's variation selector) belongs to nothing and goes with the punctuation. The result is
 * recomposed (NFC) so a Hangul syllable or a voiced kana counts as the one character it is, which
 * `titleScore`'s length floors rely on.
 *
 * Text with no letter or digit at all ("???", "...") would still come out empty and equal every
 * other such text, so it falls back to the input itself, trimmed and lower-cased. Only text that
 * is blank to begin with normalises to "".
 *
 * NOT done, deliberately: compatibility forms stay as they are (full-width ＢＴＳ, the ﬁ ligature,
 * Ⅳ and ² are not folded to BTS, fi, IV and 2), and the accent fold applies to every script (й
 * folds to и, ё to е, as é folds to e). Both are choices for a later change, not oversights.
 */
export function normalize(value: string): string {
  const words = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining marks left behind by NFD
    .toLowerCase()
    // Apostrophes are DELETED, not turned into a space like other punctuation: "Don't" and "Dont"
    // have to normalise identically, and replacing the quote with a space would split the word into
    // "don t" and lose the match against Spotify's own spelling. Covers the typographic apostrophe
    // too, which is what a copy-paste from a web page actually carries. Eight characters: the ASCII
    // apostrophe, the backtick, U+2018 and U+2019 (curly quotes), U+02BC (modifier letter
    // apostrophe), and three more that stand in for one when it is typed on a keyboard without an
    // apostrophe: U+00B4 (acute accent -- setlist.fm has "Don´t Stop Believin´", #191),
    // U+2032 (prime) and U+FF07 (fullwidth apostrophe). Written as escapes so each is legible.
    .replace(/['\u2018\u2019\u02bc\u00b4\u2032\uff07`]/g, "")
    // "&" and "+" between two words read as "and": setlist.fm has "By-Tor & the Snow Dog", Spotify
    // "By-Tor And The Snow Dog", and turning the symbol into a space made them different titles.
    // Only between non-space characters, so a symbol on its own edge is still just punctuation.
    .replace(/(?<=\S)\s*[&+]\s*(?=\S)/g, " and ")
    .match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu);
  const folded = words === null ? "" : words.join(" ").normalize("NFC");
  return folded === "" ? value.trim().toLowerCase() : folded;
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
  { pattern: /\b(made popular by|in the style of|tribute|originally (performed )?by)\b/, penalty: 100 },
  { pattern: /\bcommentary\b/, penalty: 60 },
  { pattern: /\binstrumental\b/, penalty: 45 },
  { pattern: /\b(remix|rmx)\b/, penalty: 30 },
  { pattern: /\b(live|concert)\b/, penalty: 25 },
  { pattern: /\b(demo|rehearsal)\b/, penalty: 20 },
  { pattern: /\b(sped up|slowed|nightcore)\b/, penalty: 50 },
];

/**
 * A karaoke label's own uploads carry the ORIGINAL artist in the title, not the label's name, so
 * the title-side rules above can miss them entirely (#99: "Originally Performed by Blondie" isn't
 * caught by any title pattern). The candidate's own artist name is a second, independent signal:
 * whatever the title says, a track credited to a karaoke label is never the right recording.
 */
const KARAOKE_ARTIST = /\bkaraoke\b/;

function variantPenalty(candidateTitle: string, songTitle: string, candidateArtists: readonly string[]): number {
  let total = 0;
  for (const { pattern, penalty } of VARIANT_PENALTIES) {
    if (pattern.test(candidateTitle) && !pattern.test(songTitle)) total += penalty;
  }
  // Unlike the title-side rules, this carries no "absent from the song's own title" guard: a song
  // title never names its own artist, so there is no genuine song whose real artist is "Karaoke".
  if (candidateArtists.some((artist) => KARAOKE_ARTIST.test(artist))) total += 100;
  return total;
}

/**
 * A clean-edition suffix: a remaster of the SAME recording, in every spelling the catalogue uses
 * -- `2004 remaster`, `2013 remaster`, `remastered 2001`, `2017 remaster` and bare `remastered`
 * all appear in the #56 corpus; `remastered version` doesn't, but the same pattern covers it too.
 * `normalize` already drops the parentheses and dashes around it, so `(Remastered)` and
 * `- Remastered 2001` reach this as the identical case. Nothing else qualifies: `single version`,
 * `radio edit`, `mono`, `retrospective 3 version`, `take 2`, `live`, `remix`, `demo` and
 * `instrumental` are a different edit or a different recording, not the same master, and stay a
 * mere title prefix (#60's out-of-scope: a part-of-a-larger-work suffix like `- A New Age Dawns
 * 3`, which this pattern was never meant to match either).
 */
const CLEAN_EDITION_SUFFIX = /^(\d{4} )?remaster(ed)?( \d{4})?( version)?$/;

/**
 * Whether `candidate` IS `song`, or is `song` plus nothing but a clean-edition suffix -- the two
 * shapes `titleScore` (100 vs 99) and `pickBestTrack` (exact-title confidence, no score) each read
 * through this one function so they can never disagree about what counts.
 */
function isExactTitle(candidate: string, song: string): boolean {
  if (candidate === song) return true;
  if (!candidate.startsWith(`${song} `)) return false;
  return CLEAN_EDITION_SUFFIX.test(candidate.slice(song.length + 1));
}

/**
 * Whether a song title names one part of a suite: `<stem> Part <n>: <part name>`, after
 * `normalize` has already collapsed "Part I:" to "part i " (the colon is punctuation to
 * `normalize`, gone before this ever runs). `n` is Roman or Arabic -- setlist.fm's own spelling
 * isn't consistent -- and a part NAME must follow it, or this isn't a suite part worth searching
 * specially for: "Another Brick in the Wall, Part 2" has no part name and is an ordinary title
 * ("(.+)$" would never match nothing), and "Parts I-V" names no single part at all. `(.+?)` is
 * non-greedy so the stem is as short as possible -- the part number is the first "part <n>" the
 * title contains, not the last.
 */
export function parseSuitePart(normalizedTitle: string): { stem: string; part: string } | undefined {
  const match = normalizedTitle.match(/^(.+?) part ([ivxlcdm]+|\d+) (.+)$/);
  return match === null ? undefined : { stem: match[1]!, part: match[3]! };
}

/**
 * How well a candidate's title matches, 0-100. An exact match scores the full 100; a clean-edition
 * suffix (a remaster of the same recording) scores 99 -- exact enough for `high` confidence, but
 * one point short of the genuinely un-suffixed title, so when a page carries both, the plain title
 * still wins the tie by score rather than by page order (#60). A candidate that merely STARTS with
 * the song title scores well because that is what every OTHER edition suffix looks like ("Hey Jude
 * - Live").
 *
 * `suite`, when the song is one part of a suite (#66), scores 60 a candidate whose title starts
 * with the suite's stem and names the part -- setlist.fm lists *2112 Part I: Overture* as its own
 * song, but no Spotify title ever carries "Part I:", so without this every candidate scores 0 on
 * title and the part goes missing. 60 sits below a prefix match (72, an ordinary edition suffix)
 * and above a bare contains (40): a suite match wins only when nothing names the part more
 * directly. It can never satisfy `isExactTitle` either -- that compares against the SONG's own
 * title, which still literally contains "part i", and no real Spotify title does.
 *
 * A candidate that merely contains the title somewhere (and isn't a suite match) scores low -- it
 * is usually a medley or a mashup naming something else entirely.
 */
function titleScore(candidate: string, song: string, suite?: { stem: string; part: string }): number {
  if (candidate === song) return 100;
  if (isExactTitle(candidate, song)) return 99;
  if (song.length >= 3 && candidate.startsWith(`${song} `)) return 72;
  if (suite !== undefined && candidate.startsWith(suite.stem) && candidate.includes(suite.part)) return 60;
  if (song.length >= 4 && candidate.includes(song)) return 40;
  return 0;
}

/**
 * Whether `a` and `b` differ by at most one character -- one substitution, insertion or deletion.
 * Equal strings count (zero edits). No edit-distance matrix: equal-length strings get a single
 * differing-position scan; a one-character length difference gets a one-pointer scan that allows
 * exactly one skip on the longer string. A length difference of two or more is never one edit
 * away, so it short-circuits before either scan.
 */
export function withinOneEdit(a: string, b: string): boolean {
  const lengthDiff = a.length - b.length;
  if (Math.abs(lengthDiff) > 1) return false;
  if (lengthDiff === 0) {
    let diffs = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && ++diffs > 1) return false;
    }
    return true;
  }
  const [shorter, longer] = lengthDiff < 0 ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

/** The shortest song title a one-edit typo match is trusted for (#67) -- see `hasTypoPrefix`. */
const MIN_TYPO_TITLE_LENGTH = 8;

/**
 * Whether `candidate` is a one-character typo of `song` (see `withinOneEdit`), or starts with such
 * a typo'd title followed by a space -- so "detroit 442 remastered" still matches "detroit 422"
 * the same way a bare typo'd title would. `withinOneEdit` itself already rejects any length
 * difference greater than one, so trying every space-delimited prefix costs nothing extra: only a
 * prefix genuinely close in length to `song` can ever pass it.
 */
function hasTypoPrefix(candidate: string, song: string): boolean {
  if (withinOneEdit(candidate, song)) return true;
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] === " " && withinOneEdit(candidate.slice(0, i), song)) return true;
  }
  return false;
}

/**
 * How well any of the candidate's artists matches the one we searched for, 0-40. A blank candidate
 * artist (no name at all, or whitespace) scores nothing: the empty string is contained in every
 * `wanted`, so it would otherwise earn the partial score against any artist (#150).
 */
function artistScore(candidateArtists: string[], wanted: string): number {
  if (wanted === "") return 0;
  let best = 0;
  for (const artist of candidateArtists) {
    if (artist === "") continue;
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
  // Parsed once per song (not per candidate) and threaded through every titleScore call below,
  // including the sibling check inside the tieBreak loop -- so another edition of the same suite
  // part counts as a real title match there too, not just for the winning candidate.
  const suite = parseSuitePart(songTitle);
  let title = titleScore(candidateTitle, songTitle, suite);
  const candidateArtists = candidate.artistNames.map(normalize);
  const artist = artistScore(candidateArtists, normalize(song.artist));
  // A one-character typo in setlist.fm's own title text (#67): a title that scored 0 by every
  // other rule may still be the right song if it's a single edit away from what setlist.fm typed
  // AND the artist agrees -- "Detroit 422" (a human typo) vs Spotify's "Detroit 442". Scored 30:
  // with an exact artist that's 70, under the medium floor (90), so a typo match is always `low`
  // and the reply always asks the listener to check it. The length floor keeps a one-edit
  // collision on a short title (`maria` vs `mario`) from ever passing as the same song; without
  // artist agreement the rule doesn't apply at all -- a one-edit title from an unrelated artist is
  // a different song, not a typo.
  if (title === 0 && artist > 0 && songTitle.length >= MIN_TYPO_TITLE_LENGTH && hasTypoPrefix(candidateTitle, songTitle)) {
    title = 30;
  }
  // A candidate whose title doesn't match at all is never the right track, however well the artist
  // lines up -- returning 0 here (rather than a small positive) is what lets pickBestTrack reject
  // an entire result page instead of shipping its least-bad row.
  if (title === 0) return { title: 0, artist: 0, tieBreak: 0, penalty: 0, score: 0 };
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
          return otherPrimary === primaryArtist && titleScore(normalize(other.name), songTitle, suite) > 0;
        }).length;
  const tieBreak = editions / 100;
  const penalty = variantPenalty(candidateTitle, songTitle, candidateArtists);
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
    // Rejected outright, as the release notes say: a karaoke upload credited to the right artist
    // would otherwise be the only candidate on a thin page. The score stays as computed (the match
    // log records it). 100 is what each 100-point marker costs on its own -- karaoke, "in the style
    // of", "made popular by", tribute, "originally (performed) by", and a karaoke-credited artist --
    // and it is a threshold on the TOTAL, so a stack of lesser markers that reaches or passes it
    // (instrumental 45 + remix 30 + live 25) is rejected too, while one below it stays eligible.
    if (breakdown.score <= 0 || breakdown.penalty >= 100) continue;
    const tier = breakdown.artist > 0 ? 1 : 0;
    // Strictly greater on both counts, so the first candidate on a full tie (page order) is kept.
    if (best === undefined || tier > best.tier || (tier === best.tier && breakdown.score > best.score)) {
      best = { track: candidate, score: breakdown.score, tier };
    }
  }
  if (best === undefined) return undefined;

  const songTitle = normalize(song.name);
  // A clean-edition suffix (a remaster of the same recording) counts as exact here too (#60), via
  // the same `isExactTitle` that scored it 99 rather than 100 in `titleScore` -- the two can never
  // disagree about what an "exact" title is.
  const exactTitle = isExactTitle(normalize(best.track.name), songTitle);
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
 * `title` with a clean-edition suffix ("remastered 2011", "2013 remaster") taken off its end, or
 * `undefined` when it has none -- the same suffixes `isExactTitle` treats as the same recording.
 */
function withoutEditionSuffix(title: string): string | undefined {
  for (let space = title.indexOf(" "); space !== -1; space = title.indexOf(" ", space + 1)) {
    if (CLEAN_EDITION_SUFFIX.test(title.slice(space + 1))) return title.slice(0, space);
  }
  return undefined;
}

/**
 * The best candidate for one free-text query -- the entry point for `/party add`, whose option takes
 * "Track name, or track and artist". Unlike a setlist entry there is no separate artist field, so the
 * query is first tried as a title (exactly what `pickBestTrack` does with `artist: ""`, and the answer
 * whenever that finds anything), and only when no candidate's title fits is it read as "title artist"
 * or "artist title": a candidate matches when its whole normalized title heads or ends the normalized
 * query and what is left over names one of its artists (`artistScore` above zero, so a partial artist
 * counts as it does everywhere else).
 *
 * Three rules shape the reading relative to the title pass:
 * - A candidate's title also counts with a clean-edition suffix taken off ("Bohemian Rhapsody -
 *   Remastered 2011" answers "Bohemian Rhapsody Queen"), the same suffixes `isExactTitle` accepts; the
 *   unsuffixed title wins a tie against a suffixed one, as it does by score in the title pass. Any other
 *   decoration ("(feat. X)", "- Radio Edit") is not stripped: such a title matches only as a whole.
 * - A candidate the title pass would penalise as a variant is not a candidate here either. In the
 *   split only a karaoke credit on an artist can fire: a title that heads or ends the query already
 *   shares its marker words (live, remix, ...) with it.
 * - An artist name that normalizes to nothing (a blank one: `normalize` keeps the letters of every
 *   script, and falls back to the text itself when it has no letter or digit) is not an artist, and is
 *   dropped before scoring.
 *
 * Among split matches the higher artist score wins, then the longer title (it accounts for more of the
 * query), then an unsuffixed title over a suffixed one, then page order. The result is shaped like
 * `pickBestTrack`'s: `high` for an exact artist, `medium` for a partial one, and a `score` of 100 (the
 * title) plus the artist's points. The setlist path never comes through here.
 */
export function pickTrackFromQuery(query: string, candidates: readonly TrackCandidate[]): Match | undefined {
  const asTitle = pickBestTrack({ name: query, artist: "" }, candidates);
  if (asTitle !== undefined) return asTitle;

  const wanted = normalize(query);
  let best: { track: TrackCandidate; artist: number; titleLength: number; viaEdition: boolean } | undefined;
  for (const candidate of candidates) {
    const title = normalize(candidate.name);
    if (title === "") continue;
    const artists = candidate.artistNames.map(normalize).filter((artist) => artist !== "");
    if (variantPenalty(title, wanted, artists) > 0) continue;
    const base = withoutEditionSuffix(title);
    const heads = [{ text: title, viaEdition: false }];
    if (base !== undefined && base !== "") heads.push({ text: base, viaEdition: true });
    for (const { text, viaEdition } of heads) {
      // What is left of the query once the title is taken off its front ("title artist") or its back
      // ("artist title"); either reading may apply, and the better-scoring one counts.
      const rests: string[] = [];
      if (wanted.startsWith(`${text} `)) rests.push(wanted.slice(text.length + 1));
      if (wanted.endsWith(` ${text}`)) rests.push(wanted.slice(0, wanted.length - text.length - 1));
      for (const rest of rests) {
        const artist = artistScore(artists, rest);
        if (artist <= 0) continue;
        // Strictly better on every count, so the first candidate on a full tie (page order) is kept.
        const beats =
          best === undefined ||
          artist > best.artist ||
          (artist === best.artist &&
            (text.length > best.titleLength || (text.length === best.titleLength && best.viaEdition && !viaEdition)));
        if (beats) best = { track: candidate, artist, titleLength: text.length, viaEdition };
      }
    }
  }
  if (best === undefined) return undefined;
  return { track: best.track, confidence: best.artist === 40 ? "high" : "medium", score: 100 + best.artist };
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
