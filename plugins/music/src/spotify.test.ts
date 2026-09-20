import { describe, expect, test } from "bun:test";
import { authorizeUrl, chunkUris, createSpotifyClient, MAX_URIS_PER_ADD, toTrackCandidates } from "./spotify.js";

const CONFIG = {
  clientId: "cid",
  clientSecret: "csecret",
  redirectUri: "https://bot.example.com/spotify/callback",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("authorizeUrl", () => {
  test("carries the client id, redirect, state and only the two playlist scopes", () => {
    const url = new URL(authorizeUrl(CONFIG, "STATE123"));
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("state")).toBe("STATE123");
    expect(url.searchParams.get("scope")).toBe("playlist-modify-private playlist-modify-public");
  });

  test("forces the consent dialog, so a shared browser can't silently reauthorise", () => {
    expect(new URL(authorizeUrl(CONFIG, "s")).searchParams.get("show_dialog")).toBe("true");
  });

  test("never leaks the client secret into the URL", () => {
    expect(authorizeUrl(CONFIG, "s")).not.toContain("csecret");
  });
});

describe("toTrackCandidates", () => {
  test("shapes the fields matching.ts scores on", () => {
    const candidates = toTrackCandidates({
      tracks: {
        items: [{ uri: "spotify:track:abc", name: "Hey Jude", popularity: 82, artists: [{ name: "The Beatles" }] }],
      },
    });
    expect(candidates).toEqual([
      { uri: "spotify:track:abc", name: "Hey Jude", artistNames: ["The Beatles"], popularity: 82 },
    ]);
  });

  test("drops a local track, which the API refuses to add to a playlist", () => {
    const candidates = toTrackCandidates({
      tracks: { items: [{ uri: "spotify:local:x:y:z", name: "Bootleg", artists: [] }] },
    });
    expect(candidates).toEqual([]);
  });

  test("drops rows with no uri or no name instead of shipping undefined downstream", () => {
    const candidates = toTrackCandidates({
      tracks: { items: [{ name: "No URI" }, { uri: "spotify:track:x" }, null, "nope"] },
    });
    expect(candidates).toEqual([]);
  });

  test("a missing popularity defaults to 0 rather than NaN-ing every comparison", () => {
    const [candidate] = toTrackCandidates({
      tracks: { items: [{ uri: "spotify:track:a", name: "X", artists: [{ name: "Y" }] }] },
    });
    expect(candidate!.popularity).toBe(0);
  });

  test("an empty or malformed body yields an empty list, not a throw", () => {
    expect(toTrackCandidates({})).toEqual([]);
    expect(toTrackCandidates(null)).toEqual([]);
  });
});

describe("chunkUris", () => {
  test("splits at Spotify's 100-item add limit", () => {
    const uris = Array.from({ length: 250 }, (_, i) => `spotify:track:${i}`);
    const chunks = chunkUris(uris);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(MAX_URIS_PER_ADD).toBe(100);
  });

  test("exactly 100 is one batch, not two", () => {
    expect(chunkUris(Array.from({ length: 100 }, (_, i) => `${i}`)).length).toBe(1);
  });

  test("an empty list produces no batches, so addTracks makes no call", () => {
    expect(chunkUris([])).toEqual([]);
  });
});

