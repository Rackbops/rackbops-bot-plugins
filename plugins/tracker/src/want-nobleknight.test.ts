import { afterEach, describe, expect, it } from "bun:test";
import type { Fetch, FetchResponse } from "@rackbops/docket-core";
import type { Plugin } from "../../../packages/api/contract.js";
import { FetchRefusedError } from "./fetch.js";
import { NOBLE_KNIGHT_USD } from "./want.js";
import { call, cleanup, csrfOf, LARRY, ORIGIN, people, signIn, slash, world } from "./web/harness.js";

// The source itself (reading a product page's copies) is tested in Rackbops/docket
// (packages/types/test/want-nobleknight.test.ts); these are the plugin's end to end.

afterEach(cleanup);

const PAGE = "https://www.nobleknight.com/P/2147942033";
const PASTED = "https://uk.nobleknight.com/P/2147942033/Edge-of-the-Earth-Campaign-Expansion?awid=1349";
const pollTick = (p: Plugin) => p.ticks!.find((t) => t.name === "poll")!.run(new AbortController().signal);

type Copy = { sku: string; grade: string; price: string; note?: string };
const SW: Copy = { sku: "2149237670", grade: "SW (MINT/New)", price: "$323.96" };
const VG: Copy = { sku: "2149681064", grade: "VG+/NM", price: "$247.50", note: "unpunched, cards sealed" };
const FAIR: Copy = { sku: "2149697043", grade: "Fair/NM", price: "$238.50", note: "unpunched" };

/** A product page in Noble Knight's markup: its heading, each copy's row, and a related product's button. */
function productPage(copies: Copy[]): string {
  const rows = copies.map(
    (c) =>
      `<div class="col condition-col in_stock"><input id="qty-${c.sku}" aria-label="Edit quantity Condition ${c.grade} Price ${c.price}">` +
      `<span id="inventoryCondition-${c.sku}">${c.grade}</span>${c.note ? `<span class="condition-note">(${c.note})</span>` : ""}` +
      `<button class="atc" id="2147942033#${c.sku}">Add to Cart</button></div>`,
  );
  return `<html><h1 class="ppn_2147942033">Edge of the Earth Campaign Expansion</h1>${rows.join("")}<button class="atc" id="2148198707#2149744008">Add</button></html>`;
}

function noble(copies: Copy[]) {
  const s = { copies, reads: [] as string[], body: null as string | null, status: 200, refuse: null as string | null };
  const fetch: Fetch = {
    async get(url: string): Promise<FetchResponse> {
      s.reads.push(url);
      if (s.refuse) throw new FetchRefusedError(s.refuse);
      return { status: s.status, body: s.body ?? productPage(s.copies), headers: {} };
    },
  };
  return { s, fetch };
}

