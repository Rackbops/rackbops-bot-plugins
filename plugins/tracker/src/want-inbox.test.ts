import { afterEach, describe, expect, it } from "bun:test";
import type { Fetch } from "@rackbops/docket-core";
import type { Plugin } from "../../../packages/api/contract.js";
import { MAX_LISTINGS_PER_POST } from "./inbox.js";
import { DEFAULT_INBOX_HOURS, ebaySearchUrl, INBOX_OFF } from "./want.js";
import { CITY_HALL, dmsTo, fakeCityHall, query } from "./web/execute-harness.js";
import { api, call, cleanup, CURLY, csrfOf, LARRY, makeToken, ORIGIN, people, signIn, slash, world } from "./web/harness.js";

/**
 * Inbox watches (tracker 0.19.0; docket-types 0.7.0's `inbox` source): `/want source: ebay`, and
 * `source: bgg` on a bot without BGG's API, make a watch whose listings are sent in through the
 * task API's `POST /tasks/<id>/listings` -- the tracker never opens eBay or BGG -- and the poll tick
 * DMs the new ones. End to end through the plugin: the command, the API, the tick, the web editor.
 */

afterEach(cleanup);

const pollTick = (p: Plugin) => p.ticks!.find((t) => t.name === "poll")!.run(new AbortController().signal);
type Sent = { userId: string; message: unknown }[];
const contents = (sent: Sent) => sent.map((s) => String((s.message as { content?: unknown }).content ?? ""));

/** Every page read: an inbox watch must make none. */
function noPages() {
  const reads: string[] = [];
  const fetch: Fetch = {
    async get(url: string) {
      reads.push(url);
      throw new Error("no page is read here");
    },
  };
  return { reads, fetch };
}

const KEY = /^ebay-[0-9a-f]{24}$/;
const OCEANIA = { title: "Wingspan Oceania Expansion", url: "https://www.ebay.com/itm/Wingspan-Oceania/123456789?_trksid=p123&hash=x", price: "$30.00", currency: "usd", condition: "Used", seller: "meeplebarn (1,204)" };
const ASIA = { title: "Wingspan Asia", url: "https://www.ebay.com/itm/223456789", price: 45 };

async function setup(opts: { webUrl?: string | null } = {}) {
  const pages = noPages();
  const w = await world({ fetch: pages.fetch, ...(opts.webUrl !== undefined ? { webUrl: opts.webUrl } : {}) });
  await people(w.plugin);
  return { ...w, pages };
}

async function tokenFor(w: Awaited<ReturnType<typeof setup>>, who = LARRY) {
  return makeToken(w, await signIn(w.plugin, who));
}

describe("/want source: ebay", () => {
  it("makes an inbox watch with an ebay- key and hourly looks, and says how listings reach it", async () => {
    const w = await setup();
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan Oceania", source: "ebay" }, numbers: { max: 35 } });
    expect(made).toContain("Watching `t1`: Wingspan Oceania.");
    expect(made).toContain("I look at what you send in from eBay every 1 hour");
    expect(made).toContain("I never open eBay myself.");
    expect(made).toContain("Claude in Chrome");
    expect(made).toContain("`POST /tasks/t1/listings`");
    expect(made).toContain("eBay's saved-search alert emails");
    expect(made).toContain(`<${ebaySearchUrl("Wingspan Oceania", 35)}>`);
    expect(ebaySearchUrl("Wingspan Oceania", 35)).toBe("https://www.ebay.com/sch/i.html?_nkw=Wingspan+Oceania&_udhi=35");
    const [task] = query<{ type: string; config: string; schedule: string }>(w.dbPath, "SELECT type, config, schedule FROM tasks");
    const config = JSON.parse(task?.config ?? "{}");
    expect(task?.type).toBe("wantlist");
    expect(config).toMatchObject({ source: "inbox", search: "Wingspan Oceania", maxPrice: 35 });
    expect(config.target).toMatch(KEY);
    expect(JSON.parse(task?.schedule ?? "{}")).toMatchObject({ kind: "poll", every: DEFAULT_INBOX_HOURS, unit: "hour" });
    expect(w.pages.reads).toEqual([]);
  });

  it("keeps other words to search for beside the name, and gives every watch its own key", async () => {
    const w = await setup();
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Oceania", source: "ebay", target: "wingspan  oceania expansion" } });
    expect(made).toContain('The eBay search for "wingspan oceania expansion"');
    await slash(w.plugin, "want", LARRY, { strings: { name: "Oceania", source: "ebay" } });
    const configs = query<{ config: string }>(w.dbPath, "SELECT config FROM tasks ORDER BY seq").map((r) => JSON.parse(r.config));
    expect(configs.map((c) => c.search)).toEqual(["wingspan oceania expansion", "Oceania"]);
    expect(configs[0].target).not.toBe(configs[1].target);
  });

  it("is refused without the web area, where listings are sent in", async () => {
    const w = await setup({ webUrl: null });
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "W", source: "ebay" } })).toBe(INBOX_OFF);
    expect(query(w.dbPath, "SELECT * FROM tasks")).toEqual([]);
  });
});

