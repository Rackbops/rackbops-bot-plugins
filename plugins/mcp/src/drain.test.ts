import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFakeDelivery, makeFakeHost, makeRealStorage } from "../../../packages/testkit/index.js";
import type { HostApi } from "../../../packages/api/contract.js";
import {
  attemptDelivery,
  createDrainLock,
  createEditQueue,
  drainAndPersist,
  RECIPIENT_UNREACHABLE_MESSAGE,
  type DrainDeps,
} from "./drain.js";
import type { StoredDelivery } from "./protocol.js";
import { createRegistryStore, type RegistryStore } from "./registry.js";
import { createDeliveryStore, type DeliveryStore } from "./store.js";

const REQUEST_ID = "a".repeat(64);
const OTHER_REQUEST_ID = "b".repeat(64);
const TARGET = { guildId: "111111111111111111", destination: "alerts" };
const USER = "123456789012345678";
const NOW = () => new Date("2026-09-25T00:00:00.000Z");

function makeLog() {
  const calls: { level: "info" | "warn" | "error"; message: string; err?: unknown }[] = [];
  return {
    log: {
      info: (m: string) => calls.push({ level: "info", message: m }),
      warn: (m: string) => calls.push({ level: "warn", message: m }),
      error: (m: string, err?: unknown) => calls.push({ level: "error", message: m, err }),
    },
    calls,
  };
}

let storeDir: string;
let registryDir: string;
let store: DeliveryStore;
let registry: RegistryStore;

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "mcp-drain-store-"));
  registryDir = mkdtempSync(join(tmpdir(), "mcp-drain-registry-"));
  store = createDeliveryStore(storeDir, makeRealStorage());
  registry = createRegistryStore(registryDir, makeRealStorage());
});

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

function deps(host: HostApi, overrides: Partial<DrainDeps> = {}): DrainDeps {
  return { host, store, registry, editQueue: createEditQueue(), log: makeLog().log, ...overrides };
}

describe("attemptDelivery: kind post, with host.post", () => {
  test("delivers, recording the exact arguments, and message_ref is the request's own id", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const result = await attemptDelivery(deps(host), REQUEST_ID, { kind: "post", target: TARGET, body: { content: "hi" }, createdAt: NOW().toISOString() });

    expect(delivery.calls.post).toEqual([{ guildId: TARGET.guildId, destination: TARGET.destination, message: { content: "hi" } }]);
    expect(result.state).toBe("delivered");
    if (result.state === "delivered") expect(result.messageRef).toBe(REQUEST_ID);
  });

  test("passes card and links through when present", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const card = { title: "t" };
    const links = [{ label: "l", url: "https://example.com" }];
    await attemptDelivery(deps(host), REQUEST_ID, { kind: "post", target: TARGET, body: { content: "hi", card, links }, createdAt: NOW().toISOString() });
    expect(delivery.calls.post).toEqual([{ guildId: TARGET.guildId, destination: TARGET.destination, message: { content: "hi", card, links } }]);
  });

  test("the url is built from the returned HostDelivery, and delivery is carried through", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const result = await attemptDelivery(deps(host), REQUEST_ID, { kind: "post", target: TARGET, body: { content: "hi" }, createdAt: NOW().toISOString() });
    expect(result.state).toBe("delivered");
    if (result.state !== "delivered") throw new Error("unreachable");
    expect(result.delivery).toEqual({ guildId: "100000000000000001", channelId: "200000000000000001", messageId: "300000000000000001" });
    expect(result.url).toBe("https://discord.com/channels/100000000000000001/200000000000000001/300000000000000001");
  });

  test("a rejection is UPSTREAM_UNAVAILABLE, logged without the content", async () => {
    const host = makeFakeHost({
      name: "mcp",
      post: async () => {
        throw new Error("discord blip");
      },
    });
    const { log, calls } = makeLog();
    const result = await attemptDelivery(deps(host, { log }), REQUEST_ID, { kind: "post", target: TARGET, body: { content: "secret content" }, createdAt: NOW().toISOString() });
    expect(result).toEqual({ state: "failed", code: "UPSTREAM_UNAVAILABLE" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.message).not.toContain("secret content");
    expect(calls[0]!.message).toContain(REQUEST_ID);
  });
});

