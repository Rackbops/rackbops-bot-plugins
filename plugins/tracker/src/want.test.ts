import { afterEach, describe, expect, it } from "bun:test";
import type { Fetch, FetchResponse } from "@rackbops/docket-core";
import type { Plugin } from "../../../packages/api/contract.js";
import { FetchRefusedError } from "./fetch.js";
import { api, call, cleanup, csrfOf, LARRY, makeToken, ORIGIN, people, press, signIn, slash, world } from "./web/harness.js";
import { BGG_SPACING_MS, bggSource, MAX_BGG_WAITING, bggThingUrl, parseBggThingId, parseMarketplace } from "./want-bgg.js";
import { BGG_THING, shopSearch } from "./want-fixtures.js";
import { isEbayHost, listingsFromJsonLd, type Listing, pageSource, type Source, SourceMiss, SourceUnavailableError } from "./want-sources.js";
import { ebaySearchUrl, MAX_WANT_TASKS } from "./want.js";
import { MAX_REPORTED, renderWant, wantState, withinLimits } from "./wantlist-type.js";

afterEach(cleanup);

const SHOP = "https://shop.example/search?q=wingspan";
const pollTick = (p: Plugin) => p.ticks!.find((t) => t.name === "poll")!.run(new AbortController().signal);
const notifyTick = (p: Plugin) => p.ticks!.find((t) => t.name === "notify")!.run(new AbortController().signal);

type Item = { name: string; url: string; price?: number; condition?: string; seller?: string };
const OCEANIA: Item = { name: "Wingspan Oceania", url: "https://shop.example/p/oceania", price: 30, condition: "New", seller: "Meeple Barn" };
const EUROPE: Item = { name: "Wingspan European", url: "/p/europe", price: 25 };
const NESTS: Item = { name: "Wingspan Nesting Box", url: "https://shop.example/p/nests", price: 60, condition: "Used" };

function shop(items: Item[]) {
  const s = { items, status: 200, reads: [] as string[], refuse: null as string | null, body: null as string | null };
  const fetch: Fetch = {
    async get(url: string): Promise<FetchResponse> {
      s.reads.push(url);
      if (s.refuse) throw new FetchRefusedError(s.refuse);
      return { status: s.status, body: s.body ?? shopSearch(s.items), headers: {} };
    },
  };
  return { s, fetch };
}

type Sent = { userId: string; message: unknown }[];
const content = (sent: Sent, i: number): string => (sent[i]?.message as { content: string }).content;
const buttons = (sent: Sent, i: number) => (sent[i]?.message as { buttons?: { label: string; customId: string }[] }).buttons ?? [];

