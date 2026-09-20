import { describe, expect, test } from "bun:test";
import {
  createSetlistFmClient,
  flattenSetlist,
  isRetryable,
  parseDateOption,
  parseRetryAfter,
  parseSetlistUrl,
  retryDelay,
  splitMedley,
  toSetlist,
} from "./setlistfm.js";

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

/**
 * Epica at AFAS Live, Amsterdam, 20 September 2024 -- transcribed from the public setlist.fm page
 * (https://www.setlist.fm/setlist/epica/2024/afas-live-amsterdam-netherlands-1ba8a1cc.html) into the
 * shape the API returns. A real show, chosen because one entry is a genuine four-song medley: the
 * case that silently cost four tracks before `splitMedley` existed.
 */
const EPICA = {
  id: "1ba8a1cc",
  eventDate: "20-09-2024",
  url: "https://www.setlist.fm/setlist/epica/2024/afas-live-amsterdam-netherlands-1ba8a1cc.html",
  artist: { name: "Epica" },
  venue: { name: "AFAS Live", city: { name: "Amsterdam", country: { name: "Netherlands" } } },
  tour: { name: "The Symphonic Synergy Tour" },
  sets: {
    set: [
      { song: [{ name: "Storm the Sorrow" }] },
      {
        song: [
          {
            name: "Universal Death Squad / The Last Crusade / The Phantom Agony / Design Your Universe",
            info: "Symphonic synergy medley",
          },
        ],
      },
      { encore: 2, song: [{ name: "Chevaliers de Sangreal", tape: true, cover: { name: "Hans Zimmer" } }] },
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

  test("a medley entry becomes one song per part, in order, inline in the set", () => {
    const { songs } = flattenSetlist(EPICA);
    expect(songs.map((s) => s.name)).toEqual([
      "Storm the Sorrow",
      "Universal Death Squad",
      "The Last Crusade",
      "The Phantom Agony",
      "Design Your Universe",
    ]);
  });

  test("every part of a medley inherits the entry's cover credit", () => {
    const { songs } = flattenSetlist({
      artist: { name: "Band" },
      sets: { set: [{ song: [{ name: "A Side / B Side", cover: { name: "The Originals" } }] }] },
    });
    expect(songs).toEqual([
      { name: "A Side", searchArtist: "The Originals", isCover: true },
      { name: "B Side", searchArtist: "The Originals", isCover: true },
    ]);
  });

  test("a tape medley is still one tape, counted once and not split", () => {
    const { songs, tapeCount } = flattenSetlist({
      artist: { name: "Band" },
      sets: { set: [{ song: [{ name: "Outro A / Outro B", tape: true }] }] },
    });
    expect(songs).toEqual([]);
    expect(tapeCount).toBe(1);
  });

  test("a single set sent as a bare object, not an array, still yields its songs", () => {
    const { songs } = flattenSetlist({
      artist: { name: "Band" },
      sets: { set: { song: [{ name: "Only Song" }] } },
    });
    expect(songs.map((s) => s.name)).toEqual(["Only Song"]);
  });

  test("a single song sent as a bare object, not an array, still yields it", () => {
    const { songs } = flattenSetlist({
      artist: { name: "Band" },
      sets: { set: [{ song: { name: "Only Song" } }] },
    });
    expect(songs.map((s) => s.name)).toEqual(["Only Song"]);
  });

  test("a set or sets wrapper sent as a string yields nothing, and does not throw", () => {
    expect(flattenSetlist({ artist: { name: "Band" }, sets: { set: "" } })).toEqual({ songs: [], tapeCount: 0 });
    expect(flattenSetlist({ artist: { name: "Band" }, sets: "nonsense" as never })).toEqual({
      songs: [],
      tapeCount: 0,
    });
  });

  test("a setlist with no sets at all yields nothing, not a throw", () => {
    expect(flattenSetlist({ artist: { name: "Band" } })).toEqual({ songs: [], tapeCount: 0 });
  });
});

describe("splitMedley", () => {
  test("splits a slash-separated medley into its parts", () => {
    expect(splitMedley("Universal Death Squad / The Last Crusade / The Phantom Agony")).toEqual([
      "Universal Death Squad",
      "The Last Crusade",
      "The Phantom Agony",
    ]);
  });

  test("leaves an ordinary title alone", () => {
    expect(splitMedley("Storm the Sorrow")).toEqual(["Storm the Sorrow"]);
  });

  test("does NOT split an unspaced slash, which is usually part of the real title", () => {
    expect(splitMedley("Zoo Station/The Fly")).toEqual(["Zoo Station/The Fly"]);
    expect(splitMedley("Sirens - Of Blood and Water")).toEqual(["Sirens - Of Blood and Water"]);
  });

  test("tolerates ragged spacing and a trailing separator", () => {
    expect(splitMedley("A  /  B")).toEqual(["A", "B"]);
    expect(splitMedley("A / B / ")).toEqual(["A", "B"]);
  });

  test("a name that is nothing but separators falls back to the original, never an empty list", () => {
    expect(splitMedley(" / ")).toEqual([" / "]);
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

// ---------------------------------------------------------------------------------------------------
// #38: a date the user typed -> the date the API insists on
// ---------------------------------------------------------------------------------------------------

describe("parseDateOption", () => {
  test("ISO in, setlist.fm's dd-MM-yyyy out -- sending ISO to the API silently matches nothing", () => {
    expect(parseDateOption("2026-09-08")).toBe("08-09-2026");
  });

  test("setlist.fm's own spelling passes through, since that is what someone copies off the site", () => {
    expect(parseDateOption("08-09-2026")).toBe("08-09-2026");
  });

  test("single-digit day and month are padded", () => {
    expect(parseDateOption("2026-1-2")).toBe("02-01-2026");
    expect(parseDateOption("2-1-2026")).toBe("02-01-2026");
  });

  test("slashes and dots work too -- people type what their locale taught them", () => {
    expect(parseDateOption("2026/09/08")).toBe("08-09-2026");
    expect(parseDateOption("08.09.2026")).toBe("08-09-2026");
  });

  test("surrounding whitespace is forgiven", () => {
    expect(parseDateOption("  2026-09-08 ")).toBe("08-09-2026");
  });

  test("a date that doesn't exist is rejected, not rolled over into the next month", () => {
    expect(parseDateOption("31-02-2026")).toBeUndefined();
    expect(parseDateOption("2026-02-31")).toBeUndefined();
    expect(parseDateOption("2026-13-01")).toBeUndefined();
  });

  test("a leap day is accepted in a leap year and rejected otherwise", () => {
    expect(parseDateOption("2024-02-29")).toBe("29-02-2024");
    expect(parseDateOption("2026-02-29")).toBeUndefined();
  });

  test("anything else is undefined, so the caller can answer with a sentence", () => {
    expect(parseDateOption("last tuesday")).toBeUndefined();
    expect(parseDateOption("8 September 2026")).toBeUndefined();
    expect(parseDateOption("")).toBeUndefined();
    // A two-digit year is ambiguous rather than merely unsupported -- never guess the century.
    expect(parseDateOption("08-09-26")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// #37: backing off instead of giving up
// ---------------------------------------------------------------------------------------------------

describe("isRetryable", () => {
  test("a rate limit and a server error are worth trying again", () => {
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(500)).toBe(true);
    expect(isRetryable(503)).toBe(true);
  });

  test("every other 4xx is a statement about the request, so repeating it is pointless", () => {
    expect(isRetryable(400)).toBe(false);
    expect(isRetryable(403)).toBe(false);
    expect(isRetryable(404)).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  test("a count of seconds becomes milliseconds", () => {
    expect(parseRetryAfter("2", 0)).toBe(2000);
  });

  test("an HTTP-date becomes the distance from now", () => {
    const now = Date.parse("2026-09-20T10:00:00Z");
    expect(parseRetryAfter("Sun, 20 Sep 2026 10:00:30 GMT", now)).toBe(30_000);
  });

  test("a date already in the past is zero, never negative", () => {
    const now = Date.parse("2026-09-20T10:00:00Z");
    expect(parseRetryAfter("Sun, 20 Sep 2026 09:59:00 GMT", now)).toBe(0);
  });

  test("absent or unreadable is undefined -- a bad header must not be why a request fails", () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter("   ", 0)).toBeUndefined();
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
  });
});

describe("retryDelay", () => {
  test("without a header it doubles, and stops doubling at the ceiling", () => {
    expect(retryDelay(0, undefined)).toBe(500);
    expect(retryDelay(1, undefined)).toBe(1000);
    expect(retryDelay(2, undefined)).toBe(2000);
    expect(retryDelay(9, undefined)).toBe(5000);
  });

  test("a server-supplied wait wins over our own guess", () => {
    expect(retryDelay(0, 3000)).toBe(3000);
  });

  test("a wait longer than we'll sit through ends the retries rather than being clamped down", () => {
    // Clamping would mean knocking again before the server said we could, which is the one thing
    // Retry-After exists to prevent.
    expect(retryDelay(0, 60_000)).toBeUndefined();
  });
});

describe("createSetlistFmClient retries", () => {
  /** A fetch that answers from a script, plus a sleep that records instead of waiting. */
  function scripted(responses: Response[]) {
    const slept: number[] = [];
    let calls = 0;
    const client = createSetlistFmClient(
      "KEY",
      async () => {
        const next = responses[Math.min(calls, responses.length - 1)]!;
        calls += 1;
        return next.clone();
      },
      async (ms) => {
        slept.push(ms);
      },
    );
    return { client, slept, calls: () => calls };
  }

  test("a 429 is retried and the next answer is used", async () => {
    const { client, slept, calls } = scripted([json({}, 429), json(BEATLES)]);
    const result = await client.getSetlist("63de4613");
    expect(result.ok).toBe(true);
    expect(calls()).toBe(2);
    expect(slept).toEqual([500]);
  });

  test("Retry-After is obeyed instead of our own backoff", async () => {
    const limited = new Response("{}", { status: 429, headers: { "Retry-After": "2" } });
    const { client, slept } = scripted([limited, json(BEATLES)]);
    expect((await client.getSetlist("63de4613")).ok).toBe(true);
    expect(slept).toEqual([2000]);
  });

  test("a Retry-After longer than we'll wait gives up at once rather than holding the reply open", async () => {
    const limited = new Response("{}", { status: 429, headers: { "Retry-After": "120" } });
    const { client, slept, calls } = scripted([limited]);
    const result = await client.getSetlist("x");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("rate-limiting");
    expect(calls()).toBe(1);
    expect(slept).toEqual([]);
  });

  test("a 5xx is retried, and running out of attempts reports the status", async () => {
    const { client, slept, calls } = scripted([json({}, 503)]);
    const result = await client.getSetlist("x");
    expect(result).toEqual({ ok: false, error: "setlist.fm returned HTTP 503" });
    expect(calls()).toBe(4);
    expect(slept).toEqual([500, 1000, 2000]);
  });

  test("a 403 is answered immediately -- repeating a bad key only wastes the user's time", async () => {
    const { client, calls } = scripted([json({}, 403)]);
    expect((await client.getSetlist("x")).ok).toBe(false);
    expect(calls()).toBe(1);
  });

  test("a transport failure is not retried; the 10-second timeout has already been spent", async () => {
    let calls = 0;
    const client = createSetlistFmClient(
      "KEY",
      async () => {
        calls += 1;
        throw new Error("ECONNREFUSED");
      },
      async () => {},
    );
    expect(await client.getSetlist("x")).toEqual({ ok: false, error: "couldn't reach setlist.fm" });
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------
// #38: every show on a given night
// ---------------------------------------------------------------------------------------------------

describe("showsOn", () => {
  const show = (id: string, venue: string, songs = 1) => ({
    id,
    eventDate: "08-09-2026",
    artist: { name: "Band" },
    venue: { name: venue, city: { name: "Leeds" } },
    sets: { set: [{ song: Array.from({ length: songs }, (_, i) => ({ name: `Song ${i + 1}` })) }] },
  });

  test("asks setlist.fm for the artist and the date, in the format the API requires", async () => {
    let seen = "";
    const client = createSetlistFmClient("KEY", async (url) => {
      seen = url;
      return json({ setlist: [] });
    });
    await client.showsOn("Sigur Rós", "08-09-2026");
    expect(seen).toContain("artistName=Sigur%20R%C3%B3s");
    expect(seen).toContain("date=08-09-2026");
  });

  test("returns every show on the night, festival slot and club show alike, without choosing", async () => {
    const client = createSetlistFmClient("KEY", async () =>
      json({ setlist: [show("aaa111", "Big Field"), show("bbb222", "The Cave")] }),
    );
    const result = await client.showsOn("Band", "08-09-2026");
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.setlists.map((s) => s.id)).toEqual(["aaa111", "bbb222"]);
  });

  test("setlist.fm's own duplicate entries for one gig both survive -- neither is provably the wrong one", async () => {
    const client = createSetlistFmClient("KEY", async () =>
      json({ setlist: [show("aaa111", "The Cave", 12), show("bbb222", "The Cave", 3)] }),
    );
    const result = await client.showsOn("Band", "08-09-2026");
    expect(result.ok === true && result.setlists.length).toBe(2);
  });

  test("nothing matched is an empty list, not an error -- the search endpoint answers 404", async () => {
    const client = createSetlistFmClient("KEY", async () => json({}, 404));
    expect(await client.showsOn("Band", "08-09-2026")).toEqual({ ok: true, setlists: [] });
  });

  test("a stub with no songs is still returned; deciding what to do with it is the caller's job", async () => {
    const client = createSetlistFmClient("KEY", async () =>
      json({ setlist: [{ id: "aaa111", artist: { name: "Band" } }] }),
    );
    const result = await client.showsOn("Band", "08-09-2026");
    expect(result.ok === true && result.setlists.length).toBe(1);
    expect(result.ok === true && result.setlists[0]!.songs).toEqual([]);
  });

  test("a single result that arrives as a bare object, not an array, is still read", async () => {
    // Same one-element-collection wrinkle `asList` guards for `sets.set` -- see its doc-comment.
    const client = createSetlistFmClient("KEY", async () => json({ setlist: show("aaa111", "The Cave") }));
    const result = await client.showsOn("Band", "08-09-2026");
    expect(result.ok === true && result.setlists.map((s) => s.id)).toEqual(["aaa111"]);
  });

  test("a real failure is still a failure, distinct from an empty day", async () => {
    const client = createSetlistFmClient("KEY", async () => json({}, 403));
    const result = await client.showsOn("Band", "08-09-2026");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("SETLISTFM_API_KEY");
  });
});
