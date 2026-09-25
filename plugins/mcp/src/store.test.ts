import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeRealStorage } from "../../../packages/testkit/index.js";
import type { StoredDelivery } from "./protocol.js";
import { createDeliveryStore, type DeliveryStore } from "./store.js";

const TARGET = { guildId: "111111111111111111", destination: "alerts" };
const BODY = { content: "hi" };
const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

let dir: string;
let store: DeliveryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-store-"));
  store = createDeliveryStore(dir, makeRealStorage());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("reserve", () => {
  test("an absent request_id is created as pending, existing: false", async () => {
    const { value, existing } = await store.reserve("a".repeat(64), "post", TARGET, BODY, () => new Date(NOW));
    expect(existing).toBe(false);
    expect(value).toEqual({ state: "pending", kind: "post", target: TARGET, body: BODY, createdAt: new Date(NOW).toISOString() });
  });

  test("a present request_id is returned unchanged, existing: true, never overwritten", async () => {
    const id = "a".repeat(64);
    await store.reserve(id, "post", TARGET, BODY, () => new Date(NOW));
    await store.set(id, { state: "delivered", kind: "post", target: TARGET, body: BODY, createdAt: new Date(NOW).toISOString(), messageRef: id, url: "https://discord.com/x", delivery: null });

    const second = await store.reserve(id, "post", { guildId: "999999999999999999", destination: "ops" }, { content: "different" }, () => new Date(NOW + 1));
    expect(second.existing).toBe(true);
    expect(second.value.state).toBe("delivered");
    expect(await store.get(id)).toEqual(second.value); // the second reserve's different args never landed
  });

  test("concurrent reserves for one request_id produce exactly one pending write", async () => {
    const id = "a".repeat(64);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.reserve(id, "post", TARGET, BODY, () => new Date(NOW))),
    );
    expect(results.filter((r) => !r.existing)).toHaveLength(1);
    expect(results.filter((r) => r.existing)).toHaveLength(19);
    // every result -- winner and losers alike -- agrees on the one value that actually landed
    const stored = await store.get(id);
    for (const r of results) expect(r.value).toEqual(stored!);
  });
});

describe("set / get", () => {
  test("round-trips a stored value", async () => {
    const id = "a".repeat(64);
    const value: StoredDelivery = { state: "failed", kind: "post", target: TARGET, body: BODY, createdAt: new Date(NOW).toISOString(), code: "UPSTREAM_UNAVAILABLE" };
    await store.set(id, value);
    expect(await store.get(id)).toEqual(value);
  });

  test("get on an absent request_id is undefined", async () => {
    expect(await store.get("a".repeat(64))).toBeUndefined();
  });
});

describe("list", () => {
  test("empty when nothing has been reserved, and an absent directory is not an error", async () => {
    expect(await store.list()).toEqual([]);
  });

  test("lists every reserved request_id", async () => {
    const ids = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    for (const id of ids) await store.reserve(id, "post", TARGET, BODY, () => new Date(NOW));
    expect((await store.list()).sort()).toEqual([...ids].sort());
  });
});

describe("markPendingUnknown", () => {
  test("pending becomes unknown; every other state is untouched", async () => {
    const pendingId = "a".repeat(64);
    const deliveredId = "b".repeat(64);
    const failedId = "c".repeat(64);
    const unknownId = "d".repeat(64);
    await store.reserve(pendingId, "post", TARGET, BODY, () => new Date(NOW));
    await store.set(deliveredId, { state: "delivered", kind: "post", target: TARGET, body: BODY, createdAt: new Date(NOW).toISOString(), messageRef: deliveredId, url: null, delivery: null });
    await store.set(failedId, { state: "failed", kind: "post", target: TARGET, body: BODY, createdAt: new Date(NOW).toISOString(), code: "UPSTREAM_UNAVAILABLE" });
    await store.set(unknownId, { state: "unknown", kind: "post", target: TARGET, body: BODY, createdAt: new Date(NOW).toISOString() });

    await store.markPendingUnknown();

    expect((await store.get(pendingId))!.state).toBe("unknown");
    expect((await store.get(deliveredId))!.state).toBe("delivered");
    expect((await store.get(failedId))!.state).toBe("failed");
    expect((await store.get(unknownId))!.state).toBe("unknown");
  });

  // Review finding (Tooling#742, round 2): the same missing-isolation shape the tick's own redrive
  // loop had -- one id's read/write throwing must not leave every id after it in list()'s snapshot
  // unvisited. Tracks write ATTEMPTS rather than asserting on which id runs "after" the failing one:
  // list() is explicitly "no particular order" and real directory iteration is filesystem-dependent,
  // so an order-based assertion could pass for the wrong reason on a filesystem that happens to visit
  // the non-failing id first (the exact fragility a round-2 reviewer found in the tick's own test).
  test("one id's write failure does not stop other pending ids from being marked unknown", async () => {
    const failingId = "a".repeat(64);
    const okId = "b".repeat(64);
    const attempted: string[] = [];
    const realStorage = makeRealStorage();
    const flakyStorage = {
      ...realStorage,
      writeJsonAtomic: async (path: string, data: unknown) => {
        attempted.push(path);
        if (path.includes(failingId)) throw new Error("disk full");
        return realStorage.writeJsonAtomic(path, data);
      },
    };
    const flakyStore = createDeliveryStore(dir, flakyStorage);
    await store.reserve(failingId, "post", TARGET, BODY, () => new Date(NOW));
    await store.reserve(okId, "post", TARGET, BODY, () => new Date(NOW));
    attempted.length = 0; // drop the two setup writes; only markPendingUnknown's own attempts matter

    await flakyStore.markPendingUnknown();

    expect(attempted.some((p) => p.includes(failingId))).toBe(true);
    expect(attempted.some((p) => p.includes(okId))).toBe(true);
    expect((await store.get(okId))!.state).toBe("unknown");
    expect((await store.get(failingId))!.state).toBe("pending"); // its own write never lands
  });
});

