import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFakeDelivery, makeFakeHost, makeRealStorage } from "../../../packages/testkit/index.js";
import type { HostApi, PluginHttpInfo } from "../../../packages/api/contract.js";
import { createRateLimiter, type RateLimiter } from "./auth.js";
import { createDrainLock, createEditQueue, createUnpersistedOutcomes, type DrainLock, type EditQueue, type UnpersistedOutcomes } from "./drain.js";
import { handleMcpHttp, type HttpDeps } from "./http.js";
import { createRegistryStore, type RegistryStore } from "./registry.js";
import type { StoredDelivery } from "./protocol.js";
import { createDeliveryStore, type DeliveryStore } from "./store.js";

const TOKEN = "a".repeat(43);
const CLIENT_IP = "10.0.0.1";
const NOW = 1_700_000_000_000;
const GUILD = "111111111111111111";
const REQUEST_ID = "a".repeat(64);
const USER_ID = "123456789012345678";
const INFO = (path: string): PluginHttpInfo => ({ path, clientIp: CLIENT_IP });

function post(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://bridge.local${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://bridge.local${path}`, { method: "GET", headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const validDeliveryBody = () => ({
  request_id: REQUEST_ID,
  kind: "post",
  target: { guild_id: GUILD, destination: "alerts" },
  body: { content: "hi" },
});

let dir: string;
let store: DeliveryStore;
let registry: RegistryStore;
let limiter: RateLimiter;
let drainLock: DrainLock;
let editQueue: EditQueue;
let unpersisted: UnpersistedOutcomes;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-http-"));
  store = createDeliveryStore(dir, makeRealStorage());
  registry = createRegistryStore(dir, makeRealStorage());
  limiter = createRateLimiter();
  drainLock = createDrainLock();
  editQueue = createEditQueue();
  unpersisted = createUnpersistedOutcomes();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// No default for `token`: a JS default parameter also fires when the caller passes `undefined`
// explicitly, which is exactly the value the "token unset" tests need to get through untouched.
function deps(host: HostApi, token: string | undefined): HttpDeps {
  return { host, store, registry, editQueue, unpersisted, token, limiter, drainLock, now: () => new Date(NOW), log: { info() {}, warn() {}, error() {} } };
}

// Matches auth.test.ts's own makeLog() shape/convention.
function makeLog() {
  const calls: { level: "info" | "warn" | "error"; message: string }[] = [];
  return {
    log: {
      info: (m: string) => calls.push({ level: "info", message: m }),
      warn: (m: string) => calls.push({ level: "warn", message: m }),
      error: (m: string) => calls.push({ level: "error", message: m }),
    },
    calls,
  };
}

describe("handleMcpHttp: token and auth", () => {
  test("an unset token is 503, checked before auth -- even with no Authorization header at all", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(new Request("http://bridge.local/capabilities"), INFO("/capabilities"), deps(host, undefined));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "bridge not configured" });
  });

  test("a wrong token is 401", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(get("/capabilities", { authorization: "Bearer wrong" }), INFO("/capabilities"), deps(host, TOKEN));
    expect(res.status).toBe(401);
  });

  test("more than 10 failures from one clientIp locks out further requests with 429", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const d = deps(host, TOKEN);
    for (let i = 0; i < 11; i++) await handleMcpHttp(get("/capabilities", { authorization: "Bearer wrong" }), INFO("/capabilities"), d);
    const res = await handleMcpHttp(get("/capabilities"), INFO("/capabilities"), d);
    expect(res.status).toBe(429);
  });
});

