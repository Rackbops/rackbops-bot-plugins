import { describe, expect, test } from "bun:test";
import { makeFakeDelivery, makeFakeHost } from "../../../packages/testkit/index.js";
import { attemptDelivery, createDrainLock, drainAndPersist } from "./drain.js";
import type { StoredDelivery } from "./protocol.js";

const REQUEST_ID = "a".repeat(64);
const TARGET = { guildId: "111111111111111111", destination: "alerts" };

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

describe("attemptDelivery: with host.post", () => {
  test("delivers, recording the exact arguments, and message_ref is the request's own id", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const result = await attemptDelivery(host, REQUEST_ID, "post", TARGET, { content: "hi" }, makeLog().log);

    expect(delivery.calls.post).toEqual([{ guildId: TARGET.guildId, destination: TARGET.destination, message: { content: "hi" } }]);
    expect(result.state).toBe("delivered");
    if (result.state === "delivered") expect(result.messageRef).toBe(REQUEST_ID);
  });

  test("passes card and links through when present", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const card = { title: "t" };
    const links = [{ label: "l", url: "https://example.com" }];
    await attemptDelivery(host, REQUEST_ID, "post", TARGET, { content: "hi", card, links }, makeLog().log);
    expect(delivery.calls.post).toEqual([{ guildId: TARGET.guildId, destination: TARGET.destination, message: { content: "hi", card, links } }]);
  });

  test("the url is built from the returned HostDelivery, and delivery is carried through", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const result = await attemptDelivery(host, REQUEST_ID, "post", TARGET, { content: "hi" }, makeLog().log);
    expect(result.state).toBe("delivered");
    if (result.state !== "delivered") throw new Error("unreachable");
    // makeFakeDelivery's fixed post-delivery value:
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
    const result = await attemptDelivery(host, REQUEST_ID, "post", TARGET, { content: "secret content" }, log);
    expect(result).toEqual({ state: "failed", code: "UPSTREAM_UNAVAILABLE" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.message).not.toContain("secret content");
    expect(calls[0]!.message).toContain(REQUEST_ID);
  });
});

describe("attemptDelivery: without host.post (announce fallback)", () => {
  test("announces content-only, recording the exact arguments", async () => {
    const announced: [string, string | undefined][] = [];
    const host = makeFakeHost({
      name: "mcp",
      announce: async (message, destination) => void announced.push([message, destination]),
    });
    const result = await attemptDelivery(host, REQUEST_ID, "post", TARGET, { content: "hi" }, makeLog().log);
    expect(announced).toEqual([["hi", "alerts"]]);
    expect(result).toEqual({ state: "delivered", messageRef: null, url: null, delivery: null });
  });

  test("a card present with no host.post is CAPABILITY_UNAVAILABLE, with no announce call", async () => {
    const announced: unknown[] = [];
    const host = makeFakeHost({ name: "mcp", announce: async (m) => void announced.push(m) });
    const result = await attemptDelivery(host, REQUEST_ID, "post", TARGET, { content: "hi", card: { title: "t" } }, makeLog().log);
    expect(result).toEqual({ state: "failed", code: "CAPABILITY_UNAVAILABLE" });
    expect(announced).toEqual([]);
  });

  test("a non-empty links list with no host.post is CAPABILITY_UNAVAILABLE, with no announce call", async () => {
    const announced: unknown[] = [];
    const host = makeFakeHost({ name: "mcp", announce: async (m) => void announced.push(m) });
    const result = await attemptDelivery(
      host,
      REQUEST_ID,
      "post",
      TARGET,
      { content: "hi", links: [{ label: "l", url: "https://example.com" }] },
      makeLog().log,
    );
    expect(result).toEqual({ state: "failed", code: "CAPABILITY_UNAVAILABLE" });
    expect(announced).toEqual([]);
  });

  test("an empty links array is treated the same as no links -- announce still runs", async () => {
    const announced: unknown[] = [];
    const host = makeFakeHost({ name: "mcp", announce: async (m) => void announced.push(m) });
    const result = await attemptDelivery(host, REQUEST_ID, "post", TARGET, { content: "hi", links: [] }, makeLog().log);
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
    const result = await attemptDelivery(host, REQUEST_ID, "post", TARGET, { content: "secret content" }, log);
    expect(result).toEqual({ state: "failed", code: "UPSTREAM_UNAVAILABLE" });
    expect(calls[0]!.message).not.toContain("secret content");
  });
});

