import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { createPlugin } from "./index.js";
import { recordRun, resetMatchLogForTest, type MatchLogFile } from "./matchlog.js";
import { freshParties, openParty, resetPartiesForTest } from "./party.js";
import { PARTY_SCOPES } from "./spotify.js";
import { beginPendingAuth, commit, musicState, PENDING_AUTH_TTL_MS, putConnection, type MusicState } from "./store.js";
import { makeFakeHost, makeRealStorage } from "../../../packages/testkit/index.js";

/**
 * A port that is free right now. The plugin's own config deliberately REFUSES port 0 (the manifest
 * regex and `resolveConfig` both treat it as out of range), so the usual "bind 0 and let the OS
 * choose" trick isn't available to a test that goes through `createPlugin` -- ask the OS for a free
 * number first, then hand that concrete number to the plugin.
 */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

const FULL_ENV = {
  SETLISTFM_API_KEY: "sk",
  SPOTIFY_CLIENT_ID: "cid",
  SPOTIFY_CLIENT_SECRET: "csecret",
  SPOTIFY_REDIRECT_URI: "https://bot.example.com/spotify/callback",
  MUSIC_CALLBACK_PORT: "8787",
};

describe("createPlugin", () => {
  test("registers exactly the three commands the manifest declares", () => {
    const plugin = createPlugin(makeFakeHost({ name: "music" }));
    expect((plugin.commands ?? []).map((c) => c.name)).toEqual(["setlist", "spotify", "party"]);
  });

  test("loads with a completely empty env -- enabled is not the same as configured", () => {
    expect(() => createPlugin(makeFakeHost({ name: "music", env: {} }))).not.toThrow();
    expect((createPlugin(makeFakeHost({ name: "music", env: {} })).commands ?? []).length).toBe(3);
  });

  test("throws on a SET but invalid value, so the host skips just this plugin", () => {
    expect(() => createPlugin(makeFakeHost({ name: "music", env: { MUSIC_CALLBACK_PORT: "nope" } }))).toThrow(
      /MUSIC_CALLBACK_PORT/,
    );
    expect(() => createPlugin(makeFakeHost({ name: "music", env: { SPOTIFY_REDIRECT_URI: "http://insecure/cb" } }))).toThrow(
      /must be an https:\/\/ URL/,
    );
  });

  test("createPlugin performs no I/O -- it must be safe to call before takeOver()", () => {
    // A dataDir that cannot exist: anything touching the filesystem here would throw.
    expect(() => createPlugin(makeFakeHost({ name: "music", env: FULL_ENV, dataDir: "/nonexistent-dir/deeper" }))).not.toThrow();
  });

  test("/setlist takes url, artist and date, all optional", () => {
    const plugin = createPlugin(makeFakeHost({ name: "music" }));
    const setlist = (plugin.commands ?? []).find((c) => c.name === "setlist")!;
    const body = setlist.build(new SlashCommandBuilder().setName("setlist")).toJSON();
    expect(body.description).toBe("Turn a setlist.fm setlist into a Spotify playlist");
    // Every option is optional: `date` is only meaningful WITH `artist`, and Discord has no way to
    // express that pairing, so the handler checks the combination and says so in words instead.
    expect(body.options?.map((o) => [o.name, o.required ?? false])).toEqual([
      ["url", false],
      ["artist", false],
      ["date", false],
    ]);
  });

  test("the plugin handles its own component interactions, for the same-day show picker", () => {
    const plugin = createPlugin(makeFakeHost({ name: "music" }));
    expect(typeof plugin.interactions).toBe("function");
  });

  test("/spotify offers connect, disconnect and status", () => {
    const plugin = createPlugin(makeFakeHost({ name: "music" }));
    const spotify = (plugin.commands ?? []).find((c) => c.name === "spotify")!;
    const body = spotify.build(new SlashCommandBuilder().setName("spotify")).toJSON();
    expect(body.options?.map((o) => o.name)).toEqual(["connect", "disconnect", "status"]);
  });

  test("the host's namespaced builder is respected -- the plugin never sets its own name", () => {
    const plugin = createPlugin(makeFakeHost({ name: "music" }));
    const setlist = (plugin.commands ?? []).find((c) => c.name === "setlist")!;
    const body = setlist.build(new SlashCommandBuilder().setName("prefix-setlist")).toJSON();
    expect(body.name).toBe("prefix-setlist");
  });
});

