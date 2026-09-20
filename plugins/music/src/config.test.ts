import { describe, expect, test } from "bun:test";
import { resolveConfig } from "./config.js";

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

  test("a valid edge-of-range port is accepted", () => {
    expect(resolveConfig({ MUSIC_CALLBACK_PORT: "65535" }).callbackPort).toBe(65535);
    expect(resolveConfig({ MUSIC_CALLBACK_PORT: "1" }).callbackPort).toBe(1);
  });
});
