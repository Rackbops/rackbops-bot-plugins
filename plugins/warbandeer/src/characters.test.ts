import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteCharacterSnapshotFrom,
  initCharacters,
  loadCharacterSnapshotsFrom,
  MAX_ACCOUNT_LABEL_LENGTH,
  MAX_CHARACTERS_PER_SNAPSHOT,
  MAX_STRING_FIELD_LENGTH,
  saveCharacterSnapshotTo,
  validateAccountLabel,
  validateCharacterPayload,
} from "./characters.js";
import { makeRealStorage } from "./test-host.js";

const realisticCharacter = {
  realm: "Argent Dawn",
  guid: "Player-1234-00000001",
  classKey: "MAGE",
  classId: 8,
  className: "Mage",
  isAlliance: true,
  level: 80,
  ilvl: 620,
  currency: { gold: 123456, HeroDawncrest: { quantity: 500, max: 2000, capped: false } },
};

describe("validateCharacterPayload", () => {
  test("accepts a realistic desktop-shaped payload", () => {
    const result = validateCharacterPayload(
      { warband: { bankGold: 999 }, characters: [realisticCharacter] },
      "Main",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.accountLabel).toBe("Main");
      expect(result.snapshot.warband.bankGold).toBe(999);
      expect(result.snapshot.characters).toEqual([realisticCharacter]);
    }
  });

  test("accountLabel comes from the parameter, not the body", () => {
    const result = validateCharacterPayload({ accountLabel: "Spoofed", characters: [] }, "Real");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.accountLabel).toBe("Real");
  });

  test("defaults bankGold to 0 when warband is absent or malformed", () => {
    const noWarband = validateCharacterPayload({ characters: [] }, "Main");
    expect(noWarband.ok && noWarband.snapshot.warband.bankGold).toBe(0);
    const badWarband = validateCharacterPayload({ warband: { bankGold: "lots" }, characters: [] }, "Main");
    expect(badWarband.ok && badWarband.snapshot.warband.bankGold).toBe(0);
  });

  test("rejects a non-object payload", () => {
    expect(validateCharacterPayload("nope", "Main")).toMatchObject({ ok: false });
    expect(validateCharacterPayload(null, "Main")).toMatchObject({ ok: false });
    expect(validateCharacterPayload([], "Main")).toMatchObject({ ok: false });
  });

  test("rejects a missing or non-array characters field", () => {
    expect(validateCharacterPayload({}, "Main")).toMatchObject({ ok: false });
    expect(validateCharacterPayload({ characters: "nope" }, "Main")).toMatchObject({ ok: false });
  });

  test("rejects a non-object entry inside characters", () => {
    const result = validateCharacterPayload({ characters: ["not an object"] }, "Main");
    expect(result).toMatchObject({ ok: false });
  });

  test("rejects more characters than the cap", () => {
    const characters = Array.from({ length: MAX_CHARACTERS_PER_SNAPSHOT + 1 }, (_, i) => ({ name: `c${i}` }));
    expect(validateCharacterPayload({ characters }, "Main")).toMatchObject({ ok: false });
  });

  test("accepts exactly the cap", () => {
    const characters = Array.from({ length: MAX_CHARACTERS_PER_SNAPSHOT }, (_, i) => ({ name: `c${i}` }));
    expect(validateCharacterPayload({ characters }, "Main")).toMatchObject({ ok: true });
  });

  test("rejects a string field over the length cap", () => {
    const characters = [{ realm: "x".repeat(MAX_STRING_FIELD_LENGTH + 1) }];
    expect(validateCharacterPayload({ characters }, "Main")).toMatchObject({ ok: false });
  });

  test("rejects nesting past the depth cap", () => {
    let value: unknown = "leaf";
    for (let i = 0; i < 10; i++) value = { nested: value };
    const result = validateCharacterPayload({ characters: [{ deep: value }] }, "Main");
    expect(result).toMatchObject({ ok: false });
  });

  test("rejects an object with too many keys (a key-count bomb)", () => {
    const bomb: Record<string, number> = {};
    for (let i = 0; i < 500; i++) bomb[`k${i}`] = i;
    const result = validateCharacterPayload({ characters: [{ currency: bomb }] }, "Main");
    expect(result).toMatchObject({ ok: false });
  });

  test("rejects an oversized object key WITHOUT echoing it into the error message", () => {
    const hugeKey = "k".repeat(MAX_STRING_FIELD_LENGTH + 1);
    const result = validateCharacterPayload({ characters: [{ [hugeKey]: 1 }] }, "Main");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.length).toBeLessThan(100);
      expect(result.error).not.toContain(hugeKey);
    }
  });
});

describe("validateAccountLabel", () => {
  test("accepts a normal label", () => {
    expect(validateAccountLabel("Main")).toEqual({ ok: true, accountLabel: "Main" });
  });

  test("accepts exactly the length cap", () => {
    const label = "x".repeat(MAX_ACCOUNT_LABEL_LENGTH);
    expect(validateAccountLabel(label)).toEqual({ ok: true, accountLabel: label });
  });

  test("rejects a label over the length cap", () => {
    expect(validateAccountLabel("x".repeat(MAX_ACCOUNT_LABEL_LENGTH + 1))).toMatchObject({ ok: false });
  });

  test("rejects an empty or whitespace-only label", () => {
    expect(validateAccountLabel("")).toMatchObject({ ok: false });
    expect(validateAccountLabel("   ")).toMatchObject({ ok: false });
  });

  test("trims surrounding whitespace and returns the trimmed value", () => {
    expect(validateAccountLabel("  Main  ")).toEqual({ ok: true, accountLabel: "Main" });
  });

  test("length cap applies to the TRIMMED label", () => {
    const padded = ` ${"x".repeat(MAX_ACCOUNT_LABEL_LENGTH)} `; // untrimmed length exceeds the cap, trimmed doesn't
    expect(validateAccountLabel(padded)).toMatchObject({ ok: true });
  });

  test("rejects control characters (including newlines) even within the length cap", () => {
    expect(validateAccountLabel("Main\nInjected log line")).toMatchObject({ ok: false });
    expect(validateAccountLabel("Main\x00null")).toMatchObject({ ok: false });
    expect(validateAccountLabel("Main\ttab")).toMatchObject({ ok: false });
  });
});

