import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { makeFakeHost, makeRealStorage } from "../../../packages/testkit/index.js";
import type { PluginHttpInfo } from "../../../packages/api/contract.js";
import { createPlugin } from "./index.js";
import { createDeliveryStore, type DeliveryStore } from "./store.js";

const TOKEN = "a".repeat(43);
const CLIENT_IP = "10.0.0.1";
const GUILD = "111111111111111111";
const REQUEST_ID = "a".repeat(64);
const TARGET = { guildId: GUILD, destination: "alerts" };
const BODY = { content: "hi" };
const INFO = (path: string): PluginHttpInfo => ({ path, clientIp: CLIENT_IP });

function post(path: string, body?: unknown): Request {
  return new Request(`http://bridge.local${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Polls `check` until it returns true or `timeoutMs` elapses -- used instead of a fixed-delay flush
 *  where the thing being waited for involves real fs I/O (store.list/get go through node:fs), whose
 *  timing a single setTimeout(0) tick cannot reliably outlast. */
async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const validDeliveryBody = () => ({ request_id: REQUEST_ID, kind: "post", target: { guild_id: GUILD, destination: "alerts" }, body: BODY });

function fakeRegisterInteraction(userId: string): ChatInputCommandInteraction {
  return {
    user: { id: userId, globalName: "Ash", username: "ash123" },
    options: { getSubcommand: () => "register" },
    reply: async () => {},
  } as unknown as ChatInputCommandInteraction;
}

let dir: string;
let externalStore: DeliveryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-plugin-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createPlugin", () => {
  test("returns http, one redrive tick, the agent command, activate and dispose", () => {
    const host = makeFakeHost({ name: "mcp", dataDir: dir, env: { MCP_BRIDGE_TOKEN: TOKEN } });
    const plugin = createPlugin(host);
    expect(typeof plugin.http).toBe("function");
    expect(plugin.ticks).toHaveLength(1);
    expect(plugin.ticks![0]!.name).toBe("redrive");
    expect(plugin.commands).toHaveLength(1);
    expect(plugin.commands![0]!.name).toBe("agent");
    expect(typeof plugin.activate).toBe("function");
    expect(typeof plugin.dispose).toBe("function");
  });

  test("with no MCP_BRIDGE_TOKEN, http answers 503", async () => {
    const host = makeFakeHost({ name: "mcp", dataDir: dir });
    const plugin = createPlugin(host);
    const res = await plugin.http!(post("/capabilities"), INFO("/capabilities"));
    expect(res.status).toBe(503);
  });

  test("with MCP_BRIDGE_TOKEN set, a correctly authenticated call reaches the route", async () => {
    const host = makeFakeHost({ name: "mcp", dataDir: dir, env: { MCP_BRIDGE_TOKEN: TOKEN } });
    const plugin = createPlugin(host);
    const res = await plugin.http!(new Request("http://bridge.local/capabilities", { headers: { authorization: `Bearer ${TOKEN}` } }), INFO("/capabilities"));
    expect(res.status).toBe(200);
  });

  test("the agent command and the HTTP routes share one registry: a command registration is visible through GET /registration/{user_id}", async () => {
    const host = makeFakeHost({ name: "mcp", dataDir: dir, env: { MCP_BRIDGE_TOKEN: TOKEN } });
    const plugin = createPlugin(host);
    const userId = "123456789012345678";

    await plugin.commands![0]!.handle(fakeRegisterInteraction(userId));

    const res = await plugin.http!(
      new Request(`http://bridge.local/registration/${userId}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      INFO(`/registration/${userId}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { generation: string };
    expect(typeof body.generation).toBe("string");
  });
});

describe("activate", () => {
  test("turns every pending entry into unknown", async () => {
    const host = makeFakeHost({ name: "mcp", dataDir: dir, env: { MCP_BRIDGE_TOKEN: TOKEN } });
    externalStore = createDeliveryStore(dir, host.storage);
    await externalStore.reserve(REQUEST_ID, "post", TARGET, BODY, () => new Date());

    const plugin = createPlugin(host);
    await plugin.activate!();

    expect((await externalStore.get(REQUEST_ID))!.state).toBe("unknown");
  });
});

