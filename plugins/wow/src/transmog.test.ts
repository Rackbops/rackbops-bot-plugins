import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EquipmentResponse } from "./transmog.js";
// fetchTransmog reads the plugin's `config.region`, which defaults to "us" until initWowConfig runs;
// these tests mock fetch by URL substring (region-agnostic), so the default is all they need.
import {
  buildCustomSet,
  realmSlug,
  formatTransmogReply,
  OUTFIT_VALUE_COUNT,
  pickRetrySlug,
  fetchTransmog,
  TransmogLookupError,
} from "./transmog.js";
import { _resetBlizzardToken } from "./blizzard.js";
import { _resetRealmIndex } from "./realm.js";

// A slot with a transmog, shaped as the equipment endpoint returns it.
const mog = (
  type: string,
  id: number,
  name: string,
  second?: { id: number; name: string },
) => ({
  slot: { type },
  transmog: {
    item: { name },
    item_modified_appearance_id: id,
    ...(second
      ? { second_item: { name: second.name }, second_item_modified_appearance_id: second.id }
      : {}),
  },
});

/** A slot that is equipped but NOT transmogged — the payload simply omits `transmog`. */
const plain = (type: string) => ({ slot: { type }, transmog: undefined });

describe("buildCustomSet", () => {
  test("emits 17 values in the addon's wire order", () => {
    const { code } = buildCustomSet({
      equipped_items: [
        mog("HEAD", 101, "Helm"),
        mog("SHOULDER", 102, "Pauldrons", { id: 103, name: "Left Pauldron" }),
        mog("BACK", 104, "Cloak"),
        mog("CHEST", 105, "Robe"),
        mog("SHIRT", 106, "Shirt"),
        mog("TABARD", 107, "Tabard"),
        mog("WRIST", 108, "Bracers"),
        mog("HANDS", 109, "Gloves"),
        mog("WAIST", 110, "Belt"),
        mog("LEGS", 111, "Leggings"),
        mog("FEET", 112, "Boots"),
        mog("MAIN_HAND", 113, "Sword", { id: 114, name: "Sword Skin" }),
        mog("OFF_HAND", 115, "Shield"),
      ],
    });
    // Head, Shoulder, Shoulder2, Back, Chest, Shirt, Tabard, Wrist, Hands, Waist, Legs, Feet,
    // MainHand, MainHand2, MainHandIllusion, OffHand, OffHandIllusion
    expect(code).toBe(
      "/customset v1 101,102,103,104,105,106,107,108,109,110,111,112,113,114,0,115,0",
    );
    expect(code.split(" ")[2]!.split(",")).toHaveLength(OUTFIT_VALUE_COUNT);
  });

  test("always emits 17 values, even for a character wearing nothing", () => {
    const { code, bare, empty } = buildCustomSet({ equipped_items: [] });
    const values = code.split(" ")[2]!.split(",");
    expect(values).toHaveLength(OUTFIT_VALUE_COUNT);
    expect(values.every((v) => v === "0")).toBe(true);
    // Nothing equipped is not the same as nothing transmogged.
    expect(bare).toHaveLength(0);
    expect(empty).toHaveLength(13);
  });

  test("an equipped-but-untransmogged slot is bare; an unequipped one is empty", () => {
    // The distinction drives the reply: only `bare` leaves the look incomplete. An empty off hand
    // is what a two-hander looks like, and calling that incomplete would be wrong.
    const { code, bare, empty, named } = buildCustomSet({
      equipped_items: [mog("HEAD", 101, "Helm"), plain("CHEST")],
    });
    expect(code.startsWith("/customset v1 101,0,0,0,0,")).toBe(true);
    expect(bare).toEqual(["CHEST"]);
    expect(empty).toContain("OFF_HAND");
    expect(empty).not.toContain("CHEST");
    expect(named).toEqual([{ slot: "HEAD", name: "Helm" }]);
  });

  test("a secondary that merely echoes the primary encodes 0", () => {
    // The REST payload repeats the primary when a slot has no distinct secondary; the in-game
    // producer emits 0, and 0 is what the format means by "none". Both must agree.
    const { code } = buildCustomSet({
      equipped_items: [mog("SHOULDER", 107743, "Pauldrons", { id: 107743, name: "Pauldrons" })],
    });
    expect(code).toBe("/customset v1 0,107743,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0");
  });

  test("a genuinely distinct secondary is preserved", () => {
    const { code } = buildCustomSet({
      equipped_items: [mog("SHOULDER", 1, "Right", { id: 2, name: "Left" })],
    });
    expect(code).toBe("/customset v1 0,1,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0");
  });

  test("illusion positions are always 0 — the payload carries no visual enchant", () => {
    const { code } = buildCustomSet({
      equipped_items: [mog("MAIN_HAND", 500, "Axe"), mog("OFF_HAND", 501, "Shield")],
    });
    const v = code.split(" ")[2]!.split(",");
    expect(v[14]).toBe("0"); // main-hand illusion
    expect(v[16]).toBe("0"); // off-hand illusion
    expect(v[12]).toBe("500");
    expect(v[15]).toBe("501");
  });

  test("a secondary appearance only occupies its own slot's position", () => {
    // A shoulder secondary must not bleed into the back slot that follows it.
    const { code } = buildCustomSet({
      equipped_items: [mog("SHOULDER", 1, "S", { id: 2, name: "S2" }), mog("BACK", 3, "B")],
    });
    expect(code).toBe("/customset v1 0,1,2,3,0,0,0,0,0,0,0,0,0,0,0,0,0");
  });

  test("non-transmoggable slots are ignored rather than reported as unknown", () => {
    const { unknown } = buildCustomSet({
      equipped_items: [
        mog("HEAD", 1, "Helm"),
        plain("NECK"),
        plain("FINGER_1"),
        plain("TRINKET_2"),
      ],
    });
    expect(unknown).toEqual([]);
  });

  test("an unrecognised slot type is surfaced, not swallowed", () => {
    // The slot vocabulary is the one thing here not verified against a captured response, so a
    // drift has to be visible rather than silently encoding zeros.
    const { unknown } = buildCustomSet({ equipped_items: [{ slot: { type: "SHOULDERS" } }] });
    expect(unknown).toEqual(["SHOULDERS"]);
  });

  test("tolerates a payload with no equipped_items at all", () => {
    const { code } = buildCustomSet({} as EquipmentResponse);
    expect(code.split(" ")[2]!.split(",")).toHaveLength(OUTFIT_VALUE_COUNT);
  });
});

