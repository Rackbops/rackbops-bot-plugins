import { describe, expect, test } from "bun:test";
import { createSetlistFmClient, flattenSetlist, parseSetlistUrl, toSetlist } from "./setlistfm.js";

/** A response builder, so each test says only what it is actually about. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const BEATLES = {
  id: "63de4613",
  eventDate: "23-08-2015",
  url: "https://www.setlist.fm/setlist/the-beatles/2015/x-63de4613.html",
  artist: { name: "The Beatles" },
  venue: { name: "The Cavern Club", city: { name: "Liverpool", country: { name: "United Kingdom" } } },
  tour: { name: "Summer Tour" },
  sets: {
    set: [
      { name: "Main set", song: [{ name: "Hey Jude" }, { name: "Twist and Shout", cover: { name: "The Top Notes" } }] },
      { encore: 1, song: [{ name: "Yesterday" }] },
    ],
  },
};

describe("parseSetlistUrl", () => {
  test("pulls the id out of a canonical setlist.fm URL", () => {
    expect(
      parseSetlistUrl("https://www.setlist.fm/setlist/the-beatles/1963/the-cavern-club-liverpool-england-63de4613.html"),
    ).toBe("63de4613");
  });

  test("anchors on the LAST hyphen, so a hyphenated venue slug doesn't break it", () => {
    expect(parseSetlistUrl("https://www.setlist.fm/setlist/x/2024/a-b-c-d-e-1a2b3c4d.html")).toBe("1a2b3c4d");
  });

  test("accepts a bare id pasted on its own, case-insensitively", () => {
    expect(parseSetlistUrl("63DE4613")).toBe("63de4613");
  });

  test("accepts the bare and www hostnames but rejects a look-alike domain", () => {
    expect(parseSetlistUrl("https://setlist.fm/setlist/x/2024/y-63de4613.html")).toBe("63de4613");
    expect(parseSetlistUrl("https://evil-setlist.fm/setlist/x/2024/y-63de4613.html")).toBeUndefined();
  });

  test("rejects junk, a non-setlist URL and an empty string", () => {
    expect(parseSetlistUrl("not a url")).toBeUndefined();
    expect(parseSetlistUrl("https://open.spotify.com/playlist/abc")).toBeUndefined();
    expect(parseSetlistUrl("   ")).toBeUndefined();
  });
});

describe("flattenSetlist", () => {
  test("flattens every set in order, main set before encore", () => {
    const { songs } = flattenSetlist(BEATLES);
    expect(songs.map((s) => s.name)).toEqual(["Hey Jude", "Twist and Shout", "Yesterday"]);
  });

  test("a cover is searched under the ORIGINAL artist, and flagged", () => {
    const { songs } = flattenSetlist(BEATLES);
    expect(songs[1]).toEqual({ name: "Twist and Shout", searchArtist: "The Top Notes", isCover: true });
    expect(songs[0]).toEqual({ name: "Hey Jude", searchArtist: "The Beatles", isCover: false });
  });

  test("tape songs are dropped from the list and counted instead", () => {
    const { songs, tapeCount } = flattenSetlist({
      artist: { name: "Band" },
      sets: { set: [{ song: [{ name: "Intro Music", tape: true }, { name: "Real Song" }] }] },
    });
    expect(songs.map((s) => s.name)).toEqual(["Real Song"]);
    expect(tapeCount).toBe(1);
  });

  test("blank and malformed entries are skipped without throwing", () => {
    const { songs } = flattenSetlist({
      artist: { name: "Band" },
      sets: { set: [{ song: [{ name: "" }, { name: "   " }, null, "nope", { name: "Kept" }] }] },
    });
    expect(songs.map((s) => s.name)).toEqual(["Kept"]);
  });

  test("a setlist with no sets at all yields nothing, not a throw", () => {
    expect(flattenSetlist({ artist: { name: "Band" } })).toEqual({ songs: [], tapeCount: 0 });
  });
});

describe("toSetlist", () => {
  test("shapes the venue, city, country and tour", () => {
    const setlist = toSetlist(BEATLES)!;
    expect(setlist.artistName).toBe("The Beatles");
    expect(setlist.venueName).toBe("The Cavern Club");
    expect(setlist.cityName).toBe("Liverpool");
    expect(setlist.countryName).toBe("United Kingdom");
    expect(setlist.tourName).toBe("Summer Tour");
  });

  test("rejects a payload with no id or no artist rather than half-using it", () => {
    expect(toSetlist({ artist: { name: "X" } })).toBeUndefined();
    expect(toSetlist({ id: "abc" })).toBeUndefined();
    expect(toSetlist(null)).toBeUndefined();
  });

  test("a setlist with no tour or venue still shapes, with those fields absent", () => {
    const setlist = toSetlist({ id: "a1b2c3", artist: { name: "X" }, eventDate: "01-01-2026" })!;
    expect(setlist.tourName).toBeUndefined();
    expect(setlist.venueName).toBeUndefined();
    expect(setlist.songs).toEqual([]);
  });
});

describe("createSetlistFmClient", () => {
  test("sends the API key and asks for JSON, which the API needs to not answer XML", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const client = createSetlistFmClient("KEY", async (url, init) => {
      seen = { url, init };
      return json(BEATLES);
    });
    await client.getSetlist("63de4613");
    const headers = seen!.init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("KEY");
    expect(headers.Accept).toBe("application/json");
    expect(seen!.url).toBe("https://api.setlist.fm/rest/1.0/setlist/63de4613");
  });

  test("404 becomes a sentence a user can act on, not a status code", async () => {
    const client = createSetlistFmClient("KEY", async () => json({}, 404));
    const result = await client.getSetlist("nope");
    expect(result).toEqual({ ok: false, error: "setlist.fm has nothing under that link or artist name" });
  });

  test("403 names the env key an operator has to fix", async () => {
    const client = createSetlistFmClient("KEY", async () => json({}, 403));
    const result = await client.getSetlist("x");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("SETLISTFM_API_KEY");
  });

  test("a network failure is reported, not thrown", async () => {
    const client = createSetlistFmClient("KEY", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await client.getSetlist("x")).toEqual({ ok: false, error: "couldn't reach setlist.fm" });
  });

  test("a timeout is reported as a timeout, distinctly from a refused connection", async () => {
    const client = createSetlistFmClient("KEY", async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    });
    expect(await client.getSetlist("x")).toEqual({ ok: false, error: "setlist.fm took too long to answer" });
  });

  test("latestForArtist skips stub setlists with no songs and takes the first real one", async () => {
    const stub = { id: "aaa111", artist: { name: "Band" }, sets: { set: [] } };
    const real = { id: "bbb222", artist: { name: "Band" }, sets: { set: [{ song: [{ name: "Song" }] }] } };
    const client = createSetlistFmClient("KEY", async () => json({ setlist: [stub, real] }));
    const result = await client.latestForArtist("Band");
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.setlist.id).toBe("bbb222");
  });

  test("all-stubs and no-results are told apart, because the fix differs", async () => {
    const stubsOnly = createSetlistFmClient("KEY", async () =>
      json({ setlist: [{ id: "aaa111", artist: { name: "Band" } }] }),
    );
    const none = createSetlistFmClient("KEY", async () => json({ setlist: [] }));
    const stubResult = await stubsOnly.latestForArtist("Band");
    const noneResult = await none.latestForArtist("Band");
    expect(stubResult.ok === false && stubResult.error).toContain("none with a song list filled in");
    expect(noneResult.ok === false && noneResult.error).toContain("no setlists on setlist.fm");
  });

  test("an artist name with spaces and punctuation is URL-encoded", async () => {
    let seen = "";
    const client = createSetlistFmClient("KEY", async (url) => {
      seen = url;
      return json({ setlist: [] });
    });
    await client.latestForArtist("Sigur Rós & Friends");
    expect(seen).toContain("artistName=Sigur%20R%C3%B3s%20%26%20Friends");
  });
});
