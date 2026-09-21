import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { createPlugin } from "./index.js";
import { recordRun, resetMatchLogForTest, type MatchLogFile } from "./matchlog.js";
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
