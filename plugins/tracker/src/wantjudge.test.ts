import { afterEach, describe, expect, it } from "bun:test";
import type { Fetch, FetchResponse } from "@rackbops/docket-core";
import { JUDGE_OFF, NOTES_LONG, NOTES_PLAIN } from "./want.js";
import { shopSearch } from "./want-fixtures.js";
import { CITY_HALL, dmsTo, fakeCityHall, query, success } from "./web/execute-harness.js";
import { api, call, cleanup, csrfOf, LARRY, makeToken, ORIGIN, people, signIn, slash, world } from "./web/harness.js";

/**
 * The judged want-list watch (category 2, plan 5.4 and item 63; rackbops-bot-plugins#83): the Job it
 * makes, what it makes of the verdicts, and end to end through the fake city-hall -- `/want` with the
 * model runner set up, a plain-code look that is not charged, the model's look only at new listings,
 * the DM with its notes, the findings, a failed look sending the listings unchecked, and the web and
 * task API making one.
 */

afterEach(cleanup);

const SHOP = "https://shop.example/search?q=wingspan";
type Item = { name: string; url: string; price?: number; condition?: string; seller?: string };
const OCEANIA: Item = { name: "Wingspan Oceania", url: "https://shop.example/p/oceania", price: 30, condition: "New", seller: "Meeple Barn" };
const BOX: Item = { name: "Wingspan Nesting Box", url: "https://shop.example/p/nests", price: 25 };
const EUROPE: Item = { name: "Wingspan European", url: "https://other.example/p/europe", price: 28 };

function shop(items: Item[]) {
  const s = { items, reads: [] as string[] };
  const fetch: Fetch = {
    async get(url: string): Promise<FetchResponse> {
      s.reads.push(url);
      return { status: 200, body: shopSearch(s.items), headers: {} };
    },
  };
  return { s, fetch };
}

/** The plugin with the model runner (a fake city-hall) and a shop; `round` runs every tick and waits for the execute lane. */
async function judged(items: Item[]) {
  const city = fakeCityHall();
  const { s, fetch } = shop(items);
  const work: Promise<void>[] = [];
  const w = await world({ env: CITY_HALL, cityHallFetch: city.fetchImpl, executeStarted: (p) => void work.push(p), fetch });
  await people(w.plugin);
  const round = async () => {
    for (const t of w.plugin.ticks ?? []) await t.run(new AbortController().signal);
    await Promise.all(work.splice(0));
    w.clock.advance(61_000);
  };
  return { ...w, city, shop: s, round };
}


// The Job, the verdicts and the runs' rules are tested with the type in Rackbops/docket
// (packages/types/test/wantjudge.test.ts); these are the plugin's end to end.

describe("/want without the model runner", () => {
  it("makes a plain watch by default, and refuses judge: true", async () => {
    const w = await world({ fetch: shop([OCEANIA]).fetch });
    await people(w.plugin);
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "W", source: "page", target: SHOP }, booleans: { judge: true } })).toBe(JUDGE_OFF);
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "W", source: "page", target: SHOP } });
    expect(made).toContain("Watching `t1`");
    expect(made).not.toContain("The model looks");
    expect(query<{ type: string }>(w.dbPath, "SELECT type FROM tasks")).toEqual([{ type: "wantlist" }]);
  });
});

