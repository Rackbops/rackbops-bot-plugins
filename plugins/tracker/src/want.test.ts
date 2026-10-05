import { afterEach, describe, expect, it } from "bun:test";
import type { Fetch, FetchResponse } from "@rackbops/docket-core";
import type { Plugin } from "../../../packages/api/contract.js";
import { FetchRefusedError } from "./fetch.js";
import { api, call, cleanup, csrfOf, LARRY, makeToken, ORIGIN, people, press, signIn, slash, world } from "./web/harness.js";
import { parseMarketplace, type Source, SourceUnavailableError } from "@rackbops/docket-types";
import { BGG_THING, shopSearch } from "./want-fixtures.js";
import { EBAY_PAGE, MAX_WANT_TASKS } from "./want.js";

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
