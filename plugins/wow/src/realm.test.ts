import { describe, expect, test } from "bun:test";
import { config } from "./config.js";
import {
  decideRealmTransition,
  normalizeRealmName,
  matchRealmIndex,
  connectedRealmSearchUrl,
} from "./realm.js";

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

describe("connectedRealmSearchUrl", () => {
  // #18: this must be the only place the connected-realm search URL is built, and the slug must
  // be encoded — a dropped encodeURIComponent regresses silently for any slug containing a
  // character the config-driven callers never happen to exercise in tests.
  //
  // `config.region` is read at call time from the shared module singleton, which other test
  // files (config.test.ts) mutate for the life of the process — so the expected URL is built
  // from whatever `config.region` actually is right now, not a hardcoded "us"/"eu".
  test("encodes the slug and pins the full URL shape", () => {
    expect(connectedRealmSearchUrl("test realm")).toBe(
      `https://${config.region}.api.blizzard.com/data/wow/search/connected-realm` +
        `?namespace=dynamic-${config.region}&realms.slug=test%20realm&_pageSize=1`,
    );
  });

  test("is a no-op for an already-ASCII hyphenated slug", () => {
    expect(connectedRealmSearchUrl("argent-dawn")).toBe(
      `https://${config.region}.api.blizzard.com/data/wow/search/connected-realm` +
        `?namespace=dynamic-${config.region}&realms.slug=argent-dawn&_pageSize=1`,
    );
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
