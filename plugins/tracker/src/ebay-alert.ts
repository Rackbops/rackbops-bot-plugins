import type { Submitted } from "@rackbops/docket-types";
import { MAX_LISTINGS_PER_POST } from "./inbox.js";
import type { MailMessage } from "./mime.js";

/**
 * eBay's saved-search alert emails, read for the listings in them (tracker 0.25.0): the second way
 * listings reach an eBay inbox watch, beside Claude in Chrome posting them (web/api-listings.ts).
 * The tracker still never opens eBay (Rod, 2026-10-05): eBay mails the alert to the owner, the
 * owner's Gmail forwards it to their alert address (mail.ts), and this reads only what the email
 * itself says.
 *
 * Read from the first real alert, 2026-10-13 (`fixtures/ebay-saved-search-alert.eml`, with the
 * tracking parameters and the account's names taken out). What it relies on:
 *
 * - it comes from one of eBay's own domains (`EBAY_DOMAINS`, an allowlist: a lookalike such as
 *   `ebay.com.de` is not eBay), and so do the item links taken from it;
 * - the saved search's own link is an eBay `/sch/i.html` address carrying `_svsrch=1` and the
 *   words as `_nkw` (the subject also starts with them, "<words>: Only 1 match", which is used
 *   when no such link is found);
 * - each new match is an `/itm/<number>` link whose text is an `<h3>` (eBay cuts long titles with
 *   an ellipsis), followed by its price in a `<p class="price ...">`, a range such as
 *   "$39.00 to $44.00" when the listing has variations (its lower end is taken);
 * - "You might also like" starts eBay's own suggestions, which are not matches: nothing from there
 *   on is read. In the real alert the suggestions' links, and only theirs, carry `_trkparms`, so a
 *   link carrying it is never taken either.
 *
 * Mail reaches this from anyone who knows a person's address, so it is read in bounded steps: at
 * most `MAX_HTML_CHARS` of the HTML, each link found by one linear pattern, and the title and price
 * looked for only in a fixed window after it, so no input makes a pattern backtrack across the
 * document. An alert with several matches has not been seen yet: they are read the same way, each
 * its own `<h3>` link, which is an inference from the one-match alert. Pure.
 */

/** Listings one alert gives at most: the task API's per-post cap. */
export const MAX_ALERT_LISTINGS = MAX_LISTINGS_PER_POST;
/** The HTML read at most; the real alert's is about 130,000 characters. */
export const MAX_HTML_CHARS = 512 * 1024;

/** eBay's own sites, by domain: a sender at one of them (or a subdomain), and item links on one. */
export const EBAY_DOMAINS: ReadonlySet<string> = new Set([
  "ebay.com", "ebay.co.uk", "ebay.de", "ebay.ca", "ebay.com.au", "ebay.fr", "ebay.it", "ebay.es", "ebay.ie",
  "ebay.at", "ebay.ch", "ebay.nl", "ebay.be", "ebay.pl", "ebay.com.sg", "ebay.com.my", "ebay.ph", "ebay.com.hk", "ebay.in",
]);

export interface EbayAlert {
  /** The saved search's words, as eBay has them. */
  search: string;
  listings: Submitted[];
}

const SUGGESTIONS = /you might also like/i;
const HREF = /\bhref="(https:\/\/[^"\s]{1,2000})"/gi;
// An item's address, bare or with a title slug before its number, as docket's own `ebayItem` reads it.
const ITEM_PATH = /^\/itm\/(?:[^/]{1,300}\/)?(\d{6,15})\/?$/;
// After an item link's address: the rest of its tag, then (optionally in a <span>) its <h3>.
const TITLE_OPEN = /^[^>]{0,2000}>\s{0,200}(?:<span[^>]{0,200}>\s{0,200})?<h3\b[^>]{0,1000}>/i;
/** The longest title markup read, inline tags and all. */
const MAX_TITLE_HTML = 2000;
const PRICE = /<p\b[^>]{0,500}\bclass="[^"]{0,200}\bprice\b[^"]{0,200}"[^>]{0,500}>([^<]{1,200})<\/p>/i;
/** How far past an item link its title and price are looked for. */
const WINDOW = 4000;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "\u2026" };

/** HTML text: tags out, entities decoded, white space made single spaces. */
export function htmlText(s: string): string {
  // `[^<>]`: a scan from one `<` stops at the next, so no run of `<` makes this quadratic.
  return decodeEntities(s.replace(/<[^<>]{0,2000}>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
    }
    return NAMED[e.toLowerCase()] ?? all;
  });
}

/** Whether `host` is one of eBay's domains or under one. */
export function isEbayDomain(host: string): boolean {
  const h = host.toLowerCase();
  for (const d of EBAY_DOMAINS) if (h === d || h.endsWith(`.${d}`)) return true;
  return false;
}