describe("listingsFromJsonLd", () => {
  it("reads an ItemList's products with their prices, conditions and sellers, resolving relative addresses", () => {
    const got = listingsFromJsonLd(shopSearch([OCEANIA, EUROPE, NESTS]), SHOP);
    expect(got).toEqual([
      { id: "https://shop.example/p/oceania", title: "Wingspan Oceania", url: "https://shop.example/p/oceania", price: 30, currency: "USD", condition: "new", seller: "Meeple Barn" },
      { id: "https://shop.example/p/europe", title: "Wingspan European", url: "https://shop.example/p/europe", price: 25, currency: "USD" },
      { id: "https://shop.example/p/nests", title: "Wingspan Nesting Box", url: "https://shop.example/p/nests", price: 60, currency: "USD", condition: "used" },
    ]);
  });

  it("takes a standalone product as the page itself, drops what has no name or an unsafe address, and repeats nothing", () => {
    const product = { "@context": "https://schema.org", "@graph": [{ "@type": "Product", name: "A game", offers: { price: "12.50", priceCurrency: "EUR" } }] };
    const list = {
      "@type": "ItemList",
      itemListElement: [
        { "@type": "ListItem", item: { "@type": "Product", name: "Bad", url: "javascript:alert(1)" } },
        { "@type": "ListItem", item: { "@type": "Product", url: "https://x.example/1" } },
        { "@type": "ListItem", item: { "@type": "Product", name: "Twice", url: "https://x.example/2#a" } },
        { "@type": "ListItem", item: { "@type": "Product", name: "Twice", url: "https://x.example/2#b" } },
      ],
    };
    const page = `<script type="application/ld+json">${JSON.stringify(product)}</script><script type="application/ld+json">${JSON.stringify(list)}</script>`;
    expect(listingsFromJsonLd(page, "https://x.example/game#top").map((l) => [l.title, l.url, l.price])).toEqual([
      ["A game", "https://x.example/game", 12.5],
      ["Twice", "https://x.example/2", undefined],
    ]);
  });

  it("finds nothing on a page without structured data, and the page source counts that as a miss", async () => {
    expect(listingsFromJsonLd("<html><body><div class=price>$30</div></body></html>", SHOP)).toEqual([]);
    const { s, fetch } = shop([]);
    s.body = "<html></html>";
    await expect(pageSource.search(SHOP, fetch)).rejects.toThrow(SourceMiss);
    s.status = 503;
    await expect(pageSource.search(SHOP, fetch)).rejects.toThrow("HTTP 503");
  });

  it("keeps one id for a listing whose address carries per-view parameters, and an empty search is no miss", async () => {
    const a = listingsFromJsonLd(shopSearch([{ name: "A", url: "/p/a?variant=2&_pos=1&_sid=abc&_ss=r&utm_source=x" }]), SHOP);
    const b = listingsFromJsonLd(shopSearch([{ name: "A", url: "/p/a?variant=2&_pos=7&_sid=def&srsltid=zz" }]), SHOP);
    expect(a[0]?.id).toBe("https://shop.example/p/a?variant=2");
    expect(b[0]?.id).toBe(a[0]?.id);
    const { s, fetch } = shop([]);
    expect(await pageSource.search(SHOP, fetch)).toEqual([]);
    s.body = "<html></html>";
    await expect(pageSource.search(SHOP, fetch)).rejects.toThrow("no listings in the page's structured data");
  });

  it("knows eBay's hosts", () => {
    for (const h of ["ebay.com", "www.ebay.com", "ebay.co.uk", "m.ebay.de", "ebay.us", "EBAY.COM."]) expect(isEbayHost(h)).toBe(true);
    for (const h of ["notebay.com", "ebay.example.org", "shop.example"]) expect(isEbayHost(h)).toBe(false);
  });
});