describe("activate / dispose", () => {
  test("with no callback port configured, no server is started and dispose is a no-op", async () => {
    const dir = await mkdtemp(join(tmpdir(), "music-activate-"));
    try {
      const host = makeFakeHost({ name: "music",
        env: { ...FULL_ENV, MUSIC_CALLBACK_PORT: undefined },
        dataDir: dir,
        storage: makeRealStorage(),
      });
      const plugin = createPlugin(host);
      await plugin.activate?.();
      await plugin.dispose?.(); // must not throw with nothing to close
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a blank TRUSTED_PROXY_HOST counts as unset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "music-activate-"));
    const infos: string[] = [];
    try {
      const host = makeFakeHost({ name: "music",
        env: { ...FULL_ENV, MUSIC_CALLBACK_PORT: String(freePort()), TRUSTED_PROXY_HOST: "   " },
        dataDir: dir,
        storage: makeRealStorage(),
        log: { info: (m) => infos.push(m), warn() {}, error() {} },
      });
      const plugin = createPlugin(host);
      await plugin.activate?.();
      try {
        // Every other key goes through `present()`; a whitespace value used to count as configured,
        // trust nobody, and skip this line.
        expect(infos.some((m) => m.includes("TRUSTED_PROXY_HOST is not set"))).toBe(true);
      } finally {
        await plugin.dispose?.();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("activate binds the callback server and dispose closes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "music-activate-"));
    try {
      const host = makeFakeHost({ name: "music",
        env: { ...FULL_ENV, MUSIC_CALLBACK_PORT: String(freePort()) },
        dataDir: dir,
        storage: makeRealStorage(),
      });
      const plugin = createPlugin(host);
      await plugin.activate?.();
      await plugin.dispose?.();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a callback server that fails to bind is logged, not thrown -- the bot must stay up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "music-activate-"));
    const errors: string[] = [];
    try {
      // Port 1 is privileged; binding it as a non-root user fails.
      const host = makeFakeHost({ name: "music",
        env: { ...FULL_ENV, MUSIC_CALLBACK_PORT: "1" },
        dataDir: dir,
        storage: makeRealStorage(),
        log: { info() {}, warn() {}, error: (m) => errors.push(m) },
      });
      const plugin = createPlugin(host);
      await plugin.activate?.();
      // Either it bound (running as root in some containers) or it logged and carried on. What
      // must never happen is activate() throwing and taking the bot down with it.
      if (errors.length > 0) expect(errors[0]).toContain("callback server failed to start");
      await plugin.dispose?.();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a callback whose store write fails is logged through the plugin's logger and answered with a plain page (#190)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "music-activate-"));
    const errors: string[] = [];
    try {
      const port = freePort();
      const host = makeFakeHost({ name: "music",
        env: { ...FULL_ENV, MUSIC_CALLBACK_PORT: String(port) },
        dataDir: dir,
        // Every write fails, like a full disk. Nothing in activate() writes, so it still comes up.
        storage: {
          ...makeRealStorage(),
          createJsonWriter: () => ({
            save: async () => {
              throw new Error("disk full");
            },
          }),
        },
        log: { info() {}, warn() {}, error: (m) => errors.push(m) },
      });
      const plugin = createPlugin(host);
      await plugin.activate?.();
      try {
        // No such handshake: redeemState still commits (the token is consumed either way), and the
        // commit is what throws. Only activate()'s own `log: host.log` can put that in the bot log.
        const response = await fetch(`http://127.0.0.1:${port}/spotify/callback?code=C&state=NO-SUCH-STATE`);
        expect(response.status).toBe(500);
        expect(await response.text()).toContain("Something went wrong");
        expect(errors).toEqual(["Spotify callback failed while redeeming the state"]);
      } finally {
        await plugin.dispose?.();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("activate creates the store file, so a first run persists from the start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "music-activate-"));
    try {
      const host = makeFakeHost({ name: "music",
        env: { ...FULL_ENV, MUSIC_CALLBACK_PORT: undefined },
        dataDir: dir,
        storage: makeRealStorage(),
      });
      const plugin = createPlugin(host);
      await plugin.activate?.();
      const { commit, putConnection, musicState } = await import("./store.js");
      await commit(putConnection(musicState(), "u1", "RT", 1));
      expect(await Bun.file(join(dir, "music.json")).exists()).toBe(true);
      await plugin.dispose?.();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("activate creates the match log, and a recorded run lands in music-match-log.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "music-activate-"));
    try {
      resetMatchLogForTest({ v: 1, runs: [] });
      const host = makeFakeHost({ name: "music",
        env: { ...FULL_ENV, MUSIC_CALLBACK_PORT: undefined },
        dataDir: dir,
        storage: makeRealStorage(),
      });
      const plugin = createPlugin(host);
      await plugin.activate?.();
      await recordRun({
        at: "2026-09-20T12:00:00.000Z",
        setlistId: "abc123",
        setlistUrl: "https://www.setlist.fm/setlist/band/2026/the-venue-abc123.html",
        artist: "Band",
        eventDate: "08-09-2026",
        ok: true,
        attempted: 1,
        added: 1,
        songs: [{ name: "One", searchArtist: "Band", outcome: "high" }],
      });
      const onDisk = (await Bun.file(join(dir, "music-match-log.json")).json()) as MatchLogFile;
      expect(onDisk.v).toBe(1);
      expect(onDisk.runs.map((r) => r.setlistId)).toEqual(["abc123"]);
      await plugin.dispose?.();
    } finally {
      resetMatchLogForTest({ v: 1, runs: [] });
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a /setlist run through the plugin's own handler is recorded and summarised in the bot log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "music-activate-"));
    const restoreFetch = stubFetch();
    try {
      resetMatchLogForTest({ v: 1, runs: [] });
      const infos: string[] = [];
      const host = makeFakeHost({ name: "music",
        env: { ...FULL_ENV, MUSIC_CALLBACK_PORT: undefined },
        dataDir: dir,
        storage: makeRealStorage(),
        log: { info: (m) => infos.push(m), warn() {}, error() {} },
      });
      const plugin = createPlugin(host);
      await plugin.activate?.();
      const { commit, putConnection, musicState } = await import("./store.js");
      await commit(putConnection(musicState(), "user-1", "RT", 1));

      const edits: string[] = [];
      const interaction = {
        user: { id: "user-1" },
        deferred: false,
        replied: false,
        options: { getString: (name: string) => (name === "artist" ? "Band" : null) },
        deferReply: async () => {},
        editReply: async (opts: { content?: string }) => {
          edits.push(opts.content ?? "");
        },
      };
      const setlist = (plugin.commands ?? []).find((c) => c.name === "setlist")!;
      await setlist.handle(interaction as unknown as ChatInputCommandInteraction);

      // One song is on Spotify, one is not -- the reply says so, and the log says how.
      expect(edits.join("\n")).toContain("Added 1 of 2 songs.");
      const onDisk = (await Bun.file(join(dir, "music-match-log.json")).json()) as MatchLogFile;
      expect(onDisk.runs).toHaveLength(1);
      const made = onDisk.runs[0]!;
      expect(made.setlistId).toBe("abc123");
      expect(made.added).toBe(1);
      expect(made.songs.map((s) => [s.name, s.outcome])).toEqual([
        ["One", "high"],
        ["Two", "missing"],
      ]);
      expect(infos).toContain('setlist abc123 "Band 08-09-2026": added 1/2, missing 1, loose 0');
      await plugin.dispose?.();
    } finally {
      restoreFetch();
      resetMatchLogForTest({ v: 1, runs: [] });
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the party-sweep tick", () => {
  test("hands the host's signal to the sweep", async () => {
    const dir = await mkdtemp(join(tmpdir(), "music-tick-"));
    const restoreFetch = stubFetch();
    const stubbed = globalThis.fetch;
    let fetchCalls = 0;
    // Installed before createPlugin: the Spotify client takes `fetch` as its default transport then.
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      return stubbed(...args);
    }) as typeof fetch;
    try {
      const infos: string[] = [];
      const host = makeFakeHost({ name: "music",
        env: { ...FULL_ENV, MUSIC_CALLBACK_PORT: undefined },
        dataDir: dir,
        storage: makeRealStorage(),
        log: { info: (m) => infos.push(m), warn() {}, error() {} },
      });
      const plugin = createPlugin(host);
      await plugin.activate?.();
      const { commit, putConnection, musicState } = await import("./store.js");
      await commit(putConnection(musicState(), "user-1", "RT", 1));
      // After activate(), which loads parties from disk: a playing party with one stored member.
      resetPartiesForTest(
        openParty(freshParties(), {
          guildId: "G1",
          channelId: "C1",
          hostId: "user-1",
          members: ["user-1"],
          queue: [{ uri: "spotify:track:one", name: "One", artist: "Band", durationMs: 180_000 }],
          index: 0,
          trackStartedAt: Date.now(),
        }),
      );
      const tick = (plugin.ticks ?? []).find((t) => t.name === "party-sweep")!;

      // Control: a sweep that is not aborted does reach for a token, through the stubbed fetch.
      await tick.run(new AbortController().signal);
      expect(fetchCalls).toBeGreaterThan(0);

      fetchCalls = 0;
      await tick.run(AbortSignal.abort());

      expect(fetchCalls).toBe(0);
      expect(infos.some((m) => m.includes("party sweep aborted by the host"))).toBe(true);
      await plugin.dispose?.();
    } finally {
      globalThis.fetch = stubbed;
      restoreFetch();
      resetPartiesForTest(freshParties());
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a party survives a restart (#195)", () => {
  test("a party in parties.json is loaded and re-armed by the first sweep", async () => {
    const dir = await mkdtemp(join(tmpdir(), "music-restart-"));
    const realFetch = globalThis.fetch;
    // A party that was already playing when the bot went down: track one, started a minute ago, one
    // connected member. Written BEFORE the plugin exists, so only a fresh activation can find it.
    const startedAt = Date.now() - 60_000;
    await Bun.write(
      join(dir, "parties.json"),
      JSON.stringify({
        parties: {
          G1: {
            guildId: "G1",
            channelId: "C1",
            hostId: "user-1",
            members: ["user-1"],
            queue: [{ uri: "spotify:track:one", name: "One", artist: "Band", durationMs: 180_000 }],
            index: 0,
            trackStartedAt: startedAt,
          },
        },
      }),
    );
    await Bun.write(
      join(dir, "music.json"),
      JSON.stringify({
        connections: { "user-1": { refreshToken: "RT", connectedAt: 1, scopes: PARTY_SCOPES } },
        pending: {},
      }),
    );
    const playbackReads: string[] = [];
    const strays: string[] = [];
    // Installed before createPlugin: the Spotify client takes `fetch` as its default transport then.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://accounts.spotify.com/api/token")) {
        return Response.json({ access_token: "AT", scope: PARTY_SCOPES });
      }
      if (url === "https://api.spotify.com/v1/me/player") {
        playbackReads.push(url);
        // In sync: exactly where the party says the member should be.
        return Response.json({ is_playing: true, progress_ms: Date.now() - startedAt, item: { uri: "spotify:track:one" } });
      }
      strays.push(url);
      return new Response(`unexpected request: ${url}`, { status: 500 });
    }) as unknown as typeof fetch;
    try {
      const infos: string[] = [];
      const host = makeFakeHost({ name: "music",
        env: { ...FULL_ENV, MUSIC_CALLBACK_PORT: undefined },
        dataDir: dir,
        storage: makeRealStorage(),
        log: { info: (m) => infos.push(m), warn() {}, error() {} },
      });
      const plugin = createPlugin(host);
      await plugin.activate?.();
      try {
        const tick = (plugin.ticks ?? []).find((t) => t.name === "party-sweep")!;
        await tick.run(new AbortController().signal);

        // The sweep found the loaded party, had no timer for it, armed one, and checked the member.
        expect(infos).toContain("re-arming party in guild G1");
        expect(playbackReads).toHaveLength(1);
        // In sync, so it resynced nobody: no play, no devices, nothing else was asked of Spotify.
        expect(strays).toEqual([]);

        // A second sweep sees the timer the first one armed.
        await tick.run(new AbortController().signal);
        expect(infos.filter((m) => m === "re-arming party in guild G1")).toHaveLength(1);

        // Disposing the plugin releases the runner's timers: the next sweep finds none and says it
        // would re-arm (the runner then arms nothing, since it was stopped). If `dispose` left the
        // timer in place, this sweep would see it and log nothing.
        await plugin.dispose?.();
        await tick.run(new AbortController().signal);
        expect(infos.filter((m) => m === "re-arming party in guild G1")).toHaveLength(2);
      } finally {
        await plugin.dispose?.();
      }
    } finally {
      globalThis.fetch = realFetch;
      resetPartiesForTest(freshParties());
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Replaces the global `fetch` with a tiny setlist.fm + Spotify. `createPlugin` builds both clients
 * with `fetch` as their default transport, so this is the one seam that lets a test drive the real
 * command handler end to end without a network.
 */
function stubFetch(): () => void {
  const real = globalThis.fetch;
  const raw = {
    id: "abc123",
    eventDate: "08-09-2026",
    url: "https://www.setlist.fm/setlist/band/2026/the-venue-abc123.html",
    artist: { name: "Band" },
    venue: { name: "The Venue", city: { name: "Leeds", country: { name: "United Kingdom" } } },
    sets: { set: [{ song: [{ name: "One" }, { name: "Two" }] }] },
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.setlist.fm/") && url.includes("/search/setlists")) {
      return Response.json({ setlist: [raw] });
    }
    if (url.startsWith("https://api.setlist.fm/")) return Response.json(raw);
    if (url.startsWith("https://accounts.spotify.com/api/token")) return Response.json({ access_token: "AT" });
    if (url.startsWith("https://api.spotify.com/v1/search")) {
      const query = new URL(url).searchParams.get("q") ?? "";
      const items = query.includes("One")
        ? [{ uri: "spotify:track:one", name: "One", artists: [{ name: "Band" }], popularity: 50 }]
        : [];
      return Response.json({ tracks: { items } });
    }
    if (url.startsWith("https://api.spotify.com/v1/me/playlists")) return Response.json({ id: "PL1" });
    if (url.includes("/items")) return Response.json({ snapshot_id: "s" }, { status: 201 });
    return new Response(`unexpected request: ${url}`, { status: 500 });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/**
 * A gate finding (round 2): the per-listener trust-boundary tests in server.test.ts drive
 * `startCallbackServer` directly with an explicitly-injected `TrustedProxy`, which pins that
 * FUNCTION's own wiring but never proves `activate()` actually BUILDS a real proxy from
 * `host.env.TRUSTED_PROXY_HOST` and hands it to that same call -- dropping the 3rd argument in
 * `index.ts` left the whole suite green. This test drives the REAL `createPlugin(...).activate()`
 * unmodified, with a REAL `TrustedProxy` (no fake `lookup` injected) resolving a REAL
 * `TRUSTED_PROXY_HOST=localhost`, so it can only pass if activate()'s own env-to-proxy wiring is
 * intact end to end. `globalThis.fetch` is untouched here (no Spotify/setlist.fm call is ever
 * reached -- every probe below is missing its `state` param, refused before any exchange), so it
 * doesn't need the mock/restore pattern the tests above use.
 */
describe("client-IP trust boundary via activate() (#69 gate finding)", () => {
  test("activate() wires its TRUSTED_PROXY_HOST-based proxy into the real listener -- a tunnel "
    + "peer is keyed by CF-Connecting-IP, not a shared identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "music-activate-trust-"));
    try {
      const port = freePort();
      const host = makeFakeHost({
        name: "music",
        env: { ...FULL_ENV, MUSIC_CALLBACK_PORT: String(port), TRUSTED_PROXY_HOST: "localhost" },
        dataDir: dir,
        storage: makeRealStorage(),
      });
      const plugin = createPlugin(host);
      await plugin.activate?.();
      try {
        // Real fetch, explicitly to 127.0.0.1 (not "localhost") so the peer address Bun's
        // `srv.requestIP` reports resolves against the SAME address `TRUSTED_PROXY_HOST=localhost`
        // resolves to via real DNS (confirmed: `dns.lookup("localhost", {all:true})` returns BOTH
        // ::1 and 127.0.0.1 on this machine) -- through activate()'s own unmodified proxy.
        const getCallback = (cfIp: string) =>
          fetch(`http://127.0.0.1:${port}/spotify/callback`, { headers: { "CF-Connecting-IP": cfIp } });

        // The real, hardcoded 30/min limiter from index.ts's own createRateLimiter call: exhaust
        // ONE identity's budget with 30 requests (each missing `state`, so a clean 400, never
        // touching Spotify), confirm the 31st (same identity) is rate-limited, then confirm a
        // DIFFERENT identity still has its own, untouched budget. This sequence can only hold if
        // activate() actually wired its proxy into the listener, keying by the header per-identity
        // -- with the proxy dropped (the round-2 mutation), every request here shares ONE real-peer
        // budget and the 31st AND 32nd would both 429.
        for (let i = 0; i < 30; i += 1) {
          const res = await getCallback("203.0.113.60");
          expect(res.status).toBe(400); // missing state token -- budget still open
        }
        const exhausted = await getCallback("203.0.113.60");
        expect(exhausted.status).toBe(429);
        const freshIdentity = await getCallback("203.0.113.61");
        expect(freshIdentity.status).toBe(400); // a DIFFERENT header value has its OWN, untouched budget
      } finally {
        await plugin.dispose?.();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Stubs the Spotify token endpoint (and nothing else): records each request's form body and answers
 * `answer`. A request to a loopback URL (the test's own listener) passes through to the real `fetch`,
 * and any other URL answers 500 "unexpected request", so a stray call fails loudly. `createSpotifyClient`
 * binds `fetch` when `createPlugin` builds it, so this must be installed BEFORE `createPlugin`.
 */
function stubTokenExchange(answer: Record<string, unknown>): {
  calls: { url: string; body: URLSearchParams }[];
  restore: () => void;
} {
  const real = globalThis.fetch;
  const calls: { url: string; body: URLSearchParams }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://accounts.spotify.com/api/token")) {
      calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
      return Response.json(answer);
    }
    if (url.startsWith("http://127.0.0.1:")) return real(input, init);
    return new Response(`unexpected request: ${url}`, { status: 500 });
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/** The Discord user the seeded handshake belongs to, and the scopes its connect link asked for. */
const HANDSHAKE_USER = "424242";
const ASKED_SCOPES = "playlist-modify-private";

/**
 * One real activation on a free port with a pending handshake `T` seeded AFTER `activate()` (its
 * `initStore` replaces the in-memory state from the file, so an earlier seed would be lost), and the
 * token endpoint stubbed. `seededAt` is the clock the handshake is minted at.
 */
async function withHandshake(
  tokenAnswer: Record<string, unknown>,
  seededAt: number,
  run: (ctx: {
    callback: (query: string) => Promise<Response>;
    dir: string;
    infos: string[];
    stub: ReturnType<typeof stubTokenExchange>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "music-handshake-"));
  const stub = stubTokenExchange(tokenAnswer);
  try {
    const port = freePort();
    const infos: string[] = [];
    const host = makeFakeHost({ name: "music",
      env: { ...FULL_ENV, MUSIC_CALLBACK_PORT: String(port) },
      dataDir: dir,
      storage: makeRealStorage(),
      log: { info: (m) => infos.push(m), warn() {}, error() {} },
    });
    const plugin = createPlugin(host);
    await plugin.activate?.();
    try {
      await commit(beginPendingAuth(musicState(), "T", HANDSHAKE_USER, seededAt, ASKED_SCOPES));
      // The seed really is there, in memory and in the file, so a later "T is gone" cannot pass
      // for want of it ever having been written.
      expect(Object.keys(musicState().pending)).toContain("T");
      expect(Object.keys((await storeOnDisk(dir)).pending)).toContain("T");
      await run({
        callback: (query) => fetch(`http://127.0.0.1:${port}/spotify/callback?${query}`),
        dir,
        infos,
        stub,
      });
    } finally {
      await plugin.dispose?.();
    }
  } finally {
    stub.restore();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * What `music.json` holds right now, read back from disk. Read with `readFile`, not `Bun.file`: a
 * lingering Bun reader handle can make the next atomic write's rename fail on Windows (see the
 * retry in `packages/testkit`), and the callbacks under test write again straight after.
 */
async function storeOnDisk(dir: string): Promise<MusicState> {
  return JSON.parse(await readFile(join(dir, "music.json"), "utf8")) as MusicState;
}

describe("the connect handshake through activate() (#148)", () => {
  // The closures under test are the ones `activate()` builds for the callback server: `redeemState`
  // (run `redeemPendingAuth`, commit the pruned state whether or not the token was valid) and
  // `saveConnection` (commit `putConnection(..., scopes)`, log the user id). The unit tests pin the
  // pure functions and `handleCallback` over fake deps, and the #190 test above reaches `redeemState`
  // only to see that a failing commit is contained and logged; none of them checks WHAT these
  // closures persist, which scopes the connection carries, or that a replayed link is refused.
  test("a real handshake consumes the token, stores the connection with Spotify's scopes in memory and on disk, and refuses a replay", async () => {
    const granted = "playlist-modify-private user-modify-playback-state";
    await withHandshake(
      { access_token: "AT", refresh_token: "RT1", scope: granted },
      Date.now(),
      async ({ callback, dir, infos, stub }) => {
        // Another user's connection, already stored: the handshake must leave it alone.
        await commit(putConnection(musicState(), "333", "RT-OTHER", 1));
        const bystander = musicState().connections["333"];
        expect(bystander).toBeDefined();

        const startedAt = Date.now();
        const first = await callback("code=C&state=T");
        expect(first.status).toBe(200);
        expect(await first.text()).toContain("Spotify connected");

        // The code went to the token endpoint once, with the registered redirect.
        expect(stub.calls).toHaveLength(1);
        expect(stub.calls[0]?.body.get("grant_type")).toBe("authorization_code");
        expect(stub.calls[0]?.body.get("code")).toBe("C");
        expect(stub.calls[0]?.body.get("redirect_uri")).toBe(FULL_ENV.SPOTIFY_REDIRECT_URI);

        // Spotify's own scope string (not the scopes the link asked for) lands on the connection,
        // and the token is gone, in memory and in the file.
        const stored = musicState().connections[HANDSHAKE_USER];
        expect(stored).toMatchObject({ refreshToken: "RT1", scopes: granted });
        expect(stored?.connectedAt).toBeGreaterThanOrEqual(startedAt);
        expect(Object.keys(musicState().pending)).not.toContain("T");
        const onDisk = await storeOnDisk(dir);
        expect(onDisk.connections[HANDSHAKE_USER]).toEqual(stored);
        expect(Object.keys(onDisk.pending)).not.toContain("T");
        expect(musicState().connections["333"]).toEqual(bystander);
        expect(onDisk.connections["333"]).toEqual(bystander);
        expect(infos).toContain(`connected Spotify for discord user ${HANDSHAKE_USER}`);
        // The user id is logged; the refresh token never is.
        expect(infos.join("\n")).not.toContain("RT1");

        // The same link again: refused, no second exchange, the connection untouched.
        const replay = await callback("code=C2&state=T");
        expect(replay.status).toBe(400);
        const replayBody = await replay.text();
        expect(replayBody).toContain("didn&#39;t work");
        // A token that is simply gone reads as unknown, not as expired.
        expect(replayBody).toContain("isn&#39;t valid any more");
        expect(replayBody).not.toContain("expired");
        expect(stub.calls).toHaveLength(1);
        expect(musicState().connections[HANDSHAKE_USER]).toEqual(stored);
      },
    );
  });

  test("a token response with no scope keeps the scopes the handshake asked for", async () => {
    await withHandshake({ access_token: "AT", refresh_token: "RT1" }, Date.now(), async ({ callback, dir }) => {
      expect((await callback("code=C&state=T")).status).toBe(200);
      expect(musicState().connections[HANDSHAKE_USER]?.scopes).toBe(ASKED_SCOPES);
      expect((await storeOnDisk(dir)).connections[HANDSHAKE_USER]?.scopes).toBe(ASKED_SCOPES);
    });
  });

  test("an expired handshake is refused with the expired text, and is consumed", async () => {
    // Minted far enough back that its ten minutes are already up.
    const seededAt = Date.now() - PENDING_AUTH_TTL_MS - 60_000;
    await withHandshake({ access_token: "AT", refresh_token: "RT1" }, seededAt, async ({ callback, dir, stub }) => {
      // Two bystanders beside the expired `T`: another expired handshake, which redeeming prunes, and
      // a live one, which it must leave alone. (Written straight into the state: `beginPendingAuth`
      // would prune the expired `T` as it went.)
      const now = Date.now();
      await commit({
        ...musicState(),
        pending: {
          ...musicState().pending,
          OLD: { discordUserId: "111", expiresAt: now - 1_000 },
          LIVE: { discordUserId: "222", expiresAt: now + PENDING_AUTH_TTL_MS },
        },
      });

      const response = await callback("code=C&state=T");
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("expired");
      expect(body).not.toContain("isn&#39;t valid any more");

      expect(stub.calls).toHaveLength(0);
      // `T` is consumed and `OLD` is pruned, in memory and in the file; `LIVE` is untouched.
      expect(Object.keys(musicState().pending)).toEqual(["LIVE"]);
      expect(Object.keys((await storeOnDisk(dir)).pending)).toEqual(["LIVE"]);
      expect(musicState().connections[HANDSHAKE_USER]).toBeUndefined();
      expect((await storeOnDisk(dir)).connections[HANDSHAKE_USER]).toBeUndefined();
    });
  });
});
