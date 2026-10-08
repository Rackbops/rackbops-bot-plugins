import { beforeEach, describe, expect, test } from "bun:test";
import { createSpotifyClient, PARTY_SCOPES, SPOTIFY_SCOPES } from "./spotify.js";
import { freshState, musicState, putConnection, resetStoreForTest } from "./store.js";
import { accessTokenFor } from "./tokens.js";

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
});