describe("/want source: bgg without BGG's API", () => {
  it("makes a bgg- inbox watch: a game named by id or address is kept as the game, other text as the words", async () => {
    const w = await setup();
    const game = await slash(w.plugin, "want", LARRY, { strings: { name: "Oceania", source: "bgg", target: "https://boardgamegeek.com/boardgameexpansion/300580/x" } });
    expect(game).toContain("I look at what you send in from BoardGameGeek every 1 hour");
    expect(game).toContain("This bot has no BoardGameGeek API access");
    expect(game).toContain("What to look for: BGG game 300580.");
    const words = await slash(w.plugin, "want", LARRY, { strings: { name: "Oceania", source: "bgg", target: "Wingspan Oceania" } });
    expect(words).toContain('What to look for: "Wingspan Oceania".');
    const configs = query<{ config: string }>(w.dbPath, "SELECT config FROM tasks ORDER BY seq").map((r) => JSON.parse(r.config));
    expect(configs[0]).toMatchObject({ source: "inbox", game: "300580", search: "Oceania" });
    expect(configs[0].target).toMatch(/^bgg-[0-9a-f]{24}$/);
    expect(configs[1]).toMatchObject({ source: "inbox", search: "Wingspan Oceania" });
    expect(configs[1].game).toBeUndefined();
    expect(w.pages.reads).toEqual([]);
  });
});