describe("handleMcpHttp: GET /capabilities", () => {
  test("reports targeted_post/cards/dm/edit true when the host has all four", async () => {
    const host = makeFakeHost({ name: "mcp", ...makeFakeDelivery() });
    const res = await handleMcpHttp(get("/capabilities"), INFO("/capabilities"), deps(host, TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ dm: true, edit: true, targeted_post: true, cards: true });
    expect(body.destinations).toHaveLength(4);
  });

  test("reports targeted_post/cards false when host.post is absent", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(get("/capabilities"), INFO("/capabilities"), deps(host, TOKEN));
    expect(await res.json()).toMatchObject({ targeted_post: false, cards: false });
  });

  test("dm: true only when host.dm exists", async () => {
    const withDm = makeFakeHost({ name: "mcp", ...makeFakeDelivery() });
    expect(await (await handleMcpHttp(get("/capabilities"), INFO("/capabilities"), deps(withDm, TOKEN))).json()).toMatchObject({ dm: true });
    const withoutDm = makeFakeHost({ name: "mcp" });
    expect(await (await handleMcpHttp(get("/capabilities"), INFO("/capabilities"), deps(withoutDm, TOKEN))).json()).toMatchObject({ dm: false });
  });

  test("edit: true only when host.edit exists", async () => {
    const withEdit = makeFakeHost({ name: "mcp", ...makeFakeDelivery() });
    expect(await (await handleMcpHttp(get("/capabilities"), INFO("/capabilities"), deps(withEdit, TOKEN))).json()).toMatchObject({ edit: true });
    const withoutEdit = makeFakeHost({ name: "mcp" });
    expect(await (await handleMcpHttp(get("/capabilities"), INFO("/capabilities"), deps(withoutEdit, TOKEN))).json()).toMatchObject({ edit: false });
  });

  test("a non-GET method on /capabilities is 405", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(post("/capabilities"), INFO("/capabilities"), deps(host, TOKEN));
    expect(res.status).toBe(405);
  });
});

