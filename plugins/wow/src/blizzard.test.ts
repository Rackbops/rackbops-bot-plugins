import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { blizzardGet, blizzardToken, _resetBlizzardToken } from "./blizzard.js";
import { ECHO_LIMIT } from "./clip.js";

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

  test("an OAuth failure carries the status but only a clipped slice of the response body (#200 wow-7)", async () => {
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => new Response("<html>".padEnd(5000, "x"), { status: 503 })) as typeof fetch;
    const err = await blizzardToken().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("Blizzard OAuth failed: 503 <html>");
    expect(msg.length).toBeLessThan("Blizzard OAuth failed: 503 ".length + ECHO_LIMIT + 1); // mutation: dropping clip() passes 5000 chars on
  });

  describe("the cached token", () => {
    const realNow = Date.now;
    let tokenFetches: number;
    beforeEach(() => {
      tokenFetches = 0;
      globalThis.fetch = (async (input: string | URL | Request) => {
        if (String(input).includes("oauth.battle.net/token")) {
          tokenFetches++;
          return new Response(JSON.stringify({ access_token: `t${tokenFetches}`, expires_in: 3600 }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
    });
    afterEach(() => {
      Date.now = realNow;
    });

    test("is reused while it is valid, so a second call does not hit the token endpoint", async () => {
      expect(await blizzardToken()).toBe("t1");
      expect(await blizzardToken()).toBe("t1"); // mutation: dropping the Date.now() < expiresAt check refetches every time
      expect(tokenFetches).toBe(1);
    });

    test("is refreshed a minute before it expires, not after", async () => {
      const start = realNow();
      Date.now = () => start;
      await blizzardToken();
      Date.now = () => start + 3500 * 1000; // 100 s left of 3600: still valid
      expect(await blizzardToken()).toBe("t1");
      Date.now = () => start + 3545 * 1000; // inside the final minute: refresh (mutation: expires_in + 60 keeps the old token)
      expect(await blizzardToken()).toBe("t2");
      expect(tokenFetches).toBe(2);
    });

    test("a failed token request throws with the status and is not cached", async () => {
      globalThis.fetch = (async (_i: string | URL | Request) => new Response("denied", { status: 401 })) as typeof fetch;
      await expect(blizzardToken()).rejects.toThrow("Blizzard OAuth failed: 401 denied");
      globalThis.fetch = (async (_i: string | URL | Request) =>
        new Response(JSON.stringify({ access_token: "ok", expires_in: 3600 }), { status: 200 })) as typeof fetch;
      expect(await blizzardToken()).toBe("ok");
    });
  });
});
