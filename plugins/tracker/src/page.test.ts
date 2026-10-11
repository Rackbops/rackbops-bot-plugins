import { describe, expect, it } from "bun:test";
import { extractPrice, jsonLdBlocks, pageSource } from "@rackbops/docket-types";
import { createPageFetch } from "./fetch.js";
import { MAX_BLOCKS, MAX_METAS, pageForExtraction } from "./page.js";
import { nearPattern } from "./price.js";

/** The page rebuilt for price extraction (rackbops-bot-plugins#81): same prices, no slow scans. */

const MB3 = 3 * 1024 * 1024;

function timed(body: string, pattern?: string): { ms: number; found: ReturnType<typeof extractPrice> } {
  const start = performance.now();
  const found = extractPrice(pageForExtraction(body), pattern);
  return { ms: performance.now() - start, found };
}

describe("pageForExtraction", () => {
  it("keeps every price source docket reads: JSON-LD, meta tags, a JSON body, text for near", () => {
    const ld = { "@type": "Product", offers: { price: "19.99", priceCurrency: "USD", description: "a < b" } };
    expect(extractPrice(pageForExtraction(`<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head></html>`))).toEqual({
      value: 19.99,
      currency: "USD",
    });
    const meta = '<head><meta property="product:price:amount" content="42.50"><meta property="product:price:currency" content="EUR"></head><body>x</body>';
    expect(extractPrice(pageForExtraction(meta))).toEqual({ value: 42.5, currency: "EUR" });
    expect(extractPrice(pageForExtraction('{"data":{"price":7.25,"currency":"GBP","note":"<meta "}}'))).toEqual({ value: 7.25, currency: "GBP" });
    const html = "<div><b>Our price (today):</b> <span>$1,299.99</span></div><script>var a = '<meta ';</script>";
    expect(extractPrice(pageForExtraction(html), nearPattern("Our price (today):"))).toEqual({ value: 1299.99 });
  });

  it("keeps what near reads in script data and attributes, and blocks after a stray < or an unclosed style", () => {
    expect(extractPrice(pageForExtraction("<script>var price = 19.99;</script>"), nearPattern("var price ="))).toEqual({ value: 19.99 });
    expect(extractPrice(pageForExtraction('<div data-price="24.50">x</div>'), nearPattern('data-price="'))).toEqual({ value: 24.5 });
    const ld = '<script type="application/ld+json">{"offers":{"price":"12.00","priceCurrency":"EUR"}}</script>';
    expect(extractPrice(pageForExtraction(`<p>Deals <30 EUR here</p>${ld}`))).toEqual({ value: 12, currency: "EUR" });
    expect(extractPrice(pageForExtraction('<style>.a{} <meta property="og:price:amount" content="8.00">'))).toEqual({ value: 8 });
  });

  // `toLowerCase` makes "İ" (U+0130) two code units, so offsets after it used to land one off (#163).
  it("an 'İ' before a meta tag does not shift it out of reach", () => {
    const page = '<title>İstanbul</title><meta property="product:price:amount" content="19.99">';
    expect(extractPrice(pageForExtraction(page))).toEqual({ value: 19.99 });
  });

  it("an 'İ' before a JSON-LD block does not shift it out of reach", () => {
    const ld = { "@type": "Product", name: "Kahve", offers: { price: "249.90", priceCurrency: "TRY" } };
    const page = `<title>İstanbul</title><script type="application/ld+json">${JSON.stringify(ld)}</script>`;
    expect(extractPrice(pageForExtraction(page))).toEqual({ value: 249.9, currency: "TRY" });
  });

  it("a script that closes after an 'İ' is cut at its own end", () => {
    const ld = { "@type": "Product", name: "İzmir kahvesi", offers: { price: "19.99", priceCurrency: "USD" } };
    const page = `<script>var city = "İzmir";</script><script type="application/ld+json">${JSON.stringify(ld)}</script>`;
    const out = pageForExtraction(page);
    expect(jsonLdBlocks(out)).toEqual([ld]);
    expect(extractPrice(out)).toEqual({ value: 19.99, currency: "USD" });
  });

  it("upper-case tags are still read", () => {
    expect(extractPrice(pageForExtraction('<HEAD><META PROPERTY="product:price:amount" CONTENT="42.50"></HEAD>'))).toEqual({ value: 42.5 });
    const ld = '{"@type":"Product","offers":{"price":"12.00","priceCurrency":"EUR"}}';
    expect(extractPrice(pageForExtraction(`<SCRIPT TYPE="APPLICATION/LD+JSON">${ld}</SCRIPT>`))).toEqual({ value: 12, currency: "EUR" });
    // A style's text is skipped to its own `</STYLE>`: the meta inside it is not a tag.
    const style = `<STYLE>.x{content:"<meta property='product:price:amount' content='1.00'>"}</STYLE><META PROPERTY="product:price:amount" CONTENT="8.00">`;
    expect(extractPrice(pageForExtraction(style))).toEqual({ value: 8 });
  });

  it("reads each tag as what it is", () => {
    const meta8 = '<meta property="product:price:amount" content="8.00">';
    // A script of another type is no JSON-LD block, so its price is not read.
    expect(extractPrice(pageForExtraction(`<script type="application/json">{"price":"1.00"}</script>${meta8}`))).toEqual({ value: 8 });
    // An empty script ends at its own close, not at the next block's.
    expect(extractPrice(pageForExtraction('<script></script><script type="application/ld+json">{"offers":{"price":"5.00"}}</script>'))).toEqual({ value: 5 });
    // A meta written inside a script's code is script data, not a tag.
    expect(extractPrice(pageForExtraction(`<script>document.write('<meta property="product:price:amount" content="1.00">')</script>${meta8}`))).toEqual({ value: 8 });
    // A stray < in the text before a meta does not swallow it: the tag is the last < before the >.
    expect(extractPrice(pageForExtraction(`<p>Deals <30 EUR ${meta8}</p>`))).toEqual({ value: 8 });
    // A type with spaces around = and no quotes is still JSON-LD.
    expect(extractPrice(pageForExtraction('<script type = application/ld+json>{"offers":{"price":"3.00"}}</script>'))).toEqual({ value: 3 });
  });

  it("keeps the first MAX_BLOCKS JSON-LD blocks, in page order", () => {
    const names = Array.from({ length: MAX_BLOCKS + 10 }, (_, i) => `item ${i + 1}`);
    const page = names.map((name) => `<script type="application/ld+json">${JSON.stringify({ "@type": "Thing", name })}</script>`).join("\n");
    const out = pageForExtraction(page);
    expect(out.split('<script type="application/ld+json">').length - 1).toBe(MAX_BLOCKS);
    const kept = jsonLdBlocks(out).map((b) => (b as { name: string }).name);
    expect(kept[0]).toBe("item 1");
    expect(kept.at(-1)).toBe(`item ${MAX_BLOCKS}`);
    expect(kept).not.toContain(`item ${MAX_BLOCKS + 1}`);
    expect(kept).toEqual(names.slice(0, MAX_BLOCKS));
  });

  it("a search page with 40 product cards keeps all 40", async () => {
    // The want-list's `page` source over the tracker's own fenced Fetch, which hands it pageForExtraction's body.
    const search = "https://shop.example/search?q=wingspan";
    const cards = Array.from({ length: 40 }, (_, i) => ({
      "@context": "https://schema.org",
      "@type": "Product",
      name: `Card ${i + 1}`,
      url: `https://shop.example/p/${i + 1}`,
      offers: { "@type": "Offer", price: `${i + 1}.00`, priceCurrency: "USD" },
    }));
    const page = `<html><head><title>Search</title></head><body>${cards
      .map((c) => `<div class="card"><h2>${c.name}</h2><script type="application/ld+json">${JSON.stringify(c)}</script></div>`)
      .join("\n")}</body></html>`;
    const fetchImpl = (async (url: string) => (url === search ? new Response(page, { status: 200 }) : new Response("", { status: 404 }))) as unknown as typeof fetch;
    const listings = await pageSource.search(search, createPageFetch({ resolve: async () => ["93.184.215.14"], fetchImpl }));
    expect(listings.map((l) => l.title)).toEqual(cards.map((c) => c.name));
    expect(listings.at(-1)).toMatchObject({ url: "https://shop.example/p/40", price: 40, currency: "USD" });
  });

  it("leaves no tag start in the text, and at most MAX_METAS meta tags", () => {
    const out = pageForExtraction(`${'<meta name="x" content="1">'.repeat(MAX_METAS + 50)}<p>a < b</p>`);
    expect(out.split("<meta").length - 1).toBe(MAX_METAS);
    expect(out.slice(out.lastIndexOf(">") + 1)).not.toContain("<");
  });

  it("stays fast on pages built to make the extraction patterns backtrack (3 MB)", () => {
    // Well-formed JSON-LD blocks, thousands more than MAX_BLOCKS: the walk keeps the first ones and moves on.
    const manyBlocks = '<script type="application/ld+json">{"@type":"Product","name":"x"}</script>'.repeat(MB3 / 74);
    for (const body of [
      "<meta ".repeat(MB3 / 6),
      "<script ".repeat(MB3 / 8),
      `${"<meta a>".repeat(MB3 / 8)}`,
      `<p>${"<meta property ".repeat(MB3 / 15)}>`,
      `${"<script type='application/ld+json'>{".repeat(MB3 / 40)}`,
      "<script>".repeat(MB3 / 8),
      "<style>".repeat(MB3 / 7),
      "<>".repeat(MB3 / 2),
      `${"<meta ".repeat(MB3 / 12)}>${"<meta ".repeat(MB3 / 12)}`,
      manyBlocks,
      // Tag starts inside JSON-LD data and inside a JSON body: kept only with every < escaped.
      Array.from({ length: 200 }, () => `<script type="application/ld+json">${JSON.stringify({ d: "<meta ".repeat(2600) })}</script>`).join(""),
      JSON.stringify({ note: "<meta ".repeat(MB3 / 6 - 10) }),
      // Upper and mixed case, which the fold lower-cases.
      "<sCrIpT a>".repeat(MB3 / 10),
      "Aa".repeat(MB3 / 2),
    ]) {
      const { ms, found } = timed(body);
      expect(found).toBeNull();
      expect(ms).toBeLessThan(2000);
    }
    expect(jsonLdBlocks(pageForExtraction(manyBlocks))).toHaveLength(MAX_BLOCKS);
  });
});
