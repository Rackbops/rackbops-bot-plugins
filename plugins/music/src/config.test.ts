import { describe, expect, test } from "bun:test";
import { resolveConfig } from "./config.js";
import pkg from "../package.json" with { type: "json" };

const FULL = {
  SETLISTFM_API_KEY: "sk",
  SPOTIFY_CLIENT_ID: "cid",
  SPOTIFY_CLIENT_SECRET: "csecret",
  SPOTIFY_REDIRECT_URI: "https://bot.example.com/spotify/callback",
  MUSIC_CALLBACK_PORT: "8787",
};

describe("resolveConfig", () => {
  test("a complete env resolves every part and reports nothing missing", () => {
    const config = resolveConfig(FULL);
    expect(config.setlistFmKey).toBe("sk");
    expect(config.callbackPort).toBe(8787);
    expect(config.spotify).toEqual({
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "https://bot.example.com/spotify/callback",
      callbackPath: "/spotify/callback",
    });
    expect(config.missing).toEqual([]);
  });

  test("an empty env is the ordinary unconfigured case, not a throw", () => {
    const config = resolveConfig({});
    expect(config.spotify).toBeUndefined();
    expect(config.setlistFmKey).toBeUndefined();
    expect(config.missing).toEqual([
      "SETLISTFM_API_KEY",
      "SPOTIFY_CLIENT_ID",
      "SPOTIFY_CLIENT_SECRET",
      "SPOTIFY_REDIRECT_URI",
      "MUSIC_CALLBACK_PORT",
    ]);
  });

  test("a half-filled Spotify triple leaves spotify undefined and names what's left", () => {
    const config = resolveConfig({ ...FULL, SPOTIFY_CLIENT_SECRET: undefined });
    expect(config.spotify).toBeUndefined();
    expect(config.missing).toEqual(["SPOTIFY_CLIENT_SECRET"]);
  });

  test("whitespace-only values count as unset, not as a value", () => {
    expect(resolveConfig({ SETLISTFM_API_KEY: "   " }).setlistFmKey).toBeUndefined();
  });

  test("the callback path is taken from the redirect URI, so the two can never disagree", () => {
    const config = resolveConfig({ ...FULL, SPOTIFY_REDIRECT_URI: "https://x.example.com/deep/cb" });
    expect(config.spotify!.callbackPath).toBe("/deep/cb");
  });

  test("an unparseable redirect URI throws, naming the key", () => {
    expect(() => resolveConfig({ ...FULL, SPOTIFY_REDIRECT_URI: "not a url" })).toThrow(
      /SPOTIFY_REDIRECT_URI must be a valid URL/,
    );
  });

  test("a non-HTTPS redirect throws -- Spotify would reject it at the consent screen anyway", () => {
    expect(() => resolveConfig({ ...FULL, SPOTIFY_REDIRECT_URI: "http://bot.example.com/cb" })).toThrow(
      /must be an https:\/\/ URL/,
    );
  });

  test("a non-numeric or out-of-range port throws, naming the key", () => {
    expect(() => resolveConfig({ ...FULL, MUSIC_CALLBACK_PORT: "no" })).toThrow(/MUSIC_CALLBACK_PORT/);
    expect(() => resolveConfig({ ...FULL, MUSIC_CALLBACK_PORT: "70000" })).toThrow(/MUSIC_CALLBACK_PORT/);
    expect(() => resolveConfig({ ...FULL, MUSIC_CALLBACK_PORT: "0" })).toThrow(/MUSIC_CALLBACK_PORT/);
  });

  test("a canonical redirect URI is stored as given", () => {
    expect(resolveConfig(FULL).spotify!.redirectUri).toBe(FULL.SPOTIFY_REDIRECT_URI);
  });

  test("a non-canonical redirect URI is refused with the form to use", () => {
    // Each of these re-serialises to something else under `new URL`, and the re-serialised form is
    // what `authorizeUrl` and `exchangeCode` send -- so the operator must register (and set) that one.
    expect(() => resolveConfig({ ...FULL, SPOTIFY_REDIRECT_URI: "https://Bot.Example.com/spotify/callback" })).toThrow(
      /use "https:\/\/bot\.example\.com\/spotify\/callback"/,
    );
    expect(() => resolveConfig({ ...FULL, SPOTIFY_REDIRECT_URI: "https://bot.example.com:443/spotify/callback" })).toThrow(
      /use "https:\/\/bot\.example\.com\/spotify\/callback"/,
    );
    expect(() => resolveConfig({ ...FULL, SPOTIFY_REDIRECT_URI: "https://bot.example.com" })).toThrow(
      /use "https:\/\/bot\.example\.com\/"/,
    );
  });

  test("a redirect URI with credentials or a fragment is refused", () => {
    // Username alone, password alone, both: each is its own condition.
    for (const withCredentials of ["https://u@bot.example.com/cb", "https://:p@bot.example.com/cb", "https://u:p@bot.example.com/cb"]) {
      expect(() => resolveConfig({ ...FULL, SPOTIFY_REDIRECT_URI: withCredentials })).toThrow(/credentials or a #fragment/);
    }
    // A fragment, and an EMPTY one: `new URL(...).hash` is "" for `cb#` but `toString()` keeps the `#`,
    // so only a check on the raw text catches it.
    for (const withFragment of ["https://bot.example.com/cb#x", "https://bot.example.com/cb#", "https://bot.example.com/cb?#"]) {
      expect(() => resolveConfig({ ...FULL, SPOTIFY_REDIRECT_URI: withFragment })).toThrow(/credentials or a #fragment/);
    }
  });

  test("the credentials refusal does not echo the value, which can carry a password", () => {
    // The second value is ALSO non-canonical (upper-case host): the credentials check must run before
    // the canonical-form one, whose message echoes the value it refuses.
    for (const withPassword of ["https://u:hunter2@bot.example.com/cb", "https://u:hunter2@Bot.Example.com/cb"]) {
      let message = "";
      try {
        resolveConfig({ ...FULL, SPOTIFY_REDIRECT_URI: withPassword });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("SPOTIFY_REDIRECT_URI");
      expect(message).not.toContain("hunter2");
    }
  });

  test("a port is plain digits or nothing", () => {
    // `Number()` alone accepts all four; the manifest's `format` rejects them.
    for (const bad of ["0x1F90", "1e3", "+80", "8787."]) {
      expect(() => resolveConfig({ ...FULL, MUSIC_CALLBACK_PORT: bad })).toThrow(/MUSIC_CALLBACK_PORT/);
    }
    expect(resolveConfig({ ...FULL, MUSIC_CALLBACK_PORT: "8787" }).callbackPort).toBe(8787);
  });

  test("a valid edge-of-range port is accepted", () => {
    expect(resolveConfig({ MUSIC_CALLBACK_PORT: "65535" }).callbackPort).toBe(65535);
    expect(resolveConfig({ MUSIC_CALLBACK_PORT: "1" }).callbackPort).toBe(1);
  });
});

// The host's settings panel (`ops/bot-ops.sh env-set`) checks a CHANGED value against its manifest
// `format`; the bot itself never does, so an unchanged or hand-edited value reaches `resolveConfig`
// unchecked. These pin the regexes `resolveConfig` is meant to agree with (#189).
describe("the manifest's env formats", () => {
  const formatOf = (key: string): RegExp =>
    new RegExp(pkg.botPlugin.env.find((e) => e.key === key)!.format);

  test("SPOTIFY_REDIRECT_URI matches the canonical form and rejects credentials and fragments", () => {
    const format = formatOf("SPOTIFY_REDIRECT_URI");
    expect(format.test("https://bot.example.com/spotify/callback")).toBe(true);
    expect(format.test("https://bot.example.com:8443/spotify/callback")).toBe(true);
    expect(format.test("https://u@bot.example.com/cb")).toBe(false);
    expect(format.test("https://u:p@bot.example.com/cb")).toBe(false);
    expect(format.test("https://bot.example.com/cb#x")).toBe(false);
  });

  test("MUSIC_CALLBACK_PORT rejects the spellings resolveConfig refuses", () => {
    const format = formatOf("MUSIC_CALLBACK_PORT");
    for (const bad of ["0x1F90", "1e3", "+80", "8787."]) expect(format.test(bad)).toBe(false);
    expect(format.test("8787")).toBe(true);
  });
});