describe("attemptDelivery: kind post, without host.post (announce fallback)", () => {
  test("announces content-only, recording the exact arguments", async () => {
    const announced: [string, string | undefined][] = [];
    const host = makeFakeHost({
      name: "mcp",
      announce: async (message, destination) => void announced.push([message, destination]),
    });
    const result = await attemptDelivery(deps(host), REQUEST_ID, { kind: "post", target: TARGET, body: { content: "hi" }, createdAt: NOW().toISOString() });
    expect(announced).toEqual([["hi", "alerts"]]);
    expect(result).toEqual({ state: "delivered", messageRef: null, url: null, delivery: null });
  });

  test("a card present with no host.post is CAPABILITY_UNAVAILABLE, with no announce call", async () => {
    const announced: unknown[] = [];
    const host = makeFakeHost({ name: "mcp", announce: async (m) => void announced.push(m) });
    const result = await attemptDelivery(deps(host), REQUEST_ID, { kind: "post", target: TARGET, body: { content: "hi", card: { title: "t" } }, createdAt: NOW().toISOString() });
    expect(result).toEqual({ state: "failed", code: "CAPABILITY_UNAVAILABLE" });
    expect(announced).toEqual([]);
  });

  test("a non-empty links list with no host.post is CAPABILITY_UNAVAILABLE, with no announce call", async () => {
    const announced: unknown[] = [];
    const host = makeFakeHost({ name: "mcp", announce: async (m) => void announced.push(m) });
    const result = await attemptDelivery(deps(host), REQUEST_ID, {
      kind: "post",
      target: TARGET,
      body: { content: "hi", links: [{ label: "l", url: "https://example.com" }] },
      createdAt: NOW().toISOString(),
    });
    expect(result).toEqual({ state: "failed", code: "CAPABILITY_UNAVAILABLE" });
    expect(announced).toEqual([]);
  });

  test("an empty links array is treated the same as no links -- announce still runs", async () => {
    const announced: unknown[] = [];
    const host = makeFakeHost({ name: "mcp", announce: async (m) => void announced.push(m) });
    const result = await attemptDelivery(deps(host), REQUEST_ID, { kind: "post", target: TARGET, body: { content: "hi", links: [] }, createdAt: NOW().toISOString() });
    expect(result.state).toBe("delivered");
    expect(announced).toEqual(["hi"]);
  });

  test("a rejection is UPSTREAM_UNAVAILABLE, logged without the content", async () => {
    const host = makeFakeHost({
      name: "mcp",
      announce: async () => {
        throw new Error("webhook down");
      },
    });
    const { log, calls } = makeLog();
    const result = await attemptDelivery(deps(host, { log }), REQUEST_ID, { kind: "post", target: TARGET, body: { content: "secret content" }, createdAt: NOW().toISOString() });
    expect(result).toEqual({ state: "failed", code: "UPSTREAM_UNAVAILABLE" });
    expect(calls[0]!.message).not.toContain("secret content");
  });
});

