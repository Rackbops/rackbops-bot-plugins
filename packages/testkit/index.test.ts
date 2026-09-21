// The shared testkit's own self-test (replaces the per-plugin test-host.test.ts copies). Pins that
// the extracted helpers work and keep their shape, so they don't bit-rot: makeFakeInteraction has no
// production consumer yet (no plugin ships an interactions() handler), and makeFakeHost's name/dataDir
// contract is the one thing that changed when the three per-plugin copies were unified.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeFakeHost, makeFakeInteraction, makeRealStorage } from "./index.js";

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

describe("makeFakeInteraction", () => {
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
