// The shared testkit's own self-test (replaces the per-plugin test-host.test.ts copies). Pins that
// the extracted helpers work and keep their shape, so they don't bit-rot: makeFakeInteraction has no
// production consumer yet (no plugin ships an interactions() handler), and makeFakeHost's name/dataDir
// contract is the one thing that changed when the three per-plugin copies were unified.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { makeFakeDelivery, makeFakeHost, makeFakeInteraction, makeRealStorage, renameWithRetry, tmpPathFor } from "./index.js";

describe("makeFakeHost", () => {
  test("requires name and derives dataDir from it", () => {
    const host = makeFakeHost({ name: "wow" });
    expect(host.name).toBe("wow");
    expect(host.dataDir).toBe("/tmp/wow-fake-datadir");
  });

  test("applies overrides, including an explicit dataDir", () => {
    const host = makeFakeHost({ name: "warbandeer", dataDir: "/somewhere/real", env: { A: "1" } });
    expect(host.dataDir).toBe("/somewhere/real");
    expect(host.env).toEqual({ A: "1" });
  });

  test("without makeFakeDelivery, the four #736 members are absent -- the degraded, pre-#736 path", () => {
    const host = makeFakeHost({ name: "wow" });
    expect(host.post).toBeUndefined();
    expect(host.dm).toBeUndefined();
    expect(host.edit).toBeUndefined();
    expect(host.destinations).toBeUndefined();
  });
});

describe("makeFakeDelivery (#736)", () => {
  test("spreads into makeFakeHost's overrides, wiring all four members as functions", () => {
    const host = makeFakeHost({ name: "wow", ...makeFakeDelivery() });
    expect(typeof host.post).toBe("function");
    expect(typeof host.dm).toBe("function");
    expect(typeof host.edit).toBe("function");
    expect(typeof host.destinations).toBe("function");
  });

  test("post records its call and echoes the guildId with fixed channel and message ids", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "wow", ...delivery });
    const first = await host.post!("100000000000000000", "alerts", { content: "hi" });
    const second = await host.post!("999999999999999999", "news", { content: "bye" });
    expect(first.guildId).toBe("100000000000000000");
    expect(second.guildId).toBe("999999999999999999");
    expect(second.channelId).toBe(first.channelId);
    expect(second.messageId).toBe(first.messageId);
    expect(delivery.calls.post).toEqual([
      { guildId: "100000000000000000", destination: "alerts", message: { content: "hi" } },
      { guildId: "999999999999999999", destination: "news", message: { content: "bye" } },
    ]);
  });

  test("post and dm return a fresh object each call, so mutating one never leaks into the next", async () => {
    const delivery = makeFakeDelivery();
    const a = await delivery.post("1", "alerts", { content: "a" });
    a.messageId = "mutated";
    const b = await delivery.post("1", "alerts", { content: "b" });
    expect(b.messageId).not.toBe("mutated");
    const c = await delivery.dm("1", { content: "c" });
    c.messageId = "mutated";
    expect((await delivery.dm("1", { content: "d" })).messageId).not.toBe("mutated");
  });

  test("dm records its call and returns a HostDelivery with a null guildId and fixed channel and message ids", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "wow", ...delivery });
    const result = await host.dm!("42", { content: "hi" });
    expect(result.guildId).toBeNull();
    expect(result.channelId).toBe("200000000000000002");
    expect(result.messageId).toBe("300000000000000002");
    expect(delivery.calls.dm).toEqual([{ userId: "42", message: { content: "hi" } }]);
  });

  test("edit records its call and resolves with nothing", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "wow", ...delivery });
    const sent = await host.post!("100000000000000000", "alerts", { content: "hi" });
    await expect(host.edit!(sent, { content: "edited" })).resolves.toBeUndefined();
    expect(delivery.calls.edit).toEqual([{ delivery: sent, message: { content: "edited" } }]);
  });

  test("destinations answers [] and counts its calls", async () => {
    const delivery = makeFakeDelivery();
    const host = makeFakeHost({ name: "wow", ...delivery });
    expect(await host.destinations!()).toEqual([]);
    expect(await host.destinations!()).toEqual([]);
    expect(delivery.calls.destinations).toBe(2);
  });

  test("a test that needs a specific destinations list overrides it directly on makeFakeHost", async () => {
    const mapped = [{ guildId: "1", guildName: "g", destination: "news" }];
    const host = makeFakeHost({ name: "wow", ...makeFakeDelivery(), destinations: async () => mapped });
    expect(await host.destinations!()).toEqual(mapped);
  });

  test("recorded calls are snapshots: mutating the arguments afterwards doesn't change them", async () => {
    const delivery = makeFakeDelivery();
    const message = { content: "before" };
    const target = { guildId: "1", channelId: "2", messageId: "3" };
    await delivery.post("1", "alerts", message);
    await delivery.dm("9", message);
    await delivery.edit(target, message);
    message.content = "after";
    target.messageId = "mutated";
    expect(delivery.calls.post[0]!.message).toEqual({ content: "before" });
    expect(delivery.calls.dm[0]!.message).toEqual({ content: "before" });
    expect(delivery.calls.edit[0]).toEqual({ delivery: { guildId: "1", channelId: "2", messageId: "3" }, message: { content: "before" } });
  });

  test("two instances never share recorded calls", async () => {
    const a = makeFakeDelivery();
    const b = makeFakeDelivery();
    await a.dm("1", { content: "a" });
    expect(a.calls.dm).toHaveLength(1);
    expect(b.calls.dm).toHaveLength(0);
  });
});

