import { afterEach, describe, expect, it } from "bun:test";
import type { Fetch, FetchResponse } from "@rackbops/docket-core";
import type { Plugin } from "../../../packages/api/contract.js";
import { CONFIRM_JUDGED, UNCONFIRMED_ALONE } from "./want.js";
import { shopSearch } from "./want-fixtures.js";
import { fieldsFor } from "./web/editor-pages.js";
import { CITY_HALL, fakeCityHall } from "./web/execute-harness.js";
import { api, call, cleanup, csrfOf, LARRY, makeToken, ORIGIN, people, signIn, slash, world } from "./web/harness.js";

/**
 * Confirm words on want-list watches (docket#87, docket 0.20.0, the Arkham pilot of #368, Rod
 * 2026-10-30: "leave it out, then double check any that don't have it"), end to end: `/want`, the
 * web editor and the task API keep `confirm` and `unconfirmed` in a plain watch's config, and a poll
 * DMs a confirmed listing plainly, marks one to check, and leaves out one `unconfirmed` rules out.
 * The matching and eBay's full-listing read are tested in Rackbops/docket
 * (packages/types/test/want-confirm.test.ts); the eBay read through this host is in want.test.ts.
 */

afterEach(cleanup);

const SHOP = "https://shop.example/search?q=edge+of+the+earth";
const pollTick = (p: Plugin) => p.ticks!.find((t) => t.name === "poll")!.run(new AbortController().signal);
const CAMPAIGN = { name: "Edge of the Earth Campaign Expansion", url: "https://shop.example/p/campaign", price: 60 };
const SEALED = { name: "Edge of the Earth expansion, sealed", url: "https://shop.example/p/sealed", price: 55 };
const INVESTIGATOR = { name: "Edge of the Earth Investigator Expansion", url: "https://shop.example/p/investigator", price: 45 };

function shop() {
  const fetch: Fetch = {
    async get(): Promise<FetchResponse> {
      return { status: 200, body: shopSearch([CAMPAIGN, SEALED, INVESTIGATOR]), headers: {} };
    },
  };
  return fetch;
}

type Sent = { userId: string; message: unknown }[];
const content = (sent: Sent, i: number): string => (sent[i]?.message as { content: string }).content;

