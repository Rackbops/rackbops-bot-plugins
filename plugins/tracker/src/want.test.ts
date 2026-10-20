import { afterEach, describe, expect, it } from "bun:test";
import type { Fetch, FetchResponse } from "@rackbops/docket-core";
import type { Plugin } from "../../../packages/api/contract.js";
import { MAX_ANSWER, NO_SUCH_TASK } from "./actions.js";
import { DeliveryHealth, PAUSE_AFTER } from "./delivery-health.js";
import { FetchRefusedError } from "./fetch.js";
import { HOST_CANNOT_MESSAGE } from "./notifier.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";
import { ADMIN, api, call, cleanup, CURLY, csrfOf, LARRY, makeToken, ORIGIN, people, press, type Said, signIn, slash, world } from "./web/harness.js";
import { parseMarketplace, type Source, SourceUnavailableError } from "@rackbops/docket-types";
import { BGG_THING, shopSearch } from "./want-fixtures.js";
import { EBAY_PAGE, EBAY_USD, MAX_WANT_TASKS, SHOPIFY_OFF } from "./want.js";
import { FIRECRAWL_SCRAPE_URL } from "./firecrawl.js";

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

// The page and BGG sources and the type's pieces are tested with them in Rackbops/docket
// (packages/types/test/want.test.ts); these are the plugin's end to end.

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

    const said: Said[] = [];
    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" }, said });
    expect(history).toContain("Findings: 3");
    expect(said[1]?.content).toContain("Wingspan Nesting Box -- 60.00 USD -- used <https://shop.example/p/nests>");

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

  /** A watch whose first run found 20 listings, each line about 180 characters, so not all fit in one message. */
  async function twentyListings(logs?: string[]) {
    const items: Item[] = Array.from({ length: 20 }, (_, i) => ({
      name: `Wingspan expansion ${String(i + 1).padStart(2, "0")}: ${"birds, eggs and nests in a box ".repeat(3).trim()}`,
      url: `https://shop.example/p/wingspan-expansion-${i + 1}`,
      price: 30,
    }));
    const { fetch } = shop(items);
    const w = await world({ fetch, ...(logs ? { logs } : {}) });
    await people(w.plugin);
    await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan expansions", source: "page", target: SHOP } });
    await pollTick(w.plugin);
    expect(content(w.sent, 0)).toContain("Wingspan expansions: 20 new listings.");
    expect(content(w.sent, 0)).toContain("...and 15 more: `/task history t1` lists them all.");
    return { w, items };
  }

  it("sends a 20-listing run's findings in /task history as a second message, after the history (#166)", async () => {
    const { w, items } = await twentyListings();
    const said: Said[] = [];
    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" }, said });
    // The answer is the history: the count and the run, and no listing.
    expect(history).toContain("\nFindings: 20\nRuns:\n- ");
    expect(history).toMatch(/^Runs:\n- .+ -- done$/m);
    expect(history).not.toContain("Wingspan expansion ");
    // Then the findings, in one follow-up only Larry sees and that mentions no one, like the answer.
    expect(said.map((m) => m.kind)).toEqual(["edit", "followUp"]);
    expect(said[0]).toEqual({ kind: "edit", content: history, flags: 4 });
    expect(said[1]).toMatchObject({ kind: "followUp", flags: 64 | 4, allowedMentions: { parse: [] } });
    const findings = said[1]?.content ?? "";
    expect(findings.length).toBeLessThanOrEqual(MAX_ANSWER);
    // The newest, whole, oldest to newest, then the count of the rest and where they are.
    const shown = findings.split("\n").filter((l) => l.startsWith("- Wingspan expansion "));
    expect(shown.length).toBeGreaterThan(8);
    expect(shown.length).toBeLessThan(20);
    expect(findings).toBe(
      [
        `Findings (newest ${shown.length} of 20):`,
        ...items.slice(20 - shown.length).map((it) => `- ${it.name} -- 30.00 USD <${it.url}>`),
        `...and ${20 - shown.length} more; the web area's task page shows the newest 50 (\`/web\`).`,
      ].join("\n"),
    );

    // An admin sees Larry's watch as he does: the same history, then the same findings.
    const admin: Said[] = [];
    await slash(w.plugin, "task", ADMIN, { sub: "history", strings: { task: "t1" }, said: admin });
    expect(admin).toEqual([{ kind: "edit", content: history, flags: 4 }, { kind: "followUp", content: findings, flags: 64 | 4, allowedMentions: { parse: [] } }]);
    // A typed id with spaces around it is the same watch, findings and all.
    const padded: Said[] = [];
    await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: " t1 " }, said: padded });
    expect(padded).toEqual([{ kind: "edit", content: history, flags: 4 }, { kind: "followUp", content: findings, flags: 64 | 4, allowedMentions: { parse: [] } }]);
    // Someone the watch is not shared with sees neither.
    const curly: Said[] = [];
    await slash(w.plugin, "task", CURLY, { sub: "history", strings: { task: "t1" }, said: curly });
    expect(curly).toEqual([{ kind: "edit", content: NO_SUCH_TASK, flags: 4 }]);
  });

  it("sends /task history's findings before the resume notice, each a message of its own (#166)", async () => {
    // A 100-character name, 5 listings, then (straight into the store) 12 runs that failed with long errors and 7 edits.
    const title = `Wingspan expansions, ${"and the promo packs for it ".repeat(4)}`.slice(0, 100);
    expect(title).toHaveLength(100);
    const items: Item[] = Array.from({ length: 5 }, (_, i) => ({ name: `Wingspan expansion ${i + 1}`, url: `https://shop.example/p/wingspan-${i + 1}`, price: 30 }));
    const { fetch } = shop(items);
    const w = await world({ fetch });
    await people(w.plugin);
    await slash(w.plugin, "want", LARRY, { strings: { name: title, source: "page", target: SHOP } });
    await pollTick(w.plugin);
    expect(content(w.sent, 0)).toContain(`${title}: 5 new listings.`);
    const db = openDatabase(w.dbPath);
    try {
      const store = new SqliteStore(db);
      const larry = await store.findUserByDiscordId(LARRY);
      if (!larry) throw new Error("no Larry");
      for (let i = 0; i < 12; i++) {
        const at = new Date(Date.parse("2026-09-01T12:00:00.000Z") + i * 3600_000).toISOString();
        const o = await store.createOccurrence({ taskId: "t1", lane: "notify", dueAt: at, dedupeKey: `failed${i}`, at });
        if (o) await store.updateOccurrence(o.id, { status: "failed", error: `the shop's page did not answer in time, read ${i + 1} ${"of a long and slow afternoon ".repeat(3)}` });
      }
      for (let i = 0; i < 7; i++) await store.addTaskEvent({ taskId: "t1", actorId: larry.id, kind: "edited", detail: "", at: w.clock.now().toISOString() });
      // Larry's DMs fail PAUSE_AFTER times in a row: he and his watch are paused until he next uses a command.
      const health = new DeliveryHealth(db, store);
      for (let i = 0; i < PAUSE_AFTER; i++) await health.recordFailure(larry.id, HOST_CANNOT_MESSAGE, w.clock.now().toISOString());
      expect(health.isPaused(larry.id)).toBe(true);
    } finally {
      db.close();
    }

    const said: Said[] = [];
    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" }, said });
    // The answer, then its findings, then the notice: each a message only Larry sees, mentioning no one.
    expect(said.map((m) => m.kind)).toEqual(["edit", "followUp", "followUp"]);
    expect(said[0]).toEqual({ kind: "edit", content: history, flags: 4 });
    expect(history.startsWith(`\`t1\` ${title} -- wantlist, active, `)).toBe(true);
    expect(history).toContain("\nFindings: 5\nRuns:\n- (3 earlier)\n");
    expect(history).not.toContain("I could not DM you");
    expect(said[1]).toEqual({
      kind: "followUp",
      content: ["Findings (newest 5 of 5):", ...items.map((it) => `- ${it.name} -- 30.00 USD <${it.url}>`)].join("\n"),
      flags: 64 | 4,
      allowedMentions: { parse: [] },
    });
    const notice = said[2]?.content ?? "";
    expect(said[2]).toMatchObject({ kind: "followUp", flags: 64 | 4, allowedMentions: { parse: [] } });
    expect(notice).toStartWith(`I could not DM you ${PAUSE_AFTER} times in a row, so your reminders were paused. 1 task(s) are back on.`);
    // Why the notice is a message of its own: above the answer, the two would pass one message.
    expect(`${notice}\n\n${history}`.length).toBeGreaterThan(MAX_ANSWER);
    expect(history.length).toBeLessThanOrEqual(MAX_ANSWER);
  });

  it("logs a /task history follow-up that fails, and still answers (#166)", async () => {
    const logs: string[] = [];
    const { w } = await twentyListings(logs);
    const said: Said[] = [];
    // `slash` awaits the command's handle(): a rejection would fail the test here.
    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" }, said, followUpFails: Object.assign(new Error("Unknown interaction"), { code: 10062 }) });
    expect(said).toEqual([{ kind: "edit", content: history, flags: 4 }]);
    expect(history).toContain("\nFindings: 20\nRuns:\n- ");
    expect(logs).toContain("could not send /task's answer's message 2 as a follow-up: Unknown interaction");
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
    expect(ebay).toBe(EBAY_PAGE);
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "page" } })).toBe("`target` is the listing page's address.");
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "page", target: SHOP, currency: "dollars" } })).toContain("`currency` is a three-letter code");
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "page", target: SHOP }, ints: { hours: 500 } })).toContain("`hours` is a whole number from 1 to 168");
    expect(await slash(w.plugin, "tasks", LARRY)).not.toContain("t1");
  });

  it("watches a BGG game through BGG's API once the bot has its token", async () => {
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

  it("with TRACKER_BGG_TOKEN set, the plugin's BGG reader never follows a redirect, so the token stays on BGG (#215)", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(null, { status: 302, headers: { location: "https://boardgamegeek.com/login" } });
    }) as unknown as typeof fetch;
    const w = await world({ fetch: shop([]).fetch, env: { TRACKER_BGG_TOKEN: "bgg-token" }, bggNetwork: { resolve: async () => ["93.184.215.14"], fetchImpl } });
    await people(w.plugin);
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "Oceania", source: "bgg", target: "300580" } })).toContain("BoardGameGeek's marketplace");
    await pollTick(w.plugin);
    // The read went to BGG's API once, and the 302 came back as it was: nothing went to the login page.
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("https://boardgamegeek.com/xmlapi2/"))).toBe(true);
  });

  it("watches Shopify stores daily with TRACKER_FIRECRAWL_KEY, sending only the search to Firecrawl with the key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const variant = (id: string, amount: number, shop: string, url: string) => ({
      id,
      title: "Wingspan: Oceania Expansion",
      url: `${url}?variant=1&_gsid=abc&utm_source=shopify`,
      price: { amount, currency: "USD" },
      availability: { available: true },
      seller: { name: shop },
      condition: ["new"],
    });
    const firecrawlFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const products = [
        { title: "Wingspan: Oceania Expansion", variants: [variant("gid://v/1", 3200, "Stonemaier Games", "https://store.stonemaiergames.com/products/oceania")] },
        { title: "Wingspan (base game)", variants: [variant("gid://v/2", 2000, "Elsewhere", "https://shop.example/base")] },
      ];
      return new Response(JSON.stringify({ success: true, data: { alexandria: [{ data: { products } }] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const w = await world({ fetch: shop([]).fetch, env: { TRACKER_FIRECRAWL_KEY: "fc-key" }, firecrawlFetch });
    await people(w.plugin);
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "Oceania", source: "shopify", target: "Wingspan Oceania" }, ints: { hours: 6 } })).toContain("`hours` is a whole number from 24 to 168");
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan Oceania expansion", source: "shopify" }, numbers: { max: 35 } });
    expect(made).toContain("Watching `t1`: Wingspan Oceania expansion.");
    expect(made).toContain(`Shopify stores' search for "Wingspan Oceania expansion" every 24 hours`);
    expect(made).toContain("5 credits");
    await pollTick(w.plugin);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(FIRECRAWL_SCRAPE_URL);
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer fc-key");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.alexandria).toMatchObject({ provider: "shopify", capability: "catalog/search_catalog", options: { query: "Wingspan Oceania expansion", filters: { available: true, price: { max: 3500 } } } });
    expect(content(w.sent, 0)).toContain("Wingspan Oceania expansion: a new listing.");
    expect(content(w.sent, 0)).toContain("- Wingspan: Oceania Expansion -- 32.00 USD -- new -- sold by Stonemaier Games <https://store.stonemaiergames.com/products/oceania?variant=1> (via Shopify)");
    expect(content(w.sent, 0)).not.toContain("base game");
    // Not again before the day is out; the next day, nothing new is nothing said.
    w.clock.advance(6 * 3600_000);
    await pollTick(w.plugin);
    expect(calls).toHaveLength(1);
    w.clock.advance(18 * 3600_000);
    await pollTick(w.plugin);
    expect(calls).toHaveLength(2);
    expect(w.sent).toHaveLength(1);
  });

  it("refuses a Shopify watch without TRACKER_FIRECRAWL_KEY, and tells the owner at once when the key is refused", async () => {
    const w = await world({ fetch: shop([]).fetch });
    await people(w.plugin);
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "Oceania", source: "shopify" } })).toBe(SHOPIFY_OFF);
    const refused = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const k = await world({ fetch: shop([]).fetch, env: { TRACKER_FIRECRAWL_KEY: "bad" }, firecrawlFetch: refused });
    await people(k.plugin);
    await slash(k.plugin, "want", LARRY, { strings: { name: "Oceania", source: "shopify" } });
    await pollTick(k.plugin);
    expect(content(k.sent, 0)).toContain("Oceania: I could read no listings from Shopify's store search just now (Firecrawl refused the key).");
    expect(content(k.sent, 0)).not.toContain("bad");
  });

  it("watches eBay through eBay's own API with the eBay keys, hourly, opening no eBay page", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const item = (id: string, title: string, value: string, seller: string) => ({
      itemId: `v1|${id}|0`,
      title,
      price: { value, currency: "USD" },
      condition: "New",
      itemWebUrl: `https://www.ebay.com/itm/${id}?hash=item1:g:x`,
      seller: { username: seller, feedbackPercentage: "99.6", feedbackScore: 4821 },
      buyingOptions: ["FIXED_PRICE"],
    });
    const ebayFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/identity/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "app-token", expires_in: 7200 }), { status: 200 });
      const itemSummaries = [item("123456789012", "Wingspan Oceania Expansion New Sealed", "29.99", "boardgame_bin"), item("223456789012", "Wingspan base game", "20.00", "elsewhere")];
      return new Response(JSON.stringify({ total: 2, itemSummaries }), { status: 200 });
    }) as unknown as typeof fetch;
    const { s: page, fetch: pageFetch } = shop([]);
    const w = await world({ fetch: pageFetch, env: { TRACKER_EBAY_CLIENT_ID: "app-id", TRACKER_EBAY_CLIENT_SECRET: "cert-id" }, ebayFetch });
    await people(w.plugin);
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan Oceania expansion", source: "ebay" }, numbers: { max: 35 } });
    expect(made).toContain("Watching `t1`: Wingspan Oceania expansion.");
    expect(made).toContain(`eBay's search for "Wingspan Oceania expansion" every 1 hour`);
    expect(made).toContain("I never open an eBay page");
    expect(made).not.toContain("POST /tasks/");
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "Oceania", source: "ebay", currency: "GBP" } })).toBe(EBAY_USD);
    await pollTick(w.plugin);
    expect(calls.map((c) => new URL(c.url).origin)).toEqual(["https://api.ebay.com", "https://api.ebay.com"]);
    expect(new URL(calls[1]?.url ?? "").searchParams.get("filter")).toBe("price:[..35.00],priceCurrency:USD");
    expect((calls[1]?.init.headers as Record<string, string>).authorization).toBe("Bearer app-token");
    expect(page.reads).toEqual([]);
    expect(content(w.sent, 0)).toContain("- Wingspan Oceania Expansion New Sealed -- 29.99 USD -- New -- sold by boardgame_bin, 99.6% positive, 4821 feedback <https://www.ebay.com/itm/123456789012> (via eBay)");
    expect(content(w.sent, 0)).not.toContain("base game");
    w.clock.advance(3600_000);
    await pollTick(w.plugin);
    // The token is kept: one more search, no second minting, and nothing new is nothing said.
    expect(calls).toHaveLength(3);
    expect(w.sent).toHaveLength(1);
  });

  it("keeps eBay an inbox watch without the keys, and tells the owner at once when eBay refuses them", async () => {
    const w = await world({ fetch: shop([]).fetch });
    await people(w.plugin);
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "Oceania", source: "ebay" } })).toContain("This watch never opens eBay itself.");
    const refused = (async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 })) as unknown as typeof fetch;
    const k = await world({ fetch: shop([]).fetch, env: { TRACKER_EBAY_CLIENT_ID: "app-id", TRACKER_EBAY_CLIENT_SECRET: "bad-cert" }, ebayFetch: refused });
    await people(k.plugin);
    await slash(k.plugin, "want", LARRY, { strings: { name: "Oceania", source: "ebay" } });
    await pollTick(k.plugin);
    expect(content(k.sent, 0)).toContain("Oceania: I could read no listings from eBay's search just now (eBay refused the app's keys).");
    expect(content(k.sent, 0)).not.toContain("bad-cert");
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

  it("over the task API: the cap is 409, judge without the runner is 503, and a PATCH clears the top price with null", async () => {
    const w = await world({ fetch: shop([OCEANIA]).fetch });
    await people(w.plugin);
    const jar = await signIn(w.plugin, LARRY);
    const token = await makeToken(w, jar);
    const post = (b: Record<string, unknown>) => api(w.plugin, "POST", "/tasks", { token, body: b });
    expect((await post({ type: "wantlist", name: "W", source: "page", target: SHOP, judge: "yes" })).status).toBe(503);
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

  it("over the task API: a Shopify watch is made with its words, and a PATCH under a day is refused", async () => {
    const empty = (async () => new Response(JSON.stringify({ data: { alexandria: [{ data: { products: [] } }] } }), { status: 200 })) as unknown as typeof fetch;
    const w = await world({ fetch: shop([]).fetch, env: { TRACKER_FIRECRAWL_KEY: "fc-key" }, firecrawlFetch: empty });
    await people(w.plugin);
    const jar = await signIn(w.plugin, LARRY);
    const token = await makeToken(w, jar);
    const made = await api(w.plugin, "POST", "/tasks", { token, body: { type: "wantlist", name: "Oceania", source: "shopify", target: "Wingspan Oceania", max: 35 } });
    expect(made.status).toBe(201);
    expect((await made.json()).task).toMatchObject({ source: "shopify", target: "Wingspan Oceania", settings: { max: 35, hours: 24 } });
    const fast = await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { hours: 6 } });
    expect(fast.status).toBe(400);
    expect(JSON.stringify(await fast.json())).toContain("from 24 to 168");
    expect((await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { hours: 48 } })).status).toBe(200);
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
