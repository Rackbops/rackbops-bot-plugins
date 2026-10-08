import { describe, expect, test } from "bun:test";
import {
  buildQueries,
  explainCandidate,
  normalize,
  parseSuitePart,
  pickBestTrack,
  pickTrackFromQuery,
  scoreCandidate,
  withinOneEdit,
  type TrackCandidate,
} from "./matching.js";

function track(name: string, artists: string[], popularity = 50): TrackCandidate {
  return { uri: `spotify:track:${name.replace(/\W/g, "").toLowerCase()}`, name, artistNames: artists, popularity };
}

describe("normalize", () => {
  test("strips accents so a typed-at-a-gig title still matches", () => {
    expect(normalize("Mötley Crüe")).toBe("motley crue");
    expect(normalize("Sigur Rós")).toBe("sigur ros");
  });

  test("drops punctuation, so a missing apostrophe costs nothing", () => {
    expect(normalize("Don't Stop Me Now")).toBe(normalize("Dont Stop Me Now"));
  });

  test("collapses whitespace and case", () => {
    expect(normalize("  HEY   Jude  ")).toBe("hey jude");
  });

  test('treats & and + as the word "and", so setlist.fm\'s ampersand meets Spotify\'s "And"', () => {
    expect(normalize("By-Tor & the Snow Dog")).toBe(normalize("By-Tor And The Snow Dog"));
    expect(normalize("Rock&Roll")).toBe(normalize("Rock and Roll"));
    expect(normalize("1+1")).toBe(normalize("1 and 1"));
  });

  test('a symbol on the edge of a title is still punctuation, not "and"', () => {
    expect(normalize("Plus +")).toBe("plus");
    expect(normalize("& Co")).toBe("co");
  });
});

describe("parseSuitePart", () => {
  test("a Roman-numbered part, colon form: stem and part name, colon already gone", () => {
    expect(parseSuitePart(normalize("2112 Part I: Overture"))).toEqual({ stem: "2112", part: "overture" });
  });

  test("an Arabic-numbered part, dash form", () => {
    expect(parseSuitePart(normalize("2112 - Part 2 - The Temples of Syrinx"))).toEqual({
      stem: "2112",
      part: "the temples of syrinx",
    });
  });

  test("a part number with no part name is not a suite part", () => {
    expect(parseSuitePart(normalize("Another Brick in the Wall, Part 2"))).toBeUndefined();
  });

  test('"Parts I-V" names no single part and is not a suite part', () => {
    expect(parseSuitePart(normalize("Parts I-V"))).toBeUndefined();
  });

  test("an ordinary title is not a suite part", () => {
    expect(parseSuitePart(normalize("Tom Sawyer"))).toBeUndefined();
  });
});

describe("withinOneEdit", () => {
  test("a single substitution is one edit", () => {
    expect(withinOneEdit("detroit 422", "detroit 442")).toBe(true);
  });

  test("a single insertion is one edit", () => {
    expect(withinOneEdit("cat", "cats")).toBe(true);
    expect(withinOneEdit("cat", "cast")).toBe(true);
  });

  test("a single deletion is one edit", () => {
    expect(withinOneEdit("cats", "cat")).toBe(true);
  });

  test("two edits is not one edit", () => {
    expect(withinOneEdit("cat", "hats")).toBe(false);
    expect(withinOneEdit("maria", "mario")).toBe(true); // sanity: this one IS one edit
    expect(withinOneEdit("maria", "marco")).toBe(false); // two substitutions
  });

  test("equal strings are zero edits, which counts", () => {
    expect(withinOneEdit("detroit 422", "detroit 422")).toBe(true);
  });
});

