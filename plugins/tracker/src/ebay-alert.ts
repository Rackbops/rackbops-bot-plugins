import type { Submitted } from "@rackbops/docket-types";
import type { MailMessage } from "./mime.js";

/**
 * eBay's saved-search alert emails, read for the listings in them (tracker 0.24.0): the second way
 * listings reach an eBay inbox watch, beside Claude in Chrome posting them (web/api-listings.ts).
 * The tracker still never opens eBay (Rod, 2026-10-05): eBay mails the alert to the owner, the
 * owner's Gmail forwards it to their alert address (mail.ts), and this reads only what the email
 * itself says.
 *
 * Read from the first real alert, 2026-10-13 (`fixtures/ebay-saved-search-alert.eml`, with the
 * tracking parameters and the account's names taken out). What it relies on:
 *
 * - it comes from an `ebay.<tld>` address;
 * - the saved search's own link is an eBay `/sch/i.html` address carrying `_svsrch=1` and the
 *   words as `_nkw` (the subject also starts with them, "<words>: Only 1 match", which is used
 *   when no such link is found);
 * - each new match is an `/itm/<number>` link whose text is an `<h3>` (eBay cuts long titles with
 *   an ellipsis), followed by its price in a `<p class="price ...">`, a range such as
 *   "$39.00 to $44.00" when the listing has variations;
 * - "You might also like" starts eBay's own suggestions, which are not matches: nothing from there
 *   on is read, and a link carrying `_trkparms` (how those suggestions are tracked) is never taken.
 *
 * An alert with several matches has not been seen yet: they are read the same way, each its own
 * `<h3>` link, which is an inference from the one-match alert. Pure.
 */

/** Listings one alert gives at most: the task API's per-post cap. */
export const MAX_ALERT_LISTINGS = 40;

export interface EbayAlert {
  /** The saved search's words, as eBay has them. */
  search: string;
  listings: Submitted[];
}

const EBAY_SENDER = /@(?:[a-z0-9-]+\.)*ebay\.[a-z]{2,3}(?:\.[a-z]{2})?$/;
const EBAY_HOST = /^(?:www\.)?ebay\.[a-z]{2,3}(?:\.[a-z]{2})?$/;
const SUGGESTIONS = /you might also like/i;
// An item link whose text holds an <h3> title: the link's address and the title's text.
const ITEM = /<a\b[^>]*\bhref="(https:\/\/[^"]+\/itm\/(\d{6,15})[^"]*)"[^>]*>\s*(?:<span[^>]*>\s*)?<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
const PRICE = /<p\b[^>]*\bclass="[^"]*\bprice\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i;
const LINK = /\bhref="(https:\/\/[^"]+\/sch\/i\.html\?[^"]*)"/gi;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…" };

/** HTML text: tags out, entities decoded, white space made single spaces. */
export function htmlText(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
      }
      return NAMED[e.toLowerCase()] ?? all;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function ebayUrl(href: string): URL | null {
  try {
    const url = new URL(htmlText(href));
    return url.protocol === "https:" && EBAY_HOST.test(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

/** The saved search's words: its `_svsrch=1` link's `_nkw`, else the subject before its last colon. */
function searchOf(html: string, subject: string): string | null {
  for (const m of html.matchAll(LINK)) {
    const url = ebayUrl(m[1] ?? "");
    const words = url?.searchParams.get("_nkw")?.trim();
    if (url?.searchParams.get("_svsrch") === "1" && words) return words.replace(/\s+/g, " ");
  }
  const colon = subject.lastIndexOf(":");
  const words = colon > 0 ? subject.slice(0, colon).trim() : "";
  return words || null;
}

/** The first price in a price line ("$39.00 to $44.00" is its lower end), as text the inbox parses. */
function priceOf(text: string): string | undefined {
  const m = /(?:[A-Z]{1,3} ?)?[$£€]? ?\d[\d,]*(?:\.\d{1,2})?/.exec(text);
  return m ? m[0].trim() : undefined;
}

/** The alert in `mail`, or null when it is not one: not from eBay, no search to name, no match in it. */
export function readEbayAlert(mail: MailMessage): EbayAlert | null {
  if (!mail.from || !EBAY_SENDER.test(mail.from) || !mail.html) return null;
  const cut = mail.html.search(SUGGESTIONS);
  const html = cut >= 0 ? mail.html.slice(0, cut) : mail.html;
  const search = searchOf(html, mail.subject);
  if (!search) return null;
  const seen = new Set<string>();
  const listings: Submitted[] = [];
  const items = [...html.matchAll(ITEM)];
  items.forEach((m, i) => {
    const href = m[1] ?? "";
    const number = m[2] ?? "";
    const url = ebayUrl(href);
    if (!url || url.searchParams.has("_trkparms") || seen.has(number) || listings.length >= MAX_ALERT_LISTINGS) return;
    const title = htmlText(m[3] ?? "");
    if (!title) return;
    seen.add(number);
    // The price line after this title and before the next item's.
    const end = items[i + 1]?.index ?? html.length;
    const after = html.slice((m.index ?? 0) + m[0].length, end);
    const priceLine = PRICE.exec(after);
    const price = priceLine ? priceOf(htmlText(priceLine[1] ?? "")) : undefined;
    const usd = url.hostname.endsWith("ebay.com") && price?.startsWith("$");
    listings.push({
      title,
      url: `https://${url.hostname}/itm/${number}`,
      ...(price !== undefined ? { price } : {}),
      ...(usd ? { currency: "USD" } : {}),
    });
  });
  return listings.length > 0 ? { search, listings } : null;
}

/** Words compared as eBay's search would: case and runs of white space ignored. */
export function sameSearch(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}