describe("prune", () => {
  test("a record survives at 8 days minus 1ms, and is pruned once it reaches exactly 8 days", async () => {
    const id = "a".repeat(64);
    await store.set(id, {
      state: "delivered",
      kind: "post",
      target: TARGET,
      body: BODY,
      createdAt: new Date(NOW).toISOString(),
      messageRef: null,
      url: null,
      delivery: null,
    });

    expect(await store.prune(() => new Date(NOW + 8 * DAY_MS - 1))).toEqual([]);
    expect(await store.get(id)).toBeDefined();

    expect(await store.prune(() => new Date(NOW + 8 * DAY_MS))).toEqual([id]);
    expect(await store.get(id)).toBeUndefined();
  });

  test("only entries reaching the cutoff are pruned; others are left alone", async () => {
    const oldId = "a".repeat(64);
    const freshId = "b".repeat(64);
    await store.set(oldId, {
      state: "delivered",
      kind: "post",
      target: TARGET,
      body: BODY,
      createdAt: new Date(NOW).toISOString(),
      messageRef: null,
      url: null,
      delivery: null,
    });
    await store.set(freshId, { state: "pending", kind: "post", target: TARGET, body: BODY, createdAt: new Date(NOW + DAY_MS).toISOString() });

    expect(await store.prune(() => new Date(NOW + 8 * DAY_MS))).toEqual([oldId]);
    expect(await store.get(oldId)).toBeUndefined();
    expect(await store.get(freshId)).toBeDefined();
  });

  test("prunes nothing when everything is within the window", async () => {
    const id = "a".repeat(64);
    await store.set(id, { state: "pending", kind: "post", target: TARGET, body: BODY, createdAt: new Date(NOW).toISOString() });
    expect(await store.prune(() => new Date(NOW + DAY_MS))).toEqual([]);
    expect(await store.get(id)).toBeDefined();
  });

  // Review finding (Tooling#742, round 2): same isolation shape as markPendingUnknown's test above --
  // one id's read failing while pruning must not leave a later, genuinely-old id un-pruned.
  test("one id's read failure does not stop another old id from being pruned", async () => {
    const failingId = "a".repeat(64);
    const oldId = "b".repeat(64);
    const attempted: string[] = [];
    const realStorage = makeRealStorage();
    const flakyStorage = {
      ...realStorage,
      readJsonOrFresh: async <T>(path: string, fresh: () => T, label: string): Promise<T> => {
        attempted.push(path);
        if (path.includes(failingId)) throw new Error("permission denied");
        return realStorage.readJsonOrFresh<T>(path, fresh, label);
      },
    };
    const flakyStore = createDeliveryStore(dir, flakyStorage);
    const old = new Date(NOW).toISOString();
    await store.set(failingId, { state: "pending", kind: "post", target: TARGET, body: BODY, createdAt: old });
    await store.set(oldId, { state: "pending", kind: "post", target: TARGET, body: BODY, createdAt: old });
    attempted.length = 0; // drop the two setup writes' own reads (writeJsonAtomic doesn't read, but be explicit)

    const pruned = await flakyStore.prune(() => new Date(NOW + 8 * DAY_MS));

    expect(attempted.some((p) => p.includes(failingId))).toBe(true);
    expect(attempted.some((p) => p.includes(oldId))).toBe(true);
    expect(pruned).toEqual([oldId]);
    expect(await store.get(oldId)).toBeUndefined();
    expect(await store.get(failingId)).toBeDefined(); // its read failed, so it was never even considered for deletion
  });
});
