import { describe, expect, test } from "bun:test";
import { createRateLimiter, escapeHtml, handleCallback, startCallbackServer, type CallbackDeps } from "./server.js";

const PATH = "/spotify/callback";

function makeDeps(overrides: Partial<CallbackDeps> = {}): CallbackDeps {
  return {
    callbackPath: PATH,
    redeemState: async () => ({ ok: true, discordUserId: "user1" }),
    exchangeCode: async () => ({ ok: true, value: { accessToken: "AT", refreshToken: "RT" } }),
    saveConnection: async () => {},
    rateLimiter: { allow: () => true },
    ...overrides,
  };
}

function get(query: string, path = PATH): Request {
  return new Request(`https://bot.example.com${path}${query}`);
}

describe("handleCallback", () => {
  test("the happy path saves the connection for the Discord user who started the flow", async () => {
    const saved: Array<[string, string]> = [];
    const response = await handleCallback(get("?code=CODE&state=T"), "1.2.3.4", makeDeps({
      saveConnection: async (id, token) => {
        saved.push([id, token]);
      },
    }));
    expect(response.status).toBe(200);
    expect(saved).toEqual([["user1", "RT"]]);
    expect(await response.text()).toContain("Spotify connected");
  });

  test("the code is exchanged exactly once, with the value Spotify sent", async () => {
    const codes: string[] = [];
    await handleCallback(get("?code=THE_CODE&state=T"), "ip", makeDeps({
      exchangeCode: async (code) => {
        codes.push(code);
        return { ok: true, value: { accessToken: "AT", refreshToken: "RT" } };
      },
    }));
    expect(codes).toEqual(["THE_CODE"]);
  });

  test("a request on any other path is a 404, so the server exposes nothing else", async () => {
    const response = await handleCallback(get("?code=C&state=T", "/admin"), "ip", makeDeps());
    expect(response.status).toBe(404);
  });

  test("a POST is refused even on the right path", async () => {
    const request = new Request(`https://bot.example.com${PATH}?code=C&state=T`, { method: "POST" });
    expect((await handleCallback(request, "ip", makeDeps())).status).toBe(404);
  });

  test("a missing state token is refused before anything is exchanged", async () => {
    let exchanged = false;
    const response = await handleCallback(get("?code=C"), "ip", makeDeps({
      exchangeCode: async () => {
        exchanged = true;
        return { ok: true, value: { accessToken: "A", refreshToken: "R" } };
      },
    }));
    expect(response.status).toBe(400);
    expect(exchanged).toBe(false);
  });

  test("an unknown or replayed state is refused and no code is exchanged", async () => {
    let exchanged = false;
    const response = await handleCallback(get("?code=C&state=STALE"), "ip", makeDeps({
      redeemState: async () => ({ ok: false, error: "That connect link isn't valid any more." }),
      exchangeCode: async () => {
        exchanged = true;
        return { ok: true, value: { accessToken: "A", refreshToken: "R" } };
      },
    }));
    expect(response.status).toBe(400);
    expect(exchanged).toBe(false);
    expect(await response.text()).toContain("isn&#39;t valid any more");
  });

  test("a declined consent screen consumes the handshake and says nothing was connected", async () => {
    let redeemed = false;
    let saved = false;
    const response = await handleCallback(get("?error=access_denied&state=T"), "ip", makeDeps({
      redeemState: async () => {
        redeemed = true;
        return { ok: true, discordUserId: "user1" };
      },
      saveConnection: async () => {
        saved = true;
      },
    }));
    expect(response.status).toBe(200);
    expect(redeemed).toBe(true);
    expect(saved).toBe(false);
    expect(await response.text()).toContain("You declined");
  });

  test("a failed token exchange reports Spotify's reason and saves nothing", async () => {
    let saved = false;
    const response = await handleCallback(get("?code=C&state=T"), "ip", makeDeps({
      exchangeCode: async () => ({ ok: false, error: "Spotify returned HTTP 400: invalid_grant" }),
      saveConnection: async () => {
        saved = true;
      },
    }));
    expect(response.status).toBe(502);
    expect(saved).toBe(false);
    expect(await response.text()).toContain("invalid_grant");
  });

  test("the rate limiter rejects before the state token is even looked at", async () => {
    let redeemed = false;
    const response = await handleCallback(get("?code=C&state=T"), "ip", makeDeps({
      rateLimiter: { allow: () => false },
      redeemState: async () => {
        redeemed = true;
        return { ok: true, discordUserId: "u" };
      },
    }));
    expect(response.status).toBe(429);
    expect(redeemed).toBe(false);
  });

  test("a reflected error parameter cannot inject HTML", async () => {
    const response = await handleCallback(
      get(`?state=T&error=${encodeURIComponent('<script>alert("x")</script>')}`),
      "ip",
      makeDeps(),
    );
    const body = await response.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });
});

describe("escapeHtml", () => {
  test("escapes every character that could break out of the page", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  test("escapes the ampersand first, so entities are not double-broken", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("createRateLimiter", () => {
  test("allows up to the cap, then refuses within the window", () => {
    let now = 0;
    const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: () => now });
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(false);
  });

  test("the window resets", () => {
    let now = 0;
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => now });
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(false);
    now = 1001;
    expect(limiter.allow("k")).toBe(true);
  });

  test("keys are independent, so one noisy address can't lock everyone out", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("b")).toBe(true);
  });
});

describe("startCallbackServer", () => {
  test("binds a real port and answers the callback path end to end", async () => {
    const saved: Array<[string, string]> = [];
    const server = startCallbackServer(0, makeDeps({
      saveConnection: async (id, token) => {
        saved.push([id, token]);
      },
    }));
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}${PATH}?code=C&state=T`);
      expect(response.status).toBe(200);
      expect(saved).toEqual([["user1", "RT"]]);
    } finally {
      server.stop();
    }
  });

  test("stop() closes the listener", async () => {
    const server = startCallbackServer(0, makeDeps());
    const { port } = server;
    server.stop();
    await expect(fetch(`http://127.0.0.1:${port}${PATH}?code=C&state=T`)).rejects.toThrow();
  });
});
