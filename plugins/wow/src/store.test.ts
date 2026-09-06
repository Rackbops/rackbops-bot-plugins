import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakeHost } from "./test-host.js";
import { initWowStore, wowState, saveWowState, _resetWowStore, type WowState } from "./store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wow-store-"));
  _resetWowStore();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const readJson = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), "utf8"));

describe("initWowStore", () => {
  test("seeds wow.json from the bot's state.json when wow.json is absent, keeping only the three WoW keys", async () => {
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        seenReleaseIds: { "a/b": [1] },
        dmfAnnouncedFor: "2026-9",
        weeklyAnnouncedFor: "2026-09-01T15:00:00.000Z",
        realmStatus: "UP",
        pendingUpdateReport: { some: "thing" },
      }),
    );
    await initWowStore(makeFakeHost({ dataDir: dir }));
    const expected: WowState = { dmfAnnouncedFor: "2026-9", weeklyAnnouncedFor: "2026-09-01T15:00:00.000Z", realmStatus: "UP" };
    expect(wowState()).toEqual(expected);
    expect(existsSync(join(dir, "wow.json"))).toBe(true);
    expect(readJson("wow.json")).toEqual(expected);
  });

  test("does NOT re-seed when wow.json already exists (mutation: seeding unconditionally)", async () => {
    writeFileSync(join(dir, "wow.json"), JSON.stringify({ dmfAnnouncedFor: "existing" }));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ dmfAnnouncedFor: "from-state" }));
    await initWowStore(makeFakeHost({ dataDir: dir }));
    expect(wowState()).toEqual({ dmfAnnouncedFor: "existing" });
  });

  test("seeds empty when state.json is absent (a fresh install)", async () => {
    await initWowStore(makeFakeHost({ dataDir: dir }));
    expect(wowState()).toEqual({});
    expect(existsSync(join(dir, "wow.json"))).toBe(true);
  });

  test("seeds empty from a CORRUPT state.json WITHOUT moving it aside (mutation: using readJsonOrFresh)", async () => {
    writeFileSync(join(dir, "state.json"), "{ this is not valid json ");
    await initWowStore(makeFakeHost({ dataDir: dir }));
    expect(wowState()).toEqual({});
    // The bot's state.json is not ours to quarantine — no `.corrupt-*` sibling, and it stays in place.
    expect(readdirSync(dir).some((f) => f.startsWith("state.json.corrupt"))).toBe(false);
    expect(existsSync(join(dir, "state.json"))).toBe(true);
  });

  test("saveWowState persists later mutations to wow.json", async () => {
    await initWowStore(makeFakeHost({ dataDir: dir }));
    wowState().dmfAnnouncedFor = "2026-10";
    await saveWowState();
    expect(readJson("wow.json")).toEqual({ dmfAnnouncedFor: "2026-10" });
  });
});