describe("/want with the model runner", () => {
  it("reads the page in plain code, has the model look only at new listings, DMs those worth a look, and keeps them all as findings", async () => {
    const w = await judged([OCEANIA, BOX]);
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan Oceania", source: "page", target: SHOP } });
    expect(made).toContain("Watching `t1`: Wingspan Oceania. The page lists 2 things now.");
    expect(made).toContain("the model looks at each listing I have not shown you before");
    const [task] = query<{ type: string; lane: string }>(w.dbPath, "SELECT type, lane FROM tasks");
    expect(task).toEqual({ type: "wantjudge", lane: "execute" });

    // The first look is plain code, uncharged; its follow-up is the model's look.
    for (let i = 0; i < 4 && w.city.jobs.size === 0; i++) await w.round();
    expect(w.city.jobs.size).toBe(1);
    const job = w.city.latest();
    const spec = job?.spec as { prompt: string; allowedTools: string[]; disallowedTools: string[] };
    expect(spec.prompt).toContain("1. Wingspan Oceania | 30.00 USD | new | seller: Meeple Barn | https://shop.example/p/oceania");
    expect(spec.prompt).toContain("2. Wingspan Nesting Box");
    expect(spec.allowedTools).toEqual(["WebFetch(domain:shop.example)"]);
    expect(spec.disallowedTools).toContain("WebSearch");
    expect(dmsTo(w.sent, LARRY).filter((c) => c.startsWith("Wingspan Oceania"))).toEqual([]);

    const verdicts = {
      verdicts: [
        { n: 1, fit: "match", why: "It is the Oceania expansion, new.", seller: "Meeple Barn: 4.9 stars from 210 reviews, 30-day returns." },
        { n: 2, fit: "no", why: "A storage insert, not the expansion.", seller: "not shown" },
      ],
    };
    if (job) Object.assign(job, { status: "done", result: success(verdicts, 0.12) });
    for (let i = 0; i < 4 && !dmsTo(w.sent, LARRY).some((c) => c.startsWith("Wingspan Oceania")); i++) await w.round();
    const dm = dmsTo(w.sent, LARRY).filter((c) => c.startsWith("Wingspan Oceania"));
    expect(dm).toHaveLength(1);
    expect(dm[0]).toContain("a new listing worth a look (1 more did not look like it)");
    expect(dm[0]).toContain("<https://shop.example/p/oceania>");
    expect(dm[0]).toContain("looks right: It is the Oceania expansion, new. Seller: Meeple Barn: 4.9 stars from 210 reviews");
    expect(dm[0]).not.toContain("Nesting Box");
    const findings = query<{ source: string; text: string; tags: string }>(w.dbPath, "SELECT source, text, tags FROM findings ORDER BY seq");
    expect(findings.map((f) => f.source)).toEqual(["https://shop.example/p/oceania", "https://shop.example/p/nests"]);
    expect(findings[1]?.text).toContain("not it: A storage insert");
    expect(JSON.parse(findings[1]?.tags ?? "[]")).toEqual(["wantlist", "page", "no"]);

    // The next look finds nothing new: no model call.
    w.clock.advance(12 * 3600_000);
    for (let i = 0; i < 3; i++) await w.round();
    expect(w.city.jobs.size).toBe(1);
    // A new listing is the only one the model sees next time.
    w.shop.items = [OCEANIA, BOX, EUROPE];
    w.clock.advance(12 * 3600_000);
    for (let i = 0; i < 4 && w.city.jobs.size === 1; i++) await w.round();
    expect(w.city.jobs.size).toBe(2);
    const second = w.city.latest()?.spec as { prompt: string; allowedTools: string[] };
    expect(second.prompt).toContain("1. Wingspan European");
    expect(second.prompt).not.toContain("Wingspan Oceania |");
    // On another site than the watch's: judged from its own text, no page opened.
    expect(second.allowedTools).toEqual([]);
    const runs = query<{ cost_usd: number | null }>(w.dbPath, "SELECT cost_usd FROM usage").length;
    expect(runs).toBe(1);
  });

  it("sends the listings unchecked when the model's look fails for good", async () => {
    const w = await judged([OCEANIA]);
    await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan Oceania", source: "page", target: SHOP } });
    for (let i = 0; i < 4 && w.city.jobs.size === 0; i++) await w.round();
    const job = w.city.latest();
    if (job) Object.assign(job, { status: "done", result: { kind: "budget_cap", detail: "over", durationMs: 10 } });
    for (let i = 0; i < 4 && !dmsTo(w.sent, LARRY).some((c) => c.startsWith("Wingspan Oceania")); i++) await w.round();
    const dm = dmsTo(w.sent, LARRY).filter((c) => c.startsWith("Wingspan Oceania"));
    expect(dm).toHaveLength(1);
    expect(dm[0]).toContain("a new listing, unchecked: the check cost more than it is allowed.");
    expect(dm[0]).toContain("<https://shop.example/p/oceania>");
    expect(w.city.jobs.size).toBe(1);
  });

  it("retries a failed look once with the same listings, then DMs its verdicts", async () => {
    const w = await judged([OCEANIA]);
    await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan Oceania", source: "page", target: SHOP } });
    for (let i = 0; i < 4 && w.city.jobs.size === 0; i++) await w.round();
    const first = w.city.latest();
    if (first) Object.assign(first, { status: "done", result: { kind: "schema_miss", detail: "shape", durationMs: 10 } });
    for (let i = 0; i < 4 && w.city.jobs.size === 1; i++) await w.round();
    expect(w.city.jobs.size).toBe(2);
    const retry = w.city.latest();
    expect(retry?.spec.prompt).toContain("1. Wingspan Oceania");
    expect(dmsTo(w.sent, LARRY).filter((c) => c.startsWith("Wingspan Oceania"))).toEqual([]);
    if (retry) Object.assign(retry, { status: "done", result: success({ verdicts: [{ n: 1, fit: "maybe", why: "Edition not stated.", seller: "not shown" }] }) });
    for (let i = 0; i < 4 && !dmsTo(w.sent, LARRY).some((c) => c.startsWith("Wingspan Oceania")); i++) await w.round();
    const dm = dmsTo(w.sent, LARRY).filter((c) => c.startsWith("Wingspan Oceania"));
    expect(dm).toHaveLength(1);
    expect(dm[0]).toContain("check it: Edition not stated.");
    expect(dm[0]).not.toContain("Seller: not shown");
    expect(w.city.jobs.size).toBe(2);
  });

  it("makes a plain watch with judge: false", async () => {
    const w = await judged([OCEANIA]);
    await slash(w.plugin, "want", LARRY, { strings: { name: "W", source: "page", target: SHOP }, booleans: { judge: false } });
    expect(query<{ type: string }>(w.dbPath, "SELECT type FROM tasks")).toEqual([{ type: "wantlist" }]);
  });

  it("is made from the web form and the task API, edited like a plain watch, and refused judging without the runner", async () => {
    const w = await judged([OCEANIA]);
    const jar = await signIn(w.plugin, LARRY);
    const form = await (await call(w.plugin, "GET", "/new/wantlist", { jar })).text();
    expect(form).toContain('<option value="yes" selected');
    const csrf = await csrfOf(w.plugin, jar);
    const posted = await call(w.plugin, "POST", "/new/wantlist", { jar, origin: ORIGIN, form: { csrf, name: "Wingspan", source: "page", target: SHOP, judge: "yes" } });
    expect(posted.status).toBe(303);
    const token = await makeToken(w, jar);
    const made = await api(w.plugin, "POST", "/tasks", { token, body: { type: "wantlist", name: "Oceania", source: "page", target: `${SHOP}&p=2`, judge: "no" } });
    expect(made.status).toBe(201);
    expect(query<{ type: string }>(w.dbPath, "SELECT type FROM tasks ORDER BY seq")).toEqual([{ type: "wantjudge" }, { type: "wantlist" }]);
    const got = await api(w.plugin, "GET", "/tasks/t1", { token });
    expect(((await got.json()) as { task: unknown }).task).toMatchObject({ type: "wantjudge", source: "page", target: SHOP });
    const edit = await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar })).text();
    expect(edit).toContain("Looking at: https://shop.example/search?q=wingspan");
    expect((await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { max: 40, hours: 6 } })).status).toBe(200);
    expect((await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { max: null } })).status).toBe(200);
    expect((await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { judge: "no" } })).status).toBe(400);

    const off = await world({ fetch: shop([OCEANIA]).fetch });
    await people(off.plugin);
    const offToken = await makeToken(off, await signIn(off.plugin, LARRY));
    const refused = await api(off.plugin, "POST", "/tasks", { token: offToken, body: { type: "wantlist", name: "Oceania", source: "page", target: SHOP, judge: "yes" } });
    expect(refused.status).toBe(503);
  });
});

