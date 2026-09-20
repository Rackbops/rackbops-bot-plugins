import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlashCommandBuilder } from "discord.js";
import { createPlugin } from "./index.js";
import { makeFakeHost, makeRealStorage } from "./test-host.js";

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
  SETLIST_CALLBACK_PORT: "8787",
};

describe("createPlugin", () => {
  test("registers exactly the two commands the manifest declares", () => {
    const plugin = createPlugin(makeFakeHost());
    expect((plugin.commands ?? []).map((c) => c.name)).toEqual(["setlist", "spotify"]);
  });

  test("loads with a completely empty env -- enabled is not the same as configured", () => {
    expect(() => createPlugin(makeFakeHost({ env: {} }))).not.toThrow();
    expect((createPlugin(makeFakeHost({ env: {} })).commands ?? []).length).toBe(2);
  });

  test("throws on a SET but invalid value, so the host skips just this plugin", () => {
    expect(() => createPlugin(makeFakeHost({ env: { SETLIST_CALLBACK_PORT: "nope" } }))).toThrow(
      /SETLIST_CALLBACK_PORT/,
    );
    expect(() => createPlugin(makeFakeHost({ env: { SPOTIFY_REDIRECT_URI: "http://insecure/cb" } }))).toThrow(
      /must be an https:\/\/ URL/,
    );
  });

  test("createPlugin performs no I/O -- it must be safe to call before takeOver()", () => {
    // A dataDir that cannot exist: anything touching the filesystem here would throw.
    expect(() => createPlugin(makeFakeHost({ env: FULL_ENV, dataDir: "/nonexistent-dir/deeper" }))).not.toThrow();
  });

  test("/setlist takes url and artist, both optional", () => {
    const plugin = createPlugin(makeFakeHost());
    const setlist = (plugin.commands ?? []).find((c) => c.name === "setlist")!;
    const body = setlist.build(new SlashCommandBuilder().setName("setlist")).toJSON();
    expect(body.description).toBe("Turn a setlist.fm setlist into a Spotify playlist");
    expect(body.options?.map((o) => [o.name, o.required ?? false])).toEqual([
      ["url", false],
      ["artist", false],
    ]);
  });

  test("/spotify offers connect, disconnect and status", () => {
    const plugin = createPlugin(makeFakeHost());
    const spotify = (plugin.commands ?? []).find((c) => c.name === "spotify")!;
    const body = spotify.build(new SlashCommandBuilder().setName("spotify")).toJSON();
    expect(body.options?.map((o) => o.name)).toEqual(["connect", "disconnect", "status"]);
  });

  test("the host's namespaced builder is respected -- the plugin never sets its own name", () => {
    const plugin = createPlugin(makeFakeHost());
    const setlist = (plugin.commands ?? []).find((c) => c.name === "setlist")!;
    const body = setlist.build(new SlashCommandBuilder().setName("prefix-setlist")).toJSON();
    expect(body.name).toBe("prefix-setlist");
  });
});

describe("activate / dispose", () => {
  test("with no callback port configured, no server is started and dispose is a no-op", async () => {
    const dir = await mkdtemp(join(tmpdir(), "setlist-activate-"));
    try {
      const host = makeFakeHost({
        env: { ...FULL_ENV, SETLIST_CALLBACK_PORT: undefined },
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
    const dir = await mkdtemp(join(tmpdir(), "setlist-activate-"));
    try {
      const host = makeFakeHost({
        env: { ...FULL_ENV, SETLIST_CALLBACK_PORT: String(freePort()) },
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
    const dir = await mkdtemp(join(tmpdir(), "setlist-activate-"));
    const errors: string[] = [];
    try {
      // Port 1 is privileged; binding it as a non-root user fails.
      const host = makeFakeHost({
        env: { ...FULL_ENV, SETLIST_CALLBACK_PORT: "1" },
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
    const dir = await mkdtemp(join(tmpdir(), "setlist-activate-"));
    try {
      const host = makeFakeHost({
        env: { ...FULL_ENV, SETLIST_CALLBACK_PORT: undefined },
        dataDir: dir,
        storage: makeRealStorage(),
      });
      const plugin = createPlugin(host);
      await plugin.activate?.();
      const { commit, putConnection, setlistState } = await import("./store.js");
      await commit(putConnection(setlistState(), "u1", "RT", 1));
      expect(await Bun.file(join(dir, "setlist.json")).exists()).toBe(true);
      await plugin.dispose?.();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
