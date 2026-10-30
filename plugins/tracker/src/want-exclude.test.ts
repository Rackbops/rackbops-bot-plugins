import { afterEach, describe, expect, it } from "bun:test";
import type { Fetch, FetchResponse } from "@rackbops/docket-core";
import type { Plugin } from "../../../packages/api/contract.js";
import { api, call, cleanup, csrfOf, LARRY, makeToken, ORIGIN, people, signIn, slash, world } from "./web/harness.js";
import { shopSearch } from "./want-fixtures.js";

/**
 * Exclude words on want-list watches (docket#77, the Arkham pilot of #368), end to end: `/want`,
 * the web editor and the task API keep them in the config, and a poll leaves out what they rule
 * out. The matching itself is tested in Rackbops/docket (packages/types/test/want-exclude.test.ts).
 */

afterEach(cleanup);

const SHOP = "https://shop.example/search?q=edge+of+the+earth";
const pollTick = (p: Plugin) => p.ticks!.find((t) => t.name === "poll")!.run(new AbortController().signal);
const CAMPAIGN = { name: "Edge of the Earth Campaign Expansion", url: "https://shop.example/p/campaign", price: 60 };
const INVESTIGATOR = { name: "Edge of the Earth Investigator Expansion", url: "https://shop.example/p/investigator", price: 45 };

function shop() {
  const fetch: Fetch = {
    async get(): Promise<FetchResponse> {
      return { status: 200, body: shopSearch([CAMPAIGN, INVESTIGATOR]), headers: {} };
    },
  };
  return fetch;
}

type Sent = { userId: string; message: unknown }[];
const content = (sent: Sent, i: number): string => (sent[i]?.message as { content: string }).content;

describe("exclude words", () => {
  it("/want keeps them, says so, counts only what passes, and the poll DMs only the campaign box", async () => {
    const w = await world({ fetch: shop() });
    await people(w.plugin);
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Edge of the Earth", source: "page", target: SHOP, exclude: "investigator, starter deck" } });
    expect(made).toContain("The page lists 2 things now, 1 within your limits.");
    expect(made).toContain('I leave out any listing whose title has "investigator", "starter deck".');
    await pollTick(w.plugin);
    expect(w.sent).toHaveLength(1);
    expect(content(w.sent, 0)).toContain("Edge of the Earth Campaign Expansion");
    expect(content(w.sent, 0)).not.toContain("Investigator");
  });

  it("refuses too many entries, a long one, and one a searched watch's every listing has", async () => {
    const empty = (async () => new Response(JSON.stringify({ data: { alexandria: [{ data: { products: [] } }] } }), { status: 200 })) as unknown as typeof fetch;
    const w = await world({ fetch: shop(), env: { TRACKER_FIRECRAWL_KEY: "fc-key" }, firecrawlFetch: empty });
    await people(w.plugin);
    const many = Array.from({ length: 21 }, (_, i) => `w${i}`).join(", ");
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "E", source: "page", target: SHOP, exclude: many } })).toContain("at most 20 words or phrases");
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "E", source: "page", target: SHOP, exclude: "x".repeat(81) } })).toContain("at most 80 characters");
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "E", source: "page", target: SHOP, exclude: "a, " + many } })).toContain("at most 20 words or phrases");
    // Repeats and wordless entries are not counted: twenty distinct entries pass.
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "E", source: "page", target: SHOP, exclude: `${Array.from({ length: 20 }, (_, i) => `w${i}`).join(", ")}, W0, --` } })).toContain("Watching `t1`");
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "E", source: "page", target: `${SHOP}&p=2`, exclude: "!!!" } })).toContain("`exclude` needs words or phrases");
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "Arkham", source: "shopify", target: "Arkham Horror Edge of the Earth", exclude: "investigator, Earth" } })).toContain(
      'has "Earth", a word this watch searches for',
    );
    // A phrase of searched words is allowed: a title need not hold them together, in that order.
    const ok = await slash(w.plugin, "want", LARRY, { strings: { name: "Arkham", source: "shopify", target: "Arkham Horror Edge of the Earth", exclude: "investigator, earth edge" } });
    expect(ok).toContain("Watching `t2`");
  });

  it("over the task API: shown in settings, replaced and cleared by PATCH, listed by GET /types", async () => {
    const w = await world({ fetch: shop() });
    await people(w.plugin);
    const jar = await signIn(w.plugin, LARRY);
    const token = await makeToken(w, jar);
    const types = await (await api(w.plugin, "GET", "/types", { token })).json();
    const want = types.types.find((t: { type: string }) => t.type === "wantlist");
    expect(want.create.map((f: { name: string }) => f.name)).toContain("exclude");
    expect(want.edit.map((f: { name: string }) => f.name)).toContain("exclude");
    const made = await api(w.plugin, "POST", "/tasks", { token, body: { type: "wantlist", name: "Edge", source: "page", target: SHOP, exclude: "Investigator,investigator , promo" } });
    expect(made.status).toBe(201);
    expect((await made.json()).task.settings.exclude).toBe("Investigator, promo");
    const kept = await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { name: "Edge of the Earth" } });
    expect((await kept.json()).task.settings.exclude).toBe("Investigator, promo");
    const replaced = await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { exclude: "starter" } });
    expect((await replaced.json()).task.settings.exclude).toBe("starter");
    const cleared = await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { exclude: "" } });
    expect((await cleared.json()).task.settings.exclude).toBe("");
    const bad = await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { exclude: Array.from({ length: 21 }, (_, i) => `w${i}`).join(",") } });
    expect(bad.status).toBe(400);
  });

  it("from the web: the form takes them, and the edit form shows and keeps them", async () => {
    const w = await world({ fetch: shop() });
    await people(w.plugin);
    const jar = await signIn(w.plugin, LARRY);
    const csrf = await csrfOf(w.plugin, jar);
    expect(await (await call(w.plugin, "GET", "/new/wantlist", { jar })).text()).toContain('name="exclude"');
    const made = await call(w.plugin, "POST", "/new/wantlist", { jar, origin: ORIGIN, form: { csrf, name: "Edge", source: "page", target: SHOP, max: "", currency: "", exclude: "investigator", hours: "" } });
    expect(made.status).toBe(303);
    const edit = await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar })).text();
    expect(edit).toContain('name="exclude" type="text" value="investigator"');
    const saved = await call(w.plugin, "POST", "/tasks/t1/edit", { jar, origin: ORIGIN, form: { csrf, name: "Edge", max: "", currency: "", exclude: "investigator, promo", hours: "" } });
    expect(saved.status).toBe(303);
    expect(await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar })).text()).toContain('value="investigator, promo"');
  });
});
