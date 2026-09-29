import { describe, expect, it } from "bun:test";
import { extractPrice } from "@rackbops/docket-types";
import { MAX_METAS, pageForExtraction } from "./page.js";
import { nearPattern } from "./tracked.js";

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

  it("leaves no tag start in the text, and at most MAX_METAS meta tags", () => {
    const out = pageForExtraction(`${'<meta name="x" content="1">'.repeat(MAX_METAS + 50)}<p>a < b</p>`);
    expect(out.split("<meta").length - 1).toBe(MAX_METAS);
    expect(out.slice(out.lastIndexOf(">") + 1)).not.toContain("<");
  });

  it("stays fast on pages built to make the extraction patterns backtrack (3 MB)", () => {
    for (const body of [
      "<meta ".repeat(MB3 / 6),
      "<script ".repeat(MB3 / 8),
      `${"<meta a>".repeat(MB3 / 8)}`,
      `<p>${"<meta property ".repeat(MB3 / 15)}>`,
      `${"<script type='application/ld+json'>{".repeat(MB3 / 40)}`,
    ]) {
      const { ms, found } = timed(body);
      expect(found).toBeNull();
      expect(ms).toBeLessThan(2000);
    }
  });
});
