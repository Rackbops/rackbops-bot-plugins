import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { Fetch, FetchResponse } from "@rackbops/docket-core";
import { parseMarketplace, type Source } from "@rackbops/docket-types";
import type { Plugin } from "../../../packages/api/contract.js";
import { ebayLinesForgotten, forgetEbayMessages } from "./ebay-forget.js";
import { openDatabase } from "./schema.js";
import { BGG_THING, shopSearch } from "./want-fixtures.js";
import { SOURCE_WORDS, sourcesPlan } from "./want.js";
import { CITY_HALL, dmsTo, fakeCityHall, success } from "./web/execute-harness.js";
import { api, call, cleanup, csrfOf, LARRY, makeToken, ORIGIN, people, signIn, world } from "./web/harness.js";

/**
 * One watch, several places (Rod, 2026-11-15, on the New want-list watch form: "This should be
 * check boxes for multiple selections, not single pull down choices"): the form's boxes, the task
 * API's comma-separated `source` and `target_<source>` fields, and every host path that reads a
 * watch's source. The merge of what the places find is docket-types' (want-places.test.ts there).
 */

afterEach(cleanup);

const SHOP = "https://shop.example/search?q=rougarou";
const pollTick = (p: Plugin) => p.ticks!.find((t) => t.name === "poll")!.run(new AbortController().signal);
type Sent = { userId: string; message: unknown }[];
const content = (sent: Sent, i: number): string => (sent[i]?.message as { content: string }).content;

function shop() {
  const reads: string[] = [];
  const fetch: Fetch = {
    async get(url: string): Promise<FetchResponse> {
      reads.push(url);
      return { status: 200, body: shopSearch([{ name: "Curse of the Rougarou", url: "https://shop.example/p/rougarou", price: 30 }]), headers: {} };
    },
  };
  return { reads, fetch };
}

function bggSource(): Source & { searched: string[] } {
  const searched: string[] = [];
  return {
    id: "bgg",
    searched,
    async search(target) {
      searched.push(target);
      return parseMarketplace(BGG_THING);
    },
  };
}