describe("scoreCandidate", () => {
  const song = { name: "Hey Jude", artist: "The Beatles" };

  test("an exact title and artist beats everything else", () => {
    const exact = scoreCandidate(song, track("Hey Jude", ["The Beatles"]));
    const looser = scoreCandidate(song, track("Hey Jude - Live", ["The Beatles"]));
    expect(exact).toBeGreaterThan(looser);
  });

  test("a title that doesn't match at all scores zero however right the artist is", () => {
    expect(scoreCandidate(song, track("Let It Be", ["The Beatles"]))).toBe(0);
  });

  test("a remaster suffix is NOT penalised -- it is the same recording", () => {
    const remaster = scoreCandidate(song, track("Hey Jude - Remastered 2015", ["The Beatles"]));
    const live = scoreCandidate(song, track("Hey Jude - Live at Wembley", ["The Beatles"]));
    expect(remaster).toBeGreaterThan(live);
  });

  test("karaoke is penalised so heavily it can never win", () => {
    expect(scoreCandidate(song, track("Hey Jude (Karaoke Version)", ["Karaoke Crew"]))).toBe(0);
  });

  test("'in the style of' tribute uploads are rejected too", () => {
    expect(scoreCandidate(song, track("Hey Jude (In the Style of The Beatles)", ["Tribute Band"]))).toBe(0);
  });

  test('an "originally performed by" upload is rejected like any other karaoke', () => {
    const wantThatMan = { name: "I Want That Man", artist: "Blondie" };
    expect(
      scoreCandidate(
        wantThatMan,
        track("I Want That Man (Originally Performed by Blondie) [Instrumental Version]", ["Karaoke Collective"]),
      ),
    ).toBe(0);
    expect(scoreCandidate(wantThatMan, track("I Want That Man (Originally by Blondie)", ["Tribute Band"]))).toBe(0);
  });

  test("a karaoke label's upload is rejected by its artist name alone", () => {
    const wantThatMan = { name: "I Want That Man", artist: "Blondie" };
    expect(scoreCandidate(wantThatMan, track("I Want That Man", ["Zoom Karaoke"]))).toBe(0);
  });

  test("the word 'live' in the song's OWN title is not treated as a variant marker", () => {
    const liveSong = { name: "Live and Let Die", artist: "Wings" };
    expect(scoreCandidate(liveSong, track("Live and Let Die", ["Wings"]))).toBeGreaterThan(130);
  });

  test("popularity no longer breaks ties -- Spotify search never sends it", () => {
    const popular = scoreCandidate(song, track("Hey Jude", ["The Beatles"], 90));
    const obscure = scoreCandidate(song, track("Hey Jude", ["The Beatles"], 10));
    expect(popular).toBe(obscure);
  });

  test("a clean remaster suffix scores as exact minus one (#60)", () => {
    const yesterday = { name: "Yesterday", artist: "The Beatles" };
    const dreamline = { name: "Dreamline", artist: "Rush" };
    const rapture = { name: "Rapture", artist: "Blondie" };
    for (const [candidateSong, name, artist] of [
      [yesterday, "Yesterday - Remastered 2009", "The Beatles"],
      [dreamline, "Dreamline - 2004 Remaster", "Rush"],
      [rapture, "Rapture (Remastered)", "Blondie"],
      [song, "Hey Jude - Remastered Version", "The Beatles"],
    ] as const) {
      expect(explainCandidate(candidateSong, track(name, [artist])).title).toBe(99);
    }
  });

  test("an edit or a re-recording is still a prefix, not a clean edition", () => {
    const dreamline = { name: "Dreamline", artist: "Rush" };
    const youBetterRun = { name: "You Better Run", artist: "The Rascals" };
    const maria = { name: "Maria", artist: "Blondie" };
    const detroit = { name: "Detroit 442", artist: "Blondie" };
    for (const [candidateSong, name, artist] of [
      [dreamline, "Dreamline - Retrospective 3 Version", "Rush"],
      [youBetterRun, "You Better Run - Single Version", "The Young Rascals"],
      [maria, "Maria - Radio Edit", "Blondie"],
      [detroit, "Detroit 442 - Take 2", "Blondie"],
    ] as const) {
      expect(explainCandidate(candidateSong, track(name, [artist])).title).toBe(72);
    }
  });
});