describe("the BGG source", () => {
  it("parses a thing id from a bare id or a BGG address, and nothing else", () => {
    expect(parseBggThingId("300580")).toBe(300580);
    expect(parseBggThingId("https://boardgamegeek.com/boardgameexpansion/300580/wingspan-oceania")).toBe(300580);
    expect(parseBggThingId("https://www.boardgamegeek.com/boardgame/266192")).toBe(266192);
    for (const bad of ["0", "abc", "https://evil.example/boardgame/1", "https://boardgamegeek.com/user/1", "ftp://boardgamegeek.com/boardgame/1"]) {
      expect(parseBggThingId(bad)).toBeNull();
    }
    expect(bggThingUrl(300580)).toBe("https://boardgamegeek.com/xmlapi2/thing?id=300580&marketplace=1");
  });

  it("reads the (hand-written) marketplace fixture: price, currency, condition and link, dropping an unsafe link", () => {
    expect(parseMarketplace(BGG_THING)).toEqual([
      { id: "bgg:https://boardgamegeek.com/geekmarket/product/4100001", title: "Wingspan: Oceania Expansion", url: "https://boardgamegeek.com/geekmarket/product/4100001", price: 32, currency: "USD", condition: "likenew" },
      { id: "bgg:https://boardgamegeek.com/geekmarket/product/4100002", title: "Wingspan: Oceania Expansion", url: "https://boardgamegeek.com/geekmarket/product/4100002", price: 29.5, currency: "EUR", condition: "new" },
    ]);
    expect(parseMarketplace("<items><item><name type=\"primary\" value=\"X\"/></item></items>")).toEqual([]);
  });

  it("sends the token to the bare host, waits 5 s between requests, and maps BGG's refusals", async () => {
    let now = 1_000_000;
    const slept: number[] = [];
    const asked: { url: string; headers: Record<string, string> | undefined; at: number }[] = [];
    let status = 200;
    const fetch: Fetch = {
      async get(url, headers) {
        asked.push({ url, headers, at: now });
        return { status, body: BGG_THING, headers: {} };
      },
    };
    const source = bggSource({ token: "tok", fetch, now: () => now, sleep: async (ms) => void (slept.push(ms), (now += ms)) });
    const [a, b] = await Promise.all([source.search("300580", undefined), source.search("https://boardgamegeek.com/boardgame/266192/x", undefined)]);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(asked.map((x) => x.url)).toEqual([bggThingUrl(300580), bggThingUrl(266192)]);
    expect(asked[0]?.headers?.authorization).toBe("Bearer tok");
    expect((asked[1]?.at ?? 0) - (asked[0]?.at ?? 0)).toBeGreaterThanOrEqual(BGG_SPACING_MS);
    expect(slept).toEqual([BGG_SPACING_MS]);
    status = 401;
    await expect(source.search("300580", undefined)).rejects.toThrow(SourceUnavailableError);
    status = 202;
    const busy = source.search("300580", undefined);
    await expect(busy).rejects.toThrow("BGG is busy (HTTP 202)");
    await expect(busy).rejects.not.toThrow(SourceUnavailableError);
    status = 302;
    await expect(source.search("300580", undefined)).rejects.toThrow("BGG answered HTTP 302");
  });

  it("puts a third waiting read back for the next tick rather than queue it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fetch: Fetch = { async get() { await gate; return { status: 200, body: BGG_THING, headers: {} }; } };
    const source = bggSource({ token: "t", fetch, now: () => 0, sleep: async () => {} });
    const held = Array.from({ length: MAX_BGG_WAITING }, () => source.search("1", undefined));
    await expect(source.search("1", undefined)).rejects.toThrow("waits for the next tick");
    release();
    expect(await Promise.all(held)).toHaveLength(MAX_BGG_WAITING);
  });

  it("parses a hostile 3 MB answer in linear time, and names the thing by its primary name", () => {
    const hostile = `<items><item><name type="alternate" value="Other"/><name type="primary" value="Real"/><marketplacelistings>${"<listing></listing>".repeat(160_000)}</marketplacelistings></item></items>`;
    const t0 = performance.now();
    expect(parseMarketplace(hostile)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(1500);
    const named = parseMarketplace(BGG_THING.replace('<name type="primary" sortindex="1" value="Wingspan: Oceania Expansion" />', '<name type="alternate" value="Ozeanien" /><name type="primary" value="Wingspan: Oceania Expansion" />'));
    expect(named[0]?.title).toBe("Wingspan: Oceania Expansion");
  });
});

describe("the wantlist type's pieces", () => {
  const l = (id: string, price?: number, currency?: string): Listing => ({ id, title: id, url: `https://x.example/${id}`, ...(price !== undefined ? { price } : {}), ...(currency ? { currency } : {}) });

  it("keeps listings within the limits: an unknown price never passes a top price, another currency never passes", () => {
    const cfg = { source: "page" as const, target: SHOP, maxPrice: 30, currency: "USD" };
    expect(withinLimits(l("a", 30, "USD"), cfg)).toBe(true);
    expect(withinLimits(l("b", 31, "USD"), cfg)).toBe(false);
    expect(withinLimits(l("c"), cfg)).toBe(false);
    expect(withinLimits(l("d", 10, "EUR"), cfg)).toBe(false);
    expect(withinLimits(l("e", 10), cfg)).toBe(true);
    expect(withinLimits(l("f"), { source: "page", target: SHOP })).toBe(true);
  });

  it("breaks any address in a shop's text, so only the listing's own link is a link", () => {
    const text = renderWant("W", "t1", [{ id: "a", title: "Deal https://phish.example/x www.phish.example", url: "https://x.example/a", seller: "see http://y.example" }], { source: "page", target: SHOP });
    expect(text).not.toContain("https://phish");
    expect(text).not.toContain("http://y");
    expect(text).not.toContain("www.phish");
    expect(text).toContain("<https://x.example/a>");
  });

  it("shows five lines and says how many more, and BGG's lines name BGG", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g"].map((id) => l(id, 1, "USD"));
    const text = renderWant("Wingspan", "t9", many, { source: "bgg", target: "1" });
    expect(text.split("\n").filter((x) => x.startsWith("- "))).toHaveLength(5);
    expect(text).toContain("(via BoardGameGeek)");
    expect(text).toContain("...and 2 more: `/task history t9` lists them all.");
  });

  it("reads back a state, capped, and a broken one as fresh", () => {
    expect(wantState(null)).toEqual({ reported: [], misses: 0, told: 0, warned: false });
    expect(wantState({ reported: Array.from({ length: MAX_REPORTED + 5 }, (_, i) => `k${i}`), misses: 2, told: 7 }).reported).toHaveLength(MAX_REPORTED);
  });
});

