import { beforeEach, describe, expect, test } from "bun:test";
import { createSpotifyClient, PARTY_SCOPES, SPOTIFY_SCOPES } from "./spotify.js";
import { commit, freshState, musicState, putConnection, removeConnection, resetStoreForTest } from "./store.js";
import { accessTokenFor } from "./tokens.js";
import { makeRealStorage } from "../../../packages/testkit/index.js";

// These drive a REAL client over a fake fetch rather than a fake `refresh`, so what is pinned is
// the whole boundary #133 is about: the answer's shape on the wire, how spotify.ts classifies it,
// and what tokens.ts then does to the stored connection. The body shapes follow RFC 6749 section
// 5.2 and the fixtures spotify.test.ts already used; nothing here has run against Spotify itself,
// which is why `invalid_client` is covered at both of the statuses it might arrive with.

const CONFIG = {
  clientId: "cid",
  clientSecret: "csecret",
  redirectUri: "https://bot.example.com/spotify/callback",
};
const USER = "100000000000000001";
const CONNECTED_AT = 1_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function spotifyAnswering(answer: () => Response) {
  return createSpotifyClient(CONFIG, async () => answer());
}

function errorOf(result: Awaited<ReturnType<typeof accessTokenFor>>): string {
  return result.ok ? "" : result.error;
}

beforeEach(() => {
  resetStoreForTest(putConnection(freshState(), USER, "RT1", CONNECTED_AT, SPOTIFY_SCOPES));
});