describe("explainCandidate", () => {
  const song = { name: "Hey Jude", artist: "The Beatles" };

  test("parts reproduce scoreCandidate for an exact match", () => {
    const candidate = track("Hey Jude", ["The Beatles"]);
    const breakdown = explainCandidate(song, candidate);
    expect(breakdown).toEqual({ title: 100, artist: 40, tieBreak: 0, penalty: 0, score: 140 });
    expect(breakdown.score).toBe(scoreCandidate(song, candidate));
    // scoreCandidate delegates to explainCandidate, so the line above cannot fail on its own; this
    // literal is the number the scorer returned before the log existed.
    expect(scoreCandidate(song, candidate)).toBe(140);
  });

  test("parts reproduce scoreCandidate for a remaster-suffixed title", () => {
    // #60: a clean-edition suffix ("Remastered 2015") scores 99, not the 72 an ordinary suffix
    // (a live cut, an edit) gets -- it's the same recording, one point short of un-suffixed exact.
    const candidate = track("Hey Jude - Remastered 2015", ["The Beatles"]);
    const breakdown = explainCandidate(song, candidate);
    expect(breakdown).toEqual({ title: 99, artist: 40, tieBreak: 0, penalty: 0, score: 139 });
    expect(breakdown.score).toBe(scoreCandidate(song, candidate));
    expect(scoreCandidate(song, candidate)).toBe(139);
  });

  test("parts reproduce scoreCandidate for a live-penalised title", () => {
    const candidate = track("Hey Jude - Live at Wembley", ["The Beatles"]);
    const breakdown = explainCandidate(song, candidate);
    expect(breakdown).toEqual({ title: 72, artist: 40, tieBreak: 0, penalty: 25, score: 87 });
    expect(breakdown.score).toBe(scoreCandidate(song, candidate));
    expect(scoreCandidate(song, candidate)).toBe(87);
  });

  test("a title miss is all zeros", () => {
    const candidate = track("Let It Be", ["The Beatles"]);
    const breakdown = explainCandidate(song, candidate);
    expect(breakdown).toEqual({ title: 0, artist: 0, tieBreak: 0, penalty: 0, score: 0 });
    expect(breakdown.score).toBe(scoreCandidate(song, candidate));
  });

  test("a penalty larger than the rest clamps the total at 0 and keeps the parts", () => {
    // Both the title ("Karaoke Version") and the artist name ("Karaoke Crew") independently trip
    // the 100-point karaoke rule (#99 added the artist-side one), so the total penalty is 200 --
    // still clamped to a score of 0, which is what this test actually guards.
    const candidate = track("Hey Jude (Karaoke Version)", ["Karaoke Crew"]);
    const breakdown = explainCandidate(song, candidate);
    expect(breakdown).toEqual({ title: 72, artist: 0, tieBreak: 0, penalty: 200, score: 0 });
    expect(scoreCandidate(song, candidate)).toBe(0);
  });

  // #59: tieBreak now counts OTHER same-primary-artist, title-matching candidates on the page,
  // divided by 100 -- not popularity, which Spotify search never actually sends.
  test("tieBreak counts other editions of the same primary artist on the page", () => {
    const remaster = track("Hey Jude - Remastered 2015", ["The Beatles"]);
    const page = [track("Hey Jude", ["The Beatles"]), remaster, track("Hey Jude", ["Wilson Pickett"])];
    const breakdown = explainCandidate(song, remaster, page);
    // Only "Hey Jude" (The Beatles) is another candidate with the same primary artist AND a
    // title-matching name; Wilson Pickett's does not share the primary artist.
    expect(breakdown.tieBreak).toBe(0.01);
  });

  test("tieBreak does not count a same-artist candidate whose title doesn't match at all", () => {
    const candidate = track("Hey Jude", ["The Beatles"]);
    const page = [candidate, track("Let It Be", ["The Beatles"])];
    expect(explainCandidate(song, candidate, page).tieBreak).toBe(0);
  });

  test("tieBreak excludes the candidate itself even when an identical duplicate is elsewhere on the page", () => {
    const candidate = track("Hey Jude", ["The Beatles"]);
    // A genuine duplicate row: same content, but a DISTINCT object -- real Spotify pages carry
    // exact duplicates like this (the corpus has several). Exclusion is by reference identity, not
    // content, so `candidate` must not count itself while `duplicate` still correctly counts as
    // another edition.
    const duplicate = track("Hey Jude", ["The Beatles"]);
    const page = [candidate, duplicate];
    expect(explainCandidate(song, candidate, page).tieBreak).toBe(0.01);
  });

  test("tieBreak treats two candidates with no artist at all as unrelated, not as sharing a primary artist", () => {
    const noArtist = track("Hey Jude", []);
    const alsoNoArtist = track("Hey Jude", []);
    const page = [noArtist, alsoNoArtist];
    expect(explainCandidate(song, noArtist, page).tieBreak).toBe(0);
  });
});

