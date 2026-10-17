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

  test("the host's signal cancels a Blizzard request that never answers", async () => {
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const controller = new AbortController();
    const pending = blizzardGet("https://us.api.blizzard.com/x", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });

  test("a request without a host signal still carries a timeout signal", async () => {
    let seen: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen = init?.signal;
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    await blizzardGet("https://us.api.blizzard.com/x");
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});