// Real file I/O against a temp dir — never the actual data/characters/. initCharacters wires the
// injected (real) HostStorage + a fresh keyed mutator per test; the mutator is keyed by full path,
// so pointing the *From helpers at each test's temp dir works.
describe("saveCharacterSnapshotTo / loadCharacterSnapshotsFrom", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "warbandeer-characters-test-"));
    initCharacters(dir, makeRealStorage());
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips a snapshot for a fresh user", async () => {
    await saveCharacterSnapshotTo(dir, "123456789012345678", { accountLabel: "Main", warband: { bankGold: 1 }, characters: [] }, 1000);
    const stored = await loadCharacterSnapshotsFrom(dir, "123456789012345678");
    expect(stored.snapshots).toEqual([{ accountLabel: "Main", warband: { bankGold: 1 }, characters: [], receivedAt: 1000 }]);
  });

  test("a second push for the same accountLabel replaces the prior snapshot wholesale", async () => {
    const id = "123456789012345678";
    await saveCharacterSnapshotTo(dir, id, { accountLabel: "Main", warband: { bankGold: 1 }, characters: [realisticCharacter] }, 1000);
    await saveCharacterSnapshotTo(dir, id, { accountLabel: "Main", warband: { bankGold: 2 }, characters: [] }, 2000);
    const stored = await loadCharacterSnapshotsFrom(dir, id);
    expect(stored.snapshots).toEqual([{ accountLabel: "Main", warband: { bankGold: 2 }, characters: [], receivedAt: 2000 }]);
  });

  test("a push for a different accountLabel is appended, not replaced", async () => {
    const id = "123456789012345678";
    await saveCharacterSnapshotTo(dir, id, { accountLabel: "Main", warband: { bankGold: 1 }, characters: [] }, 1000);
    await saveCharacterSnapshotTo(dir, id, { accountLabel: "Alts", warband: { bankGold: 1 }, characters: [] }, 1000);
    const stored = await loadCharacterSnapshotsFrom(dir, id);
    expect(stored.snapshots.map((s) => s.accountLabel).sort()).toEqual(["Alts", "Main"]);
  });

  test("two different users get isolated files", async () => {
    await saveCharacterSnapshotTo(dir, "111111111111111111", { accountLabel: "Main", warband: { bankGold: 1 }, characters: [] }, 1000);
    const storedB = await loadCharacterSnapshotsFrom(dir, "222222222222222222");
    expect(storedB.snapshots).toEqual([]);
  });

  test("two concurrent pushes for the SAME user (different accountLabels) both land — neither is lost", async () => {
    const id = "123456789012345678";
    await Promise.all([
      saveCharacterSnapshotTo(dir, id, { accountLabel: "Main", warband: { bankGold: 1 }, characters: [] }, 1000),
      saveCharacterSnapshotTo(dir, id, { accountLabel: "Alts", warband: { bankGold: 2 }, characters: [] }, 1000),
    ]);
    const stored = await loadCharacterSnapshotsFrom(dir, id);
    expect(stored.snapshots.map((s) => s.accountLabel).sort()).toEqual(["Alts", "Main"]);
  });

  test("20 concurrent pushes for the same user, distinct labels, all land with none dropped", async () => {
    const id = "123456789012345678";
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        saveCharacterSnapshotTo(dir, id, { accountLabel: `Label${i}`, warband: { bankGold: i }, characters: [] }, 1000),
      ),
    );
    const stored = await loadCharacterSnapshotsFrom(dir, id);
    expect(stored.snapshots).toHaveLength(20);
    expect(new Set(stored.snapshots.map((s) => s.accountLabel)).size).toBe(20);
  });

  test("an absent user resolves an empty snapshot list, not an error", async () => {
    const stored = await loadCharacterSnapshotsFrom(dir, "333333333333333333");
    expect(stored).toEqual({ snapshots: [] });
  });

  test("a non-snowflake id is refused rather than used as a path", async () => {
    await expect(loadCharacterSnapshotsFrom(dir, "../../etc/passwd")).rejects.toThrow();
  });
});

describe("deleteCharacterSnapshotFrom", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "warbandeer-characters-delete-test-"));
    initCharacters(dir, makeRealStorage());
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("removes the named label's snapshot, leaving others intact", async () => {
    const id = "123456789012345678";
    await saveCharacterSnapshotTo(dir, id, { accountLabel: "Main", warband: { bankGold: 1 }, characters: [] }, 1000);
    await saveCharacterSnapshotTo(dir, id, { accountLabel: "Alts", warband: { bankGold: 1 }, characters: [] }, 1000);
    await deleteCharacterSnapshotFrom(dir, id, "Main");
    const stored = await loadCharacterSnapshotsFrom(dir, id);
    expect(stored.snapshots.map((s) => s.accountLabel)).toEqual(["Alts"]);
  });

  test("a no-op when the label was never stored — not an error", async () => {
    const id = "123456789012345678";
    await deleteCharacterSnapshotFrom(dir, id, "NeverLinked");
    const stored = await loadCharacterSnapshotsFrom(dir, id);
    expect(stored.snapshots).toEqual([]);
  });
});