describe("attemptDelivery: kind dm", () => {
  test("a registered user -> host.dm called once, delivered, url uses @me", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    await registry.register(USER, "Ash", NOW);
    const result = await attemptDelivery(deps(host), REQUEST_ID, { kind: "dm", target: { userId: USER }, body: { content: "hi" }, createdAt: NOW().toISOString() });

    expect(delivery.calls.dm).toEqual([{ userId: USER, message: { content: "hi" } }]);
    expect(delivery.calls.post).toEqual([]);
    expect(result).toEqual({
      state: "delivered",
      messageRef: REQUEST_ID,
      url: `https://discord.com/channels/@me/200000000000000002/300000000000000002`,
      delivery: { guildId: null, channelId: "200000000000000002", messageId: "300000000000000002" },
    });
  });

  test("an unregistered user -> RECIPIENT_UNREACHABLE, host.dm never called", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    // No registry.register call for USER.
    const result = await attemptDelivery(deps(host), REQUEST_ID, { kind: "dm", target: { userId: USER }, body: { content: "hi" }, createdAt: NOW().toISOString() });

    expect(result).toEqual({ state: "failed", code: "RECIPIENT_UNREACHABLE" });
    expect(delivery.calls.dm).toEqual([]);
  });

  test("closed DMs (the host's literal rejection message) -> RECIPIENT_UNREACHABLE", async () => {
    const host = makeFakeHost({
      name: "mcp",
      dm: async () => {
        throw new Error(RECIPIENT_UNREACHABLE_MESSAGE);
      },
    });
    await registry.register(USER, "Ash", NOW);
    const result = await attemptDelivery(deps(host), REQUEST_ID, { kind: "dm", target: { userId: USER }, body: { content: "hi" }, createdAt: NOW().toISOString() });
    expect(result).toEqual({ state: "failed", code: "RECIPIENT_UNREACHABLE" });
  });

  test("any other dm rejection -> UPSTREAM_UNAVAILABLE, logged without content", async () => {
    const host = makeFakeHost({
      name: "mcp",
      dm: async () => {
        throw new Error("discord blip");
      },
    });
    await registry.register(USER, "Ash", NOW);
    const { log, calls } = makeLog();
    const result = await attemptDelivery(deps(host, { log }), REQUEST_ID, { kind: "dm", target: { userId: USER }, body: { content: "secret content" }, createdAt: NOW().toISOString() });
    expect(result).toEqual({ state: "failed", code: "UPSTREAM_UNAVAILABLE" });
    expect(calls[0]!.message).not.toContain("secret content");
  });

  test("a legacy #742 record (target coerced to a PostTarget) -- RECIPIENT_UNREACHABLE, no host call", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    await registry.register(USER, "Ash", NOW); // even a real registration can't rescue a malformed target
    const result = await attemptDelivery(deps(host), REQUEST_ID, { kind: "dm", target: TARGET, body: { content: "hi" }, createdAt: NOW().toISOString() });
    expect(result).toEqual({ state: "failed", code: "RECIPIENT_UNREACHABLE" });
    expect(delivery.calls.dm).toEqual([]);
  });
});

/** A delivered "post" original, ready to be edited -- the shape every edit test starts from. */
async function seedDeliveredPost(requestId: string): Promise<void> {
  await store.set(requestId, {
    state: "delivered",
    kind: "post",
    target: TARGET,
    body: { content: "v1" },
    createdAt: NOW().toISOString(),
    messageRef: requestId,
    url: `https://discord.com/channels/${TARGET.guildId}/222222222222222222/333333333333333333`,
    delivery: { guildId: TARGET.guildId, channelId: "222222222222222222", messageId: "333333333333333333" },
  });
}