describe("handleMcpHttp: POST /deliveries + GET /deliveries/{id}, the full flow", () => {
  test("a new post delivery: 202 pending immediately, delivered exactly once after the drain settles", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const d = deps(host, TOKEN);

    const created = await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), d);
    expect(created.status).toBe(202);
    const createdBody = (await created.json()) as { state: { state: string }; existing: boolean };
    expect(createdBody.existing).toBe(false);
    expect(createdBody.state.state).toBe("pending");

    await drainLock.settled(REQUEST_ID);

    const fetched = await handleMcpHttp(get(`/deliveries/${REQUEST_ID}`), INFO(`/deliveries/${REQUEST_ID}`), d);
    expect(fetched.status).toBe(200);
    const fetchedBody = (await fetched.json()) as Record<string, unknown>;
    expect(fetchedBody.state).toBe("delivered");
    expect(fetchedBody.message_ref).toBe(REQUEST_ID);
    // The mutation this guards against: draining twice on a new entry.
    expect(delivery.calls.post).toHaveLength(1);
  });

  test("a retry while still pending returns pending, existing: true, with no second drain", async () => {
    let postCalls = 0;
    // A post that never resolves -- the entry stays pending for the whole test.
    const host = makeFakeHost({
      name: "mcp",
      post: () => {
        postCalls += 1;
        return new Promise(() => {});
      },
    });
    const d = deps(host, TOKEN);

    await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), d);
    await flush();
    expect(postCalls).toBe(1);
    const retry = await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), d);
    expect(retry.status).toBe(202);
    const retryBody = (await retry.json()) as { state: { state: string }; existing: boolean };
    expect(retryBody.existing).toBe(true);
    expect(retryBody.state.state).toBe("pending");
    // The mutation this guards against: draining again on a pending retry. A second call here would
    // still just hang (post never resolves either way), so the count -- not the response shape --
    // is what actually proves a second attempt was never started.
    expect(postCalls).toBe(1);
  });

  test("a retry once delivered returns the stored delivered state, with no second post call", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const d = deps(host, TOKEN);

    await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), d);
    await drainLock.settled(REQUEST_ID);
    const retry = await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), d);
    expect(retry.status).toBe(202);
    const retryBody = (await retry.json()) as { state: { state: string }; existing: boolean };
    expect(retryBody.existing).toBe(true);
    expect(retryBody.state.state).toBe("delivered");
    expect(delivery.calls.post).toHaveLength(1);
  });

  test("a retry after failed resets to pending and drains again", async () => {
    let attempts = 0;
    const host = makeFakeHost({
      name: "mcp",
      post: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first attempt fails");
        return { guildId: GUILD, channelId: "222222222222222222", messageId: "333333333333333333" };
      },
    });
    const d = deps(host, TOKEN);

    await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), d);
    await drainLock.settled(REQUEST_ID);

    const retry = await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), d);
    expect(retry.status).toBe(202);
    const retryBody = (await retry.json()) as { state: { state: string }; existing: boolean };
    expect(retryBody.existing).toBe(true);
    expect(retryBody.state.state).toBe("pending");
    await drainLock.settled(REQUEST_ID);
    expect(attempts).toBe(2);
  });

  test("a retry that loses the drain lock to another retry of the same failed id answers pending, not the stale failed", async () => {
    let attempts = 0;
    const host = makeFakeHost({
      name: "mcp",
      post: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first attempt fails");
        return { guildId: GUILD, channelId: "222222222222222222", messageId: "333333333333333333" };
      },
    });
    const d = deps(host, TOKEN);
    await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), d);
    await drainLock.settled(REQUEST_ID);
    expect((await store.get(REQUEST_ID))!.state).toBe("failed");

    // The other retry has won the lock and is mid-delivery; this one reserved the id while it was still failed.
    expect(drainLock.tryStart(REQUEST_ID)).toBe(true);
    const retry = await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), d);
    const retryBody = (await retry.json()) as { state: { state: string; code?: string }; existing: boolean };
    expect(retryBody.existing).toBe(true);
    expect(retryBody.state.state).toBe("pending"); // mutation: answering the stale `value` says failed
    expect(retryBody.state.code).toBeUndefined();
    expect(attempts).toBe(1); // and it started no second delivery
    drainLock.finish(REQUEST_ID);
  });

  test("a retry of an unknown record with the lock free resets it to pending and delivers once", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    await store.set(REQUEST_ID, { state: "unknown", kind: "post", target: { guildId: GUILD, destination: "alerts" }, body: { content: "hi" }, createdAt: new Date(NOW).toISOString() });
    const res = await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), deps(host, TOKEN));
    const body = (await res.json()) as { state: { state: string }; existing: boolean };
    expect(body.existing).toBe(true);
    expect(body.state.state).toBe("pending"); // mutation: treating unknown like pending/delivered answers `unknown` and never delivers
    await drainLock.settled(REQUEST_ID);
    expect(delivery.calls.post).toHaveLength(1);
    expect((await store.get(REQUEST_ID))!.state).toBe("delivered");
  });

  test("a retry keeps the original createdAt across the failed -> pending reset", async () => {
    const host = makeFakeHost({
      name: "mcp",
      post: async () => {
        throw new Error("always fails");
      },
    });
    const d = deps(host, TOKEN);
    await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), d);
    await drainLock.settled(REQUEST_ID);
    const firstCreatedAt = (await store.get(REQUEST_ID))!.createdAt;

    const laterDeps = { ...d, now: () => new Date(NOW + 60_000) };
    await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), laterDeps);
    expect((await store.get(REQUEST_ID))!.createdAt).toBe(firstCreatedAt);
  });

  test("dm/edit with no host capability -- immediately CAPABILITY_UNAVAILABLE, with no host call at all", async () => {
    // Tooling#746 decision 7: a host that predates #736 (no host.dm/host.edit) still gets a clean
    // 202/CAPABILITY_UNAVAILABLE for a structurally VALID dm/edit request, the same shape #742 always
    // gave dm/edit unconditionally.
    const announced: unknown[] = [];
    const host = makeFakeHost({ name: "mcp", announce: async (m) => void announced.push(m) });
    const d = deps(host, TOKEN);

    const dmRes = await handleMcpHttp(
      post("/deliveries", { request_id: "b".repeat(64), kind: "dm", target: { user_id: USER_ID }, body: { content: "hi" } }),
      INFO("/deliveries"),
      d,
    );
    expect(dmRes.status).toBe(202);
    expect(((await dmRes.json()) as { state: { state: string; code?: string } }).state).toMatchObject({ state: "failed", code: "CAPABILITY_UNAVAILABLE" });

    const editRes = await handleMcpHttp(
      post("/deliveries", { request_id: "c".repeat(64), kind: "edit", target: { message_ref: REQUEST_ID, seq: 1 }, body: { content: "hi" } }),
      INFO("/deliveries"),
      d,
    );
    expect(editRes.status).toBe(202);
    expect(((await editRes.json()) as { state: { state: string; code?: string } }).state).toMatchObject({ state: "failed", code: "CAPABILITY_UNAVAILABLE" });

    expect(announced).toEqual([]);
  });

  test("dm literal round-trip: the POST 202 pending literal, then the GET delivered literal", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const d = deps(host, TOKEN);
    await registry.register(USER_ID, "Roshne", () => new Date(NOW));
    const dmRequestId = "b".repeat(64);

    const created = await handleMcpHttp(
      post("/deliveries", { request_id: dmRequestId, kind: "dm", target: { user_id: USER_ID }, body: { content: "hi" } }),
      INFO("/deliveries"),
      d,
    );
    expect(created.status).toBe(202);
    expect(await created.json()).toEqual({
      state: {
        state: "pending",
        kind: "dm",
        target: { user_id: USER_ID },
        body: { content: "hi" },
        created_at: new Date(NOW).toISOString(),
      },
      existing: false,
    });

    await drainLock.settled(dmRequestId);

    const fetched = await handleMcpHttp(get(`/deliveries/${dmRequestId}`), INFO(`/deliveries/${dmRequestId}`), d);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual({
      state: "delivered",
      kind: "dm",
      target: { user_id: USER_ID },
      body: { content: "hi" },
      created_at: new Date(NOW).toISOString(),
      message_ref: dmRequestId,
      url: "https://discord.com/channels/@me/200000000000000002/300000000000000002",
    });
    expect(delivery.calls.dm).toHaveLength(1);
  });

  test("dm to an unregistered user: 202 pending, then failed{RECIPIENT_UNREACHABLE}, with no host.dm call", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const d = deps(host, TOKEN);
    const dmRequestId = "b".repeat(64);

    await handleMcpHttp(post("/deliveries", { request_id: dmRequestId, kind: "dm", target: { user_id: USER_ID }, body: { content: "hi" } }), INFO("/deliveries"), d);
    await drainLock.settled(dmRequestId);

    const fetched = await handleMcpHttp(get(`/deliveries/${dmRequestId}`), INFO(`/deliveries/${dmRequestId}`), d);
    const body = (await fetched.json()) as { state: string; code?: string };
    expect(body).toMatchObject({ state: "failed", code: "RECIPIENT_UNREACHABLE" });
    expect(delivery.calls.dm).toEqual([]);
  });

  test("edit literal round-trip: applies against the original post, GET shows applied:true", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const d = deps(host, TOKEN);

    await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), d);
    await drainLock.settled(REQUEST_ID);

    const editRequestId = "b".repeat(64);
    const created = await handleMcpHttp(
      post("/deliveries", { request_id: editRequestId, kind: "edit", target: { message_ref: REQUEST_ID, seq: 2 }, body: { content: "v2" } }),
      INFO("/deliveries"),
      d,
    );
    expect(created.status).toBe(202);
    await drainLock.settled(editRequestId);

    const fetched = await handleMcpHttp(get(`/deliveries/${editRequestId}`), INFO(`/deliveries/${editRequestId}`), d);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual({
      state: "delivered",
      kind: "edit",
      target: { message_ref: REQUEST_ID, seq: 2 },
      body: { content: "v2" },
      created_at: new Date(NOW).toISOString(),
      message_ref: REQUEST_ID,
      url: "https://discord.com/channels/111111111111111111/200000000000000001/300000000000000001",
      applied: true,
    });
    expect(delivery.calls.edit).toHaveLength(1);
  });

  test("GET on an unknown request_id is 404", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(get(`/deliveries/${"f".repeat(64)}`), INFO(`/deliveries/${"f".repeat(64)}`), deps(host, TOKEN));
    expect(res.status).toBe(404);
  });
});

