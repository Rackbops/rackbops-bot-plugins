import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProductionDeps,
  createRateLimiter,
  handleRequest,
  rateLimitKeyFor,
  startWarbandeerServer,
  warbandeerServerRunning,
  type WarbandeerDeps,
} from "./server.js";
import { initCharacters, loadCharacterSnapshotsFrom } from "./characters.js";
import { mintLinkCode, removeLinkedAccount, type LinksState } from "./links.js";
import { makeRealStorage } from "../../../packages/testkit/index.js";
import type { TrustedProxy } from "../../../packages/net/clientIp.js";

describe("createRateLimiter", () => {
  test("allows up to max calls within the window, then rejects", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3, now: () => 0 });
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(false);
  });

  test("resets after the window elapses", () => {
    let t = 0;
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(false);
    t = 1001;
    expect(limiter.allow("k")).toBe(true);
  });

  test("tracks each key independently", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => 0 });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("b")).toBe(false);
  });
});

describe("createRateLimiter expiry sweep", () => {
  test("allow() never sweeps: expired keys stay until sweep() runs, however many there are", () => {
    let t = 0;
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
    for (let i = 0; i < 10_500; i++) limiter.allow(`k${i}`);
    expect(limiter.size()).toBe(10_500);
    t = 1001;
    limiter.allow("fresh"); // used to trigger a full scan past 10,000 keys
    expect(limiter.size()).toBe(10_501);
    limiter.stop?.();
  });

  test("sweep() drops expired keys and keeps live ones", () => {
    let t = 0;
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
    limiter.allow("old");
    t = 600;
    limiter.allow("young");
    t = 1001;
    limiter.sweep();
    expect(limiter.size()).toBe(1);
    expect(limiter.allow("young")).toBe(false); // still counted in its window
    expect(limiter.allow("old")).toBe(true); // swept, so a fresh window
    limiter.stop?.();
  });

  test("the timer sweeps expired keys on its own", async () => {
    const limiter = createRateLimiter({ windowMs: 20, max: 1 });
    for (let i = 0; i < 5; i++) limiter.allow(`k${i}`);
    expect(limiter.size()).toBe(5);
    const deadline = Date.now() + 2000;
    while (limiter.size() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(limiter.size()).toBe(0);
    // The sweep that emptied the map stopped the timer; a later key starts a new one.
    expect(limiter.allow("again")).toBe(true);
    while (limiter.size() > 0 && Date.now() < deadline + 2000) await new Promise((r) => setTimeout(r, 10));
    expect(limiter.size()).toBe(0);
  });

  test("the sweep that empties the map clears the timer, and the next key starts a new one", () => {
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    let started = 0;
    let cleared = 0;
    let tick: (() => void) | undefined;
    globalThis.setInterval = ((fn: () => void) => {
      started += 1;
      tick = fn;
      return { unref() {} };
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {
      cleared += 1;
    }) as typeof clearInterval;
    try {
      let t = 0;
      const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
      limiter.allow("a");
      limiter.allow("b"); // a second key does not start a second timer
      expect(started).toBe(1);
      t = 1001;
      tick?.();
      expect(limiter.size()).toBe(0);
      expect(cleared).toBe(1);
      limiter.allow("c");
      expect(started).toBe(2);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });

  test("startWarbandeerServer's stop() stops both limiters", () => {
    const stopped: string[] = [];
    const spy = (name: string) => ({ allow: () => true, stop: () => void stopped.push(name) });
    const { stop } = startWarbandeerServer(
      0,
      { ...makeDeps(), rateLimiter: spy("rate"), authFailureLimiter: spy("auth") },
      { isTrusted: () => false, refresh: async () => {} },
    );
    stop();
    expect(stopped.sort()).toEqual(["auth", "rate"]);
  });

  test("stop() clears the counters", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => 0 });
    limiter.allow("k");
    limiter.stop?.();
    expect(limiter.size()).toBe(0);
  });
});

