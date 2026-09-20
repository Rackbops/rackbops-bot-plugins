import { describe, expect, test } from "bun:test";
import { buildQueries, normalize, pickBestTrack, scoreCandidate, type TrackCandidate } from "./matching.js";

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