describe("formatTransmogReply", () => {
  const full = () =>
    buildCustomSet({
      equipped_items: [mog("HEAD", 101, "Helm of Testing"), mog("CHEST", 105, "Robe of Testing")],
    });

  test("carries the pasteable code and the import target", () => {
    const out = formatTransmogReply("Testchar", "argent-dawn", full());
    expect(out).toContain("/customset v1 101,0,0,0,105,");
    expect(out).toContain("/collected outfit import");
    expect(out).toContain("**Testchar**");
    expect(out).toContain("argent-dawn");
  });

  test("names what it captured, with readable slot labels", () => {
    const out = formatTransmogReply("Testchar", "argent-dawn", full());
    expect(out).toContain("Head — Helm of Testing");
    expect(out).toContain("Chest — Robe of Testing");
  });

  test("always states the illusion and staleness caveats", () => {
    const out = formatTransmogReply("Testchar", "argent-dawn", full());
    expect(out).toContain("illusion");
    expect(out).toContain("last logout");
  });

  test("counts equipped-but-untransmogged slots, and says nothing about empty ones", () => {
    // `full()` equips only head and chest, so the other 11 wire slots are EMPTY, not untransmogged
    // — a reply that called those a gap would be telling the user their look is broken when it
    // isn't (the off hand of any two-hander).
    const out = formatTransmogReply("Testchar", "argent-dawn", full());
    expect(out).not.toContain("not transmogged");

    const withBare = buildCustomSet({
      equipped_items: [mog("HEAD", 101, "Helm"), plain("CHEST")],
    });
    const out2 = formatTransmogReply("Testchar", "argent-dawn", withBare);
    expect(out2).toContain("1 equipped slot not transmogged");
    expect(out2).toContain("Chest");
  });

  test("an all-zero result says so instead of offering an empty outfit as a success", () => {
    const out = formatTransmogReply("Testchar", "argent-dawn", buildCustomSet({ equipped_items: [] }));
    expect(out).toContain("No transmogged slots found");
    // The bare-slot line would be noise on top of that, so it's suppressed.
    expect(out).not.toContain("slots not transmogged");
  });

  test("surfaces unrecognised slot types for reporting", () => {
    const r = buildCustomSet({
      equipped_items: [mog("HEAD", 1, "Helm"), { slot: { type: "SHOULDERS" } }],
    });
    expect(formatTransmogReply("Testchar", "argent-dawn", r)).toContain("SHOULDERS");
  });
});

