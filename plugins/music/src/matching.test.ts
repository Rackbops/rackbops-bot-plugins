import { describe, expect, test } from "bun:test";
import {
  buildQueries,
  explainCandidate,
  normalize,
  pickBestTrack,
  scoreCandidate,
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

  test("the word 'live' in the song's OWN title is not treated as a variant marker", () => {
    const liveSong = { name: "Live and Let Die", artist: "Wings" };
    expect(scoreCandidate(liveSong, track("Live and Let Die", ["Wings"]))).toBeGreaterThan(130);
  });

  test("popularity only separates otherwise-equal candidates", () => {
    const popular = scoreCandidate(song, track("Hey Jude", ["The Beatles"], 90));
    const obscure = scoreCandidate(song, track("Hey Jude", ["The Beatles"], 10));
    expect(popular).toBeGreaterThan(obscure);
    expect(popular - obscure).toBeLessThan(1);
  });
});

describe("explainCandidate", () => {
  const song = { name: "Hey Jude", artist: "The Beatles" };

  test("parts reproduce scoreCandidate for an exact match", () => {
    const candidate = track("Hey Jude", ["The Beatles"]);
    const breakdown = explainCandidate(song, candidate);
    expect(breakdown).toEqual({ title: 100, artist: 40, tieBreak: 0.5, penalty: 0, score: 140.5 });
    expect(breakdown.score).toBe(scoreCandidate(song, candidate));
    // scoreCandidate delegates to explainCandidate, so the line above cannot fail on its own; this
    // literal is the number the scorer returned before the log existed.
    expect(scoreCandidate(song, candidate)).toBe(140.5);
  });

  test("parts reproduce scoreCandidate for a remaster-suffixed title", () => {
    const candidate = track("Hey Jude - Remastered 2015", ["The Beatles"]);
    const breakdown = explainCandidate(song, candidate);
    expect(breakdown).toEqual({ title: 72, artist: 40, tieBreak: 0.5, penalty: 0, score: 112.5 });
    expect(breakdown.score).toBe(scoreCandidate(song, candidate));
    expect(scoreCandidate(song, candidate)).toBe(112.5);
  });

  test("parts reproduce scoreCandidate for a live-penalised title", () => {
    const candidate = track("Hey Jude - Live at Wembley", ["The Beatles"]);
    const breakdown = explainCandidate(song, candidate);
    expect(breakdown).toEqual({ title: 72, artist: 40, tieBreak: 0.5, penalty: 25, score: 87.5 });
    expect(breakdown.score).toBe(scoreCandidate(song, candidate));
    expect(scoreCandidate(song, candidate)).toBe(87.5);
  });

  test("a title miss is all zeros", () => {
    const candidate = track("Let It Be", ["The Beatles"]);
    const breakdown = explainCandidate(song, candidate);
    expect(breakdown).toEqual({ title: 0, artist: 0, tieBreak: 0, penalty: 0, score: 0 });
    expect(breakdown.score).toBe(scoreCandidate(song, candidate));
  });

  test("a penalty larger than the rest clamps the total at 0 and keeps the parts", () => {
    const candidate = track("Hey Jude (Karaoke Version)", ["Karaoke Crew"]);
    const breakdown = explainCandidate(song, candidate);
    expect(breakdown).toEqual({ title: 72, artist: 0, tieBreak: 0.5, penalty: 100, score: 0 });
    expect(scoreCandidate(song, candidate)).toBe(0);
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
    expect(best!.confidence).toBe("medium");
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