describe("/want source: nobleknight", () => {
  it("reads the product page in US dollars, keeps its one address, and DMs each copy once, Noble Knight named", async () => {
    const { s, fetch } = noble([SW, VG]);
    const w = await world({ fetch });
    await people(w.plugin);
    const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Edge of the Earth", source: "nobleknight", target: PASTED, currency: "usd" }, numbers: { max: 300 } });
    expect(made).toContain("Watching `t1`: Edge of the Earth.");
    expect(made).toContain("Noble Knight has 2 copies in stock now, 1 within your limits.");
    expect(made).toContain("Noble Knight is a trusted seller, so no shop check runs.");
    expect(made).toContain("Noble Knight's page for it");
    expect(s.reads).toEqual([`${PAGE}?SS=USD`]);

    await pollTick(w.plugin);
    expect(w.sent).toHaveLength(1);
    const first = (w.sent[0]?.message as { content: string }).content;
    expect(first).toContain("Edge of the Earth Campaign Expansion -- VG+/NM (unpunched, cards sealed) -- 247.50 USD");
    expect(first).toContain("sold by Noble Knight Games");
    expect(first).toContain(`<${PAGE}>`);
    expect(first).not.toContain("SW (MINT/New)");

    // A new copy is told; one already told is not, even cheaper.
    s.copies = [SW, { ...VG, price: "$199.00" }, FAIR];
    w.clock.advance(24 * 3600_000);
    await pollTick(w.plugin);
    expect(w.sent).toHaveLength(2);
    const second = (w.sent[1]?.message as { content: string }).content;
    expect(second).toContain("Fair/NM (unpunched) -- 238.50 USD");
    expect(second).not.toContain("VG+/NM");
  });

  it("refuses an address that is not a product page, and says why a page cannot be watched", async () => {
    const { s, fetch } = noble([SW]);
    const w = await world({ fetch });
    await people(w.plugin);
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "nobleknight" } })).toContain("`target` is a Noble Knight product page's address");
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "nobleknight", target: "https://www.nobleknight.com/MC/BoardGames" } })).toContain("That is not a Noble Knight product page.");
    s.body = "<html>Access denied</html>";
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "nobleknight", target: PAGE } })).toContain("did not give me a Noble Knight product page");
    s.body = productPage([{ ...SW, price: "£259.98" }]);
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "nobleknight", target: PAGE } })).toContain("in another currency, not US dollars");
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "nobleknight", target: PAGE, currency: "gbp" } })).toBe(NOBLE_KNIGHT_USD);
    s.body = null;
    s.status = 503;
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "nobleknight", target: PAGE } })).toContain("I could not read Noble Knight's page just now");
    s.status = 200;
    s.refuse = "www.nobleknight.com is not on the public internet";
    expect(await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "nobleknight", target: PAGE } })).toBe("I cannot read that page: www.nobleknight.com is not on the public internet.");
    const none = await slash(w.plugin, "want", LARRY, { strings: { name: "X", source: "bogus", target: PAGE } });
    expect(none).toBe("`source` is page, bgg, ebay, shopify or nobleknight.");
  });

  it("makes the watch from the web form and shows where it looks", async () => {
    const { fetch } = noble([SW]);
    const w = await world({ fetch });
    await people(w.plugin);
    const jar = await signIn(w.plugin, LARRY);
    const csrf = await csrfOf(w.plugin, jar);
    const form = await (await call(w.plugin, "GET", "/new/wantlist", { jar })).text();
    expect(form).toContain('value="nobleknight"');
    const made = await call(w.plugin, "POST", "/new/wantlist", { jar, origin: ORIGIN, form: { csrf, name: "Edge", source: "nobleknight", target: PASTED, max: "", currency: "", hours: "" } });
    expect(made.status).toBe(303);
    const edit = await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar })).text();
    expect(edit).toContain(`Looking at: Noble Knight&#39;s page ${PAGE}.`);
    // The web form reads the page once at once too, so a page that is not the product's is refused.
    const { s: other, fetch: otherFetch } = noble([SW]);
    other.body = "<html>Access denied</html>";
    const w2 = await world({ fetch: otherFetch });
    await people(w2.plugin);
    const jar2 = await signIn(w2.plugin, LARRY);
    const refused = await call(w2.plugin, "POST", "/new/wantlist", { jar: jar2, origin: ORIGIN, form: { csrf: await csrfOf(w2.plugin, jar2), name: "Edge", source: "nobleknight", target: PAGE, max: "", currency: "", hours: "" } });
    expect(refused.status).not.toBe(303);
    expect(await refused.text()).toContain("did not give me a Noble Knight product page");
    expect(other.reads).toEqual([`${PAGE}?SS=USD`]);
    const gbp = await call(w.plugin, "POST", "/tasks/t1/edit", { jar, origin: ORIGIN, form: { csrf, name: "Edge", max: "", currency: "gbp", hours: "" } });
    expect(gbp.status).not.toBe(303);
    expect(await gbp.text()).toContain("I read Noble Knight&#39;s prices in USD");

  });
});