describe("POST /tasks/<id>/listings", () => {
  it("stores what is sent, the next look DMs it once, and GET /tasks says what to search for", async () => {
    const w = await setup();
    await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan Oceania", source: "ebay", currency: "USD" }, numbers: { max: 40 } });
    const token = await tokenFor(w);
    const listed = await (await api(w.plugin, "GET", "/tasks", { token })).json();
    expect(listed.tasks[0]).toMatchObject({ source: "inbox", site: "ebay", search: "Wingspan Oceania", settings: { max: 40, currency: "USD", hours: 1 } });
    expect(listed.tasks[0].target).toMatch(KEY);

    // The first look finds an empty inbox: nothing said.
    await pollTick(w.plugin);
    const before = w.sent.length;
    expect(contents(w.sent).filter((c) => c.startsWith("Wingspan Oceania"))).toEqual([]);

    const sent = await api(w.plugin, "POST", "/tasks/t1/listings", { token, body: { listings: [OCEANIA, ASIA, { title: "no address" }, "junk"] } });
    expect(sent.status).toBe(200);
    const body = await sent.json();
    expect(body).toMatchObject({ accepted: 2, rejected: 2 });
    expect(body.message).toContain("Took 2 listings from eBay for Wingspan Oceania. 2 were left out");
    const rows = query<{ task_id: string; listing: string }>(w.dbPath, "SELECT task_id, listing FROM want_inbox ORDER BY seq");
    expect(rows.map((r) => r.task_id)).toEqual(["t1", "t1"]);
    // Cleaned before it is stored: the eBay item's bare address, the price a number, the currency upper-case.
    expect(JSON.parse(rows[0]?.listing ?? "{}")).toEqual({
      title: "Wingspan Oceania Expansion",
      url: "https://www.ebay.com/itm/123456789",
      price: 30,
      currency: "USD",
      condition: "Used",
      seller: "meeplebarn (1,204)",
    });

    w.clock.advance(3600_000);
    await pollTick(w.plugin);
    const dms = contents(w.sent.slice(before)).filter((c) => c.startsWith("Wingspan Oceania"));
    expect(dms).toHaveLength(1);
    expect(dms[0]).toContain("Wingspan Oceania: a new listing.");
    expect(dms[0]).toContain("- Wingspan Oceania Expansion -- 30.00 USD -- Used -- sold by meeplebarn (1,204) <https://www.ebay.com/itm/123456789>");
    // Over the top price: not sent.
    expect(dms[0]).not.toContain("Wingspan Asia");

    // The same listing sent again, with new tracking on its address, is not DMed twice.
    expect((await api(w.plugin, "POST", "/tasks/t1/listings", { token, body: { listings: [{ ...OCEANIA, url: "https://www.ebay.com/itm/123456789?mkevt=1" }] } })).status).toBe(200);
    w.clock.advance(3600_000);
    await pollTick(w.plugin);
    expect(contents(w.sent.slice(before)).filter((c) => c.startsWith("Wingspan Oceania"))).toHaveLength(1);
    expect(w.pages.reads).toEqual([]);
  });

  it(`takes at most ${MAX_LISTINGS_PER_POST} a request, and refuses a body with none usable`, async () => {
    const w = await setup();
    await slash(w.plugin, "want", LARRY, { strings: { name: "W", source: "ebay" } });
    const token = await tokenFor(w);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `W ${i}`, url: `https://www.ebay.com/itm/${100000000 + i}` }));
    const post = (body: unknown) => api(w.plugin, "POST", "/tasks/t1/listings", { token, body });
    expect((await (await post({ listings: many(MAX_LISTINGS_PER_POST) })).json()).accepted).toBe(MAX_LISTINGS_PER_POST);
    const over = await post({ listings: many(MAX_LISTINGS_PER_POST + 1) });
    expect(over.status).toBe(400);
    expect((await over.json()).error.code).toBe("too_many");
    expect((await post({ listings: [{ title: "x", url: "/itm/1" }, { url: "https://www.ebay.com/itm/123456789" }] })).status).toBe(400);
    expect((await post({ listings: [] })).status).toBe(400);
    expect((await post({ listings: "x" })).status).toBe(400);
    expect((await post({ listings: many(1), extra: 1 })).status).toBe(400);
    expect((await api(w.plugin, "GET", "/tasks/t1/listings", { token })).status).toBe(405);
    expect(query(w.dbPath, "SELECT 1 FROM want_inbox")).toHaveLength(MAX_LISTINGS_PER_POST);
  });

  it("is the owner's own live inbox watch only: another's is 404, a page watch or a reminder is 409 or 404", async () => {
    const shopFetch: Fetch = {
      async get() {
        return { status: 200, body: '<script type="application/ld+json">{"@type":"ItemList","itemListElement":[]}</script>', headers: {} };
      },
    };
    const w = await world({ fetch: shopFetch });
    await people(w.plugin);
    await slash(w.plugin, "want", LARRY, { strings: { name: "Mine", source: "ebay" } });
    await slash(w.plugin, "want", CURLY, { strings: { name: "Curly's", source: "ebay" } });
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "A page", source: "page", target: "https://shop.example/search?q=w" } })).toContain("Watching `t3`");
    await slash(w.plugin, "remind", LARRY, { strings: { text: "water the plants", when: "tomorrow 9am" } });
    const token = await makeToken(w, await signIn(w.plugin, LARRY));
    const post = (id: string) => api(w.plugin, "POST", `/tasks/${id}/listings`, { token, body: { listings: [ASIA] } });
    expect((await post("t1")).status).toBe(200);
    const curly = await post("t2");
    expect(curly.status).toBe(404);
    expect((await curly.json()).error.message).toBe("No such task.");
    const page = await post("t3");
    expect(page.status).toBe(409);
    expect((await page.json()).error.message).toContain("listings are sent in only to an eBay watch");
    expect((await post("t4")).status).toBe(404);
    expect((await post("t99")).status).toBe(404);
    // Paused: still taken, read once it is resumed. Deleted: gone.
    expect((await api(w.plugin, "POST", "/tasks/t1/pause", { token, body: {} })).status).toBe(200);
    expect((await (await post("t1")).json()).message).toContain("The watch is paused");
    expect((await api(w.plugin, "DELETE", "/tasks/t1", { token })).status).toBe(200);
    expect((await post("t1")).status).toBe(404);
    expect(query<{ task_id: string }>(w.dbPath, "SELECT task_id FROM want_inbox")).toEqual([{ task_id: "t1" }, { task_id: "t1" }]);
  });
});