describe("makeRealStorage", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "testkit-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writeJsonAtomic then readJsonOrFresh round-trips", async () => {
    const storage = makeRealStorage();
    const path = join(dir, "round-trip.json");
    await storage.writeJsonAtomic(path, { hello: "world" });
    expect(await storage.readJsonOrFresh(path, () => ({ hello: "fresh" }), "test")).toEqual({ hello: "world" });
  });

  test("readJsonOrFresh returns fresh for a missing file", async () => {
    const storage = makeRealStorage();
    expect(await storage.readJsonOrFresh(join(dir, "absent.json"), () => ({ n: 0 }), "test")).toEqual({ n: 0 });
  });

  test("readJsonOrFresh returns fresh for a corrupt file and leaves a .corrupt-* sibling", async () => {
    const storage = makeRealStorage();
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{ not json");
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await storage.readJsonOrFresh(path, () => ({ n: 0 }), "test")).toEqual({ n: 0 });
    } finally {
      quiet.mockRestore();
    }
    const siblings = readdirSync(dir).filter((f) => f.startsWith("corrupt.json.corrupt-"));
    expect(siblings).toHaveLength(1);
    expect(readFileSync(join(dir, siblings[0]!), "utf8")).toBe("{ not json");
  });

  test("createJsonWriter keeps the last save in call order", async () => {
    const storage = makeRealStorage();
    const path = join(dir, "writer.json");
    const writer = storage.createJsonWriter<{ n: number }>(path);
    await Promise.all(Array.from({ length: 10 }, (_, n) => writer.save({ n })));
    expect(await storage.readJsonOrFresh(path, () => ({ n: -1 }), "test")).toEqual({ n: 9 });
  });

  test("createJsonWriter still saves after a failed save", async () => {
    const storage = makeRealStorage();
    // A regular file sits where the parent directory should be, so mkdirSync throws before any rename
    // (no Windows retry loop, no leftover tmp file).
    const parent = join(dir, "writer-fail-parent");
    writeFileSync(parent, "not a directory");
    const path = join(parent, "w.json");
    const writer = storage.createJsonWriter<{ n: number }>(path);
    await expect(writer.save({ n: 1 })).rejects.toBeDefined();
    rmSync(parent);
    await writer.save({ n: 2 });
    expect(await storage.readJsonOrFresh(path, () => ({ n: -1 }), "test")).toEqual({ n: 2 });
  });

  test("createKeyedJsonMutator runs the next update after one mutate throws", async () => {
    const storage = makeRealStorage();
    const path = join(dir, "mutate-throws.json");
    const mutator = storage.createKeyedJsonMutator<{ n: number }>();
    const failed = mutator.update(path, () => ({ n: 0 }), () => {
      throw new Error("boom");
    }, "test");
    const after = mutator.update(path, () => ({ n: 0 }), (cur) => ({ n: cur.n + 1 }), "test");
    await expect(failed).rejects.toThrow("boom");
    await after;
    expect(await storage.readJsonOrFresh(path, () => ({ n: -1 }), "test")).toEqual({ n: 1 });
  });

  test("createKeyedJsonMutator serializes concurrent updates on one path", async () => {
    const storage = makeRealStorage();
    const path = join(dir, "counter.json");
    const mutator = storage.createKeyedJsonMutator<{ n: number }>();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        mutator.update(path, () => ({ n: 0 }), (cur) => ({ n: cur.n + 1 }), "test"),
      ),
    );
    expect(await storage.readJsonOrFresh(path, () => ({ n: -1 }), "test")).toEqual({ n: 20 });
  });
});