describe("accessTokenFor", () => {
  // [name, Spotify's answer, the detail the reply must carry]
  const revokedCases: Array<[string, () => Response, string]> = [
    [
      "a revoked grant (400 invalid_grant with Spotify's prose)",
      () => json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400),
      "Refresh token revoked",
    ],
    [
      "a bare invalid_grant body with no description (the shape Spotify documents for a token past its six-month expiry)",
      () => json({ error: "invalid_grant" }, 400),
      "Spotify returned HTTP 400: invalid_grant",
    ],
  ];

  for (const [name, answer, detail] of revokedCases) {
    test(`${name} removes the connection and says reconnect`, async () => {
      const result = await accessTokenFor(spotifyAnswering(answer), USER);
      expect(result).toMatchObject({ ok: false, kind: "revoked" });
      expect(errorOf(result)).toContain("no longer valid");
      expect(errorOf(result)).toContain(detail);
      expect(errorOf(result)).toContain("/spotify connect");
      expect(musicState().connections[USER]).toBeUndefined();
    });
  }

  const keptCases: Array<[string, () => Response, string]> = [
    ["a 503", () => new Response("<html>503</html>", { status: 503 }), "Spotify returned HTTP 503"],
    ["a 429", () => json({ error: { status: 429, message: "Rate limited" } }, 429), "Rate limited"],
    [
      "a timeout",
      () => {
        const err = new Error("The operation timed out");
        err.name = "TimeoutError";
        throw err;
      },
      "Spotify took too long to answer",
    ],
    [
      "a connection failure",
      () => {
        throw new TypeError("fetch failed");
      },
      "couldn't reach Spotify",
    ],
    [
      "a 401 invalid_client (the app's own credentials)",
      () => json({ error: "invalid_client", error_description: "Invalid client" }, 401),
      "Invalid client",
    ],
    [
      "a 400 invalid_client (the same refusal, whichever status Spotify gives it)",
      () => json({ error: "invalid_client", error_description: "Invalid client" }, 400),
      "Invalid client",
    ],
    [
      "a 400 whose code is not invalid_grant, whatever its prose says",
      () => json({ error: "invalid_request", error_description: "Refresh token revoked" }, 400),
      "Refresh token revoked",
    ],
    ["a 400 with no readable code", () => new Response("Bad Request", { status: 400 }), "Spotify returned HTTP 400"],
  ];

  for (const [name, answer, detail] of keptCases) {
    test(`${name} keeps the connection and says the link is still saved`, async () => {
      const result = await accessTokenFor(spotifyAnswering(answer), USER);
      expect(result).toMatchObject({ ok: false, kind: "unavailable" });
      expect(errorOf(result)).toContain("still saved");
      expect(errorOf(result)).toContain(detail);
      expect(errorOf(result)).toContain("try again in a moment");
      expect(errorOf(result)).toContain("/spotify connect");
      expect(musicState().connections[USER]).toMatchObject({ refreshToken: "RT1", connectedAt: CONNECTED_AT });
    });
  }

  test("a rotated refresh token and the granted scopes are persisted", async () => {
    const spotify = spotifyAnswering(() => json({ access_token: "AT2", refresh_token: "RT2", scope: PARTY_SCOPES }));
    const result = await accessTokenFor(spotify, USER);
    expect(result).toEqual({ ok: true, accessToken: "AT2", scopes: PARTY_SCOPES });
    expect(musicState().connections[USER]).toEqual({ refreshToken: "RT2", connectedAt: CONNECTED_AT, scopes: PARTY_SCOPES });
  });

  test("a refresh without rotation keeps the stored token and reports the stored scopes", async () => {
    const result = await accessTokenFor(spotifyAnswering(() => json({ access_token: "AT2" })), USER);
    expect(result).toEqual({ ok: true, accessToken: "AT2", scopes: SPOTIFY_SCOPES });
    expect(musicState().connections[USER]?.refreshToken).toBe("RT1");
  });

  test("a refresh that reports scopes but no rotation persists the scopes and keeps the token", async () => {
    const result = await accessTokenFor(spotifyAnswering(() => json({ access_token: "AT2", scope: PARTY_SCOPES })), USER);
    expect(result).toEqual({ ok: true, accessToken: "AT2", scopes: PARTY_SCOPES });
    expect(musicState().connections[USER]).toEqual({ refreshToken: "RT1", connectedAt: CONNECTED_AT, scopes: PARTY_SCOPES });
  });

  test("a rotation that reports no scopes stores the new token and keeps the recorded scopes", async () => {
    const result = await accessTokenFor(spotifyAnswering(() => json({ access_token: "AT2", refresh_token: "RT2" })), USER);
    expect(result).toEqual({ ok: true, accessToken: "AT2", scopes: SPOTIFY_SCOPES });
    expect(musicState().connections[USER]).toEqual({ refreshToken: "RT2", connectedAt: CONNECTED_AT, scopes: SPOTIFY_SCOPES });
  });

  test("nobody connected: says connect first and never calls Spotify", async () => {
    let calls = 0;
    const spotify = createSpotifyClient(CONFIG, async () => {
      calls += 1;
      return json({});
    });
    const result = await accessTokenFor(spotify, "200000000000000002");
    expect(result).toMatchObject({ ok: false, kind: "not-connected" });
    expect(errorOf(result)).toContain("/spotify connect");
    expect(calls).toBe(0);
  });

  test("a prototype key is not a connection: not-connected, and Spotify is never called (#247)", async () => {
    resetStoreForTest(freshState());
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "__defineGetter__"]) {
      let calls = 0;
      const spotify = createSpotifyClient(CONFIG, async () => {
        calls += 1;
        return json({});
      });
      const result = await accessTokenFor(spotify, key);
      expect(result).toMatchObject({ ok: false, kind: "not-connected" });
      expect(calls).toBe(0);
    }
  });
});

/**
 * A fake fetch that counts its calls and holds every answer until `release()`, so a test can move
 * the store while a refresh is out -- the window #146 is about. `answer` gets the call number.
 */
function parked(answer: (call: number) => Response) {
  let calls = 0;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spotify = createSpotifyClient(CONFIG, async () => {
    calls += 1;
    const call = calls;
    await released;
    return answer(call);
  });
  return { spotify, release, calls: () => calls };
}

