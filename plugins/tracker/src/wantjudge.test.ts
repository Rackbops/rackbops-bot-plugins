import { afterEach, describe, expect, it } from "bun:test";
import type { Fetch, FetchResponse } from "@rackbops/docket-core";
import { JUDGE_OFF } from "./want.js";
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