describe("pickBestTrack", () => {
  const song = { name: "Yesterday", artist: "The Beatles" };

  test("picks the studio cut over a live one and a karaoke one on the same page", () => {
    const best = pickBestTrack(song, [
      track("Yesterday (Karaoke Version)", ["Karaoke Stars"], 80),
      track("Yesterday - Live at the BBC", ["The Beatles"], 70),
      track("Yesterday", ["The Beatles"], 60),
    ]);
    expect(best!.track.name).toBe("Yesterday");
    expect(best!.confidence).toBe("high");
  });

  test('an "originally performed by" karaoke upload does not win an otherwise-empty page', () => {
    const wantThatMan = { name: "I Want That Man", artist: "Blondie" };
    const best = pickBestTrack(wantThatMan, [
      track("I Want That Man (Originally Performed by Blondie) [Instrumental Version]", ["Karaoke Collective"]),
      track("I Want That Man", ["Debbie Harry"]),
    ]);
    // Debbie Harry's plain title wins -- but with no artist overlap ("Blondie" vs "Debbie Harry"),
    // that's still only a low-confidence pick, exactly what the reply should flag to the listener.
    expect(best!.track.artistNames).toEqual(["Debbie Harry"]);
    expect(best!.confidence).toBe("low");
  });

  test("returns undefined when nothing on the page is credible", () => {
    expect(pickBestTrack(song, [track("Let It Be", ["The Beatles"]), track("Help!", ["The Beatles"])])).toBeUndefined();
  });

  test("an empty result page is a miss, not a crash", () => {
    expect(pickBestTrack(song, [])).toBeUndefined();
  });

  test("a right title under the wrong artist is matched but flagged low confidence", () => {
    const best = pickBestTrack(song, [track("Yesterday", ["Boyz II Men"])]);
    expect(best!.track.artistNames).toEqual(["Boyz II Men"]);
    expect(best!.confidence).toBe("low");
  });

  test("a remaster under the right artist is confident enough to add without comment", () => {
    const best = pickBestTrack(song, [track("Yesterday - Remastered 2009", ["The Beatles"])]);
    expect(best!.confidence).toBe("high");
  });

  test("Yesterday - Remastered 2009 / The Beatles and Dreamline - 2004 Remaster / Rush are high", () => {
    const yesterday = pickBestTrack(song, [track("Yesterday - Remastered 2009", ["The Beatles"])]);
    expect(yesterday!.confidence).toBe("high");

    const dreamline = { name: "Dreamline", artist: "Rush" };
    const rush = pickBestTrack(dreamline, [track("Dreamline - 2004 Remaster", ["Rush"])]);
    expect(rush!.confidence).toBe("high");
  });

  test("Dreamline - Retrospective 3 Version and Dreamline - Live are not high", () => {
    const dreamline = { name: "Dreamline", artist: "Rush" };
    const retrospective = pickBestTrack(dreamline, [track("Dreamline - Retrospective 3 Version", ["Rush"])]);
    expect(retrospective!.confidence).not.toBe("high");

    const live = pickBestTrack(dreamline, [track("Dreamline - Live", ["Rush"])]);
    expect(live!.confidence).not.toBe("high");
  });

  test("the un-suffixed title still beats its own remaster on the same page", () => {
    const dreamline = { name: "Dreamline", artist: "Rush" };
    const best = pickBestTrack(dreamline, [
      track("Dreamline - 2004 Remaster", ["Rush"]),
      track("Dreamline", ["Rush"]),
    ]);
    // Exact (100) beats a clean-edition suffix (99) by score, not by page order -- the remaster
    // is listed FIRST here, and the plain title still wins.
    expect(best!.track.name).toBe("Dreamline");
    expect(best!.confidence).toBe("high");
  });

  test("only a live version available still matches, flagged rather than dropped", () => {
    const best = pickBestTrack(song, [track("Yesterday - Live", ["The Beatles"])]);
    expect(best).toBeDefined();
    expect(best!.confidence).not.toBe("high");
  });

  test("a cover is found under the original artist, which is how flattenSetlist queries it", () => {
    const cover = { name: "Twist and Shout", artist: "The Top Notes" };
    const best = pickBestTrack(cover, [track("Twist and Shout", ["The Top Notes"])]);
    expect(best!.confidence).toBe("high");
  });

  // #57: names and artists straight from a real logged run (rackbops-bot-plugins#43, the Rush
  // setlist) -- setlist.fm credited the cover "By-Tor & the Snow Dog", Spotify's studio track is
  // "By-Tor And The Snow Dog", and before this fix the studio cut scored 0 (title mismatch) while a
  // 1980 live recording won at "low".
  test("picks the studio By-Tor And The Snow Dog at high over the live cut, from the logged page", () => {
    const song = { name: "By-Tor & the Snow Dog", artist: "Rush" };
    const best = pickBestTrack(song, [
      track("By-Tor And The Snow Dog", ["Rush"]),
      track("By-Tor & The Snow Dog - Live in London - Permanent Waves 1980 Tour", ["Rush"]),
    ]);
    expect(best!.track.name).toBe("By-Tor And The Snow Dog");
    expect(best!.confidence).toBe("high");
  });

  // An ampersand flanked by real characters on both sides (not at the edge of the title, unlike
  // "Plus +" or "& Co" above) still has to compare equal to the same title spelled out with "And"
  // -- using the SAME literal string on both sides here would pass trivially however "&" is
  // handled, since normalize(x) always equals normalize(x); the candidate is deliberately spelled
  // differently so this genuinely exercises the "&"-to-"and" conversion.
  test("an ampersand flanked by real characters on both sides still matches a differently-spelled equivalent", () => {
    const song = { name: "I Don't Like People (& They Don't Like Me)", artist: "Boston Manor" };
    const best = pickBestTrack(song, [
      track("I Don't Like People (And They Don't Like Me)", ["Boston Manor"]),
    ]);
    expect(best!.confidence).toBe("high");
  });

  // #58: names and artists straight from a real logged run (rackbops-bot-plugins#43) -- Boomkat's
  // exact title (100, no artist agreement) used to outrank Blondie's own remaster (72 + 22 = 94,
  // partial artist agreement), so an unrelated band's exact title won over the right artist's
  // recording. Artist agreement is now a tier above title score, so the remaster wins even though
  // its raw score is lower.
  test("the right artist's remaster outranks an exact title by an unrelated artist, from the logged page", () => {
    const song = { name: "Rip Her to Shreds", artist: "Totally Blondie" };
    const best = pickBestTrack(song, [
      track("Rip Her To Shreds - Remastered 2001", ["Blondie", "Craig Leon"]),
      track("Rip Her to Shreds", ["Boomkat"]),
    ]);
    expect(best!.track.name).toBe("Rip Her To Shreds - Remastered 2001");
    expect(best!.confidence).toBe("medium");
  });

  test("within a tier the score still decides", () => {
    const best = pickBestTrack(song, [
      track("Yesterday - Remastered 2015", ["The Beatles"]),
      track("Yesterday", ["The Beatles"]),
    ]);
    expect(best!.track.name).toBe("Yesterday");
    expect(best!.confidence).toBe("high");
  });

  // #59: modelled on the corpus's *All Fired Up* -- four exact-titled covers tied on title score,
  // no artist agreement because the search used the original's own credit. The artist whose
  // recording exists in more than one edition on the page (Pat Benatar's remaster alongside her
  // original) is the catalogue artist, and now wins the tie even though it is listed second.
  test("a tie goes to the artist with more editions on the page, even when it comes second", () => {
    const song = { name: "All Fired Up", artist: "Rattling Sabres" };
    const best = pickBestTrack(song, [
      track("All Fired Up", ["Fastway"]),
      track("All Fired Up", ["Pat Benatar"]),
      track("All Fired Up - Remastered", ["Pat Benatar"]),
    ]);
    expect(best!.track.artistNames).toEqual(["Pat Benatar"]);
    expect(best!.track.name).toBe("All Fired Up");
  });

  test("page order still decides a genuine tie", () => {
    const song = { name: "Genuine Tie", artist: "Nobody Related" };
    const best = pickBestTrack(song, [
      track("Genuine Tie", ["Artist One"]),
      track("Genuine Tie", ["Artist Two"]),
    ]);
    expect(best!.track.artistNames).toEqual(["Artist One"]);
  });

  // #66: setlist.fm lists a suite by its parts ("2112 Part VII: Grand Finale"), but no Spotify
  // title ever carries "Part VII:" -- names taken from the real corpus entry (rackbops-bot-plugins#43).
  test("a suite part matches the suite's recording that names it, at medium", () => {
    const song = { name: "2112 Part VII: Grand Finale", artist: "Rush" };
    const best = pickBestTrack(song, [
      track(
        "2112: Overture / The Temples Of Syrinx / Discovery / Presentation / Oracle / Soliloquy / Grand Finale - Medley",
        ["Rush"],
      ),
      track("2112 (Grand Finale) - Live", ["Rush"]),
    ]);
    expect(best!.track.name).toBe(
      "2112: Overture / The Temples Of Syrinx / Discovery / Presentation / Oracle / Soliloquy / Grand Finale - Medley",
    );
    expect(best!.confidence).toBe("medium");
  });

  test("a suite part does not match a track of the suite that omits the part", () => {
    const song = { name: "2112 Part VII: Grand Finale", artist: "Rush" };
    const best = pickBestTrack(song, [track("2112 Overture / The Temples Of Syrinx", ["Rush"])]);
    expect(best).toBeUndefined();
  });

  // A LITERAL exact-title candidate would win via titleScore's very first branch (100) regardless
  // of whether the suite rule exists or where it sits -- that proves nothing about precedence. The
  // candidate here reaches its score through the PREFIX rule (72) instead: it starts with the full
  // song title plus a suffix that isn't a clean-edition remaster, so isExactTitle is false, but it
  // ALSO independently satisfies the suite condition (starts with the stem, contains the part
  // name). Both candidates tie on artist and tieBreak, so only the title rule that wins decides:
  // 72 (prefix, checked first) beats 60 (suite) here; if the suite check ever ran first, both
  // candidates would score identically and the medley (listed first) would win the tie instead.
  test("a candidate satisfying both the prefix rule and the suite rule scores via the prefix rule, not the suite rule", () => {
    const song = { name: "2112 Part I: Overture", artist: "Rush" };
    const candidate = track("2112 Part I: Overture - Single Edit", ["Rush"]);
    expect(explainCandidate(song, candidate).title).toBe(72);
  });

  test("an exact or prefix title still beats a suite match", () => {
    const song = { name: "2112 Part I: Overture", artist: "Rush" };
    const best = pickBestTrack(song, [
      track(
        "2112: Overture / The Temples Of Syrinx / Discovery / Presentation / Oracle / Soliloquy / Grand Finale - Medley",
        ["Rush"],
      ),
      track("2112 Part I: Overture - Single Edit", ["Rush"]),
    ]);
    expect(best!.track.name).toBe("2112 Part I: Overture - Single Edit");
    expect(best!.confidence).toBe("medium");
  });

  // #67: setlist.fm typed "Detroit 422"; Blondie's song is "Detroit 442" -- names and candidates
  // straight from the real logged run (rackbops-bot-plugins#43).
  test("a one-edit title with an agreeing artist matches at low", () => {
    const song = { name: "Detroit 422", artist: "Totally Blondie" };
    const best = pickBestTrack(song, [track("Detroit 442 - Remastered", ["Blondie"])]);
    expect(best!.track.name).toBe("Detroit 442 - Remastered");
    expect(best!.confidence).toBe("low");
  });

  test("with an unrelated artist a one-edit title does not match", () => {
    const song = { name: "Detroit 422", artist: "Someone Else" };
    const best = pickBestTrack(song, [track("Detroit 442 - Remastered", ["Blondie"])]);
    expect(best).toBeUndefined();
  });

  test("a title under 8 characters never gets the one-edit fallback", () => {
    const song = { name: "Maria", artist: "Blondie" };
    const best = pickBestTrack(song, [track("Mario", ["Blondie"])]);
    expect(best).toBeUndefined();
  });

  // Pinned to the exact floor, not just "somewhere under 8" (the "Maria"/"Mario" test above is 5
  // characters, nowhere near 8, so it can't tell an 8 from a 7 or a 9): a title one character
  // short of MIN_TYPO_TITLE_LENGTH never gets the fallback, and a title exactly at the floor does.
  test("a title one character short of the 8-character floor never gets the fallback", () => {
    const song = { name: "Freeway", artist: "Test Act" }; // 7 characters
    const best = pickBestTrack(song, [track("Freeday", ["Test Act"])]); // one substitution
    expect(best).toBeUndefined();
  });

  test("a title exactly at the 8-character floor gets the fallback", () => {
    const song = { name: "Freeways", artist: "Test Act" }; // 8 characters
    const best = pickBestTrack(song, [track("Freeway", ["Test Act"])]); // one deletion
    expect(best!.confidence).toBe("low");
  });

  test("a live one-edit cut still pays the live penalty, ranking below the plain one", () => {
    const song = { name: "Detroit 422", artist: "Totally Blondie" };
    const best = pickBestTrack(song, [
      track("Detroit 442 - Live At The Walnut Theatre, Philadelphia, 1978 / Remastered", ["Blondie"]),
      track("Detroit 442 - Remastered", ["Blondie"]),
    ]);
    expect(best!.track.name).toBe("Detroit 442 - Remastered");
    expect(best!.confidence).toBe("low");
  });
});