describe("edit ordering survives a restart", () => {
  test("apply seq 2, recreate the plugin on the same dataDir, then send seq 1 -> applied:false", async () => {
    // Tooling#746 decision 4: lastEditSeq persists on the original's own delivered record, not just
    // in the EditQueue's in-memory state -- this is what a plugin restart (a brand new createPlugin
    // call over the SAME dataDir) must not be able to forget.
    const host = makeFakeHost({
      name: "mcp",
      dataDir: dir,
      env: { MCP_BRIDGE_TOKEN: TOKEN },
      post: async () => ({ guildId: GUILD, channelId: "222222222222222222", messageId: "333333333333333333" }),
      edit: async () => {},
    });
    externalStore = createDeliveryStore(dir, host.storage);

    async function waitForDelivered(requestId: string): Promise<void> {
      const start = Date.now();
      while ((await externalStore.get(requestId))?.state !== "delivered") {
        if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${requestId} to deliver`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    const plugin1 = createPlugin(host);
    await plugin1.http!(post("/deliveries", validDeliveryBody()), INFO("/deliveries"));
    await waitForDelivered(REQUEST_ID);

    const editSeq2Id = "b".repeat(64);
    await plugin1.http!(
      post("/deliveries", { request_id: editSeq2Id, kind: "edit", target: { message_ref: REQUEST_ID, seq: 2 }, body: { content: "v2" } }),
      INFO("/deliveries"),
    );
    await waitForDelivered(editSeq2Id);

    // The "restart": a fresh plugin instance (fresh in-memory EditQueue/drainLock/registry-store
    // object) over the exact same host.dataDir.
    const plugin2 = createPlugin(host);
    const editSeq1Id = "c".repeat(64);
    await plugin2.http!(
      post("/deliveries", { request_id: editSeq1Id, kind: "edit", target: { message_ref: REQUEST_ID, seq: 1 }, body: { content: "v1-again" } }),
      INFO("/deliveries"),
    );
    await waitForDelivered(editSeq1Id);

    const seq1Result = (await externalStore.get(editSeq1Id)) as { applied?: boolean };
    expect(seq1Result.applied).toBe(false);
  });
});

describe("the redrive tick", () => {
  test("one entry's persistence failure does not abort the rest of the cycle -- every entry is still attempted and prune still runs", async () => {
    // Review finding (Tooling#742): the tick's per-entry work used to have a try/finally but no
    // catch, so one id's drainAndPersist throwing propagated out of the whole run(), skipping every
    // later id in that cycle's store.list() snapshot and the prune pass that follows.
    //
    // store.list()'s own contract is explicit that it returns ids "in no particular order" (store.ts),
    // and real directory iteration order is filesystem-dependent (NTFS returns readdir sorted; ext4,
    // used in CI, does not) -- so this cannot assert on "the entry AFTER the failing one still ran"
    // via naming/sort order, or it could pass for the wrong reason on a filesystem that happens to
    // process the non-failing id first. Instead it tracks every write ATTEMPT the flaky storage sees,
    // which proves both ids were reached regardless of which one the loop hit first.
    const idA = "a".repeat(64);
    const idB = "b".repeat(64);
    const staleId = "c".repeat(64);
    const realStorage = makeRealStorage();
    const attempted: string[] = [];
    const flakyStorage = {
      ...realStorage,
      writeJsonAtomic: async (path: string, data: unknown) => {
        attempted.push(path);
        if (path.includes(idA)) throw new Error("disk full");
        return realStorage.writeJsonAtomic(path, data);
      },
    };
    const host = makeFakeHost({
      name: "mcp",
      dataDir: dir,
      storage: flakyStorage,
      env: { MCP_BRIDGE_TOKEN: TOKEN },
      post: async () => ({ guildId: GUILD, channelId: "222222222222222222", messageId: "333333333333333333" }),
    });
    externalStore = createDeliveryStore(dir, realStorage);
    const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(); // 9 days old -- past the 8-day prune window
    await externalStore.set(idA, { state: "unknown", kind: "post", target: TARGET, body: BODY, createdAt: new Date().toISOString() });
    await externalStore.set(idB, { state: "unknown", kind: "post", target: TARGET, body: BODY, createdAt: new Date().toISOString() });
    await externalStore.set(staleId, { state: "delivered", kind: "post", target: TARGET, body: BODY, createdAt: old, messageRef: null, url: null, delivery: null });
    attempted.length = 0; // drop the three setup writes above; only the tick's own attempts matter

    const plugin = createPlugin(host);
    await plugin.ticks![0]!.run();

    // Both ids were reached -- whichever the loop hit first, the other was not skipped because of it.
    expect(attempted.some((p) => p.includes(idA))).toBe(true);
    expect(attempted.some((p) => p.includes(idB))).toBe(true);
    // idB's own write never fails, so it reaches "delivered" regardless of processing order.
    expect((await externalStore.get(idB))!.state).toBe("delivered");
    // idA itself is left as it was (still "unknown" -- its own write never lands); not this test's
    // point, but worth confirming nothing corrupted it either.
    expect((await externalStore.get(idA))!.state).toBe("unknown");
    // The prune pass after the loop still ran, despite idA's mid-loop throw.
    expect(await externalStore.get(staleId)).toBeUndefined();
  });

  test("delivers an unknown entry with no caller retry needed", async () => {
    const host = makeFakeHost({
      name: "mcp",
      dataDir: dir,
      env: { MCP_BRIDGE_TOKEN: TOKEN },
      post: async () => ({ guildId: GUILD, channelId: "222222222222222222", messageId: "333333333333333333" }),
    });
    externalStore = createDeliveryStore(dir, host.storage);
    await externalStore.set(REQUEST_ID, { state: "unknown", kind: "post", target: TARGET, body: BODY, createdAt: new Date().toISOString() });

    const plugin = createPlugin(host);
    await plugin.ticks![0]!.run();

    expect((await externalStore.get(REQUEST_ID))!.state).toBe("delivered");
  });

  test("skips entries that are not unknown, and prunes nothing that's still fresh", async () => {
    const host = makeFakeHost({ name: "mcp", dataDir: dir, env: { MCP_BRIDGE_TOKEN: TOKEN } });
    externalStore = createDeliveryStore(dir, host.storage);
    await externalStore.set("b".repeat(64), { state: "pending", kind: "post", target: TARGET, body: BODY, createdAt: new Date().toISOString() });

    const plugin = createPlugin(host);
    await plugin.ticks![0]!.run();

    expect((await externalStore.get("b".repeat(64)))!.state).toBe("pending");
  });

  test("a caller POST for an id the tick is already re-driving does not start a second delivery", async () => {
    let postCalls = 0;
    let releasePost: (() => void) | undefined;
    const host = makeFakeHost({
      name: "mcp",
      dataDir: dir,
      env: { MCP_BRIDGE_TOKEN: TOKEN },
      post: async () => {
        postCalls += 1;
        await new Promise<void>((resolve) => {
          releasePost = resolve;
        });
        return { guildId: GUILD, channelId: "222222222222222222", messageId: "333333333333333333" };
      },
    });
    externalStore = createDeliveryStore(dir, host.storage);
    await externalStore.set(REQUEST_ID, { state: "unknown", kind: "post", target: TARGET, body: BODY, createdAt: new Date().toISOString() });

    const plugin = createPlugin(host);
    const tickPromise = plugin.ticks![0]!.run();
    // Let the tick get as far as calling host.post, where it now hangs on releasePost. store.list/get
    // go through real fs I/O, so this polls rather than trusting a single setTimeout(0) to outlast it.
    await waitUntil(() => postCalls === 1);

    // A caller retries the SAME request_id while the tick's attempt is still in flight.
    const retryRes = await plugin.http!(post("/deliveries", validDeliveryBody()), INFO("/deliveries"));
    expect(retryRes.status).toBe(202);
    const retryBody = (await retryRes.json()) as { state: { state: string }; existing: boolean };
    expect(retryBody.existing).toBe(true);
    // Nothing was reset or started for this retry -- the entry is exactly as the tick left it, still
    // "unknown" (the tick hasn't written a new state yet; it's still awaiting releasePost).
    expect(retryBody.state.state).toBe("unknown");
    expect(postCalls).toBe(1); // the retry did NOT start a second host.post call

    releasePost!();
    await tickPromise;
    await flush();

    expect(postCalls).toBe(1); // still exactly one call, after the tick's own attempt settled
    expect((await externalStore.get(REQUEST_ID))!.state).toBe("delivered");
  });
});

describe("dispose", () => {
  test("stops the tick from starting a new drain, even with an unknown entry waiting", async () => {
    let postCalls = 0;
    const host = makeFakeHost({
      name: "mcp",
      dataDir: dir,
      env: { MCP_BRIDGE_TOKEN: TOKEN },
      post: async () => {
        postCalls += 1;
        return { guildId: GUILD, channelId: "222222222222222222", messageId: "333333333333333333" };
      },
    });
    externalStore = createDeliveryStore(dir, host.storage);
    await externalStore.set(REQUEST_ID, { state: "unknown", kind: "post", target: TARGET, body: BODY, createdAt: new Date().toISOString() });

    const plugin = createPlugin(host);
    await plugin.dispose!();
    await plugin.ticks![0]!.run();

    expect(postCalls).toBe(0);
    expect((await externalStore.get(REQUEST_ID))!.state).toBe("unknown");
  });
});