describe("attemptDelivery: kind edit", () => {
  test("applies against the original, persists lastEditSeq, delivered{applied:true}", async () => {
    await seedDeliveredPost(REQUEST_ID);
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const result = await attemptDelivery(deps(host), OTHER_REQUEST_ID, { kind: "edit", target: { messageRef: REQUEST_ID, seq: 1 }, body: { content: "v2" }, createdAt: NOW().toISOString() });

    expect(delivery.calls.edit).toEqual([{ delivery: { guildId: TARGET.guildId, channelId: "222222222222222222", messageId: "333333333333333333" }, message: { content: "v2" } }]);
    expect(result).toMatchObject({ state: "delivered", messageRef: REQUEST_ID, applied: true });
    expect((await store.get(REQUEST_ID))!.state).toBe("delivered");
    expect(((await store.get(REQUEST_ID)) as { lastEditSeq?: number }).lastEditSeq).toBe(1);
  });

  test("seq 2 then seq 1, applied one after another -- one host.edit call, seq 1 reports applied:false", async () => {
    await seedDeliveredPost(REQUEST_ID);
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });

    const first = await attemptDelivery(deps(host), "c".repeat(64), { kind: "edit", target: { messageRef: REQUEST_ID, seq: 2 }, body: { content: "v2" }, createdAt: NOW().toISOString() });
    expect(first).toMatchObject({ applied: true });

    const second = await attemptDelivery(deps(host), "d".repeat(64), { kind: "edit", target: { messageRef: REQUEST_ID, seq: 1 }, body: { content: "v1-again" }, createdAt: NOW().toISOString() });
    expect(second).toMatchObject({ applied: false });

    expect(delivery.calls.edit).toHaveLength(1); // seq 1's call never reached host.edit
    expect(delivery.calls.edit[0]!.message).toEqual({ content: "v2" });
  });

  test("a re-drive of an already-applied seq re-applies (applied:true), not skipped like a lower seq", async () => {
    // Decision 3: "An equal seq re-applies... only happens when a re-drive repeats an edit that had
    // already applied, and the content is the same." This is what distinguishes the `<` comparison
    // from a `<=` one -- `<=` would wrongly skip a re-drive of the SAME seq that already landed.
    await seedDeliveredPost(REQUEST_ID);
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });

    const first = await attemptDelivery(deps(host), "c".repeat(64), { kind: "edit", target: { messageRef: REQUEST_ID, seq: 2 }, body: { content: "v2" }, createdAt: NOW().toISOString() });
    expect(first).toMatchObject({ applied: true });

    const redrive = await attemptDelivery(deps(host), "c".repeat(64), { kind: "edit", target: { messageRef: REQUEST_ID, seq: 2 }, body: { content: "v2" }, createdAt: NOW().toISOString() });
    expect(redrive).toMatchObject({ applied: true });
    expect(delivery.calls.edit).toHaveLength(2); // the re-drive called host.edit again, not skipped
  });

  test("concurrent seq 1 (slow fake edit) and seq 2, submitted in that order -- the queue serializes them, so the last content applied is v2", async () => {
    await seedDeliveredPost(REQUEST_ID);
    const edits: { message: { content?: string } }[] = [];
    let releaseSlowEdit: (() => void) | undefined;
    const host = makeFakeHost({
      name: "mcp",
      edit: async (_delivery, message) => {
        edits.push({ message });
        if (message.content === "v1") {
          await new Promise<void>((resolve) => {
            releaseSlowEdit = resolve;
          });
        }
      },
    });
    const d = deps(host);

    // Both calls are made synchronously (neither awaited individually) so they enqueue on the
    // EditQueue in exactly this order, regardless of which one's host.edit settles first.
    const seq1 = attemptDelivery(d, "c".repeat(64), { kind: "edit", target: { messageRef: REQUEST_ID, seq: 1 }, body: { content: "v1" }, createdAt: NOW().toISOString() });
    const seq2 = attemptDelivery(d, "d".repeat(64), { kind: "edit", target: { messageRef: REQUEST_ID, seq: 2 }, body: { content: "v2" }, createdAt: NOW().toISOString() });

    // seq 2 must not even START its own read of the original until seq 1's whole turn (including its
    // slow host.edit) has settled -- proven by releasing seq 1 only after giving seq 2 a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(edits).toHaveLength(1); // seq 2 has not reached host.edit yet
    releaseSlowEdit!();

    const [firstResult, secondResult] = await Promise.all([seq1, seq2]);
    expect(firstResult).toMatchObject({ applied: true });
    expect(secondResult).toMatchObject({ applied: true });
    expect(edits.map((e) => e.message.content)).toEqual(["v1", "v2"]);
    expect(((await store.get(REQUEST_ID)) as { lastEditSeq?: number }).lastEditSeq).toBe(2);
  });

  test("an unknown message_ref -- NOT_FOUND, no host call", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const result = await attemptDelivery(deps(host), OTHER_REQUEST_ID, { kind: "edit", target: { messageRef: REQUEST_ID, seq: 1 }, body: { content: "v2" }, createdAt: NOW().toISOString() });
    expect(result).toEqual({ state: "failed", code: "NOT_FOUND" });
    expect(delivery.calls.edit).toEqual([]);
  });

  test("editing a pending (not yet delivered) original -- NOT_FOUND", async () => {
    await store.set(REQUEST_ID, { state: "pending", kind: "post", target: TARGET, body: { content: "v1" }, createdAt: NOW().toISOString() });
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const result = await attemptDelivery(deps(host), OTHER_REQUEST_ID, { kind: "edit", target: { messageRef: REQUEST_ID, seq: 1 }, body: { content: "v2" }, createdAt: NOW().toISOString() });
    expect(result).toEqual({ state: "failed", code: "NOT_FOUND" });
    expect(delivery.calls.edit).toEqual([]);
  });

  test("editing an edit -- NOT_FOUND (an edit's own record never chains)", async () => {
    await seedDeliveredPost(REQUEST_ID);
    await store.set(OTHER_REQUEST_ID, {
      state: "delivered",
      kind: "edit",
      target: { messageRef: REQUEST_ID, seq: 1 },
      body: { content: "v2" },
      createdAt: NOW().toISOString(),
      messageRef: REQUEST_ID,
      url: "https://discord.com/x",
      delivery: { guildId: TARGET.guildId, channelId: "222222222222222222", messageId: "333333333333333333" },
      applied: true,
    });
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const result = await attemptDelivery(deps(host), "c".repeat(64), { kind: "edit", target: { messageRef: OTHER_REQUEST_ID, seq: 1 }, body: { content: "v3" }, createdAt: NOW().toISOString() });
    expect(result).toEqual({ state: "failed", code: "NOT_FOUND" });
    expect(delivery.calls.edit).toEqual([]);
  });

  test("editing an announce-delivered original (delivery: null) -- CAPABILITY_UNAVAILABLE", async () => {
    await store.set(REQUEST_ID, {
      state: "delivered",
      kind: "post",
      target: TARGET,
      body: { content: "v1" },
      createdAt: NOW().toISOString(),
      messageRef: null,
      url: null,
      delivery: null,
    });
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const result = await attemptDelivery(deps(host), OTHER_REQUEST_ID, { kind: "edit", target: { messageRef: REQUEST_ID, seq: 1 }, body: { content: "v2" }, createdAt: NOW().toISOString() });
    expect(result).toEqual({ state: "failed", code: "CAPABILITY_UNAVAILABLE" });
    expect(delivery.calls.edit).toEqual([]);
  });

  test("host.edit absent -- CAPABILITY_UNAVAILABLE, even with a normal delivered post original", async () => {
    await seedDeliveredPost(REQUEST_ID);
    const host = makeFakeHost({ name: "mcp" }); // no edit
    const result = await attemptDelivery(deps(host), OTHER_REQUEST_ID, { kind: "edit", target: { messageRef: REQUEST_ID, seq: 1 }, body: { content: "v2" }, createdAt: NOW().toISOString() });
    expect(result).toEqual({ state: "failed", code: "CAPABILITY_UNAVAILABLE" });
  });

  test("editing a dm whose recipient has since unregistered -- RECIPIENT_UNREACHABLE", async () => {
    await registry.register(USER, "Ash", NOW);
    await store.set(REQUEST_ID, {
      state: "delivered",
      kind: "dm",
      target: { userId: USER },
      body: { content: "v1" },
      createdAt: NOW().toISOString(),
      messageRef: REQUEST_ID,
      url: "https://discord.com/channels/@me/200000000000000002/300000000000000002",
      delivery: { guildId: null, channelId: "200000000000000002", messageId: "300000000000000002" },
    });
    await registry.unregister(USER, NOW);
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const result = await attemptDelivery(deps(host), OTHER_REQUEST_ID, { kind: "edit", target: { messageRef: REQUEST_ID, seq: 1 }, body: { content: "v2" }, createdAt: NOW().toISOString() });
    expect(result).toEqual({ state: "failed", code: "RECIPIENT_UNREACHABLE" });
    expect(delivery.calls.edit).toEqual([]);
  });

  test("editing a dm whose recipient is still registered succeeds", async () => {
    await registry.register(USER, "Ash", NOW);
    await store.set(REQUEST_ID, {
      state: "delivered",
      kind: "dm",
      target: { userId: USER },
      body: { content: "v1" },
      createdAt: NOW().toISOString(),
      messageRef: REQUEST_ID,
      url: "https://discord.com/channels/@me/200000000000000002/300000000000000002",
      delivery: { guildId: null, channelId: "200000000000000002", messageId: "300000000000000002" },
    });
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const result = await attemptDelivery(deps(host), OTHER_REQUEST_ID, { kind: "edit", target: { messageRef: REQUEST_ID, seq: 1 }, body: { content: "v2" }, createdAt: NOW().toISOString() });
    expect(result).toMatchObject({ state: "delivered", applied: true });
  });

  test("host.edit rejects -- UPSTREAM_UNAVAILABLE", async () => {
    await seedDeliveredPost(REQUEST_ID);
    const host = makeFakeHost({
      name: "mcp",
      edit: async () => {
        throw new Error("discord blip");
      },
    });
    const { log, calls } = makeLog();
    const result = await attemptDelivery(deps(host, { log }), OTHER_REQUEST_ID, { kind: "edit", target: { messageRef: REQUEST_ID, seq: 1 }, body: { content: "secret content" }, createdAt: NOW().toISOString() });
    expect(result).toEqual({ state: "failed", code: "UPSTREAM_UNAVAILABLE" });
    expect(calls[0]!.message).not.toContain("secret content");
  });

  test("a legacy #742 record (kind edit, target coerced to a PostTarget) -- NOT_FOUND, no host call", async () => {
    await seedDeliveredPost(REQUEST_ID);
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const result = await attemptDelivery(deps(host), OTHER_REQUEST_ID, { kind: "edit", target: TARGET, body: { content: "v2" }, createdAt: NOW().toISOString() });
    expect(result).toEqual({ state: "failed", code: "NOT_FOUND" });
    expect(delivery.calls.edit).toEqual([]);
  });
});

