import { describe, expect, test } from "bun:test";
import { formatBuildReply, formatNotConfigured } from "./commands.js";
import type { BuildOutcome } from "./build.js";
import type { Setlist } from "./setlistfm.js";

function setlist(overrides: Partial<Setlist> = {}): Setlist {
  return {
    id: "abc123",
    artistName: "Band",
    eventDate: "08-09-2026",
    venueName: "The Venue",
    cityName: "Leeds",
    countryName: "United Kingdom",
    tourName: "The Tour",
    url: "https://www.setlist.fm/setlist/band/2026/the-venue-abc123.html",
    songs: [],
    tapeCount: 0,
    ...overrides,
  };
}

function outcome(overrides: Partial<BuildOutcome> = {}): BuildOutcome {
  return {
    playlistUrl: "https://open.spotify.com/playlist/PL1",
    playlistName: "Band at The Venue, Leeds (2026-09-08)",
    added: 2,
    attempted: 2,
    uncertain: [],
    missing: [],
    ...overrides,
  };
}

describe("formatNotConfigured", () => {
  test("names every key an admin still has to set", () => {
    const reply = formatNotConfigured(["SETLISTFM_API_KEY", "SPOTIFY_CLIENT_ID"]);
    expect(reply).toContain("`SETLISTFM_API_KEY`");
    expect(reply).toContain("`SPOTIFY_CLIENT_ID`");
  });
});

describe("formatBuildReply", () => {
  test("leads with the show and the playlist link", () => {
    const reply = formatBuildReply(setlist(), outcome());
    const lines = reply.split("\n");
    expect(lines[0]).toContain("Band - The Venue, Leeds, United Kingdom");
    expect(lines[1]).toBe("https://open.spotify.com/playlist/PL1");
    expect(lines[2]).toBe("Added 2 of 2 songs.");
  });

  test("says how many tape tracks were skipped, so the count isn't a silent mystery", () => {
    const reply = formatBuildReply(setlist({ tapeCount: 2 }), outcome());
    expect(reply).toContain("Skipped 2 played from tape");
  });

  test("says nothing about tape when there was none", () => {
    expect(formatBuildReply(setlist(), outcome())).not.toContain("tape");
  });

  test("names the songs it couldn't find", () => {
    const reply = formatBuildReply(setlist(), outcome({ added: 1, missing: ["Rare B-Side"] }));
    expect(reply).toContain("Couldn't find on Spotify: Rare B-Side.");
  });

  test("names loose matches as worth a check, showing what it picked", () => {
    const reply = formatBuildReply(
      setlist(),
      outcome({
        uncertain: [
          {
            song: { name: "Yesterday", searchArtist: "The Beatles", isCover: false },
            match: {
              track: { uri: "u", name: "Yesterday - Live", artistNames: ["The Beatles"], popularity: 1 },
              confidence: "low",
            },
          },
        ],
      }),
    );
    expect(reply).toContain("Yesterday -> Yesterday - Live");
  });

  test("a long missing list is summarised rather than dumped", () => {
    const missing = Array.from({ length: 20 }, (_, i) => `Song ${i}`);
    const reply = formatBuildReply(setlist(), outcome({ missing }));
    expect(reply).toContain("and 12 more");
    expect(reply).not.toContain("Song 19");
  });

  test("stays under Discord's 2000-character limit even at full spread", () => {
    const missing = Array.from({ length: 40 }, (_, i) => `A Very Long Song Title Number ${i}`);
    const reply = formatBuildReply(setlist({ artistName: "B".repeat(200), tapeCount: 5 }), outcome({ missing }));
    expect(reply.length).toBeLessThanOrEqual(2000);
  });

  test("a setlist with no venue still reads correctly", () => {
    const reply = formatBuildReply(
      setlist({ venueName: undefined, cityName: undefined, countryName: undefined }),
      outcome(),
    );
    expect(reply.split("\n")[0]).toBe("**Band**");
  });
});
