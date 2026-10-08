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

  test("every apostrophe spelling is deleted, not spaced", () => {
    // The ASCII apostrophe and backtick, the two curly quotes, the modifier letter apostrophe, and
    // the acute accent, prime and fullwidth apostrophe setlist.fm titles carry ("Don´t Stop
    // Believin´"). Keyed by code point so a failure names the character that turned into a space.
    const apostrophes = ["'", "`", "‘", "’", "ʼ", "´", "′", "＇"];
    // Two apostrophes of the same kind per title, both inside it, so a replace that stops at the
    // first one (or one that leaves a trailing apostrophe for `trim` to hide) is caught too.
    const normalized = Object.fromEntries(
      apostrophes.map((c) => [c.codePointAt(0)!.toString(16), normalize(`Don${c}t Won${c}t Stop`)]),
    );
    expect(normalized).toEqual(
      Object.fromEntries(apostrophes.map((c) => [c.codePointAt(0)!.toString(16), "dont wont stop"])),
    );
    // And the end to end shape of the bug: setlist.fm's spelling against Spotify's.
    expect(normalize("Don´t Stop Believin´")).toBe(normalize("Don't Stop Believin'"));
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

  // #193: the sibling check inside the tieBreak loop scores the OTHER rows with the song's suite
  // too, so a recording that only names the suite still counts as another edition of the same
  // artist's work. Without the suite argument that sibling scores 0 on title and drops out of the
  // count, which no other test notices: every other tieBreak case is a plain (non-suite) title.
  test("the suite-aware sibling check counts a whole-suite recording as an edition", () => {
    const suitePart = { name: "2112 Part II: The Temples of Syrinx", artist: "Rush" };
    const exact = track("2112 Part II: The Temples of Syrinx", ["Rush"]);
    const wholeSuite = track("2112: Overture / The Temples Of Syrinx / Discovery", ["Rush"]);

    // The sibling reaches title > 0 only through the suite rule (60): its title does not contain
    // the song's own, so the plain rules score it 0.
    expect(explainCandidate(suitePart, wholeSuite).title).toBe(60);
    expect(explainCandidate(suitePart, exact, [exact, wholeSuite]).tieBreak).toBe(0.01);
  });
});