function configOf(dbPath: string, id: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT config FROM tasks WHERE seq = ?").get(Number(id.slice(1))) as { config: string };
    return JSON.parse(row.config) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

describe("the sources a watch names", () => {
  it("reads one or several, once each, in a fixed order, and none as a page", () => {
    expect(sourcesPlan("")).toEqual({ ok: true, sources: ["page"] });
    expect(sourcesPlan("ebay")).toEqual({ ok: true, sources: ["ebay"] });
    expect(sourcesPlan(" Shopify, page,ebay,page ")).toEqual({ ok: true, sources: ["page", "ebay", "shopify"] });
    expect(sourcesPlan("page,nowhere")).toEqual({ ok: false, error: SOURCE_WORDS });
  });
});

describe("a watch of several places", () => {
  it("from the web form's boxes: one watch, one DM with every place's listings", async () => {
    const { fetch, reads } = shop();
    const bgg = bggSource();
    const w = await world({ fetch, bgg });
    await people(w.plugin);
    const jar = await signIn(w.plugin, LARRY);
    const csrf = await csrfOf(w.plugin, jar);
    const form: [string, string][] = [["csrf", csrf], ["name", "Rougarou"], ["source", "page"], ["source", "bgg"], ["target_page", SHOP], ["target_bgg", "300580"], ["judge", "no"]];
    const made = await call(w.plugin, "POST", "/new/wantlist", { jar, origin: ORIGIN, form });
    expect(made.status).toBe(303);
    const config = configOf(w.dbPath, "t1");
    expect(config.source).toBe("page");
    expect(config.target).toBe(SHOP);
    expect(config.also).toEqual([{ source: "bgg", target: "300580" }]);
    // The page was read once, as a one-place page watch is when it is made.
    expect(reads).toEqual([SHOP]);
    await pollTick(w.plugin);
    expect(bgg.searched).toEqual(["300580"]);
    expect(w.sent).toHaveLength(1);
    const dm = content(w.sent, 0);
    expect(dm).toContain("Rougarou: 3 new listings.");
    expect(dm).toContain("<https://shop.example/p/rougarou>");
    expect(dm).toContain("<https://boardgamegeek.com/geekmarket/product/4100001> (via BoardGameGeek)");
    const edit = await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar })).text();
    expect(edit).toContain("BoardGameGeek game 300580");
  });

  it("over the task API: a comma-separated source with each place's target, shown back as places", async () => {
    const w = await world({ fetch: shop().fetch, bgg: bggSource() });
    await people(w.plugin);
    const token = await makeToken(w, await signIn(w.plugin, LARRY));
    const body = { type: "wantlist", name: "Rougarou", source: "page,bgg", target_page: SHOP, target_bgg: "300580", judge: "no" };
    const made = await api(w.plugin, "POST", "/tasks", { token, body });
    expect(made.status).toBe(201);
    const { task } = (await (await api(w.plugin, "GET", "/tasks/t1", { token })).json()) as { task: { source: string; places: { source: string; target: string }[] } };
    expect(task.source).toBe("page");
    expect(task.places).toEqual([
      { source: "page", target: SHOP },
      { source: "bgg", target: "300580" },
    ]);
    const types = (await (await api(w.plugin, "GET", "/types", { token })).json()) as { types: { type: string; create: { name: string; enum?: string[] }[] }[] };
    const fields = types.types.find((t) => t.type === "wantlist")?.create ?? [];
    expect(fields.find((f) => f.name === "source")?.enum).toBeUndefined();
    expect(fields.map((f) => f.name)).toContain("target");
    expect(fields.map((f) => f.name)).toContain("target_nobleknight");
  });

  it("is refused when a place's target is wrong, naming the place", async () => {
    const w = await world({ fetch: shop().fetch, bgg: bggSource() });
    await people(w.plugin);
    const token = await makeToken(w, await signIn(w.plugin, LARRY));
    const bad = await api(w.plugin, "POST", "/tasks", { token, body: { type: "wantlist", name: "R", source: "page,bgg", target_page: SHOP, target_bgg: "not a game" } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toStartWith("BoardGameGeek: That is not a BGG game.");
    // Several places take only their own targets: `target` alone names no page.
    const generic = await api(w.plugin, "POST", "/tasks", { token, body: { type: "wantlist", name: "R", source: "page,bgg", target: SHOP, target_bgg: "300580" } });
    expect(((await generic.json()) as { error: { message: string } }).error.message).toStartWith("the listing page: `target_page` is");
  });

  it("several inbox places searched by the name need no targets, and each takes its own site's listings", async () => {
    const w = await world({ fetch: shop().fetch });
    await people(w.plugin);
    const token = await makeToken(w, await signIn(w.plugin, LARRY));
    // Without eBay keys or BGG access both are inbox places, searched by the name.
    const made = await api(w.plugin, "POST", "/tasks", { token, body: { type: "wantlist", name: "Rougarou", source: "bgg,ebay" } });
    expect(made.status).toBe(201);
    const config = configOf(w.dbPath, "t1");
    expect(config.source).toBe("inbox");
    expect((config.also as { source: string }[])[0]?.source).toBe("inbox");
    const sent = await api(w.plugin, "POST", "/tasks/t1/listings", {
      token,
      body: {
        listings: [
          { title: "Curse of the Rougarou", url: "https://www.ebay.com/itm/1", price: 20, currency: "USD" },
          { title: "Curse of the Rougarou", url: "https://boardgamegeek.com/geekmarket/product/9", price: 25, currency: "USD" },
          { title: "Curse of the Rougarou", url: "https://elsewhere.example/p/1", price: 25, currency: "USD" },
        ],
      },
    });
    expect(sent.status).toBe(200);
    const answer = (await sent.json()) as { accepted: number; rejected: number };
    expect(answer).toMatchObject({ accepted: 2, rejected: 1 });
    // Each went to its own site's place.
    const rows = openDatabase(w.dbPath).query("SELECT key, listing FROM want_inbox ORDER BY seq").all() as { key: string; listing: string }[];
    expect(rows.map((r) => [r.key.split("-")[0], JSON.parse(r.listing).url]).sort()).toEqual([
      ["bgg", "https://boardgamegeek.com/geekmarket/product/9"],
      ["ebay", "https://www.ebay.com/itm/1"],
    ]);
    const before = w.sent.length;
    await pollTick(w.plugin);
    expect(content(w.sent, before)).toContain("Rougarou: 2 new listings.");
  });

  it("repeats a watch when any one place does", async () => {
    const w = await world({ fetch: shop().fetch, bgg: bggSource() });
    await people(w.plugin);
    const token = await makeToken(w, await signIn(w.plugin, LARRY));
    expect((await api(w.plugin, "POST", "/tasks", { token, body: { type: "wantlist", name: "R", source: "bgg", target: "300580" } })).status).toBe(201);
    const again = await api(w.plugin, "POST", "/tasks", { token, body: { type: "wantlist", name: "R2", source: "page,bgg", target_page: SHOP, target_bgg: "300580" } });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("duplicate");
    // And the other way round: a one-place watch that one of a stored watch's places repeats.
    const other = await api(w.plugin, "POST", "/tasks", { token, body: { type: "wantlist", name: "R3", source: "page,bgg", target_page: SHOP, target_bgg: "300581" } });
    expect(other.status).toBe(201);
    const page = await api(w.plugin, "POST", "/tasks", { token, body: { type: "wantlist", name: "R4", source: "page", target: SHOP } });
    expect(page.status).toBe(409);
  });

  it("keeps its places through an edit", async () => {
    const w = await world({ fetch: shop().fetch, bgg: bggSource() });
    await people(w.plugin);
    const token = await makeToken(w, await signIn(w.plugin, LARRY));
    await api(w.plugin, "POST", "/tasks", { token, body: { type: "wantlist", name: "R", source: "page,bgg", target_page: SHOP, target_bgg: "300580" } });
    const edited = await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { name: "Rougarou", hours: 3, max: 40 } });
    expect(edited.status).toBe(200);
    const config = configOf(w.dbPath, "t1");
    expect(config.also).toEqual([{ source: "bgg", target: "300580" }]);
    expect(config.maxPrice).toBe(40);
  });
});

