import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { blizzardGet, _resetBlizzardToken } from "./blizzard.js";

// #18: blizzardGet is now the one place all four Blizzard fetch sites get their auth header from —
// this pins that it actually attaches one, so dropping it fails here rather than only showing up
// as a live 401 against the real API.
describe("blizzardGet", () => {
  const originalFetch = globalThis.fetch;
  let capturedAuth: string | null | undefined;

  beforeEach(() => {
    _resetBlizzardToken();
    capturedAuth = undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth.battle.net/token")) {
        return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), {
          status: 200,
        });
      }
      capturedAuth = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("attaches a bearer token derived from blizzardToken", async () => {
    await blizzardGet("https://us.api.blizzard.com/some/endpoint");
    expect(capturedAuth).toBe("Bearer test-token");
  });
});