describe("handleMcpHttp: validation and limits", () => {
  test("the body cap counts bytes, not characters: 40 000 two-byte characters are 413", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const multibyte = { request_id: REQUEST_ID, kind: "post", target: { guild_id: GUILD, destination: "alerts" }, body: { content: "\u00e9".repeat(40_000) } };
    expect(JSON.stringify(multibyte).length).toBeLessThan(64 * 1024); // fewer characters than the cap, more bytes
    const res = await handleMcpHttp(post("/deliveries", multibyte), INFO("/deliveries"), deps(host, TOKEN));
    expect(res.status).toBe(413); // mutation: text.length instead of the encoded length lets it through
  });

  test("the same byte cap applies to /pair/redeem", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(post("/pair/redeem", { code: "\u00e9".repeat(40_000) }), INFO("/pair/redeem"), deps(host, TOKEN));
    expect(res.status).toBe(413);
  });

  test("an oversized body is 413, before it is even parsed", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const huge = { request_id: REQUEST_ID, kind: "post", target: { guild_id: GUILD, destination: "alerts" }, body: { content: "x".repeat(70_000) } };
    const res = await handleMcpHttp(post("/deliveries", huge), INFO("/deliveries"), deps(host, TOKEN));
    expect(res.status).toBe(413);
  });

  test("malformed JSON is 400", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const req = new Request("http://bridge.local/deliveries", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{not json" });
    const res = await handleMcpHttp(req, INFO("/deliveries"), deps(host, TOKEN));
    expect(res.status).toBe(400);
  });

  test("a structurally invalid request (bad request_id) is 400 with the validation reason, and nothing is stored", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(post("/deliveries", { ...validDeliveryBody(), request_id: "short" }), INFO("/deliveries"), deps(host, TOKEN));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("request_id");
    expect(await store.list()).toEqual([]);
  });
});