describe("eBay's lines in a watch of several places", () => {
  const DM = [
    "Rougarou: 2 new listings.",
    "- Curse of the Rougarou -- 30.00 USD <https://shop.example/p/rougarou>",
    "- Curse of the Rougarou -- 20.00 USD -- sold by seller1 <https://www.ebay.com/itm/123> (via eBay)",
    "Press Done once you have it, and I stop looking.",
  ].join("\n");

  it("are cleared at six hours, the other places' lines kept", () => {
    const out = ebayLinesForgotten(DM, "curse rougarou", 40);
    expect(out).not.toBeNull();
    expect(out).toContain("<https://shop.example/p/rougarou>");
    expect(out).not.toContain("ebay.com/itm");
    expect(out).not.toContain("seller1");
    expect(out).toContain("eBay's own search: <https://www.ebay.com/sch/i.html?_nkw=curse+rougarou&_udhi=40>");
    expect(out?.split("\n").at(-1)).toBe("Press Done once you have it, and I stop looking.");
    expect(ebayLinesForgotten("Rougarou: a new listing.\n- X <https://shop.example/p/1>\nPress Done.", "x")).toBeNull();
  });

  it("drops a line cut at Discord's length, which may be an eBay listing before its link", () => {
    const cut = `${DM.split("\n").slice(0, 2).join("\n")}\n- Curse of the Rougarou -- 20.00 USD -- sold by seller1...`;
    const out = ebayLinesForgotten(cut, "curse rougarou");
    expect(out).not.toBeNull();
    expect(out).not.toContain("seller1");
    expect(out).toContain("<https://shop.example/p/rougarou>");
    expect(out?.split("\n").at(-1)).toBe("Press Done once you have it, and I stop looking.");
    // A DM cut at full length keeps the whole note, giving up its last listings for it.
    const long = Array.from({ length: 12 }, (_, i) => `- Curse of the Rougarou ${i} -- 30.00 USD <https://shop.example/p/${"r".repeat(120)}${i}>`);
    const full = `${["Rougarou: 13 new listings.", ...long].join("\n")}\n- Curse of the Rougarou -- 20.00 USD -- sold by seller1 <https://www.ebay.com/itm/123>`.slice(0, 1997) + "...";
    const whole = ebayLinesForgotten(full, "curse rougarou");
    expect(whole?.length).toBeLessThanOrEqual(2000);
    expect(whole).toContain("eBay's listings are not kept here past 6 hours");
    expect(whole?.split("\n").at(-1)).toBe("Press Done once you have it, and I stop looking.");
    expect(whole?.split("\n")[0]).toBe("Rougarou: 13 new listings.");
    expect(whole).not.toContain("seller1");
  });

  it("are found by the sweep through the watch's also", () => {
    const db = openDatabase(":memory:");
    try {
      const at = "2026-11-15T00:00:00.000Z";
      const config = { source: "page", target: SHOP, also: [{ source: "ebay", target: "curse rougarou" }] };
      db.query(
        "INSERT INTO tasks (owner_id, type, title, config, state, schedule, lane, capabilities, status, created_at, updated_at) VALUES ('u1', 'wantlist', 'Rougarou', ?, '{}', '{}', 'notify', '[]', 'active', ?, ?)",
      ).run(JSON.stringify(config), at, at);
      const record = { firedAt: at, outcome: { notify: { text: DM, actions: ["done"] }, summary: "2 new" } };
      db.query(
        "INSERT INTO occurrences (task_id, lane, due_at, started_at, finished_at, status, late, dedupe_key, created_at, record) VALUES ('t1', 'notify', ?, ?, ?, 'done', 0, 'k1', ?, ?)",
      ).run(at, at, at, at, JSON.stringify(record));
      expect(forgetEbayMessages(db, new Date("2026-11-15T07:00:00.000Z"))).toBe(1);
      const text = (db.query("SELECT json_extract(record, '$.outcome.notify.text') AS t FROM occurrences").get() as { t: string }).t;
      expect(text).toContain("<https://shop.example/p/rougarou>");
      expect(text).not.toContain("ebay.com/itm");
      // Swept once: a second sweep finds no eBay line left.
      expect(forgetEbayMessages(db, new Date("2026-11-15T08:00:00.000Z"))).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("a watch of several places the model checks (0.63.0)", () => {
  it("reads every place, has the model look at all they found in one Job, and DMs the ones worth a look", async () => {
    const city = fakeCityHall();
    const bgg = bggSource();
    const work: Promise<void>[] = [];
    const w = await world({ env: CITY_HALL, cityHallFetch: city.fetchImpl, executeStarted: (p) => void work.push(p), fetch: shop().fetch, bgg });
    await people(w.plugin);
    const round = async () => {
      for (const t of w.plugin.ticks ?? []) await t.run(new AbortController().signal);
      await Promise.all(work.splice(0));
      w.clock.advance(61_000);
    };
    const jar = await signIn(w.plugin, LARRY);
    const csrf = await csrfOf(w.plugin, jar);
    // The web form's judge choice is kept with several places ticked.
    const form: [string, string][] = [["csrf", csrf], ["name", "Rougarou"], ["source", "page"], ["source", "bgg"], ["target_page", SHOP], ["target_bgg", "300580"], ["judge", "yes"]];
    expect((await call(w.plugin, "POST", "/new/wantlist", { jar, origin: ORIGIN, form })).status).toBe(303);
    const db = new Database(w.dbPath, { readonly: true });
    const type = (db.query("SELECT type FROM tasks WHERE seq = 1").get() as { type: string }).type;
    db.close();
    expect(type).toBe("wantjudge");
    expect(configOf(w.dbPath, "t1").also).toEqual([{ source: "bgg", target: "300580" }]);

    for (let i = 0; i < 4 && city.jobs.size === 0; i++) await round();
    expect(city.jobs.size).toBe(1);
    const job = city.latest();
    const spec = job?.spec as { prompt: string; allowedTools: string[] };
    expect(spec.prompt).toContain("1. Curse of the Rougarou");
    expect(spec.prompt).toContain("a shop page they gave and BoardGameGeek's marketplace");
    expect(spec.allowedTools.sort()).toEqual(["WebFetch(domain:boardgamegeek.com)", "WebFetch(domain:shop.example)"]);
    // Neither place's eBay: the Job is kept as any judged watch's.
    expect(job?.forgetAfterSeconds).toBeUndefined();
    const n = (spec.prompt.match(/^\d+\. /gm) ?? []).length;
    expect(n).toBeGreaterThan(1);
    const verdicts = { verdicts: Array.from({ length: n }, (_, i) => ({ n: i + 1, fit: "match", why: "it", seller: "not shown" })) };
    if (job) Object.assign(job, { status: "done", result: success(verdicts, 0.1) });
    for (let i = 0; i < 4 && !dmsTo(w.sent, LARRY).some((c) => c.startsWith("Rougarou")); i++) await round();
    const dm = dmsTo(w.sent, LARRY).filter((c) => c.startsWith("Rougarou"));
    expect(dm).toHaveLength(1);
    expect(dm[0]).toContain(`${n} new listings worth a look`);
    expect(dm[0]).toContain("<https://shop.example/p/rougarou>");
    expect(dm[0]).toContain("(via BoardGameGeek)");
  });

  it("over the task API, with judge left out, is checked by the model where the runner is set up, and says so", async () => {
    const w = await world({ env: CITY_HALL, cityHallFetch: fakeCityHall().fetchImpl, fetch: shop().fetch, bgg: bggSource() });
    await people(w.plugin);
    const token = await makeToken(w, await signIn(w.plugin, LARRY));
    const body = { type: "wantlist", name: "Rougarou", source: "page,bgg", target_page: SHOP, target_bgg: "300580" };
    const made = await api(w.plugin, "POST", "/tasks", { token, body });
    expect(made.status).toBe(201);
    expect(JSON.stringify(await made.json())).toContain("the model checks everything they found together");
    const db = new Database(w.dbPath, { readonly: true });
    const type = (db.query("SELECT type FROM tasks WHERE seq = 1").get() as { type: string }).type;
    db.close();
    expect(type).toBe("wantjudge");
  });
});