describe("/want", () => {
  it("reads the page once, makes the watch, DMs each listing once on the poll tick, and Done ends it", async () => {
    const { s, fetch } = shop([OCEANIA, EUROPE]);
    const w = await world({ fetch });
    await people(w.plugin);
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan expansions", source: "page", target: SHOP } });
    expect(made).toContain("Watching `t1`: Wingspan expansions. The page lists 2 things now.");
    expect(made).toContain("every 12 hours");
    expect(s.reads).toEqual([SHOP]);

    // Never on the reminders' tick; the first poll DMs what is there now.
    await notifyTick(w.plugin);
    expect(w.sent).toHaveLength(0);
    await pollTick(w.plugin);
    expect(w.sent).toHaveLength(1);
    expect(content(w.sent, 0)).toContain("Wingspan expansions: 2 new listings.");
    expect(content(w.sent, 0)).toContain("- Wingspan Oceania -- 30.00 USD -- new -- sold by Meeple Barn <https://shop.example/p/oceania>");
    expect(content(w.sent, 0)).toContain("- Wingspan European -- 25.00 USD <https://shop.example/p/europe>");

    // The same two and one new: only the new one.
    s.items = [OCEANIA, EUROPE, NESTS];
    w.clock.advance(12 * 3600_000);
    await pollTick(w.plugin);
    expect(w.sent).toHaveLength(2);
    expect(content(w.sent, 1)).toContain("Wingspan expansions: a new listing.");
    expect(content(w.sent, 1)).toContain("Wingspan Nesting Box");
    expect(content(w.sent, 1)).not.toContain("Wingspan Oceania");

    // Nothing new: nothing said.
    w.clock.advance(12 * 3600_000);
    await pollTick(w.plugin);
    expect(w.sent).toHaveLength(2);

    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" } });
    expect(history).toContain("Findings: 3");
    expect(history).toContain("Wingspan Nesting Box -- 60.00 USD -- used <https://shop.example/p/nests>");

    const done = buttons(w.sent, 1).find((b) => b.label.toLowerCase() === "done");
    expect(done).toBeDefined();
    await press(w.plugin, done?.customId ?? "", LARRY);
    const after = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" } });
    expect(after).toContain("done");
    s.items = [OCEANIA, EUROPE, NESTS, { name: "Wingspan Asia", url: "https://shop.example/p/asia", price: 40 }];
    w.clock.advance(12 * 3600_000);
    const reads = s.reads.length;
    await pollTick(w.plugin);
    expect(s.reads).toHaveLength(reads);
    expect(w.sent).toHaveLength(2);
  });

  it("holds to the top price: a listing over it waits, and is sent once it drops under", async () => {
    const { s, fetch } = shop([OCEANIA, NESTS]);
    const w = await world({ fetch });
    await people(w.plugin);
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan", source: "page", target: SHOP, currency: "usd" }, numbers: { max: 40 } });
    expect(made).toContain("The page lists 2 things now, 1 within your limits.");
    expect(made).toContain("each listing at or under 40.00 USD");
    await pollTick(w.plugin);
    expect(content(w.sent, 0)).toContain("Wingspan: a new listing.");
    expect(content(w.sent, 0)).not.toContain("Nesting Box");
    s.items = [OCEANIA, { ...NESTS, price: 35 }];
    w.clock.advance(12 * 3600_000);
    await pollTick(w.plugin);
    expect(w.sent).toHaveLength(2);
    expect(content(w.sent, 1)).toContain("Wingspan Nesting Box -- 35.00 USD");
  });

  it("tells the owner once, at the third read in a row with no listings", async () => {
    const { s, fetch } = shop([OCEANIA]);
    const w = await world({ fetch });
    await people(w.plugin);
    await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan", source: "page", target: SHOP } });
    await pollTick(w.plugin);
    expect(w.sent).toHaveLength(1);
    s.body = "<html>gone</html>";
    for (let i = 0; i < 5; i++) {
      w.clock.advance(12 * 3600_000);
      await pollTick(w.plugin);
    }
    expect(w.sent).toHaveLength(2);
    expect(content(w.sent, 1)).toContain("Wingspan: I could read no listings from https://shop.example/search?q=wingspan 3 times in a row (no listings in the page's structured data).");
  });

  it("refuses a page with no listings, a private or eBay page, and a bad limit, making nothing", async () => {
    const { s, fetch } = shop([]);
    const w = await world({ fetch });
    await people(w.plugin);
    s.body = "<html>no data</html>";
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "page", target: SHOP } })).toContain("I found no listings on that page that I can read");
    s.refuse = "shop.example is not on the public internet";
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "page", target: SHOP } })).toBe("I cannot read that page: shop.example is not on the public internet.");
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "page", target: "http://localhost/x" } })).toBe("Only public web pages can be tracked.");
    const ebay = await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "page", target: "https://www.ebay.com/sch/i.html?_nkw=wingspan" } });
    expect(ebay).toContain("I never read eBay's pages.");
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "page" } })).toBe("`target` is the listing page's address.");
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "page", target: SHOP, currency: "dollars" } })).toContain("`currency` is a three-letter code");
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "page", target: SHOP }, ints: { hours: 500 } })).toContain("`hours` is a whole number from 1 to 168");
    expect(await slash(w.plugin, "tasks", LARRY)).not.toContain("t1");
  });

  it("answers source: ebay with a search to save on eBay, the top price in it, and makes nothing", async () => {
    const w = await world({ fetch: shop([]).fetch });
    await people(w.plugin);
    const said = await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan Oceania", source: "ebay" }, numbers: { max: 35 } });
    expect(said).toContain("I do not read eBay");
    expect(said).toContain(`<${ebaySearchUrl("Wingspan Oceania", 35)}>`);
    expect(ebaySearchUrl("Wingspan Oceania", 35)).toBe("https://www.ebay.com/sch/i.html?_nkw=Wingspan+Oceania&_udhi=35");
    expect(said).toContain("Save this search");
    expect(await slash(w.plugin, "tasks", LARRY)).not.toContain("t1");
  });

  it("refuses BGG while the bot has no token, and watches a BGG game once it has one", async () => {
    const off = await world({ fetch: shop([]).fetch });
    await people(off.plugin);
    expect(await slash(off.plugin, "want", LARRY, { strings: { name: "Oceania", source: "bgg", target: "300580" } })).toContain("This bot has no BoardGameGeek access yet");

    const searched: string[] = [];
    const bgg: Source = {
      id: "bgg",
      async search(target) {
        searched.push(target);
        return parseMarketplace(BGG_THING);
      },
    };
    const w = await world({ fetch: shop([]).fetch, bgg });
    await people(w.plugin);
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "Oceania", source: "bgg", target: "https://example.org/x" } })).toContain("That is not a BGG game.");
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Oceania", source: "bgg", target: "https://boardgamegeek.com/boardgameexpansion/300580/x" } });
    expect(made).toContain("Watching `t1`: Oceania.");
    expect(made).toContain("BoardGameGeek's marketplace every 24 hours");
    await pollTick(w.plugin);
    expect(searched).toEqual(["300580"]);
    expect(content(w.sent, 0)).toContain("Oceania: 2 new listings.");
    expect(content(w.sent, 0)).toContain("<https://boardgamegeek.com/geekmarket/product/4100001> (via BoardGameGeek)");
  });

  it("tells the owner once when BGG cannot be read at all, not again at the third miss", async () => {
    const bgg: Source = { id: "bgg", async search() { throw new SourceUnavailableError("BGG rejected the token"); } };
    const w = await world({ fetch: shop([]).fetch, bgg });
    await people(w.plugin);
    await slash(w.plugin, "want", LARRY, { strings: { name: "Oceania", source: "bgg", target: "300580" } });
    for (let i = 0; i < 5; i++) {
      await pollTick(w.plugin);
      w.clock.advance(24 * 3600_000);
    }
    expect(w.sent).toHaveLength(1);
    expect(content(w.sent, 0)).toContain("Oceania: I could read no listings from BoardGameGeek just now (BGG rejected the token).");
  });

  it("over the task API: the cap is 409, BGG off is 503, and a PATCH clears the top price with null", async () => {
    const w = await world({ fetch: shop([OCEANIA]).fetch });
    await people(w.plugin);
    const jar = await signIn(w.plugin, LARRY);
    const token = await makeToken(w, jar);
    const post = (b: Record<string, unknown>) => api(w.plugin, "POST", "/tasks", { token, body: b });
    expect((await post({ type: "wantlist", name: "W", source: "bgg", target: "1" })).status).toBe(503);
    const made = await post({ type: "wantlist", name: "W", source: "page", target: SHOP, max: 40 });
    expect(made.status).toBe(201);
    expect((await made.json()).task).toMatchObject({ source: "page", target: SHOP, settings: { max: 40 } });
    const cleared = await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { max: null } });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).task.settings.max).toBeUndefined();
    for (let i = 1; i < MAX_WANT_TASKS; i++) expect((await post({ type: "wantlist", name: `W${i}`, source: "page", target: `${SHOP}&p=${i}` })).status).toBe(201);
    const capped = await post({ type: "wantlist", name: "More", source: "page", target: SHOP });
    expect(capped.status).toBe(409);
    expect((await capped.json()).error.code).toBe("limit_reached");
  });

  it("caps live watches per person", async () => {
    const w = await world({ fetch: shop([OCEANIA]).fetch });
    await people(w.plugin);
    for (let i = 0; i < MAX_WANT_TASKS; i++) {
      expect(await slash(w.plugin, "want", LARRY, { strings: { name: `W${i}`, source: "page", target: `${SHOP}&p=${i}` } })).toContain("Watching");
    }
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "One more", source: "page", target: SHOP } })).toContain(`You already watch for ${MAX_WANT_TASKS} things`);
  });

  it("from the web: makes a watch, then edits its name, top price and hours, and clears the top price", async () => {
    const { fetch } = shop([OCEANIA, NESTS]);
    const w = await world({ fetch });
    await people(w.plugin);
    const jar = await signIn(w.plugin, LARRY);
    const csrf = await csrfOf(w.plugin, jar);
    const form = await (await call(w.plugin, "GET", "/new/wantlist", { jar })).text();
    expect(form).toContain('name="target"');
    const made = await call(w.plugin, "POST", "/new/wantlist", { jar, origin: ORIGIN, form: { csrf, name: "Wingspan", source: "page", target: SHOP, max: "40", currency: "", hours: "" } });
    expect(made.status).toBe(303);
    const edit = await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar })).text();
    expect(edit).toContain(`Looking at: ${SHOP.replace("&", "&amp;")}`);
    expect(edit).toContain('value="40"');
    const saved = await call(w.plugin, "POST", "/tasks/t1/edit", { jar, origin: ORIGIN, form: { csrf, name: "Wingspan bits", max: "", currency: "usd", hours: "6" } });
    expect(saved.status).toBe(303);
    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" } });
    expect(history).toContain("Wingspan bits");
    expect(history).toContain("every 6 hours");
    const again = await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar })).text();
    expect(again).toContain('name="max" type="text" value=""');
    expect(again).toContain('value="USD"');
  });
});