/** eBay's Browse API with the given listings: the token, the search, and getItem by item id. */
function ebayApi(listings: { id: string; title: string; price: string; seller: string }[]) {
  const calls: string[] = [];
  const summary = (l: (typeof listings)[number]) => ({
    itemId: `v1|${l.id}|0`,
    title: l.title,
    price: { value: l.price, currency: "USD" },
    condition: "New",
    itemWebUrl: `https://www.ebay.com/itm/${l.id}`,
    seller: { username: l.seller, feedbackPercentage: "99.6", feedbackScore: 4821 },
    buyingOptions: ["FIXED_PRICE"],
  });
  const ebayFetch = (async (url: string) => {
    calls.push(url);
    if (url.endsWith("/identity/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "app-token", expires_in: 7200 }), { status: 200 });
    const m = /\/buy\/browse\/v1\/item\/v1%7C(\d+)%7C0/.exec(url);
    if (m) {
      const l = listings.find((x) => x.id === m[1]);
      return l ? new Response(JSON.stringify(summary(l)), { status: 200 }) : new Response("{}", { status: 404 });
    }
    return new Response(JSON.stringify({ total: listings.length, itemSummaries: listings.map(summary) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, ebayFetch };
}

describe("a judged eBay watch (tracker 0.42.0: city-hall forgets its Job, Rackbops/city-hall#6)", () => {
  async function ebayJudged() {
    const city = fakeCityHall();
    const { ebayFetch } = ebayApi([{ id: "123456789012", title: "Arkham Horror Card Game Dunwich Legacy Campaign Expansion", price: "39.99", seller: "boardgame_bin" }]);
    const work: Promise<void>[] = [];
    const w = await world({
      env: { ...CITY_HALL, TRACKER_EBAY_CLIENT_ID: "app-id", TRACKER_EBAY_CLIENT_SECRET: "cert-id" },
      cityHallFetch: city.fetchImpl,
      ebayFetch,
      executeStarted: (p) => void work.push(p),
      fetch: shop([]).fetch,
    });
    await people(w.plugin);
    const round = async () => {
      for (const t of w.plugin.ticks ?? []) await t.run(new AbortController().signal);
      await Promise.all(work.splice(0));
      w.clock.advance(61_000);
    };
    return { ...w, city, round };
  }

  it("is judged by default, asks city-hall to forget its Job within six hours, and gives the model its notes", async () => {
    const w = await ebayJudged();
    const notes = "Only a campaign expansion; an investigator deck alone is not a match.";
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Dunwich", source: "ebay", notes } });
    expect(made).toContain("the model checks each new listing from what eBay's API says, and city-hall erases that check's Job soon after it ends, within 6 hours");
    const [task] = query<{ type: string; config: string }>(w.dbPath, "SELECT type, config FROM tasks");
    expect(task?.type).toBe("wantjudge");
    expect(JSON.parse(task?.config ?? "{}")).toMatchObject({ source: "ebay", notes });
    for (let i = 0; i < 6 && w.city.jobs.size === 0; i++) await w.round();
    const job = w.city.latest();
    expect(job?.forgetAfterSeconds).toBe(21_600);
    expect(job?.spec.prompt).toContain(notes);
    expect(job?.spec.prompt).toContain("Dunwich Legacy Campaign Expansion");
  });

  it("refuses notes on a plain watch and past their limit, and edits and clears them on a judged one", async () => {
    const w = await ebayJudged();
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "D", source: "ebay", notes: "x" }, booleans: { judge: false } })).toBe(NOTES_PLAIN);
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "D", source: "ebay", notes: "x".repeat(501) } })).toBe(NOTES_LONG);
    await slash(w.plugin, "want", LARRY, { strings: { name: "D", source: "ebay", notes: "first" } });
    await slash(w.plugin, "want", LARRY, { strings: { name: "P", source: "ebay" }, booleans: { judge: false } });
    const token = await makeToken(w, await signIn(w.plugin, LARRY));
    expect((await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { notes: "second" } })).status).toBe(200);
    const config = () => query<{ config: string }>(w.dbPath, "SELECT config FROM tasks ORDER BY seq").map((r) => JSON.parse(r.config) as { notes?: string });
    expect(config()[0]?.notes).toBe("second");
    const read = (await (await api(w.plugin, "GET", "/tasks/t1", { token })).json()) as { task: { settings: Record<string, unknown> } };
    expect(read.task.settings.notes).toBe("second");
    expect((await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { notes: "-" } })).status).toBe(200);
    expect(config()[0]?.notes).toBeUndefined();
    // A plain watch's edit has no notes field at all.
    expect((await api(w.plugin, "PATCH", "/tasks/t2", { token, body: { notes: "x" } })).status).toBe(400);
  });

  it("against a city-hall that does not forget: one Job lands there, the listings go out unchecked, and other model runs go on", async () => {
    const city = fakeCityHall();
    const old = (async (input: string | URL | Request, init?: RequestInit) => {
      const r = await city.fetchImpl(input, init);
      const b = (await r.json()) as { job?: Record<string, unknown> };
      if (b.job) delete b.job.forgottenAt;
      return Response.json(b, { status: r.status });
    }) as typeof fetch;
    const { ebayFetch } = ebayApi([{ id: "123456789012", title: "Arkham Horror Dunwich Legacy Campaign Expansion", price: "39.99", seller: "boardgame_bin" }]);
    const work: Promise<void>[] = [];
    const w = await world({
      env: { ...CITY_HALL, TRACKER_EBAY_CLIENT_ID: "app-id", TRACKER_EBAY_CLIENT_SECRET: "cert-id" },
      cityHallFetch: old,
      ebayFetch,
      executeStarted: (p) => void work.push(p),
      fetch: shop([OCEANIA]).fetch,
    });
    await people(w.plugin);
    await slash(w.plugin, "want", LARRY, { strings: { name: "Dunwich", source: "ebay" } });
    const round = async () => {
      for (const t of w.plugin.ticks ?? []) await t.run(new AbortController().signal);
      await Promise.all(work.splice(0));
      w.clock.advance(61_000);
    };
    for (let i = 0; i < 6; i++) await round();
    await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan", source: "page", target: SHOP } });
    for (let i = 0; i < 20; i++) await round();
    w.clock.advance(3600_000);
    for (let i = 0; i < 10; i++) await round();
    const keys = [...city.jobs.values()];
    // One eBay Job (which an old city-hall keeps), and the page watch's own Job: the lane went on.
    expect(keys.filter((j) => j.spec.prompt.includes("Dunwich"))).toHaveLength(1);
    expect(keys.some((j) => j.spec.prompt.includes("Wingspan"))).toBe(true);
    const dm = dmsTo(w.sent, LARRY).filter((c) => c.startsWith("Dunwich"));
    expect(dm).toHaveLength(1);
    expect(dm[0]).toContain("unchecked");
  });
});