describe("createSpotifyClient", () => {
  test("exchangeCode posts the authorization_code grant with Basic auth", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const client = createSpotifyClient(CONFIG, async (url, init) => {
      seen = { url, init };
      return json({ access_token: "AT", refresh_token: "RT" });
    });
    const result = await client.exchangeCode("CODE");
    expect(result).toEqual({ ok: true, value: { accessToken: "AT", refreshToken: "RT" } });
    expect(seen!.url).toBe("https://accounts.spotify.com/api/token");
    const headers = seen!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("cid:csecret").toString("base64")}`);
    const body = new URLSearchParams(seen!.init!.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("CODE");
    expect(body.get("redirect_uri")).toBe(CONFIG.redirectUri);
  });

  test("an exchange with no refresh token fails loudly -- the connection would expire in an hour", async () => {
    const client = createSpotifyClient(CONFIG, async () => json({ access_token: "AT" }));
    const result = await client.exchangeCode("CODE");
    expect(result).toEqual({ ok: false, error: "Spotify didn't return a refresh token" });
  });

  test("refresh surfaces a ROTATED refresh token so the caller can persist it", async () => {
    const client = createSpotifyClient(CONFIG, async () => json({ access_token: "AT2", refresh_token: "RT2" }));
    const result = await client.refresh("RT1");
    expect(result.ok === true && result.value.refreshToken).toBe("RT2");
  });

  test("refresh without rotation leaves refreshToken unset, so nothing overwrites the stored one", async () => {
    const client = createSpotifyClient(CONFIG, async () => json({ access_token: "AT2" }));
    const result = await client.refresh("RT1");
    expect(result.ok === true && result.value).toEqual({ accessToken: "AT2" });
  });

  test("the dev-mode five-user wall is surfaced verbatim, because that message IS the diagnosis", async () => {
    const client = createSpotifyClient(CONFIG, async () =>
      json({ error: { status: 403, message: "User not registered in the Developer Dashboard" } }, 403),
    );
    const result = await client.searchTracks("AT", "q");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("User not registered in the Developer Dashboard");
  });

  test("the accounts host's error_description shape is surfaced too", async () => {
    const client = createSpotifyClient(CONFIG, async () =>
      json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400),
    );
    const result = await client.refresh("dead");
    expect(result.ok === false && result.error).toContain("Refresh token revoked");
  });

  test("a non-JSON error body still yields the status, not a crash", async () => {
    const client = createSpotifyClient(CONFIG, async () => new Response("<html>502</html>", { status: 502 }));
    const result = await client.searchTracks("AT", "q");
    expect(result).toEqual({ ok: false, error: "Spotify returned HTTP 502" });
  });

  test("searchTracks asks for the dev-mode-legal limit of 10", async () => {
    let seen = "";
    const client = createSpotifyClient(CONFIG, async (url) => {
      seen = url;
      return json({ tracks: { items: [] } });
    });
    await client.searchTracks("AT", 'track:"x" artist:"y"');
    const params = new URL(seen).searchParams;
    expect(params.get("limit")).toBe("10");
    expect(params.get("type")).toBe("track");
    expect(params.get("q")).toBe('track:"x" artist:"y"');
  });

  test("createPlaylist posts to /me/playlists and defaults to private", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const client = createSpotifyClient(CONFIG, async (url, init) => {
      seen = { url, init };
      return json({ id: "PL1", external_urls: { spotify: "https://open.spotify.com/playlist/PL1" } }, 201);
    });
    const result = await client.createPlaylist("AT", "Name", "Desc");
    expect(result).toEqual({ ok: true, value: { id: "PL1", url: "https://open.spotify.com/playlist/PL1" } });
    expect(seen!.url).toBe("https://api.spotify.com/v1/me/playlists");
    expect(JSON.parse(seen!.init!.body as string)).toEqual({ name: "Name", description: "Desc", public: false });
  });

  test("addTracks sends one request per 100-URI batch, in order", async () => {
    const batches: string[][] = [];
    const client = createSpotifyClient(CONFIG, async (_url, init) => {
      batches.push(JSON.parse(init!.body as string).uris);
      return json({ snapshot_id: "s" }, 201);
    });
    const uris = Array.from({ length: 150 }, (_, i) => `spotify:track:${i}`);
    const result = await client.addTracks("AT", "PL1", uris);
    expect(result).toEqual({ ok: true, value: 150 });
    expect(batches.map((b) => b.length)).toEqual([100, 50]);
    expect(batches[0]![0]).toBe("spotify:track:0");
    expect(batches[1]![0]).toBe("spotify:track:100");
  });

  test("a failed second batch reports how many tracks DID land", async () => {
    let call = 0;
    const client = createSpotifyClient(CONFIG, async () => {
      call += 1;
      return call === 1 ? json({}, 201) : json({ error: { message: "Rate limited" } }, 429);
    });
    const uris = Array.from({ length: 150 }, (_, i) => `spotify:track:${i}`);
    const result = await client.addTracks("AT", "PL1", uris);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("after adding 100 of 150");
  });

  test("addTracks posts to /items, the endpoint that replaced /tracks", async () => {
    let seen = "";
    const client = createSpotifyClient(CONFIG, async (url) => {
      seen = url;
      return json({}, 201);
    });
    await client.addTracks("AT", "PL 1/x", ["spotify:track:a"]);
    expect(seen).toBe("https://api.spotify.com/v1/playlists/PL%201%2Fx/items");
  });
});
