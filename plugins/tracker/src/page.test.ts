import { describe, expect, it } from "bun:test";
import { extractPrice } from "@rackbops/docket-types";
import { MAX_METAS, pageForExtraction } from "./page.js";
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
      "<script>".repeat(MB3 / 8),
      "<style>".repeat(MB3 / 7),
      "<>".repeat(MB3 / 2),
      `${"<meta ".repeat(MB3 / 12)}>${"<meta ".repeat(MB3 / 12)}`,
    ]) {
      const { ms, found } = timed(body);
      expect(found).toBeNull();
      expect(ms).toBeLessThan(2000);
    }
  });
});

/**
 * A `near` price ends at its last digit (#164): a `.` or `,` right after the number is punctuation,
 * and captured it would hide the decimal part from `parsePrice` ("19.99," read as 1999).
 */
describe("nearPattern on a page", () => {
  const nearPrice = (html: string, near: string) => extractPrice(pageForExtraction(html), nearPattern(near));

  it("a price followed by a comma is read as written", () => {
    expect(nearPrice("<p>Price: 19.99, free shipping</p>", "Price:")).toEqual({ value: 19.99 });
  });

  it("a price that ends a sentence is read as written", () => {
    expect(nearPrice("<p>Now 49.90. Order today</p>", "Now")).toEqual({ value: 49.9 });
  });

  it("a JSON price followed by its next key is read as written", () => {
    const html = '<html><body><p>Widget</p><script>window.product = {"price":19.99,"currency":"EUR"};</script></body></html>';
    expect(nearPrice(html, '"price":')).toEqual({ value: 19.99 });
  });

  it("a thousands separator is kept", () => {
    expect(nearPrice("<p>Total: 1,299.99, with tax</p>", "Total:")).toEqual({ value: 1299.99 });
    expect(nearPrice("<p>Total: 1.299,99. Mit MwSt.</p>", "Total:")).toEqual({ value: 1299.99 });
  });

  it("a one-digit price is read", () => {
    expect(nearPrice("<p>Price: 7, today</p>", "Price:")).toEqual({ value: 7 });
  });

  it("the capture stays bounded", () => {
    const digits = "1234567890".repeat(4);
    expect(new RegExp(nearPattern("x"), "i").exec(`x ${digits}`)?.[1]).toBe(digits.slice(0, 16));
  });
});