// #155: `/party add`'s free-text query, which may be "title", "title artist" or "artist title".
describe("pickTrackFromQuery", () => {
  const queen = track("Bohemian Rhapsody", ["Queen"]);
  const dust = track("Another One Bites the Dust", ["Queen"]);

  test("a plain title still matches exactly as before", () => {
    const page = [dust, queen];
    const asTitle = pickBestTrack({ name: "Bohemian Rhapsody", artist: "" }, page);

    expect(asTitle!.track).toBe(queen);
    // Same answer, same confidence and score: the title is tried first, unchanged.
    expect(pickTrackFromQuery("Bohemian Rhapsody", page)).toEqual(asTitle);
  });

  test("a query that is a whole title wins over a reading of it as title and artist", () => {
    const literal = track("Hey Jude Band", ["Someone Else"]);
    const split = track("Hey Jude", ["Band"]);

    expect(pickTrackFromQuery("Hey Jude Band", [split, literal])!.track).toBe(literal);
  });

  test("title then artist finds the track the title alone would not", () => {
    // Read as a title, the whole query fits no candidate...
    expect(pickBestTrack({ name: "Bohemian Rhapsody Queen", artist: "" }, [dust, queen])).toBeUndefined();

    const best = pickTrackFromQuery("Bohemian Rhapsody Queen", [dust, queen]);

    expect(best!.track).toBe(queen);
    expect(best!.confidence).toBe("high");
  });

  test("artist then title too", () => {
    const best = pickTrackFromQuery("Queen Bohemian Rhapsody", [dust, queen]);

    expect(best!.track).toBe(queen);
    expect(best!.confidence).toBe("high");
  });

  test("accents, case and punctuation do not cost the split a match", () => {
    const now = track("Don't Stop Me Now", ["Queen"]);

    expect(pickTrackFromQuery("DON'T stop me now - Queen", [dust, now])!.track).toBe(now);
    expect(pickTrackFromQuery("queen: dont stop me now", [dust, now])!.track).toBe(now);
  });

  test("a partial artist still counts, with medium confidence", () => {
    // `artistScore` credits 22 when one name contains the other: "que" is inside "queen".
    const best = pickTrackFromQuery("Bohemian Rhapsody Que", [dust, queen]);

    expect(best!.track).toBe(queen);
    expect(best!.confidence).toBe("medium");
    expect(best!.score).toBe(122);
  });

  test("an exact artist beats a partial one, whatever the page order", () => {
    const tribute = track("Bohemian Rhapsody", ["Queen Tribute"]);

    const best = pickTrackFromQuery("Bohemian Rhapsody Queen", [tribute, queen]);

    expect(best!.track).toBe(queen);
    expect(best!.confidence).toBe("high");
  });

  test("the longer title wins when two candidates both fit", () => {
    // "Hey" and "Hey Jude" both head "Hey Jude Band", and both artists fit what is left of it exactly.
    const hey = track("Hey", ["Jude Band"]);
    const heyJude = track("Hey Jude", ["Band"]);

    expect(pickTrackFromQuery("Hey Jude Band", [hey, heyJude])!.track).toBe(heyJude);
    expect(pickTrackFromQuery("Hey Jude Band", [heyJude, hey])!.track).toBe(heyJude);
  });

  test("only the candidate whose whole title heads the query fits", () => {
    const rhapsody = track("Rhapsody", ["Queen"]);
    const page = [rhapsody, queen];

    expect(pickTrackFromQuery("Rhapsody Queen", page)!.track).toBe(rhapsody);
    expect(pickTrackFromQuery("Bohemian Rhapsody Queen", page)!.track).toBe(queen);
  });

  test("on a full tie the page order decides", () => {
    const first = track("Bohemian Rhapsody", ["Queen"]);
    const second = { ...track("Bohemian Rhapsody", ["Queen"]), uri: "spotify:track:second" };

    expect(pickTrackFromQuery("Bohemian Rhapsody Queen", [first, second])!.track).toBe(first);
  });

  test("nothing matches when neither half fits", () => {
    // The title fits but the rest of the query names no artist of the track.
    expect(pickTrackFromQuery("Bohemian Rhapsody Beatles", [dust, queen])).toBeUndefined();
    // The artist fits but no title does.
    expect(pickTrackFromQuery("Queen Yesterday", [dust, queen])).toBeUndefined();
  });

  test("an empty page, or a query with nothing in it, is a miss rather than a crash", () => {
    expect(pickTrackFromQuery("Bohemian Rhapsody Queen", [])).toBeUndefined();
    expect(pickTrackFromQuery("!!!", [dust, queen])).toBeUndefined();
  });
});

describe("buildQueries", () => {
  test("tries the precise field-filtered query before the loose one", () => {
    expect(buildQueries({ name: "Hey Jude", artist: "The Beatles" })).toEqual([
      'track:"Hey Jude" artist:"The Beatles"',
      "Hey Jude The Beatles",
    ]);
  });

  test("strips quotes rather than escaping them -- an unbalanced quote 400s the whole query", () => {
    const [filtered] = buildQueries({ name: '"Heroes"', artist: "David Bowie" });
    expect(filtered).not.toContain('""');
    expect(filtered).toBe('track:"Heroes" artist:"David Bowie"');
  });

  test("with no artist there is only the bare title query", () => {
    expect(buildQueries({ name: "Untitled", artist: "" })).toEqual(["Untitled"]);
  });
});