describe("attemptDelivery: kind dm/edit never actually deliver, whatever reaches the drain layer", () => {
  // Review finding (Tooling#742): the drain layer used to be kind-blind -- a dm/edit record that
  // somehow reached "unknown" (a process killed between reserve()'s unconditional pending write and
  // the immediate-failure set that follows it in http.ts, before the tick's next activate() ever
  // runs) would have been re-driven by the tick as an ordinary post, actually reaching Discord for a
  // capability the bridge advertises as unsupported. This is the defense at the layer that actually
  // calls host.post/announce, independent of http.ts already refusing dm/edit at creation time.
  for (const kind of ["dm", "edit"] as const) {
    test(`${kind}: CAPABILITY_UNAVAILABLE with no host.post or host.announce call, even with a fully-formed post-shaped target/body`, async () => {
      const delivery = makeFakeDelivery();
      const announced: unknown[] = [];
      const host = makeFakeHost({ name: "mcp", ...delivery, announce: async (m) => void announced.push(m) });
      const result = await attemptDelivery(host, REQUEST_ID, kind, TARGET, { content: "hi" }, makeLog().log);
      expect(result).toEqual({ state: "failed", code: "CAPABILITY_UNAVAILABLE" });
      expect(delivery.calls.post).toEqual([]);
      expect(announced).toEqual([]);
    });
  }
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

  test("persists a delivered outcome via setState, preserving kind/target/body/createdAt", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const stored: Record<string, StoredDelivery> = {};
    await drainAndPersist(host, REQUEST_ID, entry, async (id, value) => void (stored[id] = value), makeLog().log);
    expect(stored[REQUEST_ID]).toMatchObject({ state: "delivered", kind: "post", target: TARGET, body: { content: "hi" }, createdAt: entry.createdAt });
  });

  test("persists a failed outcome the same way", async () => {
    const host = makeFakeHost({
      name: "mcp",
      post: async () => {
        throw new Error("boom");
      },
    });
    const stored: Record<string, StoredDelivery> = {};
    await drainAndPersist(host, REQUEST_ID, entry, async (id, value) => void (stored[id] = value), makeLog().log);
    expect(stored[REQUEST_ID]).toEqual({ state: "failed", kind: "post", target: TARGET, body: { content: "hi" }, createdAt: entry.createdAt, code: "UPSTREAM_UNAVAILABLE" });
  });

  test("a dm/edit entry (however it got here -- e.g. the tick re-driving an unknown left by a crash) is refused without touching the host", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "mcp", ...delivery });
    const dmEntry = { ...entry, kind: "dm" as const };
    const stored: Record<string, StoredDelivery> = {};
    await drainAndPersist(host, REQUEST_ID, dmEntry, async (id, value) => void (stored[id] = value), makeLog().log);
    expect(stored[REQUEST_ID]).toEqual({ ...dmEntry, state: "failed", code: "CAPABILITY_UNAVAILABLE" });
    expect(delivery.calls.post).toEqual([]);
  });

  test("does not manage the lock itself -- the caller must acquire and release it", async () => {
    const lock = createDrainLock();
    const host = makeFakeHost({ name: "mcp", ...makeFakeDelivery() });
    // drainAndPersist takes no lock parameter at all; calling it twice concurrently for the same id
    // (as a caller who forgot to check tryStart first would) runs both, proving the guard has to
    // live at the call site, matching how http.ts and index.ts's tick both call tryStart themselves.
    await Promise.all([
      drainAndPersist(host, REQUEST_ID, entry, async () => {}, makeLog().log),
      drainAndPersist(host, REQUEST_ID, entry, async () => {}, makeLog().log),
    ]);
    expect(lock.tryStart(REQUEST_ID)).toBe(true); // the lock was never touched by drainAndPersist
  });
});
