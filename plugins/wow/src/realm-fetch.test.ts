import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initWowConfig } from "./config.js";
import { _resetBlizzardToken } from "./blizzard.js";
import { realmExists, realmStatus } from "./realm.js";

const originalFetch = globalThis.fetch;

/** The OAuth token, then `realm` for the connected-realm search. */
function mockSearch(realm: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("oauth.battle.net/token")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    }
    return realm(url);
  }) as typeof fetch;
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  _resetBlizzardToken();
  initWowConfig({ WOW_REGION: "us", WOW_REALM: "argent-dawn", BLIZZARD_CLIENT_ID: "id", BLIZZARD_CLIENT_SECRET: "secret" });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("realmExists", () => {
  test("is true when the search finds the realm, false when it finds none", async () => {
    mockSearch(() => json({ results: [{}] }));
    expect(await realmExists("argent-dawn")).toBe(true);
    mockSearch(() => json({ results: [] }));
    expect(await realmExists("nowhere")).toBe(false);
    mockSearch(() => json({}));
    expect(await realmExists("nowhere")).toBe(false);
  });

  test("fails open: a non-OK answer or a thrown request reads as 'exists', never as a wrong realm name", async () => {
    mockSearch(() => json({}, 500));
    expect(await realmExists("argent-dawn")).toBe(true); // mutation: flipping the fail-open to false
    mockSearch(() => {
      throw new Error("network down");
    });
    expect(await realmExists("argent-dawn")).toBe(true);
  });
});

describe("realmStatus", () => {
  test("returns the status Blizzard reports", async () => {
    mockSearch(() => json({ results: [{ data: { status: { type: "DOWN" } } }] }));
    expect(await realmStatus()).toBe("DOWN");
  });

  test("throws, rather than returning a status, on a non-OK answer or an empty result", async () => {
    mockSearch(() => json({}, 503));
    await expect(realmStatus()).rejects.toThrow("Blizzard realm query failed: 503");
    mockSearch(() => json({ results: [] }));
    await expect(realmStatus()).rejects.toThrow('Realm "argent-dawn" not found in us');
  });
});
