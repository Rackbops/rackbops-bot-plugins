import { describe, expect, test } from "bun:test";
import { decideRealmTransition, normalizeRealmName, matchRealmIndex } from "./realm.js";

describe("decideRealmTransition", () => {
  test("first observation seeds silently (no announcement)", () => {
    expect(decideRealmTransition(undefined, "UP")).toBeNull();
    expect(decideRealmTransition(undefined, "DOWN")).toBeNull();
  });

  test("no announcement while status is unchanged", () => {
    expect(decideRealmTransition("UP", "UP")).toBeNull();
    expect(decideRealmTransition("DOWN", "DOWN")).toBeNull();
  });

  test("announces down when the realm goes UP → DOWN", () => {
    expect(decideRealmTransition("UP", "DOWN")).toBe("down");
  });

  test("announces up when the realm recovers DOWN → UP", () => {
    expect(decideRealmTransition("DOWN", "UP")).toBe("up");
  });
});

describe("normalizeRealmName", () => {
  test("strips a literal hyphen the same as it strips a space", () => {
    // The whole point (#32): a name-hyphen and a word-separating one must normalize identically,
    // so matching against the realm index doesn't have to tell them apart either.
    expect(normalizeRealmName("Azjol-Nerub")).toBe(normalizeRealmName("azjolnerub"));
    expect(normalizeRealmName("Arak-arahm")).toBe(normalizeRealmName("arakarahm"));
  });

  test("case-folds", () => {
    expect(normalizeRealmName("ARGENT DAWN")).toBe(normalizeRealmName("argent dawn"));
  });

  test("drops parentheses and the space around them", () => {
    expect(normalizeRealmName("Aggra (Português)")).toBe("aggraportuguês");
  });

  test("keeps accents rather than folding them", () => {
    expect(normalizeRealmName("Chants Éternels")).toBe("chantséternels");
  });

  test("drops apostrophes", () => {
    expect(normalizeRealmName("Pozzo dell'Eternità")).toBe("pozzodelleternità");
  });
});

describe("matchRealmIndex", () => {
  const INDEX = [
    { name: "Azjol-Nerub", slug: "azjolnerub" },
    { name: "Arak-arahm", slug: "arakarahm" },
    { name: "Argent Dawn", slug: "argent-dawn" },
  ];

  test("resolves the two realms named in #32", () => {
    expect(matchRealmIndex(INDEX, "Azjol-Nerub")).toBe("azjolnerub");
    expect(matchRealmIndex(INDEX, "Arak-arahm")).toBe("arakarahm");
  });

  test("matches case-insensitively", () => {
    expect(matchRealmIndex(INDEX, "azjol-nerub")).toBe("azjolnerub");
  });

  test("returns undefined when nothing matches", () => {
    expect(matchRealmIndex(INDEX, "Not A Real Realm")).toBeUndefined();
  });
});