// #193: every row of VARIANT_PENALTIES, one case each. Most rows were removable, or their number
// changeable, with the suite green: the cases above pin the karaoke and live rows, the
// "in the style of" and "originally (performed) by" alternatives, and nothing else.
describe("variant penalties", () => {
  const song = { name: "Song", artist: "Band" };

  test.each<[string, number]>([
    ["commentary", 60],
    ["instrumental", 45],
    ["remix", 30],
    ["rmx", 30],
    ["live", 25],
    ["concert", 25],
    ["demo", 20],
    ["rehearsal", 20],
    ["sped up", 50],
    ["slowed", 50],
    ["nightcore", 50],
    ["made popular by", 100],
    ["in the style of", 100],
    ["tribute", 100],
    ["originally performed by", 100],
    ["originally by", 100],
    ["karaoke", 100],
  ])("a %s marker in the candidate's title costs %d", (marker, penalty) => {
    expect(explainCandidate(song, track(`Song (${marker})`, ["Band"])).penalty).toBe(penalty);
  });

  test("a marker in the song's own title costs nothing", () => {
    const liveSong = { name: "Live and Let Die", artist: "Wings" };
    expect(explainCandidate(liveSong, track("Live and Let Die", ["Wings"])).penalty).toBe(0);
  });

  test.each<[string, string[]]>([
    ["first", ["Karaoke Kings", "Band", "Other"]],
    ["in the middle", ["Band", "Karaoke Kings", "Other"]],
    ["last", ["Band", "Other", "Karaoke Kings"]],
  ])("a karaoke label credited %s among the artists costs 100 on its own", (_where, artists) => {
    // The rule reads every credited artist, wherever the label sits in the list.
    expect(explainCandidate(song, track("Song", artists)).penalty).toBe(100);
  });

  test("penalties add up: a live remix pays both rows, and a karaoke label's credit on top", () => {
    expect(explainCandidate(song, track("Song (Live) (Remix)", ["Band"])).penalty).toBe(55);
    expect(explainCandidate(song, track("Song (Live) (Remix)", ["Karaoke Kings"])).penalty).toBe(155);
  });

  // A marker is a whole word: a title word that merely contains one is not a variant of anything.
  test.each<[string, string]>([
    ["live", "Alive"],
    ["concert", "Concerto"],
    ["demo", "Democracy"],
    ["tribute", "Attribute"],
    ["remix", "Premix"],
  ])("the %s marker does not fire inside a longer word: %s costs nothing", (_marker, word) => {
    expect(explainCandidate(song, track(`Song (${word})`, ["Band"])).penalty).toBe(0);
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

  // #191: the release notes say karaoke and "in the style of" uploads are "rejected outright". A
  // penalty alone only sinks the score, and a score above zero is still a candidate -- so an upload
  // credited to the RIGHT artist (whose title and artist points outweigh the 100) used to survive.
  describe("a penalty of 100 or more rejects the candidate outright", () => {
    const letItBe = { name: "Let It Be", artist: "The Beatles" };

    test("a karaoke upload credited to the original artist is rejected outright", () => {
      // 72 (prefix title) + 40 (exact artist) - 100 = 12: above zero, so it used to be a `low` pick.
      const upload = track("Let It Be (Karaoke Version)", ["The Beatles"]);
      expect(scoreCandidate(letItBe, upload)).toBe(12);
      expect(pickBestTrack(letItBe, [upload])).toBeUndefined();
    });

    test("an exact title with a karaoke label among the artists is rejected, not high", () => {
      // 100 + 40 - 100 = 40, with an exact title and an exact artist: it used to be `high`.
      const upload = track("Let It Be", ["The Beatles", "Karaoke Kings"]);
      expect(scoreCandidate(letItBe, upload)).toBe(40);
      expect(pickBestTrack(letItBe, [upload])).toBeUndefined();
    });

    test("the genuine recording still wins a page that also holds a karaoke upload", () => {
      const genuine = track("Let It Be", ["The Beatles"]);
      const upload = track("Let It Be", ["The Beatles", "Karaoke Kings"]);
      expect(pickBestTrack(letItBe, [upload, genuine])!.track).toBe(genuine);
      expect(pickBestTrack(letItBe, [genuine, upload])!.track).toBe(genuine);
    });

    test("a live cut by the right artist is still eligible", () => {
      const live = track("Let It Be (Live)", ["The Beatles"]);
      expect(pickBestTrack(letItBe, [live])!.track).toBe(live);
    });

    test("every single marker short of karaoke leaves the candidate eligible", () => {
      for (const title of [
        "Let It Be (Live)",
        "Let It Be (Remix)",
        "Let It Be (Demo)",
        "Let It Be (Instrumental)",
        "Let It Be (Sped Up)",
        "Let It Be (Commentary)",
      ]) {
        const variant = track(title, ["The Beatles"]);
        expect(pickBestTrack(letItBe, [variant])?.track).toBe(variant);
      }
    });

    test("markers stack: a total below 100 stays eligible, one that reaches 100 does not", () => {
      // The threshold is the TOTAL, not the kind of marker: instrumental (45) + remix (30) is 75,
      // instrumental + sped up (50) is 95, and instrumental + remix + live (25) makes exactly 100.
      // (Commentary is 60, so commentary + instrumental is 105 and is rejected like the rest.)
      for (const [title, penalty] of [
        ["Let It Be (Instrumental Remix)", 75],
        ["Let It Be (Instrumental Sped Up)", 95],
      ] as const) {
        const below = track(title, ["The Beatles"]);
        expect(explainCandidate(letItBe, below).penalty).toBe(penalty);
        expect(pickBestTrack(letItBe, [below])!.track).toBe(below);
      }
      const reaches = track("Let It Be (Instrumental Remix Live)", ["The Beatles"]);
      expect(explainCandidate(letItBe, reaches).penalty).toBe(100);
      expect(scoreCandidate(letItBe, reaches)).toBe(72 + 40 - 100);
      expect(pickBestTrack(letItBe, [reaches])).toBeUndefined();
    });
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
    const feelgood = track("Dr. Feelgood", ["Mötley Crüe"]);

    expect(pickTrackFromQuery("DON'T stop me now - Queen", [dust, now])!.track).toBe(now);
    expect(pickTrackFromQuery("queen: dont stop me now", [dust, now])!.track).toBe(now);
    // Accents on either side: typed without them against Spotify's spelling, and the other way round.
    expect(pickTrackFromQuery("Dr Feelgood Motley Crue", [dust, feelgood])!.track).toBe(feelgood);
    expect(pickTrackFromQuery("Mötley Crüe Dr. Feelgood", [dust, feelgood])!.track).toBe(feelgood);
  });

  test("a title only counts as a whole word at the head or the tail of the query", () => {
    // "hey" is a prefix of "heyday" and "day" a suffix of "heyday", but neither is a word of it.
    expect(pickTrackFromQuery("Heyday Band", [track("Hey", ["Day Band"])])).toBeUndefined();
    expect(pickTrackFromQuery("Band Heyday", [track("Day", ["Band Hey"])])).toBeUndefined();
  });

  test("each reading is tried: the tail can match where the head does not", () => {
    // "Hey Jude Hey": the track 'Hey' by 'Hey Jude'. Read as 'title artist' the rest is 'jude hey',
    // which names nobody; read as 'artist title' it is 'hey jude', the exact artist.
    const hey = track("Hey", ["Hey Jude"]);

    const best = pickTrackFromQuery("Hey Jude Hey", [dust, hey]);

    expect(best!.track).toBe(hey);
    expect(best!.confidence).toBe("high");
    expect(best!.score).toBe(140);
  });

  test("a candidate whose title both heads and ends the query still matches", () => {
    // "Queen Queen": the track 'Queen' by Queen, read either way round.
    const selfTitled = track("Queen", ["Queen"]);

    const best = pickTrackFromQuery("Queen Queen", [dust, selfTitled]);

    expect(best!.track).toBe(selfTitled);
    expect(best!.confidence).toBe("high");
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

    for (const page of [[tribute, queen], [queen, tribute]]) {
      const best = pickTrackFromQuery("Bohemian Rhapsody Queen", page);

      expect(best!.track).toBe(queen);
      expect(best!.confidence).toBe("high");
    }
  });

  test("the artist's score is weighed before the title's length", () => {
    // "Hey" would be the shorter title, but its artist is the exact rest of the query; "Hey Jude" is
    // longer but its artist ("Bandits") only partly names the rest ("band").
    const hey = track("Hey", ["Jude Band"]);
    const heyJude = track("Hey Jude", ["Bandits"]);

    const best = pickTrackFromQuery("Hey Jude Band", [heyJude, hey]);

    expect(best!.track).toBe(hey);
    expect(best!.confidence).toBe("high");
    expect(best!.score).toBe(140);
  });

  test("a clean-edition title answers the query too, as it does for a title on its own", () => {
    const remaster = track("Bohemian Rhapsody - Remastered 2011", ["Queen"]);

    // A title-only query already accepts a remaster (isExactTitle); the split now does as well.
    expect(pickBestTrack({ name: "Bohemian Rhapsody", artist: "" }, [remaster])!.track).toBe(remaster);
    const best = pickTrackFromQuery("Bohemian Rhapsody Queen", [dust, remaster]);

    expect(best!.track).toBe(remaster);
    expect(best!.confidence).toBe("high");
    expect(pickTrackFromQuery("Queen Bohemian Rhapsody", [dust, remaster])!.track).toBe(remaster);
    // The other spellings the catalogue uses for the same master.
    for (const name of ["Bohemian Rhapsody (2011 Remaster)", "Bohemian Rhapsody - Remastered", "Bohemian Rhapsody - 2011 Remaster"]) {
      const spelled = track(name, ["Queen"]);
      expect(pickTrackFromQuery("Bohemian Rhapsody Queen", [dust, spelled])!.track).toBe(spelled);
    }
  });

  test("a clean-edition title with a one-word base answers too", () => {
    // The base is cut at the FIRST space whose remainder is a clean-edition suffix: here the only one.
    const yesterday = track("Yesterday - Remastered 2009", ["The Beatles"]);
    const help = track("Help! - Remastered 2009", ["The Beatles"]);

    const best = pickTrackFromQuery("Yesterday Beatles", [dust, yesterday]);

    expect(best!.track).toBe(yesterday);
    expect(best!.confidence).toBe("medium");
    expect(pickTrackFromQuery("The Beatles Help!", [dust, help])!.track).toBe(help);
  });

  test("the plain title wins a tie against a clean-edition one, whatever the page order", () => {
    const remaster = track("Bohemian Rhapsody - Remastered 2011", ["Queen"]);

    expect(pickTrackFromQuery("Bohemian Rhapsody Queen", [remaster, queen])!.track).toBe(queen);
    expect(pickTrackFromQuery("Bohemian Rhapsody Queen", [queen, remaster])!.track).toBe(queen);
  });

  test("an edition that is a different recording is not a clean-edition title", () => {
    // A live cut, a single version and a remix are not the same master, so none of them reads as the
    // plain title with a harmless suffix (and a live or remix title would be turned away as a variant
    // too); only 'single version' depends on the clean-edition pattern being as narrow as it is.
    for (const name of ["Bohemian Rhapsody - Live", "Bohemian Rhapsody - Single Version", "Bohemian Rhapsody - Remix"]) {
      expect(pickTrackFromQuery("Bohemian Rhapsody Queen", [track(name, ["Queen"])])).toBeUndefined();
    }
  });

  test("a karaoke credit is not a candidate, as it is not in the title pass", () => {
    const karaoke = track("Bohemian Rhapsody", ["Queen Karaoke"]);

    // Alone on the page it must not be the answer ('queen' sits inside 'queen karaoke')...
    expect(pickTrackFromQuery("Bohemian Rhapsody Queen", [karaoke])).toBeUndefined();
    // ...and the genuine track beside it still wins, whichever comes first.
    expect(pickTrackFromQuery("Bohemian Rhapsody Queen", [karaoke, queen])!.track).toBe(queen);
    expect(pickTrackFromQuery("Bohemian Rhapsody Queen", [queen, karaoke])!.track).toBe(queen);
  });

  test("a title-only query does not queue a karaoke upload either (#191)", () => {
    // The title pass is `pickBestTrack`, so its outright rejection of a penalty of 100 reaches
    // `/party add`. With no artist in the query the exact title's 100 is cancelled by the 100
    // penalty, and what survives is the 0.01 tie-break for one same-artist sibling on the page: a
    // positive score, which used to make this upload the answer (as a `low` pick, queued unflagged).
    const upload = track("Let It Be", ["The Beatles", "Karaoke Kings"]);
    const sibling = track("Let It Be (Karaoke Version)", ["The Beatles"]);
    expect(scoreCandidate({ name: "Let It Be", artist: "" }, upload, [upload, sibling])).toBeGreaterThan(0);
    expect(pickTrackFromQuery("Let It Be", [upload, sibling])).toBeUndefined();
    // The genuine recording on the same page is still found.
    const genuine = track("Let It Be", ["The Beatles"]);
    expect(pickTrackFromQuery("Let It Be", [upload, sibling, genuine])!.track).toBe(genuine);
  });

  test("an artist that normalizes to nothing is not an artist", () => {
    // Only a blank name normalizes to nothing (#150 keeps the letters of every script, and gives
    // punctuation-only text back as itself), and `artistScore` counts the empty string as contained in
    // anything: without the guard these would answer any title-then-anything query.
    expect(normalize("  ")).toBe("");
    expect(pickTrackFromQuery("Lemon Tree Fools Garden", [track("Lemon", [""])])).toBeUndefined();
    expect(pickTrackFromQuery("Heart of Glass Blondie", [track("Heart of Glass", ["   "])])).toBeUndefined();
    expect(pickTrackFromQuery("Blondie Heart of Glass", [track("Heart of Glass", [""])])).toBeUndefined();
    // A track credited to such an artist AND a real one still matches on the real one.
    const duet = track("Lemon", ["", "Kenshi"]);
    expect(pickTrackFromQuery("Lemon Kenshi", [duet])!.track).toBe(duet);
  });

  test("a non-Latin artist is a real artist, matched only by itself (#150)", () => {
    const lemon = track("Lemon", ["米津玄師"]);
    expect(pickTrackFromQuery("Lemon 米津玄師", [lemon])!.track).toBe(lemon);
    expect(pickTrackFromQuery("米津玄師 Lemon", [lemon])!.track).toBe(lemon);
    // Another name in the same script does not answer it. While non-Latin text was dropped as
    // punctuation the query collapsed to "lemon", and the title pass answered it whatever the artist.
    expect(pickTrackFromQuery("Lemon 宇多田ヒカル", [lemon])).toBeUndefined();
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

// ---------------------------------------------------------------------------------------------------
// #150: normalize keeps the letters of every script
// ---------------------------------------------------------------------------------------------------

describe("non-Latin text (#150)", () => {
  /** A candidate with an explicit uri: `track()` derives one from ASCII word characters only, which
   *  is "" for a kanji or Cyrillic name, so two such tracks would share a uri. */
  function candidate(uri: string, name: string, artistNames: string[]): TrackCandidate {
    return { uri: `spotify:track:${uri}`, name, artistNames, popularity: 0 };
  }

  test("a non-Latin title is kept and compared as itself", () => {
    expect(normalize("夜に駆ける")).toBe("夜に駆ける");
    expect(normalize("群青")).not.toBe(normalize("夜に駆ける"));
    expect(normalize("Кино")).toBe("кино");
  });

  test("case and punctuation fold in other scripts too, and a mixed-script title keeps both halves", () => {
    // These are what the character class decides: a title that is ONLY non-Latin would also come
    // back as itself from the empty-result fallback, whatever the class kept.
    expect(normalize("Группа Крови!")).toBe("группа крови");
    expect(normalize("Lemon (レモン)")).toBe("lemon レモン");
    expect(normalize("夜に駆ける (Live)")).not.toBe(normalize("群青 (Live)"));
  });

  test("a Latin letter with no decomposition is kept", () => {
    expect(normalize("Bjørk")).toBe("bjørk");
    // An accent that DOES decompose still folds to its base letter.
    expect(normalize("Motörhead")).toBe("motorhead");
  });

  test("a punctuation-only title is itself, not empty", () => {
    expect(normalize("???")).toBe("???");
    expect(normalize("???")).not.toBe(normalize("..."));
    expect(normalize("  ")).toBe("");
    // Lower-cased as well: a circled capital is a symbol, so it takes the fallback and has a case.
    expect(normalize("  ⒶⒷ  ")).toBe("ⓐⓑ");
  });

  test.each<[string, string]>([
    ["バンド", "バント"],
    ["ボート", "ボード"],
    ["ばか", "ぱか"],
    ["ガ", "カ"],
    ["दिल", "दाल"],
    ["का", "की"],
    ["का", "क"],
    ["ไม่", "ไม้"],
    ["ไก่", "ไก้"],
  ])("%s and %s are different words: a mark belongs to its letter", (a, b) => {
    expect(normalize(a)).not.toBe(normalize(b));
  });

  test("a mark does not split its word, and a recomposed syllable is one character", () => {
    expect(normalize("ロードショー")).toBe("ロードショー");
    expect(normalize("ガンダム")).toBe("ガンダム");
    expect(normalize("사랑").length).toBe(2);
  });

  test("a mark with nothing before it is punctuation, not a word", () => {
    // U+FE0F, the emoji variation selector, is a mark: it must not turn "Love ❤️" into "love ️".
    expect(normalize("Love ❤️")).toBe("love");
    // An emoji-only title has no letter, so it is itself, and two different ones are not equal.
    expect(normalize("❤️")).toBe("❤️");
    expect(normalize("❤️")).not.toBe(normalize("★"));
  });

  test("a kanji title picks the right kanji track, not the first on the page", () => {
    const song = { name: "夜に駆ける", artist: "YOASOBI" };
    const wrong = candidate("gunjo", "群青", ["YOASOBI"]);
    const right = candidate("yoru", "夜に駆ける", ["YOASOBI"]);

    const best = pickBestTrack(song, [wrong, right]);
    expect(best?.track.uri).toBe(right.uri);
    expect(best?.confidence).toBe("high");

    // With the right track absent there is nothing to add: the other kanji title is not a match.
    expect(pickBestTrack(song, [wrong])).toBeUndefined();
  });

  test("titles that differ only in a voiced mark are different titles, and a mark opens no gap", () => {
    expect(pickBestTrack({ name: "バンド", artist: "X" }, [candidate("a", "バント", ["X"])])).toBeUndefined();
    // "ロード" is not a prefix of "ロードショー". With the mark read as a space it was one (title 72,
    // `medium`); it is now one word of three characters, under the contains rule's four-character
    // floor, so there is no title match at all.
    expect(pickBestTrack({ name: "ロード", artist: "X" }, [candidate("b", "ロードショー", ["X"])])).toBeUndefined();
    // A one-syllable Hangul title is one character, under the prefix rule's three-character floor.
    expect(pickBestTrack({ name: "눈", artist: "X" }, [candidate("c", "눈 (Live)", ["X"])])).toBeUndefined();
  });

  test("a punctuation-only title picks its own track, not every punctuation-only one", () => {
    const song = { name: "???", artist: "Band" };
    const dots = candidate("dots", "...", ["Band"]);
    const same = candidate("same", "???", ["Band"]);

    expect(pickBestTrack(song, [dots, same])?.track.uri).toBe(same.uri);
    expect(pickBestTrack(song, [dots])).toBeUndefined();
  });

  test("a non-Latin primary artist's other editions count for the tie-break", () => {
    const song = { name: "Группа крови", artist: "Кино" };
    const first = candidate("one", "Группа крови", ["Кино"]);
    const second = candidate("two", "Группа крови - Remastered 2011", ["Кино"]);
    const other = candidate("three", "Группа крови", ["Любэ"]);
    // "Кино" used to normalise to "", which the tie-break reads as "no artist": no editions counted.
    // Now the other edition by the same primary artist counts, and the cover by another act does not.
    expect(explainCandidate(song, first, [first, second, other]).tieBreak).toBe(0.01);
  });

  test("a Cyrillic performer matches only itself", () => {
    const song = { name: "Группа крови", artist: "Кино" };

    // The title is the song's exactly, but the artist is someone else's: a cover, not the recording.
    expect(pickBestTrack(song, [candidate("lyube", "Группа крови", ["Любэ"])])?.confidence).toBe("low");
    expect(pickBestTrack(song, [candidate("kino", "Группа крови", ["Кино"])])?.confidence).toBe("high");
  });

  test("a candidate with a non-Latin artist earns no partial score against a Latin one", () => {
    const song = { name: "Song", artist: "Queen" };
    expect(explainCandidate(song, candidate("a", "Song", ["Кино"])).artist).toBe(0);
    // A blank artist name is contained in every name, so without a guard it would score the partial 22.
    expect(explainCandidate(song, candidate("b", "Song", [""])).artist).toBe(0);
    expect(explainCandidate(song, candidate("c", "Song", ["   "])).artist).toBe(0);
    // ...and it is skipped, not the end of the list: a real credit after it still counts in full.
    expect(explainCandidate(song, candidate("d", "Song", ["", "Queen"])).artist).toBe(40);
  });
});