describe("rateLimitKeyFor", () => {
  test("IPv4 is keyed by the address; an IPv4-mapped IPv6 address is that IPv4 peer", () => {
    expect(rateLimitKeyFor("203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitKeyFor("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitKeyFor("::FFFF:cb00:7109")).toBe("203.0.113.9");
  });

  test("IPv6 is keyed by its /64, whatever the spelling", () => {
    const key = rateLimitKeyFor("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(rateLimitKeyFor("2001:db8:1:2::1")).toBe(key);
    expect(rateLimitKeyFor("2001:DB8:1:2:0:0:0:ffff")).toBe(key);
    expect(rateLimitKeyFor("2001:db8:1:2:aaaa::")).toBe(key);
    expect(rateLimitKeyFor("2001:db8:1:3::1")).not.toBe(key);
    expect(rateLimitKeyFor("2001:db8:2:2::1")).not.toBe(key);
    expect(rateLimitKeyFor("2001:db8::1")).toBe(rateLimitKeyFor("2001:db8:0:0:9::2"));
    expect(rateLimitKeyFor("2001:db9::1")).not.toBe(rateLimitKeyFor("2001:db8::1"));
  });

  test("a zone id and an embedded IPv4 tail do not change the /64", () => {
    expect(rateLimitKeyFor("fe80::1%eth0")).toBe(rateLimitKeyFor("fe80::2"));
    expect(rateLimitKeyFor("64:ff9b::1.2.3.4")).toBe(rateLimitKeyFor("64:ff9b::9"));
  });

  test("a non-IP identity such as \"unknown\" passes through", () => {
    expect(rateLimitKeyFor("unknown")).toBe("unknown");
  });
});

// A permissive default deps object every test overrides pieces of — DI'd handleRequest style, no
// real Bun.serve listener bound.
function makeDeps(overrides: Partial<WarbandeerDeps> = {}): WarbandeerDeps {
  return {
    maxBodyBytes: 1024,
    rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
    authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
    redeemCode: async () => ({ ok: true, token: "device-token" }),
    authenticate: () => ({ discordUserId: "1", accountLabel: "Main" }),
    storeCharacters: async () => ({ ok: true }),
    ...overrides,
  };
}

function req(method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}): Request {
  return new Request(`http://x${path}`, { method, body: opts.body, headers: opts.headers });
}

describe("handleRequest — POST /link", () => {
  test("mints a token on a valid redemption", async () => {
    const res = await handleRequest(
      req("POST", "/link", { body: JSON.stringify({ code: "ABC12345", accountLabel: "Main" }) }),
      "1.2.3.4",
      makeDeps(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "device-token" });
  });

  test("400s when code or accountLabel is missing", async () => {
    const res = await handleRequest(req("POST", "/link", { body: JSON.stringify({ code: "ABC12345" }) }), "1.2.3.4", makeDeps());
    expect(res.status).toBe(400);
  });

  test("413s an oversized /link body without ever calling redeemCode (the cap applies here too)", async () => {
    let redeemed = false;
    const deps = makeDeps({
      maxBodyBytes: 64,
      redeemCode: async () => {
        redeemed = true;
        return { ok: true, token: "t" };
      },
    });
    const res = await handleRequest(req("POST", "/link", { body: JSON.stringify({ code: "ABC12345", accountLabel: "x".repeat(200) }) }), "1.2.3.4", deps);
    expect(res.status).toBe(413);
    expect(redeemed).toBe(false);
  });

  test("surfaces the redeem failure's own message", async () => {
    const deps = makeDeps({ redeemCode: async () => ({ ok: false, error: "code expired" }) });
    const res = await handleRequest(
      req("POST", "/link", { body: JSON.stringify({ code: "ABC12345", accountLabel: "Main" }) }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("code expired");
  });

  test("429s once the per-IP rate limit trips", async () => {
    const deps = makeDeps({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) });
    const body = JSON.stringify({ code: "ABC12345", accountLabel: "Main" });
    const first = await handleRequest(req("POST", "/link", { body }), "1.2.3.4", deps);
    const second = await handleRequest(req("POST", "/link", { body }), "1.2.3.4", deps);
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  test("a different IP gets its own rate-limit bucket", async () => {
    const deps = makeDeps({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) });
    const body = JSON.stringify({ code: "ABC12345", accountLabel: "Main" });
    const first = await handleRequest(req("POST", "/link", { body }), "1.2.3.4", deps);
    const second = await handleRequest(req("POST", "/link", { body }), "5.6.7.8", deps);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  test("400s an accountLabel over the length cap", async () => {
    const res = await handleRequest(
      req("POST", "/link", { body: JSON.stringify({ code: "ABC12345", accountLabel: "x".repeat(65) }) }),
      "1.2.3.4",
      makeDeps(),
    );
    expect(res.status).toBe(400);
  });

  test("400s an empty accountLabel", async () => {
    const res = await handleRequest(
      req("POST", "/link", { body: JSON.stringify({ code: "ABC12345", accountLabel: "   " }) }),
      "1.2.3.4",
      makeDeps(),
    );
    expect(res.status).toBe(400);
  });

  test("normalizes the submitted code (trims whitespace, uppercases) before redeeming", async () => {
    let receivedCode: string | undefined;
    const deps = makeDeps({
      redeemCode: async (code) => {
        receivedCode = code;
        return { ok: true, token: "t" };
      },
    });
    await handleRequest(
      req("POST", "/link", { body: JSON.stringify({ code: "  abc12345  ", accountLabel: "Main" }) }),
      "1.2.3.4",
      deps,
    );
    expect(receivedCode).toBe("ABC12345");
  });
});

describe("handleRequest — IPv6 rate-limit keys", () => {
  test("/link: addresses in one /64 share a budget; another /64 has its own", async () => {
    const deps = makeDeps({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) });
    const post = (ip: string) => handleRequest(req("POST", "/link", { body: "{}" }), ip, deps);
    expect((await post("2001:db8:1:2::1")).status).toBe(400);
    expect((await post("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).status).toBe(429);
    expect((await post("2001:db8:1:3::1")).status).toBe(400);
  });

  test("/characters failed-auth limiter is keyed by /64 too", async () => {
    const deps = makeDeps({
      authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }),
      authenticate: () => undefined,
    });
    const post = (ip: string) =>
      handleRequest(req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer x" } }), ip, deps);
    expect((await post("2001:db8:1:2::1")).status).toBe(401);
    expect((await post("2001:db8:1:2::2")).status).toBe(429);
    expect((await post("2001:db8:1:3::1")).status).toBe(401);
  });
});

describe("handleRequest — POST /characters", () => {
  test("204s on a successful authenticated push", async () => {
    const res = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer real-token" } }),
      "1.2.3.4",
      makeDeps(),
    );
    expect(res.status).toBe(204);
  });

  test("401s when storeCharacters reports the account was unlinked meanwhile", async () => {
    const deps = makeDeps({ storeCharacters: async () => ({ ok: false, error: "unauthorized", status: 401 }) });
    const res = await handleRequest(req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer real-token" } }), "1.2.3.4", deps);
    expect(res.status).toBe(401);
  });

  test("401s with no Authorization header", async () => {
    const res = await handleRequest(req("POST", "/characters", { body: "{}" }), "1.2.3.4", makeDeps());
    expect(res.status).toBe(401);
  });

  test("401s on a garbage Authorization header (not Bearer-shaped)", async () => {
    const res = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "garbage" } }),
      "1.2.3.4",
      makeDeps(),
    );
    expect(res.status).toBe(401);
  });

  test("401s on a well-formed but unknown token", async () => {
    const deps = makeDeps({ authenticate: () => undefined });
    const res = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer nope" } }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(401);
  });

  test("413s an oversized body (streamed check) without ever calling storeCharacters", async () => {
    let called = false;
    const deps = makeDeps({
      maxBodyBytes: 10,
      storeCharacters: async () => {
        called = true;
        return { ok: true };
      },
    });
    const res = await handleRequest(
      req("POST", "/characters", { body: "x".repeat(1000), headers: { Authorization: "Bearer real-token" } }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(413);
    expect(called).toBe(false);
  });

  test("413s on a declared-oversized Content-Length before the body is ever read", async () => {
    let called = false;
    const deps = makeDeps({
      maxBodyBytes: 10,
      storeCharacters: async () => {
        called = true;
        return { ok: true };
      },
    });
    const res = await handleRequest(
      req("POST", "/characters", {
        body: "{}",
        headers: { Authorization: "Bearer real-token", "Content-Length": "999999" },
      }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(413);
    expect(called).toBe(false);
  });

  test("400s invalid JSON", async () => {
    const res = await handleRequest(
      req("POST", "/characters", { body: "{not json", headers: { Authorization: "Bearer real-token" } }),
      "1.2.3.4",
      makeDeps(),
    );
    expect(res.status).toBe(400);
  });

  test("surfaces a validation failure from storeCharacters as 400", async () => {
    const deps = makeDeps({ storeCharacters: async () => ({ ok: false, error: "characters must be an array" }) });
    const res = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer real-token" } }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("characters must be an array");
  });

  test("429s once the per-token rate limit trips, keyed by TOKEN not IP", async () => {
    const deps = makeDeps({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) });
    const first = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer real-token" } }),
      "1.2.3.4",
      deps,
    );
    const second = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer real-token" } }),
      "5.6.7.8",
      deps,
    );
    expect(first.status).toBe(204);
    expect(second.status).toBe(429);
  });

  test("a request from a different token gets its own rate-limit bucket", async () => {
    const deps = makeDeps({
      rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }),
      authenticate: (token) => ({ discordUserId: token, accountLabel: "Main" }),
    });
    const first = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer token-a" } }),
      "1.2.3.4",
      deps,
    );
    const second = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer token-b" } }),
      "5.6.7.8",
      deps,
    );
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });

  test("an unauthenticated flood from one IP is rate-limited (on the separate authFailureLimiter) before authenticate is even called", async () => {
    let authCalls = 0;
    const deps = makeDeps({
      authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }),
      authenticate: () => {
        authCalls += 1;
        return undefined;
      },
    });
    const first = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer nope" } }),
      "9.9.9.9",
      deps,
    );
    const second = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer nope" } }),
      "9.9.9.9",
      deps,
    );
    expect(first.status).toBe(401);
    expect(second.status).toBe(429); // the SECOND request never even reaches authenticate
    expect(authCalls).toBe(1);
  });

  test("the unauthenticated-IP rate limit is independent per IP", async () => {
    const deps = makeDeps({
      authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }),
      authenticate: () => undefined,
    });
    const first = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer nope" } }),
      "1.1.1.1",
      deps,
    );
    const second = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer nope" } }),
      "2.2.2.2",
      deps,
    );
    expect(first.status).toBe(401);
    expect(second.status).toBe(401); // not 429 — a different IP, its own bucket
  });

  test("the pre-auth IP bucket is charged on every request, success or failure (known tradeoff)", async () => {
    const deps = makeDeps({ authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) });
    const success = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer real-token" } }),
      "1.2.3.4",
      deps,
    );
    const next = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer real-token" } }),
      "1.2.3.4",
      deps,
    );
    expect(success.status).toBe(204);
    expect(next.status).toBe(429); // the successful request above already spent the one slot
  });
});