describe("an inbox watch on the web and in an edit", () => {
  it("is made from the web form, shows what it looks at, and an edit keeps its key and words", async () => {
    const w = await setup();
    const jar = await signIn(w.plugin, LARRY);
    const csrf = await csrfOf(w.plugin, jar);
    const form = await (await call(w.plugin, "GET", "/new/wantlist", { jar })).text();
    expect(form).toContain('value="ebay"');
    const made = await call(w.plugin, "POST", "/new/wantlist", { jar, origin: ORIGIN, form: { csrf, name: "Wingspan", source: "ebay", target: "", max: "", currency: "", hours: "" } });
    expect(made.status).toBe(303);
    const [before] = query<{ config: string }>(w.dbPath, "SELECT config FROM tasks").map((r) => JSON.parse(r.config));
    const edit = await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar })).text();
    expect(edit).toContain("Looking at: the eBay listings you send in for &quot;Wingspan&quot;");
    expect(edit).toContain('name="hours" type="number" value="1"');
    const saved = await call(w.plugin, "POST", "/tasks/t1/edit", { jar, origin: ORIGIN, form: { csrf, name: "Wingspan Oceania", max: "30", currency: "", hours: "2" } });
    expect(saved.status).toBe(303);
    const [after] = query<{ title: string; config: string }>(w.dbPath, "SELECT title, config FROM tasks");
    expect(after?.title).toBe("Wingspan Oceania");
    expect(JSON.parse(after?.config ?? "{}")).toEqual({ source: "inbox", target: before.target, search: "Wingspan", maxPrice: 30 });
  });
});

describe("a judged inbox watch", () => {
  it("has the model look at what was sent in, with no page to open", async () => {
    const city = fakeCityHall();
    const work: Promise<void>[] = [];
    const w = await world({ env: CITY_HALL, cityHallFetch: city.fetchImpl, executeStarted: (p) => void work.push(p), fetch: noPages().fetch });
    await people(w.plugin);
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan Oceania", source: "ebay" } });
    expect(made).toContain("what the listing says about the seller");
    const token = await makeToken(w, await signIn(w.plugin, LARRY));
    expect((await api(w.plugin, "POST", "/tasks/t1/listings", { token, body: { listings: [OCEANIA] } })).status).toBe(200);
    for (let i = 0; i < 4 && city.jobs.size === 0; i++) {
      for (const t of w.plugin.ticks ?? []) await t.run(new AbortController().signal);
      await Promise.all(work.splice(0));
      w.clock.advance(61_000);
    }
    expect(city.jobs.size).toBe(1);
    const spec = city.latest()?.spec as { prompt: string; allowedTools: string[]; disallowedTools: string[] };
    expect(spec.prompt).toContain("Wingspan Oceania Expansion");
    expect(spec.allowedTools).toEqual([]);
    expect(spec.disallowedTools).toContain("WebFetch");
    expect(dmsTo(w.sent, LARRY).filter((c) => c.startsWith("Wingspan Oceania"))).toEqual([]);
  });
});