describe("realmSlug", () => {
  test("lowercases and hyphenates spaces", () => {
    expect(realmSlug("Argent Dawn")).toBe("argent-dawn");
  });
  test("drops apostrophes without leaving a hyphen", () => {
    expect(realmSlug("Kil'jaeden")).toBe("kiljaeden");
    expect(realmSlug("Aman'Thul")).toBe("amanthul");
  });
  test("passes an existing slug through unchanged", () => {
    expect(realmSlug("argent-dawn")).toBe("argent-dawn");
  });
  test("trims surrounding whitespace", () => {
    expect(realmSlug("  Silvermoon  ")).toBe("silvermoon");
  });

  // Blizzard does NOT fold accents in its realm slugs — verified against the live API that both the
  // character-profile equipment endpoint and the connected-realm search match only the accented
  // slug (`aggra-português` returns the character; the folded `aggra-portugues` 404s). Folding here
  // broke /transmog outright for the 7 accented EU realms, so each must slug to its accented form.
  const ACCENTED_REALMS: [name: string, slug: string][] = [
    ["Aggra (Português)", "aggra-português"],
    ["Chants Éternels", "chants-éternels"],
    ["Confrérie du Thorium", "confrérie-du-thorium"],
    ["Festung der Stürme", "festung-der-stürme"],
    ["La Croisade Écarlate", "la-croisade-écarlate"],
    ["Marécage de Zangar", "marécage-de-zangar"],
    ["Pozzo dell'Eternità", "pozzo-delleternità"],
  ];
  test.each(ACCENTED_REALMS)("preserves accents: %s -> %s", (name, slug) => {
    expect(realmSlug(name)).toBe(slug);
  });

  test("passes an already-accented slug through unchanged", () => {
    expect(realmSlug("aggra-português")).toBe("aggra-português");
    expect(realmSlug("chants-éternels")).toBe("chants-éternels");
  });

  test("keeps a single accented letter rather than folding it", () => {
    // The old behaviour folded `Éonar` -> `eonar`; the accent must now survive.
    expect(realmSlug("Éonar")).toBe("éonar");
  });

  test("recomposes decomposed input so the accent still survives the filter", () => {
    // A client may send the letter decomposed (base `E` + combining acute), which realmSlug's
    // final filter would strip back to a fold — the `.normalize("NFC")` recomposes it first. Derive
    // the decomposed form from the precomposed name via NFD; the guard proves it really decomposed.
    const precomposed = "Chants Éternels";
    const decomposed = precomposed.normalize("NFD");
    expect(decomposed).not.toBe(precomposed); // guard: NFD actually split the accent off
    expect(realmSlug(decomposed)).toBe("chants-éternels");
  });
});

describe("pickRetrySlug", () => {
  // #32: fetchTransmog recurses with the retry slug, so this must never hand back a slug equal
  // to the one that just failed — that would recurse forever re-deriving the same dead end.
  test("offers a different canonical slug", () => {
    expect(pickRetrySlug("azjolnerub", "azjol-nerub")).toBe("azjolnerub");
  });

  test("refuses when the index found nothing", () => {
    expect(pickRetrySlug(undefined, "azjol-nerub")).toBeUndefined();
  });

  test("refuses when the index only confirms the slug that already failed", () => {
    expect(pickRetrySlug("azjol-nerub", "azjol-nerub")).toBeUndefined();
  });
});

describe("fetchTransmog — realm-index retry (#32)", () => {
  // End-to-end coverage of the wiring in fetchTransmog itself (the 404 -> realmExists false ->
  // resolveCanonicalSlug -> recurse chain), not just the pure helpers it calls — that wiring has
  // no coverage otherwise, since every piece it composes is separately unit-tested in isolation.
  const originalFetch = globalThis.fetch;

  type Route = { match: string; status?: number; body?: unknown };

  function mockFetch(routes: Route[]): void {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      const route = routes.find((r) => url.includes(r.match));
      if (!route) throw new Error(`unmocked fetch in test: ${url}`);
      return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
    }) as typeof fetch;
  }

  const TOKEN_ROUTE: Route = {
    match: "oauth.battle.net/token",
    body: { access_token: "test-token", expires_in: 3600 },
  };
  const NOT_FOUND_ROUTE: Route = { match: "/data/wow/search/connected-realm", body: { results: [] } };

  beforeEach(() => {
    // Both are module-level caches (blizzardToken's OAuth token, realm.ts's realm-index cache) —
    // reset between tests so one test's mocked response can't leak into the next.
    _resetBlizzardToken();
    _resetRealmIndex();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("recovers a realm-name hyphen Blizzard drops but realmSlug's heuristic keeps", async () => {
    mockFetch([
      TOKEN_ROUTE,
      { match: "/profile/wow/character/azjol-nerub/testchar/equipment", status: 404 },
      NOT_FOUND_ROUTE,
      { match: "/data/wow/realm/index", body: { realms: [{ name: "Azjol-Nerub", slug: "azjolnerub" }] } },
      { match: "/profile/wow/character/azjolnerub/testchar/equipment", body: { equipped_items: [] } },
    ]);

    const result = await fetchTransmog("Testchar", "Azjol-Nerub");
    expect(result.code.startsWith("/customset v1 ")).toBe(true);
  });

  test("still reports no realm when the index has no match for it (regression guard)", async () => {
    mockFetch([
      TOKEN_ROUTE,
      { match: "/profile/wow/character/nonexistentrealm/testchar/equipment", status: 404 },
      NOT_FOUND_ROUTE,
      { match: "/data/wow/realm/index", body: { realms: [{ name: "Argent Dawn", slug: "argent-dawn" }] } },
    ]);

    await expect(fetchTransmog("Testchar", "NonexistentRealm")).rejects.toThrow(TransmogLookupError);
  });

  test("never touches the realm index when the heuristic slug already resolves", async () => {
    // The common case (an already-correct slug or name) must not pay for the extra call — if it
    // did, this test's realm-index route would be hit and the unmocked fallthrough would throw.
    mockFetch([
      TOKEN_ROUTE,
      { match: "/profile/wow/character/argent-dawn/testchar/equipment", body: { equipped_items: [] } },
    ]);

    const result = await fetchTransmog("Testchar", "Argent Dawn");
    expect(result.code.startsWith("/customset v1 ")).toBe(true);
  });
});