describe("createDrainLock", () => {
  test("a second tryStart for the same id fails while the first holds it", () => {
    const lock = createDrainLock();
    expect(lock.tryStart(REQUEST_ID)).toBe(true);
    expect(lock.tryStart(REQUEST_ID)).toBe(false);
  });

  test("finish releases the id so a later tryStart succeeds again", () => {
    const lock = createDrainLock();
    lock.tryStart(REQUEST_ID);
    lock.finish(REQUEST_ID);
    expect(lock.tryStart(REQUEST_ID)).toBe(true);
  });

  test("different ids never contend", () => {
    const lock = createDrainLock();
    expect(lock.tryStart(REQUEST_ID)).toBe(true);
    expect(lock.tryStart("b".repeat(64))).toBe(true);
  });

  test("finish on an id that was never started is a harmless no-op", () => {
    const lock = createDrainLock();
    expect(() => lock.finish(REQUEST_ID)).not.toThrow();
    expect(lock.tryStart(REQUEST_ID)).toBe(true);
  });
});

describe("drainAndPersist", () => {
  const entry = { kind: "post" as const, target: TARGET, body: { content: "hi" }, createdAt: "2026-09-25T00:00:00.000Z" };

  test("persists a delivered outcome via store.set, preserving kind/target/body/createdAt", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    await drainAndPersist(deps(host), REQUEST_ID, entry);
    expect(await store.get(REQUEST_ID)).toMatchObject({ state: "delivered", kind: "post", target: TARGET, body: { content: "hi" }, createdAt: entry.createdAt });
  });

  test("persists a failed outcome the same way", async () => {
    const host = makeFakeHost({
      name: "mcp",
      post: async () => {
        throw new Error("boom");
      },
    });
    await drainAndPersist(deps(host), REQUEST_ID, entry);
    expect(await store.get(REQUEST_ID)).toEqual({ ...entry, state: "failed", code: "UPSTREAM_UNAVAILABLE" });
  });

  test("a delivered edit persists with applied on the wire-facing record", async () => {
    await seedDeliveredPost(REQUEST_ID);
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const editEntry = { kind: "edit" as const, target: { messageRef: REQUEST_ID, seq: 1 }, body: { content: "v2" }, createdAt: "2026-09-25T00:00:00.000Z" };
    await drainAndPersist(deps(host), OTHER_REQUEST_ID, editEntry);
    const stored = (await store.get(OTHER_REQUEST_ID)) as StoredDelivery & { applied?: boolean };
    expect(stored.state).toBe("delivered");
    expect(stored.applied).toBe(true);
  });

  test("does not manage the lock itself -- the caller must acquire and release it", async () => {
    const lock = createDrainLock();
    const host = makeFakeHost({ name: "mcp", ...makeFakeDelivery() });
    // drainAndPersist takes no lock parameter at all; calling it twice concurrently for the same id
    // (as a caller who forgot to check tryStart first would) runs both, proving the guard has to
    // live at the call site, matching how http.ts and index.ts's tick both call tryStart themselves.
    // A recording-only fake store here, rather than the real fs-backed one: two real concurrent
    // writes to the identical path race on the shared testkit's own `${path}.tmp` rename (unrelated
    // to what this test is about), and this test only needs to prove the lock itself is untouched.
    const sets: string[] = [];
    const noStoreDeps = deps(host, { store: { ...store, set: async (id) => void sets.push(id) } });
    await Promise.all([drainAndPersist(noStoreDeps, REQUEST_ID, entry), drainAndPersist(noStoreDeps, REQUEST_ID, entry)]);
    expect(sets).toEqual([REQUEST_ID, REQUEST_ID]); // both ran, proving drainAndPersist itself never serialized them
    expect(lock.tryStart(REQUEST_ID)).toBe(true); // the lock was never touched by drainAndPersist
  });
});
