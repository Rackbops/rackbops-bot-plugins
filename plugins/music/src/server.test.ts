import { describe, expect, test } from "bun:test";
import { createRateLimiter, escapeHtml, handleCallback, startCallbackServer, type CallbackDeps } from "./server.js";
import type { TrustedProxy } from "../../../packages/net/clientIp.js";

const PATH = "/spotify/callback";

// `startCallbackServer` takes its `TrustedProxy` explicitly (no default), so every real-listener test
// passes one of these two fixed fakes: never trust `CF-Connecting-IP` / always trust it.
const TRUST_NONE: TrustedProxy = { isTrusted: () => false, refresh: async () => {} };
const TRUST_ALL: TrustedProxy = { isTrusted: () => true, refresh: async () => {} };

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

  describe("a dependency that throws (#190)", () => {
    // The state and the code are the secrets here: neither may reach the log or the page.
    const REQUEST = "?code=SPENT-CODE-9&state=SECRET-STATE-7";

    function logged() {
      const errors: string[] = [];
      return { errors, log: { error: (m: string, e?: unknown) => errors.push(`${m} | ${String(e)}`) } };
    }

    test("a dependency that throws while redeeming the state is answered with a plain page and logged without the token", async () => {
      const { errors, log } = logged();
      const response = await handleCallback(get(REQUEST), "ip", makeDeps({
        log,
        redeemState: async () => {
          throw new Error("disk full");
        },
      }));
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain("Something went wrong");
      expect(body).toContain("/spotify connect");
      expect(body).not.toContain("disk full");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("redeeming the state");
      expect(errors[0]).toContain("disk full");
      for (const entry of errors) {
        expect(entry).not.toContain("SECRET-STATE-7");
        expect(entry).not.toContain("SPENT-CODE-9");
      }
    });

    test("a throw while exchanging the code names that stage", async () => {
      const { errors, log } = logged();
      const response = await handleCallback(get(REQUEST), "ip", makeDeps({
        log,
        exchangeCode: async () => {
          throw new Error("network down");
        },
      }));
      expect(response.status).toBe(500);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("exchanging the code");
    });

    test("a throw while saving the connection names that stage", async () => {
      const { errors, log } = logged();
      const response = await handleCallback(get(REQUEST), "ip", makeDeps({
        log,
        saveConnection: async () => {
          throw new Error("EACCES");
        },
      }));
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("/spotify connect");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("saving the connection");
    });

    test("a dependency that throws is contained even with no logger wired", async () => {
      const response = await handleCallback(get(REQUEST), "ip", makeDeps({
        saveConnection: async () => {
          throw new Error("EACCES");
        },
      }));
      expect(response.status).toBe(500);
    });
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
    }), TRUST_NONE);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}${PATH}?code=C&state=T`);
      expect(response.status).toBe(200);
      expect(saved).toEqual([["user1", "RT"]]);
    } finally {
      server.stop();
    }
  });

  test("stop() closes the listener", async () => {
    const server = startCallbackServer(0, makeDeps(), TRUST_NONE);
    const { port } = server;
    server.stop();
    await expect(fetch(`http://127.0.0.1:${port}${PATH}?code=C&state=T`)).rejects.toThrow();
  });

  test("an error outside the handler's own catch becomes the plain page, not Bun's (#190)", async () => {
    const errors: string[] = [];
    const server = startCallbackServer(0, makeDeps({
      // The limiter runs before handleCallback's try, so this rejection can only be caught by the
      // server's own `error` handler.
      rateLimiter: {
        allow: () => {
          throw new Error("limiter exploded");
        },
      },
      log: { error: (m, e) => errors.push(`${m} | ${String(e)}`) },
    }), TRUST_NONE);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}${PATH}?code=C&state=T`);
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain("Something went wrong");
      expect(body).toContain("/spotify connect");
      expect(body).not.toContain("limiter exploded");
      expect(body).not.toContain("server.ts");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("callback server error");
    } finally {
      server.stop();
    }
  });

  test("the trusted proxy is a required argument (#189)", () => {
    // Checked by `bun run check`, not at run time: if `proxy` ever grew a default again, the
    // directive below would be an unused `@ts-expect-error` and the typecheck would fail. The
    // function is never called, so no listener starts.
    const never = () => {
      // @ts-expect-error -- startCallbackServer takes its TrustedProxy explicitly
      startCallbackServer(0, makeDeps());
    };
    expect(typeof never).toBe("function");
  });

  test("the server's own error handler also answers when no logger is wired (#190)", async () => {
    const server = startCallbackServer(0, makeDeps({
      rateLimiter: {
        allow: () => {
          throw new Error("limiter exploded");
        },
      },
    }), TRUST_NONE);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}${PATH}?code=C&state=T`);
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("Something went wrong");
    } finally {
      server.stop();
    }
  });
});

/**
 * Exercises `startCallbackServer`'s own `proxy` wiring (#69) over a REAL listener, mirroring
 * warbandeer's own trust-boundary tests: two fixed fake `TrustedProxy`s (never trust / always
 * trust) isolate whether `CF-Connecting-IP` gets honored, without depending on this test
 * process's own loopback peer address (which can be "127.0.0.1" or "::1" depending on the host).
 */
describe("client-IP trust boundary (#69)", () => {
  function depsWithBudget(max: number): CallbackDeps {
    return makeDeps({ rateLimiter: createRateLimiter({ windowMs: 60_000, max }) });
  }

  /** A bare GET on the real callback path with no `state` param: 400 once the rate limiter allows
   *  it through ("missing its state token"), 429 once the identity's budget is spent. */
  async function getCallback(port: number, cfConnectingIp: string): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}${PATH}`, { headers: { "CF-Connecting-IP": cfConnectingIp } });
    return res.status;
  }

  test("a non-tunnel peer setting a fresh CF-Connecting-IP per request shares ONE 30/min budget", async () => {
    const server = startCallbackServer(0, depsWithBudget(2), TRUST_NONE);
    try {
      // TRUST_NONE means the header is never honored regardless of value, so all three requests
      // below -- despite three DIFFERENT claimed CF-Connecting-IP values -- are keyed by the ONE
      // real peer address this test's own fetch() connects from.
      expect(await getCallback(server.port, "203.0.113.1")).toBe(400); // 1st, budget 1/2
      expect(await getCallback(server.port, "203.0.113.2")).toBe(400); // 2nd, budget 2/2
      expect(await getCallback(server.port, "203.0.113.3")).toBe(429); // 3rd -- budget exhausted
    } finally {
      server.stop();
    }
  });

  test("a tunnel peer is keyed by the header", async () => {
    const server = startCallbackServer(0, depsWithBudget(1), TRUST_ALL);
    try {
      // TRUST_ALL means this test's real peer is always the trusted tunnel, so each request's OWN
      // CF-Connecting-IP value becomes its identity -- two DIFFERENT values get two independent
      // budgets; reusing one exhausts that one specifically, not some shared fallback.
      expect(await getCallback(server.port, "203.0.113.10")).toBe(400); // fresh identity, budget 1/1
      expect(await getCallback(server.port, "203.0.113.11")).toBe(400); // a DIFFERENT identity
      expect(await getCallback(server.port, "203.0.113.10")).toBe(429); // back to the first -- spent
    } finally {
      server.stop();
    }
  });
});
