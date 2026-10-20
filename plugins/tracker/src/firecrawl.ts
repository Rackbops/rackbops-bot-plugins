import type { ShopifyRequest, ShopifyScrape } from "@rackbops/docket-types";
import { readCapped } from "./fetch.js";

/**
 * The host's half of docket-types' Shopify source (`shopifySource`, Rod, 2026-10-19: "add Shopify
 * to watches, daily"): one Firecrawl Alexandria call, `POST https://api.firecrawl.dev/v2/scrape`
 * with `{ alexandria: <request> }`, carrying `TRACKER_FIRECRAWL_KEY` as a Bearer token. The address
 * is fixed, so no person names where it goes; no redirect is followed (the key goes to Firecrawl
 * only); a call gives up after `FIRECRAWL_TIMEOUT_MS`; at most
 * `FIRECRAWL_MAX_BYTES` of the answer is read, and one cut short is not JSON, so it reads as a miss.
 * The key is never logged and never put in an error: a failed call says only that it timed out or
 * could not reach Firecrawl.
 */

export const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
export const FIRECRAWL_TIMEOUT_MS = 30_000;
export const FIRECRAWL_MAX_BYTES = 4 * 1024 * 1024;

/**
 * `TRACKER_FIRECRAWL_KEY`: the Firecrawl API key the Shopify source searches with, or null when unset
 * or empty. It goes out as a header value, and the runtime's error for a bad header value quotes the
 * value, so one with a character outside visible ASCII (the manifest's `^[!-~]+$`) refuses the load,
 * as the city-hall settings do (executor.ts), with an error that names the setting, never the key.
 */
export function parseFirecrawlKey(raw: string | undefined): string | null {
  const key = raw?.trim() ?? "";
  if (key === "") return null;
  if (!/^[!-~]+$/.test(key)) throw new Error("TRACKER_FIRECRAWL_KEY has a character in it that is not visible ASCII (letters, digits and punctuation only)");
  return key;
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
    } catch {
      // A fixed message: the runtime's own can quote the request's headers, and so the key.
      throw new Error(signal.aborted ? "Firecrawl did not answer in time" : "Firecrawl could not be reached");
    }
    let text: string;
    try {
      text = await readCapped(response, FIRECRAWL_MAX_BYTES);
    } catch {
      throw new Error(signal.aborted ? "Firecrawl did not answer in time" : "Firecrawl's answer could not be read");
    }
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}