describe("handleMcpHttp: POST /pair/redeem", () => {
  test("an oversized body is 413, before it is even parsed (round 2 review finding: was missing entirely)", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const huge = { code: "X".repeat(70_000) };
    const res = await handleMcpHttp(post("/pair/redeem", huge), INFO("/pair/redeem"), deps(host, TOKEN));
    expect(res.status).toBe(413);
  });

  test("redeeming a valid code returns the user id and generation, matching the literal wire shape", async () => {
    const userId = "123456789012345678";
    // Register/pair use real time directly; the redeem call below goes through deps(), whose `now`
    // is the fixed PAST NOW constant (mutate() prunes with whichever clock each call is given,
    // round-3 fix) -- that mismatch is harmless here specifically because a clock further in the
    // past than a code's own creation time can never see it as expired (pruning only drops a code
    // whose expiresAt is BEFORE `now`), so this stays a lenient no-op prune either way.
    const registerOutcome = await registry.register(userId, "Ash", () => new Date());
    const pairOutcome = await registry.pair(userId, "Ash", () => new Date());
    if (!pairOutcome.ok) throw new Error("setup: pair failed");
    const host = makeFakeHost({ name: "mcp" });

    const res = await handleMcpHttp(post("/pair/redeem", { code: pairOutcome.code }), INFO("/pair/redeem"), deps(host, TOKEN));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ discord_user_id: userId, generation: registerOutcome.generation });
  });

  test("redeeming the same code twice: the second attempt is 404 (single-use)", async () => {
    const userId = "123456789012345678";
    await registry.register(userId, "Ash", () => new Date());
    const pairOutcome = await registry.pair(userId, "Ash", () => new Date());
    if (!pairOutcome.ok) throw new Error("setup: pair failed");
    const d = deps(makeFakeHost({ name: "mcp" }), TOKEN);

    const first = await handleMcpHttp(post("/pair/redeem", { code: pairOutcome.code }), INFO("/pair/redeem"), d);
    expect(first.status).toBe(200);
    const second = await handleMcpHttp(post("/pair/redeem", { code: pairOutcome.code }), INFO("/pair/redeem"), d);
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: "invalid or expired code" });
  });

  test("decision 6: a successful redeem logs the outcome, never the code", async () => {
    const userId = "123456789012345678";
    await registry.register(userId, "Ash", () => new Date());
    const pairOutcome = await registry.pair(userId, "Ash", () => new Date());
    if (!pairOutcome.ok) throw new Error("setup: pair failed");
    const { log, calls } = makeLog();
    const d = { ...deps(makeFakeHost({ name: "mcp" }), TOKEN), log };

    await handleMcpHttp(post("/pair/redeem", { code: pairOutcome.code }), INFO("/pair/redeem"), d);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.level).toBe("info");
    expect(calls[0]!.message).toContain(userId);
    expect(calls[0]!.message).not.toContain(pairOutcome.code);
  });

  test("decision 6: a failed redeem (unknown/expired/reused code) logs the outcome, never the code", async () => {
    const { log, calls } = makeLog();
    const d = { ...deps(makeFakeHost({ name: "mcp" }), TOKEN), log };
    const guessedCode = "X".repeat(27);

    await handleMcpHttp(post("/pair/redeem", { code: guessedCode }), INFO("/pair/redeem"), d);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.level).toBe("warn");
    expect(calls[0]!.message).not.toContain(guessedCode);
  });

  test("an unknown code is 404 with the literal message", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(post("/pair/redeem", { code: "X".repeat(27) }), INFO("/pair/redeem"), deps(host, TOKEN));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "invalid or expired code" });
  });

  test("malformed bodies of every shape are all 400 with the literal message", async () => {
    const d = deps(makeFakeHost({ name: "mcp" }), TOKEN);
    const notJson = new Request("http://bridge.local/pair/redeem", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{not json" });
    const cases = [
      notJson,
      post("/pair/redeem", {}),
      post("/pair/redeem", { code: 12345 }),
      post("/pair/redeem", { code: "short" }),
      post("/pair/redeem", { code: "abcdefghjkmnpqrstvwxyz23456" }), // lowercase -- PAIR_CODE_RE is uppercase-only
      post("/pair/redeem", { code: "ABCDEFGHJKMNPQRSTVWXYZ2345" }), // round-3: 26 chars, the OLD (pre-fix) length -- must now be rejected
    ];
    for (const req of cases) {
      const res = await handleMcpHttp(req, INFO("/pair/redeem"), d);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "malformed request" });
    }
  });

  test("a non-POST method is 405", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(get("/pair/redeem"), INFO("/pair/redeem"), deps(host, TOKEN));
    expect(res.status).toBe(405);
  });
});