describe("renameWithRetry", () => {
  const lockError = (code: string) => Object.assign(new Error(code), { code });

  test("retries a transient EPERM/EBUSY/EACCES and then succeeds", async () => {
    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
      let calls = 0;
      await renameWithRetry("a", "b", {
        delayMs: 0,
        rename: () => {
          if (++calls < 3) throw lockError(code);
        },
      });
      expect(calls).toBe(3);
    }
  });

  test("throws a non-lock error on the first attempt, without retrying", async () => {
    let calls = 0;
    await expect(
      renameWithRetry("a", "b", {
        delayMs: 0,
        rename: () => {
          calls++;
          throw lockError("ENOENT");
        },
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  test("gives up with the lock error once the attempt budget is spent", async () => {
    let calls = 0;
    await expect(
      renameWithRetry("a", "b", {
        maxAttempts: 4,
        delayMs: 0,
        rename: () => {
          calls++;
          throw lockError("EBUSY");
        },
      }),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(calls).toBe(4);
  });
});

describe("tmp file names", () => {
  test("tmpPathFor differs by pid, token and counter", () => {
    const names = new Set([
      tmpPathFor("/d/x.json", 1, "aa", 1),
      tmpPathFor("/d/x.json", 2, "aa", 1),
      tmpPathFor("/d/x.json", 1, "bb", 1),
      tmpPathFor("/d/x.json", 1, "aa", 2),
    ]);
    expect(names.size).toBe(4);
    expect(tmpPathFor("/d/x.json", 7, "tok", 3)).toBe("/d/x.json.7.tok.3.tmp");
  });

  test("concurrent writes to one path leave valid JSON and no stray tmp files", async () => {
    const d = mkdtempSync(join(tmpdir(), "testkit-tmp-"));
    try {
      const storage = makeRealStorage();
      const path = join(d, "shared.json");
      await Promise.all(Array.from({ length: 20 }, (_, n) => storage.writeJsonAtomic(path, { n })));
      const final = (await storage.readJsonOrFresh(path, () => ({ n: -1 }), "test")) as { n: number };
      expect(final.n).toBeGreaterThanOrEqual(0);
      expect(readdirSync(d)).toEqual(["shared.json"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("makeFakeInteraction", () => {
  test("reply() leaves the interaction replied", async () => {
    const interaction = makeFakeInteraction("plugin:x");
    await interaction.reply({ content: "ok" });
    expect(interaction.replied).toBe(true);
  });

  test("carries the FULL customId through, unstripped", () => {
    const interaction = makeFakeInteraction("plugin:action:sub");
    expect(interaction.customId).toBe("plugin:action:sub");
  });

  test("defaults replied/deferred to false, and reply() resolves", async () => {
    const interaction = makeFakeInteraction("plugin:x");
    expect(interaction.replied).toBe(false);
    expect(interaction.deferred).toBe(false);
    await expect(interaction.reply({ content: "ok" })).resolves.toBeUndefined();
  });

  test("overrides replied/deferred/reply", async () => {
    let replyCalledWith: unknown;
    const interaction = makeFakeInteraction("plugin:x", {
      replied: true,
      deferred: true,
      reply: async (opts: unknown) => {
        replyCalledWith = opts;
      },
    });
    expect(interaction.replied).toBe(true);
    expect(interaction.deferred).toBe(true);
    await interaction.reply({ content: "hi" });
    expect(replyCalledWith).toEqual({ content: "hi" });
  });
});
