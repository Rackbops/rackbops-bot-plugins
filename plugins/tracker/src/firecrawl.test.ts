import { describe, expect, it } from "bun:test";
import { shopifyRequest } from "@rackbops/docket-types";
import { createFirecrawlScrape, FIRECRAWL_MAX_BYTES, FIRECRAWL_SCRAPE_URL, parseFirecrawlKey } from "./firecrawl.js";

const KEY = "fc-0123456789abcdef";
const request = shopifyRequest({ query: "Wingspan Oceania expansion", maxPrice: 35 });
const answering = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  (async (url: string, init: RequestInit) => respond(url, init)) as unknown as typeof fetch;

describe("parseFirecrawlKey", () => {
  it("is null unset or empty, the key trimmed otherwise", () => {
    expect(parseFirecrawlKey(undefined)).toBeNull();
    expect(parseFirecrawlKey("  ")).toBeNull();
    expect(parseFirecrawlKey(` ${KEY}\n`)).toBe(KEY);
  });

  it("refuses a key with a character outside visible ASCII, without naming the key", () => {
    for (const bad of [`${KEY}\nX`, `fc- abc`, `fc-“abc`, "fc-a b"]) {
      let message = "";
      try {
        parseFirecrawlKey(bad);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("TRACKER_FIRECRAWL_KEY");
      expect(message).not.toContain("fc-");
    }
  });
});

describe("createFirecrawlScrape", () => {
  it("POSTs the request to Firecrawl's scrape with the key, following no redirect", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const scrape = createFirecrawlScrape({ key: KEY, fetchImpl: answering((url, init) => ((seen = { url, init }), new Response('{"ok":1}', { status: 200 }))) });
    expect(await scrape(request)).toEqual({ status: 200, body: { ok: 1 } });
    expect(seen!.url).toBe(FIRECRAWL_SCRAPE_URL);
    expect(seen!.init.method).toBe("POST");
    expect(seen!.init.redirect).toBe("manual");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(seen!.init.body))).toEqual({ alexandria: request });
  });

  it("hands a redirect back as it came, and a body that is not JSON as null", async () => {
    const moved = createFirecrawlScrape({ key: KEY, fetchImpl: answering(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })) });
    expect(await moved(request)).toEqual({ status: 302, body: null });
    const html = createFirecrawlScrape({ key: KEY, fetchImpl: answering(() => new Response("<html>busy</html>", { status: 503 })) });
    expect(await html(request)).toEqual({ status: 503, body: null });
  });

  it("reads at most FIRECRAWL_MAX_BYTES, so an answer cut short is no JSON", async () => {
    const big = `{"pad":"${"x".repeat(FIRECRAWL_MAX_BYTES)}"}`;
    const scrape = createFirecrawlScrape({ key: KEY, fetchImpl: answering(() => new Response(big, { status: 200 })) });
    expect(await scrape(request)).toEqual({ status: 200, body: null });
  });

  it("says only that Firecrawl could not be reached, or did not answer in time: never the runtime's words, which can quote the key", async () => {
    const failing = createFirecrawlScrape({ key: KEY, fetchImpl: answering(() => { throw new TypeError(`Header 'authorization' has invalid value: 'Bearer ${KEY}'`); }) });
    const err = await failing(request).catch((e: Error) => e);
    expect((err as Error).message).toBe("Firecrawl could not be reached");
    const slow = createFirecrawlScrape({
      key: KEY,
      timeoutMs: 20,
      fetchImpl: answering((_url, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error(`aborted ${KEY}`))))),
    });
    expect(((await slow(request).catch((e: Error) => e)) as Error).message).toBe("Firecrawl did not answer in time");
  });
});
