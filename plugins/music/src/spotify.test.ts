import { describe, expect, spyOn, test } from "bun:test";
import {
  authorizeUrl,
  chunkUris,
  classifyPlayerError,
  createSpotifyClient,
  hasScopes,
  isDeadGrant,
  MAX_URIS_PER_ADD,
  PARTY_SCOPES,
  SPOTIFY_SCOPES,
  toTrackCandidates,
} from "./spotify.js";

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
  test("shapes the fields matching.ts needs", () => {
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

  test("a missing popularity defaults to 0 rather than undefined", () => {
    const [candidate] = toTrackCandidates({
      tracks: { items: [{ uri: "spotify:track:a", name: "X", artists: [{ name: "Y" }] }] },
    });
    expect(candidate!.popularity).toBe(0);
  });

  test("an empty or malformed body yields an empty list, not a throw", () => {
    expect(toTrackCandidates({})).toEqual([]);
    expect(toTrackCandidates(null)).toEqual([]);
  });

  test("a duration is kept only when it is a positive finite number", () => {
    // A party arms its next-track timer on this: a zero, a negative, an NaN or an Infinity would
    // advance it instantly or never. The body is an object, not JSON text: JSON cannot carry NaN or
    // Infinity, and a mutated guard could. `NaN > 0` is already false, so only Infinity tells
    // `Number.isFinite` apart from `> 0`.
    const durations: [string, unknown][] = [
      ["valid", 180_000],
      ["zero", 0],
      ["negative", -1],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["a numeric string", "180000"],
    ];
    const items = [
      ...durations.map(([label, duration]) => ({
        uri: `spotify:track:${label}`,
        name: label,
        artists: [],
        duration_ms: duration,
      })),
      { uri: "spotify:track:absent", name: "absent", artists: [] },
    ];

    const candidates = toTrackCandidates({ tracks: { items } });

    expect(candidates.map((c) => c.name)).toEqual([...durations.map(([label]) => label), "absent"]);
    const byName = Object.fromEntries(candidates.map((c) => [c.name, c]));
    expect(byName.valid?.durationMs).toBe(180_000);
    for (const label of ["zero", "negative", "NaN", "Infinity", "a numeric string", "absent"]) {
      // The key itself is absent, not just undefined.
      expect(Object.keys(byName[label] ?? {})).not.toContain("durationMs");
    }
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

  test("exchangeCode records the granted scopes when Spotify reports them, and none when it does not", async () => {
    const granted = "playlist-modify-private user-modify-playback-state";
    const reporting = createSpotifyClient(CONFIG, async () =>
      json({ access_token: "AT", refresh_token: "RT", scope: granted }),
    );
    expect(await reporting.exchangeCode("CODE")).toStrictEqual({
      ok: true,
      value: { accessToken: "AT", refreshToken: "RT", scopes: granted },
    });

    // Not reported, or not a string: the key is absent, never undefined or a guess.
    for (const scope of [undefined, 42]) {
      const silent = createSpotifyClient(CONFIG, async () => json({ access_token: "AT", refresh_token: "RT", scope }));
      expect(await silent.exchangeCode("CODE")).toStrictEqual({
        ok: true,
        value: { accessToken: "AT", refreshToken: "RT" },
      });
    }
  });

  test("refresh records the granted scopes the same way", async () => {
    const granted = "playlist-modify-private user-modify-playback-state";
    const reporting = createSpotifyClient(CONFIG, async () => json({ access_token: "AT2", scope: granted }));
    expect(await reporting.refresh("RT1")).toStrictEqual({
      ok: true,
      value: { accessToken: "AT2", scopes: granted },
    });

    for (const scope of [undefined, 42]) {
      const silent = createSpotifyClient(CONFIG, async () => json({ access_token: "AT2", scope }));
      expect(await silent.refresh("RT1")).toStrictEqual({ ok: true, value: { accessToken: "AT2" } });
    }
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

  test("refresh on a 400 invalid_grant surfaces the status and the machine-readable code", async () => {
    const client = createSpotifyClient(CONFIG, async () =>
      json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400),
    );
    const result = await client.refresh("dead");
    expect(result).toEqual({
      ok: false,
      error: "Spotify returned HTTP 400: Refresh token revoked",
      status: 400,
      code: "invalid_grant",
    });
  });

  test("a 503 with an HTML body surfaces the status and no code at all", async () => {
    const client = createSpotifyClient(CONFIG, async () => new Response("<html>503</html>", { status: 503 }));
    const result = await client.refresh("RT1");
    expect(result).toEqual({ ok: false, error: "Spotify returned HTTP 503", status: 503 });
  });

  test("a string error with no description is both the message and the code", async () => {
    const client = createSpotifyClient(CONFIG, async () => json({ error: "invalid_request" }, 400));
    const result = await client.refresh("RT1");
    expect(result).toEqual({
      ok: false,
      error: "Spotify returned HTTP 400: invalid_request",
      status: 400,
      code: "invalid_request",
    });
  });

  test("a description with no error string is the message and carries no code", async () => {
    const client = createSpotifyClient(CONFIG, async () => json({ error_description: "try later" }, 429));
    const result = await client.refresh("RT1");
    expect(result).toEqual({ ok: false, error: "Spotify returned HTTP 429: try later", status: 429 });
  });

  test("a non-JSON error body still yields the status, not a crash", async () => {
    const client = createSpotifyClient(CONFIG, async () => new Response("<html>502</html>", { status: 502 }));
    const result = await client.searchTracks("AT", "q");
    expect(result).toEqual({ ok: false, error: "Spotify returned HTTP 502", status: 502 });
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

describe("the player calls", () => {
  const API = "https://api.spotify.com/v1";

  interface Recorded {
    url: string;
    method: string | undefined;
    headers: Record<string, string>;
    body: string | undefined;
  }

  /** A client over a fetch that records every request as given and answers `respond()`. */
  function recording(respond: () => Response) {
    const requests: Recorded[] = [];
    const client = createSpotifyClient(CONFIG, async (url, init) => {
      requests.push({
        url,
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body as string | undefined,
      });
      return respond();
    });
    return { client, requests };
  }

  const noContent = () => new Response(null, { status: 204 });

  test("play PUTs one explicit URI to /me/player/play with the position rounded and never negative", async () => {
    const { client, requests } = recording(noContent);

    const first = await client.play("AT", "spotify:track:one", 12_345.6);
    const second = await client.play("AT", "spotify:track:one", -500);

    expect(first).toStrictEqual({ ok: true, value: undefined });
    expect(second).toStrictEqual({ ok: true, value: undefined });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.method).toBe("PUT");
    expect(requests[0]!.url).toBe(`${API}/me/player/play`);
    expect(requests[0]!.headers).toEqual({ Authorization: "Bearer AT", "Content-Type": "application/json" });
    expect(JSON.parse(requests[0]!.body!)).toEqual({ uris: ["spotify:track:one"], position_ms: 12_346 });
    expect(JSON.parse(requests[1]!.body!)).toEqual({ uris: ["spotify:track:one"], position_ms: 0 });
  });

  test("play targets a device through device_id, URL-encoded", async () => {
    const { client, requests } = recording(noContent);

    await client.play("AT", "spotify:track:one", 0, "dev/1 2");

    expect(requests[0]!.url).toBe(`${API}/me/player/play?device_id=dev%2F1%202`);
  });

  test("playbackState GETs /me/player and shapes the answer", async () => {
    const full = recording(() =>
      json({
        is_playing: true,
        progress_ms: 42_000,
        item: { uri: "spotify:track:one", duration_ms: 180_000 },
        device: { id: "d1" },
      }),
    );

    const shaped = await full.client.playbackState("AT");

    expect(full.requests).toHaveLength(1);
    expect(full.requests[0]!.method ?? "GET").toBe("GET");
    expect(full.requests[0]!.url).toBe(`${API}/me/player`);
    expect(full.requests[0]!.headers).toEqual({ Authorization: "Bearer AT" });
    expect(shaped).toStrictEqual({
      ok: true,
      value: {
        isPlaying: true,
        progressMs: 42_000,
        trackUri: "spotify:track:one",
        durationMs: 180_000,
        deviceId: "d1",
      },
    });

    // Nothing usable in the body: not playing, at 0, and no other keys.
    const bare = recording(() => json({}));
    expect(await bare.client.playbackState("AT")).toStrictEqual({
      ok: true,
      value: { isPlaying: false, progressMs: 0 },
    });
  });

  test("playbackState treats 204 as nothing playing, not a failure", async () => {
    const { client } = recording(noContent);

    expect(await client.playbackState("AT")).toStrictEqual({ ok: true, value: undefined });
  });

  test("devices GETs /me/player/devices and drops a device with no id", async () => {
    const listed = recording(() =>
      json({
        devices: [
          { id: "d1", name: "Phone", is_active: true },
          { id: null, name: "Restricted" },
          { id: "d2" },
        ],
      }),
    );

    const result = await listed.client.devices("AT");

    expect(listed.requests).toHaveLength(1);
    expect(listed.requests[0]!.method ?? "GET").toBe("GET");
    expect(listed.requests[0]!.url).toBe(`${API}/me/player/devices`);
    expect(listed.requests[0]!.headers).toEqual({ Authorization: "Bearer AT" });
    expect(result).toStrictEqual({
      ok: true,
      value: [
        { id: "d1", name: "Phone", isActive: true },
        { id: "d2", name: "Unnamed device", isActive: false },
      ],
    });

    // No devices array at all: an empty list, not a throw.
    const none = recording(() => json({}));
    expect(await none.client.devices("AT")).toStrictEqual({ ok: true, value: [] });
  });

  test("transfer PUTs the device to /me/player with play: false", async () => {
    const { client, requests } = recording(noContent);

    const result = await client.transfer("AT", "d1");

    expect(result).toStrictEqual({ ok: true, value: undefined });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("PUT");
    expect(requests[0]!.url).toBe(`${API}/me/player`);
    expect(requests[0]!.headers).toEqual({ Authorization: "Bearer AT", "Content-Type": "application/json" });
    expect(JSON.parse(requests[0]!.body!)).toEqual({ device_ids: ["d1"], play: false });
  });

  test("a player call's failure carries the status for classifyPlayerError", async () => {
    const { client } = recording(() => json({ error: { message: "No active device found" } }, 404));

    const result = await client.play("AT", "spotify:track:one", 0);

    expect(result).toStrictEqual({
      ok: false,
      status: 404,
      error: "Spotify returned HTTP 404: No active device found",
    });
  });
});

describe("a player call and the host's signal", () => {
  /** Runs one player call against a fetch that records the signal it was handed, then settles. */
  function player(): {
    client: ReturnType<typeof createSpotifyClient>;
    seen: (AbortSignal | undefined)[];
  } {
    const seen: (AbortSignal | undefined)[] = [];
    const client = createSpotifyClient(CONFIG, async (_url, init) => {
      seen.push(init?.signal ?? undefined);
      return new Response(null, { status: 204 });
    });
    return { client, seen };
  }

  const calls: [string, (c: ReturnType<typeof createSpotifyClient>, s?: AbortSignal) => Promise<unknown>][] = [
    ["playbackState", (c, s) => c.playbackState("AT", s)],
    ["play", (c, s) => c.play("AT", "spotify:track:one", 0, undefined, s)],
    ["devices", (c, s) => c.devices("AT", s)],
    ["transfer", (c, s) => c.transfer("AT", "d1", s)],
  ];

  /**
   * Runs `run` with `AbortSignal.timeout` replaced by one the test controls, so the client's own
   * 10-second bound can be made to fire at once. Returns that bound's controller.
   */
  async function withControllableBound(
    run: (timeoutSignal: AbortController) => Promise<void>,
  ): Promise<void> {
    const bound = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(bound.signal);
    try {
      await run(bound);
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  }

  for (const [name, run] of calls) {
    test(`${name} given the host's signal is aborted with it`, async () => {
      const { client, seen } = player();
      const controller = new AbortController();

      await run(client, controller.signal);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.aborted).toBe(false);
      controller.abort();
      expect(seen[0]?.aborted).toBe(true);
    });

    test(`${name} given the host's signal is still ended by the client's own 10 s bound`, async () => {
      const { client, seen } = player();
      const controller = new AbortController();

      await withControllableBound(async (bound) => {
        await run(client, controller.signal);
        expect(seen[0]?.aborted).toBe(false);
        bound.abort();
      });

      // The bound fired; the host's own signal did not.
      expect(seen[0]?.aborted).toBe(true);
      expect(controller.signal.aborted).toBe(false);
    });

    test(`${name} without a signal is ended by the client's own 10 s bound`, async () => {
      const { client, seen } = player();

      await withControllableBound(async (bound) => {
        await run(client);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.aborted).toBe(false);
        bound.abort();
      });

      expect(seen[0]?.aborted).toBe(true);
    });
  }

  test("a call aborted by the host reports that Spotify could not be reached", async () => {
    const client = createSpotifyClient(CONFIG, async (_url, init) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response(null, { status: 204 });
    });

    const result = await client.playbackState("AT", AbortSignal.abort());

    expect(result).toEqual({ ok: false, error: "couldn't reach Spotify" });
  });
});

describe("scopes", () => {
  test("a connection that recorded no scopes is treated as playlist-only, never as party-capable", () => {
    expect(hasScopes(undefined, SPOTIFY_SCOPES)).toBe(true);
    expect(hasScopes(undefined, PARTY_SCOPES)).toBe(false);
  });

  test("the granted set is compared as a set, since Spotify returns its own order", () => {
    expect(hasScopes("user-modify-playback-state playlist-modify-public playlist-modify-private user-read-playback-state", PARTY_SCOPES)).toBe(true);
    expect(hasScopes("playlist-modify-private playlist-modify-public user-read-playback-state", PARTY_SCOPES)).toBe(false);
  });

  test("the party link asks for the playback scopes; /spotify connect still does not", () => {
    expect(new URL(authorizeUrl(CONFIG, "S1")).searchParams.get("scope")).toBe(SPOTIFY_SCOPES);
    expect(authorizeUrl(CONFIG, "S1")).not.toContain("user-modify-playback-state");
    expect(new URL(authorizeUrl(CONFIG, "S1", PARTY_SCOPES)).searchParams.get("scope")).toBe(PARTY_SCOPES);
  });
});

describe("classifyPlayerError", () => {
  test("403 splits on the message: a free account is not a missing scope", () => {
    expect(classifyPlayerError(403, "Player command failed: Premium required")).toBe("premium");
    expect(classifyPlayerError(403, "Insufficient client scope")).toBe("scope");
  });

  test("404 on a player call means no active device, not a missing endpoint", () => {
    expect(classifyPlayerError(404, "Player command failed: No active device found")).toBe("no-device");
    expect(classifyPlayerError(undefined, "NO_ACTIVE_DEVICE")).toBe("no-device");
  });

  test("a network failure, which carries no status, is nobody's fault in particular", () => {
    expect(classifyPlayerError(undefined, "couldn't reach Spotify")).toBe("other");
  });
});

describe("isDeadGrant", () => {
  test("only a 400 invalid_grant means the refresh token itself is dead", () => {
    expect(isDeadGrant({ status: 400, code: "invalid_grant" })).toBe(true);
  });

  test("invalid_client is the app's own credentials, which reconnecting cannot fix, at either status", () => {
    expect(isDeadGrant({ status: 401, code: "invalid_client" })).toBe(false);
    expect(isDeadGrant({ status: 400, code: "invalid_client" })).toBe(false);
  });

  test("both halves are required: a different status or a different code is not a dead grant", () => {
    expect(isDeadGrant({ status: 401, code: "invalid_grant" })).toBe(false);
    expect(isDeadGrant({ status: 503, code: "invalid_grant" })).toBe(false);
    expect(isDeadGrant({ code: "invalid_grant" })).toBe(false);
    expect(isDeadGrant({ status: 400, code: "invalid_request" })).toBe(false);
  });

  test("a 400 with no readable code, a 5xx, a 429 and a timeout are not a dead grant", () => {
    expect(isDeadGrant({ status: 400 })).toBe(false);
    expect(isDeadGrant({ status: 503 })).toBe(false);
    expect(isDeadGrant({ status: 429, code: "rate_limited" })).toBe(false);
    expect(isDeadGrant({})).toBe(false);
  });
});
