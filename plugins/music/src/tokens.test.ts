import { beforeEach, describe, expect, test } from "bun:test";
import { createSpotifyClient, PARTY_SCOPES, SPOTIFY_SCOPES } from "./spotify.js";
import { freshState, musicState, putConnection, resetStoreForTest } from "./store.js";
import { accessTokenFor } from "./tokens.js";

// These drive a REAL client over a fake fetch rather than a fake `refresh`, so what is pinned is
// the whole boundary #133 is about: what Spotify's answer looks like on the wire, how spotify.ts
// classifies it, and what tokens.ts then does to the stored connection.

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

beforeEach(() => {
  resetStoreForTest(putConnection(freshState(), USER, "RT1", CONNECTED_AT, SPOTIFY_SCOPES));
});

describe("accessTokenFor", () => {
  test("a revoked grant (400 invalid_grant) removes the connection and says reconnect", async () => {
    const spotify = spotifyAnswering(() => json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400));
    const result = await accessTokenFor(spotify, USER);
    expect(result).toMatchObject({ ok: false, kind: "revoked" });
    expect(result.ok === false && result.error).toContain("no longer valid");
    expect(musicState().connections[USER]).toBeUndefined();
  });

  const keptCases: Array<[string, () => Response]> = [
    ["a 503", () => new Response("<html>503</html>", { status: 503 })],
    ["a 429", () => json({ error: { status: 429, message: "Rate limited" } }, 429)],
    [
      "a timeout",
      () => {
        const err = new Error("The operation timed out");
        err.name = "TimeoutError";
        throw err;
      },
    ],
    [
      "a connection failure",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["a 401 invalid_client (the app's own credentials)", () => json({ error: "invalid_client", error_description: "Invalid client" }, 401)],
    ["a 400 with no readable code", () => new Response("Bad Request", { status: 400 })],
  ];

  for (const [name, answer] of keptCases) {
    test(`${name} keeps the connection and says the link is still saved`, async () => {
      const result = await accessTokenFor(spotifyAnswering(answer), USER);
      expect(result).toMatchObject({ ok: false, kind: "unavailable" });
      expect(result.ok === false && result.error).toContain("still saved");
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
    expect(calls).toBe(0);
  });
});
