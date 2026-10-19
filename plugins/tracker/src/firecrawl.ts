import type { ShopifyRequest, ShopifyScrape } from "@rackbops/docket-types";
import { readCapped } from "./fetch.js";

/**
 * The host's half of docket-types' Shopify source (`shopifySource`, Rod, 2026-10-19: "add Shopify
 * to watches, daily"): one Firecrawl Alexandria call, `POST https://api.firecrawl.dev/v2/scrape`
 * with `{ alexandria: <request> }`, carrying `TRACKER_FIRECRAWL_KEY` as a Bearer token. The address
 * is fixed, so no person names where it goes; no redirect is followed (the key goes to Firecrawl
 * only); a call gives up after `FIRECRAWL_TIMEOUT_MS`; at most
 * `FIRECRAWL_MAX_BYTES` of the answer is read, and one cut short is not JSON, so it reads as a miss.
 * The key is never logged and never put in an error.
 */

export const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
export const FIRECRAWL_TIMEOUT_MS = 30_000;
export const FIRECRAWL_MAX_BYTES = 4 * 1024 * 1024;

/** `TRACKER_FIRECRAWL_KEY`: the Firecrawl API key the Shopify source searches with, or null when unset or empty. */
export function parseFirecrawlKey(raw: string | undefined): string | null {
  const key = raw?.trim() ?? "";
  return key === "" ? null : key;
}

export interface FirecrawlOptions {
  key: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The `ShopifyScrape` docket-types' `shopifySource` runs each look through. */
export function createFirecrawlScrape(o: FirecrawlOptions): ShopifyScrape {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? FIRECRAWL_TIMEOUT_MS;
  return async (request: ShopifyRequest) => {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(FIRECRAWL_SCRAPE_URL, {
        method: "POST",
        redirect: "manual",
        signal,
        headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ alexandria: request }),
      });
    } catch (err) {
      // The runtime's own message (a timeout, a refused connection) never carries the key.
      throw new Error(signal.aborted ? "Firecrawl did not answer in time" : err instanceof Error ? err.message : String(err));
    }
    const text = await readCapped(response, FIRECRAWL_MAX_BYTES);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}