describe("handleRequest — unknown routes", () => {
  test("404s anything else", async () => {
    const res = await handleRequest(req("GET", "/"), "1.2.3.4", makeDeps());
    expect(res.status).toBe(404);
  });
});

/**
 * Exercises the REAL auth + persistence wiring end to end — every other suite above injects a fake
 * `WarbandeerDeps`. Uses `createProductionDeps`'s `overrides` (a fresh in-memory `LinksState`, a
 * no-op `persistLinks`, and a temp `charactersBaseDir` per test) so this never touches the real
 * `data/links.json`/`data/characters/`. `initCharacters` wires the injected real storage so the
 * character persistence inside `createProductionDeps` runs for real against the temp dir.
 */
describe("createProductionDeps — real auth + persistence wiring", () => {
  let localLinksState: LinksState;
  let charactersDir: string;

  beforeEach(() => {
    localLinksState = { pending: [], accounts: {} };
    charactersDir = mkdtempSync(join(tmpdir(), "warbandeer-server-realwiring-test-"));
    initCharacters(charactersDir, makeRealStorage());
  });
  afterEach(() => {
    rmSync(charactersDir, { recursive: true, force: true });
  });

  function realDeps(): WarbandeerDeps {
    return createProductionDeps({
      linksState: localLinksState,
      persistLinks: async () => {},
      charactersBaseDir: charactersDir,
    });
  }

  let nextId = 100000000000000000n;
  function freshId(): string {
    nextId += 1n;
    return nextId.toString();
  }

  /** Mints+redeems a code the way `/link` really does, against the local throwaway state. */
  async function linkRealAccount(deps: WarbandeerDeps, discordUserId: string, accountLabel: string): Promise<string> {
    const { code, state } = mintLinkCode(localLinksState, discordUserId, Date.now());
    localLinksState.pending = state.pending;
    localLinksState.accounts = state.accounts;
    const res = await handleRequest(
      req("POST", "/link", { body: JSON.stringify({ code, accountLabel }) }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  test("mint -> POST /link -> POST /characters resolves and stores under the RIGHT account", async () => {
    const discordUserId = freshId();
    const deps = realDeps();
    const token = await linkRealAccount(deps, discordUserId, "Main");

    const pushRes = await handleRequest(
      req("POST", "/characters", {
        body: JSON.stringify({ characters: [{ realm: "Test" }] }),
        headers: { Authorization: `Bearer ${token}` },
      }),
      "1.2.3.4",
      deps,
    );
    expect(pushRes.status).toBe(204);

    const stored = await loadCharacterSnapshotsFrom(charactersDir, discordUserId);
    expect(stored.snapshots).toHaveLength(1);
    expect(stored.snapshots[0]?.accountLabel).toBe("Main");
    expect(stored.snapshots[0]?.characters).toEqual([{ realm: "Test" }]);
  });

  test("a user's token can never write into a DIFFERENT user's file", async () => {
    const userA = freshId();
    const userB = freshId();
    const deps = realDeps();
    const tokenA = await linkRealAccount(deps, userA, "Main");
    await linkRealAccount(deps, userB, "Main");

    const pushAsA = await handleRequest(
      req("POST", "/characters", {
        body: JSON.stringify({ characters: [{ tag: "belongs-to-A" }] }),
        headers: { Authorization: `Bearer ${tokenA}` },
      }),
      "1.2.3.4",
      deps,
    );
    expect(pushAsA.status).toBe(204);

    const [storedA, storedB] = await Promise.all([
      loadCharacterSnapshotsFrom(charactersDir, userA),
      loadCharacterSnapshotsFrom(charactersDir, userB),
    ]);
    expect(storedA.snapshots).toHaveLength(1);
    expect(storedB.snapshots).toHaveLength(0);
  });

  test("unlink actually revokes — a later push with the old token 401s", async () => {
    const discordUserId = freshId();
    const deps = realDeps();
    const token = await linkRealAccount(deps, discordUserId, "Main");

    const removal = removeLinkedAccount(localLinksState, discordUserId, "Main");
    expect(removal).toBeDefined();
    if (removal) localLinksState.accounts = removal.state.accounts;

    const pushRes = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: `Bearer ${token}` } }),
      "1.2.3.4",
      deps,
    );
    expect(pushRes.status).toBe(401);
  });

  test("a push authenticated before an /unlink writes nothing once the account is gone, and answers unauthorized", async () => {
    const discordUserId = freshId();
    const deps = realDeps();
    const token = await linkRealAccount(deps, discordUserId, "Main");
    const owner = deps.authenticate(token);
    expect(owner).toEqual({ discordUserId, accountLabel: "Main" }); // authenticated, body still to come

    const removal = removeLinkedAccount(localLinksState, discordUserId, "Main");
    if (removal) localLinksState.accounts = removal.state.accounts; // the /unlink lands while the body streams in

    const result = await deps.storeCharacters(discordUserId, "Main", { characters: [{ tag: "late" }] });
    expect(result).toEqual({ ok: false, error: "unauthorized", status: 401 }); // mutation: no re-check writes the snapshot back
    expect((await loadCharacterSnapshotsFrom(charactersDir, discordUserId)).snapshots).toEqual([]);
  });

  test("over handleRequest: a push whose body is still arriving when the /unlink lands answers 401 and writes nothing", async () => {
    const discordUserId = freshId();
    const deps = realDeps();
    const token = await linkRealAccount(deps, discordUserId, "Main");
    const payload = new TextEncoder().encode(JSON.stringify({ characters: [{ tag: "late" }] }));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Authentication already happened; the unlink lands before the last byte.
        const removal = removeLinkedAccount(localLinksState, discordUserId, "Main");
        if (removal) localLinksState.accounts = removal.state.accounts;
        controller.enqueue(payload);
        controller.close();
      },
    });
    const res = await handleRequest(
      new Request("http://x/characters", { method: "POST", body, headers: { Authorization: `Bearer ${token}` }, duplex: "half" } as RequestInit),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(401);
    expect((await loadCharacterSnapshotsFrom(charactersDir, discordUserId)).snapshots).toEqual([]);
  });

  test("a rejected push with a newline in an object key answers 400 with the key escaped, on one line", async () => {
    const deps = realDeps();
    const token = await linkRealAccount(deps, freshId(), "Main");
    const res = await handleRequest(
      req("POST", "/characters", {
        body: JSON.stringify({ characters: [{ "a\nb": "x".repeat(300) }] }),
        headers: { Authorization: `Bearer ${token}` },
      }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("\n");
    expect(text).toContain('"a\\nb"');
  });

  test("redeeming through the production deps names why: expired vs unknown code", async () => {
    const deps = realDeps();
    const userId = freshId();
    const { code, state } = mintLinkCode(localLinksState, userId, Date.now() - 11 * 60 * 1000);
    localLinksState.pending = state.pending;
    const expired = await handleRequest(req("POST", "/link", { body: JSON.stringify({ code, accountLabel: "Main" }) }), "1.2.3.4", deps);
    expect(expired.status).toBe(400);
    expect(await expired.text()).toBe("code expired");
    const unknown = await handleRequest(req("POST", "/link", { body: JSON.stringify({ code: "NOSUCHCODE", accountLabel: "Main" }) }), "1.2.3.4", deps);
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toBe("unknown code");
  });

  test("a not-found redemption does not rewrite links.json; an expired one (a burned code) does", async () => {
    let persisted = 0;
    const deps = createProductionDeps({
      linksState: localLinksState,
      persistLinks: async () => {
        persisted += 1;
      },
      charactersBaseDir: charactersDir,
    });
    const link = (code: string) =>
      handleRequest(req("POST", "/link", { body: JSON.stringify({ code, accountLabel: "Main" }) }), "1.2.3.4", deps);

    expect((await link("NOSUCHCODE")).status).toBe(400);
    expect(persisted).toBe(0);

    const { code, state } = mintLinkCode(localLinksState, freshId(), Date.now() - 11 * 60 * 1000);
    localLinksState.pending = state.pending;
    expect(await (await link(code)).text()).toBe("code expired");
    expect(persisted).toBe(1);
    expect(localLinksState.pending).toHaveLength(0); // the burn is what the write records

    const fresh = mintLinkCode(localLinksState, freshId(), Date.now());
    localLinksState.pending = fresh.state.pending;
    expect((await link(fresh.code)).status).toBe(200);
    expect(persisted).toBe(2);
  });

  test("concurrent pushes for the same user's two linked accounts both land — end-to-end regression for the storage fix", async () => {
    const discordUserId = freshId();
    const deps = realDeps();
    const tokenMain = await linkRealAccount(deps, discordUserId, "Main");
    const tokenAlts = await linkRealAccount(deps, discordUserId, "Alts");

    const [resMain, resAlts] = await Promise.all([
      handleRequest(
        req("POST", "/characters", {
          body: JSON.stringify({ characters: [{ tag: "main" }] }),
          headers: { Authorization: `Bearer ${tokenMain}` },
        }),
        "1.2.3.4",
        deps,
      ),
      handleRequest(
        req("POST", "/characters", {
          body: JSON.stringify({ characters: [{ tag: "alts" }] }),
          headers: { Authorization: `Bearer ${tokenAlts}` },
        }),
        "1.2.3.4",
        deps,
      ),
    ]);
    expect(resMain.status).toBe(204);
    expect(resAlts.status).toBe(204);

    const stored = await loadCharacterSnapshotsFrom(charactersDir, discordUserId);
    expect(stored.snapshots.map((s) => s.accountLabel).sort()).toEqual(["Alts", "Main"]);
  });

  test("a 21st linked account is rejected once MAX_LINKED_ACCOUNTS_PER_USER is reached", async () => {
    const discordUserId = freshId();
    const deps = realDeps();
    for (let i = 0; i < 20; i++) {
      await linkRealAccount(deps, discordUserId, `Label${i}`);
    }
    const { code, state } = mintLinkCode(localLinksState, discordUserId, Date.now());
    localLinksState.pending = state.pending;
    localLinksState.accounts = state.accounts;
    const res = await handleRequest(
      req("POST", "/link", { body: JSON.stringify({ code, accountLabel: "OneTooMany" }) }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(400);
    expect(localLinksState.accounts[discordUserId]).toHaveLength(20);
  });

  test("re-linking an EXISTING label at the cap still works (rotate, not append)", async () => {
    const discordUserId = freshId();
    const deps = realDeps();
    for (let i = 0; i < 20; i++) {
      await linkRealAccount(deps, discordUserId, `Label${i}`);
    }
    const newToken = await linkRealAccount(deps, discordUserId, "Label0");
    expect(localLinksState.accounts[discordUserId]).toHaveLength(20);
    const owner = deps.authenticate(newToken);
    expect(owner?.accountLabel).toBe("Label0");
  });
});

/**
 * Exercises the real `Bun.serve` wiring `startWarbandeerServer` sets up — a real listening socket
 * (port 0 = OS-assigned free port), real `fetch()` calls, real header/IP resolution. Fake
 * `WarbandeerDeps` throughout, so this never touches `links.json`/`data/characters/`.
 */
describe("startWarbandeerServer — real listener", () => {
  test("serves real HTTP requests end to end and tracks running state", async () => {
    const deps: WarbandeerDeps = {
      maxBodyBytes: 1024,
      rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      redeemCode: async () => ({ ok: true, token: "device-token" }),
      authenticate: () => undefined,
      storeCharacters: async () => ({ ok: true }),
    };
    expect(warbandeerServerRunning()).toBe(false);
    const { stop, port } = startWarbandeerServer(0, deps); // 0 = OS-assigned free port
    try {
      expect(warbandeerServerRunning()).toBe(true);
      expect(port).toBeGreaterThan(0);

      const notFound = await fetch(`http://localhost:${port}/nope`);
      expect(notFound.status).toBe(404);

      const linked = await fetch(`http://localhost:${port}/link`, {
        method: "POST",
        body: JSON.stringify({ code: "ABC12345", accountLabel: "Main" }),
      });
      expect(linked.status).toBe(200);
      expect(await linked.json()).toEqual({ token: "device-token" });
    } finally {
      stop();
      expect(warbandeerServerRunning()).toBe(false);
    }
  });

  test("an oversized body over REAL HTTP gets a clean 413, not a dropped connection", async () => {
    const deps: WarbandeerDeps = {
      maxBodyBytes: 1024,
      rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      redeemCode: async () => ({ ok: true, token: "t" }),
      authenticate: () => ({ discordUserId: "1", accountLabel: "Main" }),
      storeCharacters: async () => ({ ok: true }),
    };
    const { stop, port } = startWarbandeerServer(0, deps);
    try {
      const res = await fetch(`http://localhost:${port}/characters`, {
        method: "POST",
        headers: { Authorization: "Bearer t" },
        // Over deps.maxBodyBytes (1024), well under maxRequestBodySize (deps.maxBodyBytes * 4 = 4096).
        body: "x".repeat(2048),
      });
      expect(res.status).toBe(413);
    } finally {
      stop();
    }
  });

  test("maxRequestBodySize is derived from deps.maxBodyBytes, not a fixed constant", async () => {
    const bigCap = 3 * 1024 * 1024; // 3 MiB — bigger than DEFAULT_MAX_BODY_BYTES * 4 (2 MiB)
    const deps: WarbandeerDeps = {
      maxBodyBytes: bigCap,
      rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      redeemCode: async () => ({ ok: true, token: "t" }),
      authenticate: () => ({ discordUserId: "1", accountLabel: "Main" }),
      storeCharacters: async () => ({ ok: true }),
    };
    const { stop, port } = startWarbandeerServer(0, deps);
    try {
      const targetBytes = 2.5 * 1024 * 1024; // between the old 2 MiB backstop and bigCap (3 MiB)
      const body = JSON.stringify({ pad: "x".repeat(targetBytes - 10) });
      const res = await fetch(`http://localhost:${port}/characters`, {
        method: "POST",
        headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(204);
    } finally {
      stop();
    }
  });

  test("a second listener sees the running flag through both starts", async () => {
    const deps: WarbandeerDeps = {
      maxBodyBytes: 1024,
      rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      redeemCode: async () => ({ ok: true, token: "t" }),
      authenticate: () => undefined,
      storeCharacters: async () => ({ ok: true }),
    };
    const first = startWarbandeerServer(0, deps);
    first.stop();
    expect(warbandeerServerRunning()).toBe(false);
    const second = startWarbandeerServer(0, deps);
    expect(warbandeerServerRunning()).toBe(true);
    second.stop();
    expect(warbandeerServerRunning()).toBe(false);
  });
});

/**
 * Exercises `startWarbandeerServer`'s own `proxy` wiring (#69) over a REAL listener: real
 * `Bun.serve`, real `fetch()`, so the peer address `clientIpFrom` sees is whatever this test
 * process's own loopback connection actually is -- never asserted directly, since it can be
 * "127.0.0.1" or "::1" depending on the host. Instead, two fixed fake `TrustedProxy`s (never trust
 * / always trust) isolate the ONE thing that matters: whether `CF-Connecting-IP` gets honored.
 */
describe("client-IP trust boundary (#69)", () => {
  const TRUST_NONE: TrustedProxy = { isTrusted: () => false, refresh: async () => {} };
  const TRUST_ALL: TrustedProxy = { isTrusted: () => true, refresh: async () => {} };

  function depsWithBudget(max: number): WarbandeerDeps {
    return {
      maxBodyBytes: 1024,
      rateLimiter: createRateLimiter({ windowMs: 60_000, max }),
      authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      redeemCode: async () => ({ ok: true, token: "t" }),
      authenticate: () => undefined,
      storeCharacters: async () => ({ ok: true }),
    };
  }

  /** An empty POST /link: 400 once the rate limiter allows it through ("code and accountLabel are
   *  required"), 429 once the identity's budget (keyed however clientIpFrom resolves it) is spent. */
  async function postLink(port: number, cfConnectingIp: string): Promise<number> {
    const res = await fetch(`http://localhost:${port}/link`, {
      method: "POST",
      headers: { "CF-Connecting-IP": cfConnectingIp },
    });
    return res.status;
  }

  test("a non-tunnel peer setting a fresh CF-Connecting-IP per request shares ONE 30/min budget", async () => {
    const { stop, port } = startWarbandeerServer(0, depsWithBudget(2), TRUST_NONE);
    try {
      // TRUST_NONE means the header is never honored regardless of value, so all three requests
      // below -- despite three DIFFERENT claimed CF-Connecting-IP values -- are keyed by the ONE
      // real peer address this test's own fetch() connects from.
      expect(await postLink(port, "203.0.113.1")).toBe(400); // 1st, budget 1/2
      expect(await postLink(port, "203.0.113.2")).toBe(400); // 2nd, budget 2/2 -- a fresh header still didn't help
      expect(await postLink(port, "203.0.113.3")).toBe(429); // 3rd -- budget exhausted
    } finally {
      stop();
    }
  });

  test("a tunnel peer is keyed by the header", async () => {
    const { stop, port } = startWarbandeerServer(0, depsWithBudget(1), TRUST_ALL);
    try {
      // TRUST_ALL means this test's real peer is always the trusted tunnel, so each request's OWN
      // CF-Connecting-IP value becomes its identity -- two DIFFERENT values get two independent
      // budgets; reusing one exhausts that one specifically, not some shared fallback.
      expect(await postLink(port, "203.0.113.10")).toBe(400); // fresh identity, budget 1/1
      expect(await postLink(port, "203.0.113.11")).toBe(400); // a DIFFERENT identity, its own fresh budget
      expect(await postLink(port, "203.0.113.10")).toBe(429); // back to the first identity -- spent
    } finally {
      stop();
    }
  });
});