describe("handleMcpHttp: GET /registration/{user_id}", () => {
  const USER_ID = "123456789012345678";

  test("a registered user's generation is returned, matching the literal wire shape", async () => {
    const outcome = await registry.register(USER_ID, "Ash", () => new Date(NOW));
    const host = makeFakeHost({ name: "mcp" });

    const res = await handleMcpHttp(get(`/registration/${USER_ID}`), INFO(`/registration/${USER_ID}`), deps(host, TOKEN));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generation: outcome.generation });
  });

  test("a valid-shaped but unregistered user_id is 404 with the literal message", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(get(`/registration/${USER_ID}`), INFO(`/registration/${USER_ID}`), deps(host, TOKEN));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not registered" });
  });

  test("a malformed user_id falls through to the generic catch-all 404, not this endpoint's own message", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const d = deps(host, TOKEN);
    for (const badId of ["42", `0${"1".repeat(17)}`, "1".repeat(21)]) {
      const path = `/registration/${badId}`;
      const res = await handleMcpHttp(get(path), INFO(path), d);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    }
  });

  test("a non-GET method on a valid-shaped path is 405", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(post(`/registration/${USER_ID}`), INFO(`/registration/${USER_ID}`), deps(host, TOKEN));
    expect(res.status).toBe(405);
  });
});

describe("handleMcpHttp: GET /recipients", () => {
  test("matches the literal wire shape for one registered user", async () => {
    await registry.register(USER_ID, "Roshne", () => new Date(NOW));
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(get("/recipients"), INFO("/recipients"), deps(host, TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ user_id: USER_ID, display_name: "Roshne" }] });
  });

  test("no registered users -- an empty items array", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(get("/recipients"), INFO("/recipients"), deps(host, TOKEN));
    expect(await res.json()).toEqual({ items: [] });
  });

  test("101 registered users -- capped at 100, oldest first", async () => {
    const host = makeFakeHost({ name: "mcp" });
    for (let i = 0; i < 101; i++) {
      const userId = String(100000000000000000n + BigInt(i));
      await registry.register(userId, `user-${i}`, () => new Date(NOW + i * 1000));
    }
    const res = await handleMcpHttp(get("/recipients"), INFO("/recipients"), deps(host, TOKEN));
    const body = (await res.json()) as { items: { user_id: string; display_name: string }[] };
    expect(body.items).toHaveLength(100);
    expect(body.items[0]!.display_name).toBe("user-0"); // oldest registration first
  });

  test("a display name over 100 characters is truncated to 100", async () => {
    await registry.register(USER_ID, "x".repeat(150), () => new Date(NOW));
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(get("/recipients"), INFO("/recipients"), deps(host, TOKEN));
    const body = (await res.json()) as { items: { display_name: string }[] };
    expect(body.items[0]!.display_name).toHaveLength(100);
  });

  test("a non-GET method is 405", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(post("/recipients"), INFO("/recipients"), deps(host, TOKEN));
    expect(res.status).toBe(405);
  });
});

