import { createHash } from "node:crypto";
import { clean, type Fetch } from "@rackbops/docket-core";
import { jsonLdBlocks, priceFromJson, safeUrl } from "@rackbops/docket-types";

/**
 * The want-list watcher's sources (category 2, plan 1.2 row 2; rackbops-bot-plugins#83): where a
 * wanted thing's listings come from, behind one port so the type (wantlist-type.ts) knows none of
 * them. Two read listings:
 *
 * - `page` (here): a listing or search page the owner pasted (roshne, 2026-10-04, "Pages too"), read
 *   through the fenced Fetch port as `/price` reads a product page, and only its structured data --
 *   JSON-LD `ItemList`s of products and standalone `Product`s. No guessing at HTML: a page without
 *   them yields nothing, and the owner is told.
 * - `bgg` (want-bgg.ts): BoardGameGeek's marketplace, through its XML API, off until BGG approves
 *   roshne's application and `TRACKER_BGG_TOKEN` is set.
 *
 * eBay is a third answer, not a source: the tracker never reads eBay (no API, no pages); `/want`
 * hands the owner an eBay search to save on eBay, whose own alerts do the watching (want.ts).
 */

export interface Listing {
  /** Stable for one listing: its URL without the fragment, for `page`; `bgg:<link>` for BGG. */
  id: string;
  title: string;
  url: string;
  price?: number;
  currency?: string;
  condition?: string;
  seller?: string;
}

export type SourceId = "page" | "bgg";
export const SOURCE_IDS: readonly SourceId[] = ["page", "bgg"];

export interface Source {
  id: SourceId;
  /** The listings at `target` now; throws `SourceMiss` for a read that counts as a miss. */
  search(target: string, fetch: Fetch | undefined): Promise<Listing[]>;
}

/** A read that found nothing usable (an error page, no structured data, a busy API): the type counts it. */
export class SourceMiss extends Error {
  override name = "SourceMiss";
}

/** The source cannot be read at all as set up (BGG refusing the token): a miss the owner should hear about. */
export class SourceUnavailableError extends SourceMiss {
  override name = "SourceUnavailableError";
}

export const MAX_LISTINGS = 100;
const TITLE_CHARS = 150;
const CONDITION_CHARS = 40;
const SELLER_CHARS = 80;
const MAX_DEPTH = 8;

/** The key a listing is remembered by: a digest of its id, so the state stays small whatever the URLs. */
export function listingKey(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 32);
}

/** eBay's own hosts (and its short links): never read, by rule (plan item 20; roshne, 2026-09-29). */
export function isEbayHost(host: string): boolean {
  return /(^|\.)ebay\.[a-z]{2,3}(\.[a-z]{2})?$/i.test(host.replace(/\.$/, ""));
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function typesOf(node: Json): string[] {
  const t = node["@type"];
  const all = Array.isArray(t) ? t : [t];
  return all.filter((x): x is string => typeof x === "string").map((x) => x.replace(/^https?:\/\/schema\.org\//, ""));
}

const PRODUCT_TYPES = new Set(["Product", "IndividualProduct", "ProductModel", "ProductGroup", "Book", "Game", "VideoGame", "Vehicle"]);

function text(v: unknown, max: number): string {
  if (typeof v === "string") return clean(v, max, true);
  if (isObj(v) && typeof v.name === "string") return clean(v.name, max, true);
  return "";
}

/** schema.org's condition as a word: `https://schema.org/UsedCondition` is "used". */
function conditionOf(v: unknown): string {
  const raw = text(v, 200);
  const m = /(New|Used|Refurbished|Damaged)Condition$/i.exec(raw);
  return m ? (m[1] ?? "").toLowerCase() : clean(raw, CONDITION_CHARS, true);
}

function firstOffer(offers: unknown): Json | null {
  if (Array.isArray(offers)) return offers.find(isObj) ?? null;
  return isObj(offers) ? offers : null;
}

function absolute(raw: unknown, base: string): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const u = new URL(raw.trim(), base);
    u.hash = "";
    return safeUrl(u.toString());
  } catch {
    return null;
  }
}

/** One listing from a product node, or null without a name or a usable address. */
function listingOf(node: Json, base: string, fallbackUrl: unknown): Listing | null {
  const title = text(node.name, TITLE_CHARS);
  const offer = firstOffer(node.offers);
  const url = absolute(node.url, base) ?? absolute(fallbackUrl, base) ?? absolute(offer?.url, base);
  if (!title || !url) return null;
  const price = priceFromJson(node.offers ?? null);
  const condition = conditionOf(offer?.itemCondition ?? node.itemCondition);
  const seller = text(offer?.seller, SELLER_CHARS);
  return {
    id: url,
    title,
    url,
    ...(price ? { price: price.value } : {}),
    ...(price?.currency ? { currency: price.currency } : {}),
    ...(condition ? { condition } : {}),
    ...(seller ? { seller } : {}),
  };
}

/**
 * The listings in a page's JSON-LD: each `ItemList`'s elements (a `ListItem`'s `item`, or the
 * element itself) and each standalone product, in page order, without repeats. A product with no
 * address of its own is the page itself (a product page). Pure.
 */
export function listingsFromJsonLd(html: string, pageUrl: string): Listing[] {
  const out: Listing[] = [];
  const seen = new Set<string>();
  const add = (l: Listing | null) => {
    if (!l || seen.has(l.id) || out.length >= MAX_LISTINGS) return;
    seen.add(l.id);
    out.push(l);
  };
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_LISTINGS) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    if (!isObj(node)) return;
    const types = typesOf(node);
    if (types.includes("ItemList")) {
      const elements = Array.isArray(node.itemListElement) ? node.itemListElement : [node.itemListElement];
      for (const el of elements) {
        if (!isObj(el)) continue;
        const item = isObj(el.item) ? el.item : el;
        if (typesOf(item).includes("ItemList")) walk(item, depth + 1);
        else add(listingOf(item, pageUrl, el.url ?? (typeof el.item === "string" ? el.item : undefined)));
      }
    } else if (types.some((t) => PRODUCT_TYPES.has(t))) {
      add(listingOf(node, pageUrl, pageUrl));
    }
    if (node["@graph"] !== undefined) walk(node["@graph"], depth + 1);
    if (isObj(node.mainEntity)) walk(node.mainEntity, depth + 1);
  };
  for (const block of jsonLdBlocks(html)) walk(block, 0);
  return out;
}

/** The `page` source: the owner's page through the fenced Fetch port, structured data only. */
export const pageSource: Source = {
  id: "page",
  async search(target, fetch) {
    if (!fetch) throw new SourceMiss("this bot reads no pages");
    let body: string;
    try {
      const response = await fetch.get(target);
      if (response.status !== 200) throw new SourceMiss(`HTTP ${response.status}`);
      body = response.body;
    } catch (err) {
      if (err instanceof SourceMiss) throw err;
      // The cause is kept: `/want`'s first read tells a refused page from one that failed this once.
      throw new SourceMiss(`the read failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const listings = listingsFromJsonLd(body, target);
    if (listings.length === 0) throw new SourceMiss("no listings in the page's structured data");
    return listings;
  },
};