describe("while a refresh is in flight", () => {
  const OTHER = "200000000000000002";
  const ROTATION = { access_token: "AT2", refresh_token: "RT2", scope: PARTY_SCOPES };
  const DEAD = { error: "invalid_grant", error_description: "Refresh token revoked" };

  test("two callers for one user share one refresh and one Spotify call", async () => {
    const { spotify, release, calls } = parked(() => json(ROTATION));
    const first = accessTokenFor(spotify, USER);
    const second = accessTokenFor(spotify, USER);
    release();
    expect(await first).toEqual({ ok: true, accessToken: "AT2", scopes: PARTY_SCOPES });
    expect(await second).toEqual({ ok: true, accessToken: "AT2", scopes: PARTY_SCOPES });
    expect(calls()).toBe(1);
    expect(musicState().connections[USER]).toEqual({ refreshToken: "RT2", connectedAt: CONNECTED_AT, scopes: PARTY_SCOPES });
  });

  test("the shared answer is the failure too", async () => {
    const { spotify, release, calls } = parked(() => json(DEAD, 400));
    const first = accessTokenFor(spotify, USER);
    const second = accessTokenFor(spotify, USER);
    release();
    expect(await first).toMatchObject({ ok: false, kind: "revoked" });
    expect(await second).toMatchObject({ ok: false, kind: "revoked" });
    expect(calls()).toBe(1);
    expect(musicState().connections[USER]).toBeUndefined();
  });

  test("callers for different users do not share", async () => {
    resetStoreForTest(
      putConnection(putConnection(freshState(), USER, "RT1", CONNECTED_AT, SPOTIFY_SCOPES), OTHER, "RT9", CONNECTED_AT, SPOTIFY_SCOPES),
    );
    const { spotify, release, calls } = parked(() => json({ access_token: "AT2" }));
    const first = accessTokenFor(spotify, USER);
    const second = accessTokenFor(spotify, OTHER);
    release();
    await Promise.all([first, second]);
    expect(calls()).toBe(2);
    expect(musicState().connections[OTHER]?.refreshToken).toBe("RT9");
  });

  test("a later call after the refresh has settled starts a new one", async () => {
    const { spotify, release, calls } = parked((call) => json({ access_token: call === 1 ? "AT2" : "AT3" }));
    release();
    expect(await accessTokenFor(spotify, USER)).toMatchObject({ ok: true, accessToken: "AT2" });
    expect(await accessTokenFor(spotify, USER)).toMatchObject({ ok: true, accessToken: "AT3" });
    expect(calls()).toBe(2);
  });

  test("a disconnect meanwhile is not undone by the success path", async () => {
    const { spotify, release } = parked(() => json(ROTATION));
    const pending = accessTokenFor(spotify, USER);
    // `/spotify disconnect` lands while the refresh is out.
    await commit(removeConnection(musicState(), USER));
    release();
    expect(await pending).toMatchObject({ ok: false, kind: "not-connected" });
    expect(musicState().connections[USER]).toBeUndefined();
  });

  test("a disconnect meanwhile answers connect-first on the failure path too, and removes nothing", async () => {
    const { spotify, release } = parked(() => json(DEAD, 400));
    const pending = accessTokenFor(spotify, USER);
    await commit(removeConnection(musicState(), USER));
    release();
    expect(await pending).toMatchObject({ ok: false, kind: "not-connected" });
    expect(musicState().connections[USER]).toBeUndefined();
  });

  // The `/spotify connect` callback lands while the refresh is out, with a fresh grant. The
  // refresh's own `scope` (SPOTIFY_SCOPES) differs from the fresh grant's (PARTY_SCOPES) on purpose:
  // it is what tells a write of the stale answer apart from an untouched store, with or without a
  // rotation, and whether or not the reconnect happened to carry the same connect time.
  const reconnectCases: Array<[string, Record<string, unknown>, number]> = [
    ["a refresh without rotation", { access_token: "AT2", scope: SPOTIFY_SCOPES }, 2_000],
    ["a rotation of the old grant", { access_token: "AT2", refresh_token: "RT_ROT", scope: SPOTIFY_SCOPES }, 2_000],
    ["a refresh without rotation, at the same connect time", { access_token: "AT2", scope: SPOTIFY_SCOPES }, CONNECTED_AT],
  ];

  for (const [name, body, at] of reconnectCases) {
    test(`a reconnect meanwhile wins over ${name}`, async () => {
      const { spotify, release } = parked(() => json(body));
      const pending = accessTokenFor(spotify, USER);
      await commit(putConnection(musicState(), USER, "RT_NEW", at, PARTY_SCOPES));
      release();
      expect(await pending).toEqual({ ok: true, accessToken: "AT2", scopes: SPOTIFY_SCOPES });
      expect(musicState().connections[USER]).toEqual({ refreshToken: "RT_NEW", connectedAt: at, scopes: PARTY_SCOPES });
    });
  }

  test("a reconnect that re-issued the same token reads as unchanged: its connect time is kept, the scopes are the refresh's", async () => {
    // Spotify issues a new refresh token per authorization, so this is hypothetical; it pins that
    // the write uses the connection as stored NOW (its connect time), not the pre-await snapshot.
    const { spotify, release } = parked(() => json({ access_token: "AT2", scope: SPOTIFY_SCOPES }));
    const pending = accessTokenFor(spotify, USER);
    await commit(putConnection(musicState(), USER, "RT1", 2_000, PARTY_SCOPES));
    release();
    expect(await pending).toEqual({ ok: true, accessToken: "AT2", scopes: SPOTIFY_SCOPES });
    expect(musicState().connections[USER]).toEqual({ refreshToken: "RT1", connectedAt: 2_000, scopes: SPOTIFY_SCOPES });
  });

  test("one user's refresh settling does not release another's entry", async () => {
    resetStoreForTest(
      putConnection(putConnection(freshState(), USER, "RT1", CONNECTED_AT, SPOTIFY_SCOPES), OTHER, "RT9", CONNECTED_AT, SPOTIFY_SCOPES),
    );
    const a = parked(() => json(ROTATION));
    const b = parked(() => json({ access_token: "ATB" }));
    const a1 = accessTokenFor(a.spotify, USER);
    const b1 = accessTokenFor(b.spotify, OTHER);
    b.release();
    await b1;
    const a2 = accessTokenFor(a.spotify, USER); // joins a1, which is still out
    expect(a.calls()).toBe(1);
    a.release();
    expect(await a1).toEqual({ ok: true, accessToken: "AT2", scopes: PARTY_SCOPES });
    expect(await a2).toEqual({ ok: true, accessToken: "AT2", scopes: PARTY_SCOPES });
  });

  test("a refresh whose store write fails rejects every joined caller and is released for the next", async () => {
    // The host's writer can reject (a failed atomic write). The entry must go either way, or the
    // rejected promise would answer every later call for this user until a restart.
    const failing = {
      ...makeRealStorage(),
      createJsonWriter: () => ({
        save: async (): Promise<void> => {
          throw new Error("disk full");
        },
      }),
    };
    resetStoreForTest(putConnection(freshState(), USER, "RT1", CONNECTED_AT, SPOTIFY_SCOPES), failing, "unused.json");
    const { spotify, release, calls } = parked(() => json(ROTATION));
    const first = accessTokenFor(spotify, USER);
    const second = accessTokenFor(spotify, USER);
    release();
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map((o) => (o.status === "rejected" ? String(o.reason) : "resolved"))).toEqual([
      "Error: disk full",
      "Error: disk full",
    ]);
    resetStoreForTest(putConnection(freshState(), USER, "RT1", CONNECTED_AT, SPOTIFY_SCOPES));
    expect(await accessTokenFor(spotify, USER)).toEqual({ ok: true, accessToken: "AT2", scopes: PARTY_SCOPES });
    expect(calls()).toBe(2);
  });

  test("a dead old grant after a reconnect does not remove the fresh one", async () => {
    const { spotify, release } = parked(() => json(DEAD, 400));
    const pending = accessTokenFor(spotify, USER);
    await commit(putConnection(musicState(), USER, "RT_NEW", 2_000, PARTY_SCOPES));
    release();
    expect(await pending).toMatchObject({ ok: false, kind: "unavailable" });
    expect(musicState().connections[USER]).toEqual({ refreshToken: "RT_NEW", connectedAt: 2_000, scopes: PARTY_SCOPES });
  });
});