describe("handleMcpHttp: routing", () => {
  test("an entirely unknown path is 404", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(get("/nope"), INFO("/nope"), deps(host, TOKEN));
    expect(res.status).toBe(404);
  });

  test("a wrong method on /deliveries is 405", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(get("/deliveries"), INFO("/deliveries"), deps(host, TOKEN));
    expect(res.status).toBe(405);
  });

  test("a wrong method on /deliveries/{id} is 405", async () => {
    const host = makeFakeHost({ name: "mcp" });
    const res = await handleMcpHttp(post(`/deliveries/${REQUEST_ID}`), INFO(`/deliveries/${REQUEST_ID}`), deps(host, TOKEN));
    expect(res.status).toBe(405);
  });
});

describe("handleMcpHttp: a throw from the initial state write does not strand the drain lock", () => {
  // Review finding (Tooling#742): startDrain's initial store.set used to be unguarded, so a throw
  // there skipped past the .finally() that releases the drain lock -- stranding it for that
  // request_id forever (no retry or tick could ever drain it again short of a process restart).
  test("the delivery still proceeds and the lock is released, even though the initial write failed", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    let setCalls = 0;
    const flakyStore: DeliveryStore = {
      ...store,
      set: async (id, value) => {
        setCalls += 1;
        if (setCalls === 1) throw new Error("disk full");
        return store.set(id, value);
      },
    };
    const d = { ...deps(host, TOKEN), store: flakyStore };

    const created = await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), d);
    // Still 202: the failed initial write is logged, not propagated to the caller.
    expect(created.status).toBe(202);

    // Real fs I/O (the flaky first write, then drainAndPersist's own second write), whose timing a
    // single flush() tick cannot reliably outlast -- wait for the delivery to actually land.
    await d.drainLock.settled(REQUEST_ID);

    // Proof the lock was actually released (not just that no error surfaced): a fresh tryStart for
    // the SAME request_id succeeds. Under the bug this fails, because the lock, once acquired at
    // the top of startDrain, was never reached by a release path when store.set threw.
    expect(d.drainLock.tryStart(REQUEST_ID)).toBe(true);
    d.drainLock.finish(REQUEST_ID);

    // The delivery itself still completed, using the in-memory entry -- drainAndPersist's own
    // (second, succeeding) store.set call is what actually lands the final state.
    expect(delivery.calls.post).toHaveLength(1);
    expect((await store.get(REQUEST_ID))!.state).toBe("delivered");
  });
});

describe("handleMcpHttp: a drain that fails to persist or to run", () => {
  test("a final write that throws is logged, the 202 stands, the lock is released and the outcome is held in memory", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const { log, calls } = makeLog();
    const brokenStore: DeliveryStore = {
      ...store,
      set: async () => {
        throw new Error("disk full");
      },
    };
    const d = { ...deps(host, TOKEN), store: brokenStore, log };
    const res = await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), d);
    expect(res.status).toBe(202);
    await d.drainLock.settled(REQUEST_ID);
    expect(delivery.calls.post).toHaveLength(1);
    expect(calls.some((c) => c.level === "error" && c.message === `delivery ${REQUEST_ID} failed to persist`)).toBe(true); // mutation: no .catch -> unhandled rejection
    expect(d.unpersisted.get(REQUEST_ID)?.state).toBe("delivered");
    expect(d.drainLock.tryStart(REQUEST_ID)).toBe(true); // mutation: no .finally strands the lock
    d.drainLock.finish(REQUEST_ID);
  });

  test("a registry read that throws mid-drain is logged and releases the lock, leaving the record pending", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const { log, calls } = makeLog();
    const brokenRegistry: RegistryStore = {
      ...registry,
      generationOf: async () => {
        throw new Error("registry unreadable");
      },
    };
    const d = { ...deps(host, TOKEN), registry: brokenRegistry, log };
    const body = { request_id: REQUEST_ID, kind: "dm", target: { user_id: USER_ID }, body: { content: "hi" } };
    const res = await handleMcpHttp(post("/deliveries", body), INFO("/deliveries"), d);
    expect(res.status).toBe(202);
    await d.drainLock.settled(REQUEST_ID);
    expect(delivery.calls.dm).toEqual([]);
    expect(calls.some((c) => c.level === "error" && c.message === `delivery ${REQUEST_ID} failed to persist`)).toBe(true);
    expect((await store.get(REQUEST_ID))?.state).toBe("pending");
    expect(d.drainLock.tryStart(REQUEST_ID)).toBe(true);
    d.drainLock.finish(REQUEST_ID);
  });
});