/** An https address on one of eBay's sites (bare or `www.`), or null. */
function ebayUrl(href: string): URL | null {
  try {
    // An attribute's text: entities decoded, nothing else (a tag pattern has no business here).
    const url = new URL(decodeEntities(href));
    const host = url.hostname.replace(/^www\./, "");
    return url.protocol === "https:" && EBAY_DOMAINS.has(host) ? url : null;
  } catch {
    return null;
  }
}

/** The saved search's words: its `_svsrch=1` link's `_nkw`, else the subject before its last colon. */
function searchOf(links: readonly URL[], subject: string): string | null {
  for (const url of links) {
    const words = url.searchParams.get("_nkw")?.trim();
    if (url.pathname === "/sch/i.html" && url.searchParams.get("_svsrch") === "1" && words) return words.replace(/\s+/g, " ");
  }
  const bare = subject.replace(/^(?:\s*(?:fwd?|re)\s*:\s*)+/i, "");
  const colon = bare.lastIndexOf(":");
  const words = colon > 0 ? bare.slice(0, colon).trim() : "";
  return words || null;
}

/** A price line's lower end ("$39.00 to $44.00" is "$39.00"), as text the inbox parses. */
function priceOf(text: string): string | undefined {
  const low = text.split(/\s+(?:to|bis|\u00e0|a|-|\u2013)\s+/i)[0]?.trim() ?? "";
  return /\d/.test(low) ? low : undefined;
}

/** The currency a price's own sign names, when it names one. */
function currencyOf(price: string, host: string): string | undefined {
  if (/^(?:C\s?\$|CA\$)/i.test(price)) return "CAD";
  if (/^(?:AU\s?\$|A\$)/i.test(price)) return "AUD";
  if (/^S\$/i.test(price)) return "SGD";
  if (/^(?:US\s?\$|\$)/.test(price)) return host.replace(/^www\./, "") === "ebay.com" || /^US/i.test(price) ? "USD" : undefined;
  if (/\u00a3/.test(price)) return "GBP";
  if (/\u20ac|\bEUR\b/i.test(price)) return "EUR";
  return undefined;
}

/** The alert in `mail`, or null when it is not one: not from eBay, no search to name, no match in it. */
export function readEbayAlert(mail: MailMessage): EbayAlert | null {
  const domain = mail.from?.slice(mail.from.lastIndexOf("@") + 1) ?? "";
  if (!mail.from || !isEbayDomain(domain) || !mail.html) return null;
  const capped = mail.html.slice(0, MAX_HTML_CHARS);
  const cut = capped.search(SUGGESTIONS);
  const html = cut >= 0 ? capped.slice(0, cut) : capped;
  const links: { url: URL; end: number }[] = [];
  for (const m of html.matchAll(HREF)) {
    const url = ebayUrl(m[1] ?? "");
    if (url) links.push({ url, end: (m.index ?? 0) + m[0].length });
  }
  const search = searchOf(
    links.map((l) => l.url),
    mail.subject,
  );
  if (!search) return null;
  const seen = new Set<string>();
  const listings: Submitted[] = [];
  const items = links.filter((l) => ITEM_PATH.test(l.url.pathname) && !l.url.searchParams.has("_trkparms"));
  items.forEach((l, i) => {
    const number = ITEM_PATH.exec(l.url.pathname)?.[1] ?? "";
    if (seen.has(number) || listings.length >= MAX_ALERT_LISTINGS) return;
    const window = html.slice(l.end, l.end + WINDOW);
    const open = TITLE_OPEN.exec(window);
    const close = open ? window.indexOf("</h3>", open[0].length) : -1;
    if (!open || close < 0 || close - open[0].length > MAX_TITLE_HTML) return;
    const title = htmlText(window.slice(open[0].length, close));
    if (!title) return;
    seen.add(number);
    // The price line after this title, and before the next titled item's link.
    const titleEnd = close + "</h3>".length;
    const next = items.slice(i + 1).find((n) => ITEM_PATH.exec(n.url.pathname)?.[1] !== number);
    const after = window.slice(titleEnd, next ? Math.max(titleEnd, next.end - l.end) : WINDOW);
    const line = PRICE.exec(after);
    const price = line ? priceOf(htmlText(line[1] ?? "")) : undefined;
    const currency = price ? currencyOf(price, l.url.hostname) : undefined;
    listings.push({
      title,
      url: `https://${l.url.hostname}/itm/${number}`,
      ...(price !== undefined ? { price } : {}),
      ...(currency ? { currency } : {}),
    });
  });
  return listings.length > 0 ? { search, listings } : null;
}

/**
 * Words compared as eBay's search would, and as the "no watch searches for this" DM writes them:
 * case, spacing and the marks that DM leaves out (`SEARCH_MARKS`) ignored.
 */
export function searchWords(s: string): string {
  return s.replace(SEARCH_MARKS, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Marks taken out of a stranger's words before a DM shows them: markdown, mentions, links. */
export const SEARCH_MARKS = /[`*_~|<>@#[\]()\\:/]/g;

export function sameSearch(a: string, b: string): boolean {
  return searchWords(a) === searchWords(b);
}
