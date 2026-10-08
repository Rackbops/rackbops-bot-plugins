import { describe, expect, test } from "bun:test";
import { artistNamesFor, creditedArtist, leadArtist, searchArtistsFor } from "./artists.js";
import type { Setlist, SetlistSong } from "./setlistfm.js";

function song(name: string, searchArtist: string, isCover = false): SetlistSong {
  return { name, searchArtist, isCover };
}

describe("leadArtist", () => {
  test("a joined performer name yields its first act", () => {
    expect(leadArtist("Pat Benatar & Neil Giraldo")).toBe("Pat Benatar");
  });

  test("a plain name has no lead act", () => {
    expect(leadArtist("Band")).toBeUndefined();
  });

  test("'&' with no surrounding spaces doesn't split", () => {
    expect(leadArtist("Hall&Oates")).toBeUndefined();
  });

  test("a one-letter first segment is too short to be useful", () => {
    expect(leadArtist("A & B")).toBeUndefined();
  });

  test("a single act whose own name has '&' still yields a (useless but harmless) lead", () => {
    expect(leadArtist("Hall & Oates")).toBe("Hall");
  });
});

describe("creditedArtist", () => {
  const performer = "Tribute Act";

  test("5 of 7 credits to one artist is a strict majority -- named", () => {
    const songs = [
      ...Array.from({ length: 5 }, (_, i) => song(`Cover ${i}`, "Originals", true)),
      ...Array.from({ length: 2 }, (_, i) => song(`Other ${i}`, "Someone Else", true)),
    ];
    expect(creditedArtist(songs, performer)).toBe("Originals");
  });

  test("3 of 6 credits is exactly half -- not a strict majority, undefined", () => {
    const songs = [
      ...Array.from({ length: 3 }, (_, i) => song(`Cover ${i}`, "Originals", true)),
      ...Array.from({ length: 3 }, (_, i) => song(`Other ${i}`, "Someone Else", true)),
    ];
    expect(creditedArtist(songs, performer)).toBeUndefined();
  });

  test("1 of 1 credit is a majority but under the 2-credit floor -- undefined", () => {
    const songs = [song("Cover", "Originals", true)];
    expect(creditedArtist(songs, performer)).toBeUndefined();
  });

  test("credits that normalise to the performer are excluded before counting", () => {
    // A #62 bracketed credit is filed under the performer -- it must not count as "covers itself",
    // and must not inflate the denominator either.
    const songs = [
      song("Own Song", "Tribute Act", true),
      song("Own Song 2", "tribute act", true), // same performer, different case
      ...Array.from({ length: 2 }, (_, i) => song(`Cover ${i}`, "Originals", true)),
    ];
    expect(creditedArtist(songs, performer)).toBe("Originals");
  });

  test("no cover credits at all -- undefined", () => {
    expect(creditedArtist([song("One", performer, false)], performer)).toBeUndefined();
  });

  test("covers credited to a different non-Latin name than the performer's are counted", () => {
    // Before #150 both names normalised to "", so every credit looked like the performer's own and
    // was excluded before counting.
    const songs = [song("Группа крови", "Любэ", true), song("Атас", "Любэ", true)];
    expect(creditedArtist(songs, "Кино")).toBe("Любэ");
  });
});

describe("artistNamesFor", () => {
  test("an ordinary band with no lead act and no dominant credit has only a performer name", () => {
    const setlist = { artistName: "Band", songs: [song("One", "Band")] } as Setlist;
    expect(artistNamesFor(setlist)).toEqual({ performer: "Band" });
  });

  test("a duo performer gets a lead name", () => {
    const setlist = { artistName: "Duo A & Duo B", songs: [song("One", "Duo A & Duo B")] } as Setlist;
    expect(artistNamesFor(setlist)).toEqual({ performer: "Duo A & Duo B", lead: "Duo A" });
  });

  test("a tribute set gets a credited name", () => {
    const setlist = {
      artistName: "Tribute Act",
      songs: Array.from({ length: 3 }, (_, i) => song(`Cover ${i}`, "Originals", true)),
    } as Setlist;
    expect(artistNamesFor(setlist)).toEqual({ performer: "Tribute Act", credited: "Originals" });
  });
});

describe("searchArtistsFor", () => {
  test("an uncredited song on a tribute set is searched under the performer, then the credited artist", () => {
    const names = { performer: "Tribute Act", credited: "Originals" };
    expect(searchArtistsFor(song("One", "Tribute Act"), names)).toEqual(["Tribute Act", "Originals"]);
  });

  test("a cover on a duo is searched under the performer, the lead, then the original artist", () => {
    const names = { performer: "Duo A & Duo B", lead: "Duo A" };
    expect(searchArtistsFor(song("One", "Original Artist", true), names)).toEqual([
      "Duo A & Duo B",
      "Duo A",
      "Original Artist",
    ]);
  });

  test("de-duplicates by normalize(), keeping the first occurrence", () => {
    // The credited artist happens to be the lead act under a different spelling/case.
    const names = { performer: "Duo A & Duo B", lead: "Duo A", credited: "duo a" };
    expect(searchArtistsFor(song("One", "Duo A & Duo B"), names)).toEqual(["Duo A & Duo B", "Duo A"]);
  });

  test("an ordinary band's uncredited song collapses back to just the performer", () => {
    const names = { performer: "Band" };
    expect(searchArtistsFor(song("One", "Band"), names)).toEqual(["Band"]);
  });

  test("two different non-Latin names are two search names", () => {
    // Both normalised to "" before #150, so the second was dropped as a duplicate of the first.
    const names = { performer: "Кино" };
    expect(searchArtistsFor(song("Группа крови", "Любэ", true), names)).toEqual(["Кино", "Любэ"]);
  });
});