describe("handleMcpHttp: retrying a legacy failed dm or edit record (#746 decision 5)", () => {
  const legacyFailed = (kind: "dm" | "edit"): StoredDelivery => ({
    state: "failed",
    kind,
    target: { guildId: GUILD, destination: "alerts" }, // a #742 record: the target was coerced to a PostTarget
    body: { content: "hi" },
    createdAt: new Date(NOW).toISOString(),
    code: "CAPABILITY_UNAVAILABLE",
  });

  for (const [kind, code] of [["dm", "RECIPIENT_UNREACHABLE"], ["edit", "NOT_FOUND"]] as const) {
    test(`a ${kind} record resets to pending, keeps its createdAt, and fails ${code} with no host call`, async () => {
      const delivery = makeFakeDelivery();
      const host = makeFakeHost({ name: "mcp", ...delivery });
      await registry.register(USER_ID, "Ash", () => new Date(NOW)); // even a real registration cannot rescue the coerced target
      await store.set(REQUEST_ID, legacyFailed(kind));
      const d = deps(host, TOKEN);
      const res = await handleMcpHttp(post("/deliveries", validDeliveryBody()), INFO("/deliveries"), d);
      expect(res.status).toBe(202);
      const answered = (await res.json()) as { state: { state: string; kind: string; created_at: string; target: unknown }; existing: boolean };
      expect(answered.existing).toBe(true);
      expect(answered.state).toMatchObject({ state: "pending", kind, created_at: new Date(NOW).toISOString(), target: { guild_id: GUILD, destination: "alerts" } });
      await d.drainLock.settled(REQUEST_ID);
      expect(await store.get(REQUEST_ID)).toMatchObject({ state: "failed", kind, code });
      expect(delivery.calls.dm).toEqual([]);
      expect(delivery.calls.edit).toEqual([]);
      expect(delivery.calls.post).toEqual([]);
    });
  }
});

describe("handleMcpHttp: an outcome whose write failed after the send (#140)", () => {
  test("GET and a retried POST answer delivered from memory and never re-send", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const d = deps(host, TOKEN);
    // On disk the record is still pending; in memory the send already succeeded.
    await store.reserve(REQUEST_ID, "post", { guildId: GUILD, destination: "alerts" }, { content: "hi" }, () => new Date(NOW));
    d.unpersisted.set(REQUEST_ID, {
      state: "delivered",
      kind: "post",
      target: { guildId: GUILD, destination: "alerts" },
      body: { content: "hi" },
      createdAt: new Date(NOW).toISOString(),
      messageRef: REQUEST_ID,
      url: "https://discord.com/channels/1/2/3",
      delivery: { guildId: GUILD, channelId: "2", messageId: "3" },
    });

    const got = await handleMcpHttp(get(`/deliveries/${REQUEST_ID}`, { authorization: `Bearer ${TOKEN}` }), INFO(`/deliveries/${REQUEST_ID}`), d);
    expect(((await got.json()) as { state: string }).state).toBe("delivered");

    const retried = await handleMcpHttp(post("/deliveries", validDeliveryBody(), { authorization: `Bearer ${TOKEN}` }), INFO("/deliveries"), d);
    expect(((await retried.json()) as { state: { state: string } }).state.state).toBe("delivered");
    expect(delivery.calls.post).toHaveLength(0);
  });
});