describe("confirm words", () => {
  it("/want keeps them and says so; the poll DMs the campaign box, marks the sealed one, and leaves out the Investigator box", async () => {
    const w = await world({ fetch: shop() });
    await people(w.plugin);
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Edge of the Earth", source: "page", target: SHOP, confirm: "campaign", unconfirmed: "investigator" } });
    expect(made).toContain("Watching `t1`");
    expect(made).toContain('A listing whose title has none of "campaign": DM it if that says one, leave it out if it has "investigator", and otherwise DM it marked `check: not confirmed as "campaign"`.');
    await pollTick(w.plugin);
    expect(w.sent).toHaveLength(1);
    const dm = content(w.sent, 0);
    expect(dm).toContain("- Edge of the Earth Campaign Expansion");
    expect(dm).toContain('- check: not confirmed as "campaign" -- Edge of the Earth expansion, sealed');
    expect(dm).not.toContain("Investigator");
  });

  it("refuses unconfirmed alone, a searched confirm word, and confirm on a judged watch; makes a plain watch when judge is left out", async () => {
    const w = await world({ env: CITY_HALL, cityHallFetch: fakeCityHall().fetchImpl, fetch: shop() });
    await people(w.plugin);
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "E", source: "page", target: SHOP, unconfirmed: "investigator" } })).toBe(UNCONFIRMED_ALONE);
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "E", source: "page", target: SHOP, confirm: "campaign" }, booleans: { judge: true } })).toBe(CONFIRM_JUDGED);
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "E", source: "page", target: SHOP, confirm: Array.from({ length: 20 }, (_, i) => `w${String(i).padStart(2, "0")}xxxxxxxxxxx`).join(",") } })).toContain("`confirm` is longer than 300 characters.");
    const plain = await slash(w.plugin, "want", LARRY, { strings: { name: "E", source: "page", target: SHOP, confirm: "campaign" } });
    expect(plain).toContain("Watching `t1`");
    expect(plain).not.toContain("the model looks at each listing");
  });

  it("refuses a confirm word an eBay watch searches for, and says it reads the full listing", async () => {
    const ebayFetch = (async () => new Response(JSON.stringify({ total: 0, itemSummaries: [] }), { status: 200 })) as unknown as typeof fetch;
    const w = await world({ fetch: shop(), env: { TRACKER_EBAY_CLIENT_ID: "app-id", TRACKER_EBAY_CLIENT_SECRET: "cert-id" }, ebayFetch });
    await people(w.plugin);
    const target = "Arkham Horror Edge of the Earth";
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "Arkham", source: "ebay", target, confirm: "earth" } })).toContain('`confirm` has "earth", a word this watch searches for');
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Arkham", source: "ebay", target, confirm: "campaign", unconfirmed: "investigator" } });
    expect(made).toContain("I read it in full through eBay's API (its item specifics and description)");
  });

  it("over the task API: listed by GET /types, shown in settings, kept, cleared, and refused when unconfirmed is left alone", async () => {
    const w = await world({ fetch: shop() });
    await people(w.plugin);
    const jar = await signIn(w.plugin, LARRY);
    const token = await makeToken(w, jar);
    const types = await (await api(w.plugin, "GET", "/types", { token })).json();
    const want = types.types.find((t: { type: string }) => t.type === "wantlist");
    expect(want.create.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(["confirm", "unconfirmed"]));
    expect(want.edit.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(["confirm", "unconfirmed"]));
    const made = await api(w.plugin, "POST", "/tasks", { token, body: { type: "wantlist", name: "Edge", source: "page", target: SHOP, judge: "no", confirm: "Campaign, campaign", unconfirmed: "investigator" } });
    expect(made.status).toBe(201);
    const settings = (await made.json()).task.settings;
    expect([settings.confirm, settings.unconfirmed]).toEqual(["Campaign", "investigator"]);
    const kept = await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { name: "Edge of the Earth" } });
    expect((await kept.json()).task.settings.confirm).toBe("Campaign");
    // Clearing confirm while unconfirmed stays is refused; clearing both works.
    expect((await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { confirm: "" } })).status).toBe(400);
    const cleared = await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { confirm: "", unconfirmed: "" } });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).task.settings).toMatchObject({ confirm: "", unconfirmed: "" });
    // The 300 characters are counted as the words read back, joined by ", ", so a kept field always
    // fits an edit that sends it back: 20 entries of 14 characters with bare commas (299) are 318.
    const word = (i: number) => `w${String(i).padStart(2, "0")}xxxxxxxxxxx`;
    const tight = Array.from({ length: 20 }, (_, i) => word(i));
    expect((await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { confirm: tight.join(",") } })).status).toBe(400);
    const fits = tight.slice(0, 18).join(", ");
    const set = await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { confirm: fits.replaceAll(", ", ",") } });
    expect(set.status).toBe(200);
    expect((await set.json()).task.settings.confirm).toBe(fits);
    expect((await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { name: "Edge again" } })).status).toBe(200);
    expect((await api(w.plugin, "PATCH", "/tasks/t1", { token, body: { confirm: fits } })).status).toBe(200);
    // A judged watch's edit does not offer them.
    expect(fieldsFor("wantjudge", "edit", "api").map((f) => f.name)).not.toContain("confirm");
    expect(fieldsFor("wantlist", "edit", "api").map((f) => f.name)).toContain("confirm");
  });

  it("from the web: the form takes them, and the edit form shows and keeps them", async () => {
    const w = await world({ fetch: shop() });
    await people(w.plugin);
    const jar = await signIn(w.plugin, LARRY);
    const csrf = await csrfOf(w.plugin, jar);
    const form = await (await call(w.plugin, "GET", "/new/wantlist", { jar })).text();
    expect(form).toContain('name="confirm"');
    expect(form).toContain('name="unconfirmed"');
    const made = await call(w.plugin, "POST", "/new/wantlist", { jar, origin: ORIGIN, form: { csrf, name: "Edge", source: "page", target: SHOP, max: "", currency: "", exclude: "", confirm: "campaign", unconfirmed: "", hours: "" } });
    expect(made.status).toBe(303);
    expect(await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar })).text()).toContain('name="confirm" type="text" value="campaign"');
    const saved = await call(w.plugin, "POST", "/tasks/t1/edit", { jar, origin: ORIGIN, form: { csrf, name: "Edge", max: "", currency: "", exclude: "", confirm: "campaign", unconfirmed: "investigator", hours: "" } });
    expect(saved.status).toBe(303);
    expect(await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar })).text()).toContain('name="unconfirmed" type="text" value="investigator"');
  });
});
