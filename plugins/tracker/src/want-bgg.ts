import { clean, ExecutorUnavailableError, type Fetch } from "@rackbops/docket-core";
import { parsePrice, safeUrl } from "@rackbops/docket-types";
import { type Listing, MAX_LISTINGS, type Source, SourceMiss, SourceUnavailableError } from "./want-sources.js";

/**
 * The BoardGameGeek source (rackbops-bot-plugins#83; the #83a plan of 2026-09-29): a board game's
 * marketplace listings from BGG's XML API, `GET https://boardgamegeek.com/xmlapi2/thing?id=<id>&marketplace=1`
 * with `Authorization: Bearer <TRACKER_BGG_TOKEN>` -- BGG's rule for registered applications
 * (boardgamegeek.com/using_the_xml_api, read 2026-09-29) -- on the bare host (never `www.`), at
 * least `BGG_SPACING_MS` between two requests. roshne applied on 2026-09-29 and BGG has not
 * answered yet, so the source is registered only once the token is set (index.ts), and
 * **the parser's fixture is hand-written to the documented shape, not a captured response**:
 * one real response, saved once the token exists, is the check.
 *
 * The XML is read with `indexOf` and patterns over one bounded tag at a time, never over the whole
 * body, so a large or broken answer cannot take the bot's thread for long; no XML library.
 */

export const BGG_HOST = "boardgamegeek.com";
export const BGG_SPACING_MS = 5_000;
export const BGG_ATTRIBUTION = "via BoardGameGeek";
/**
 * BGG reads waiting their turn at most: one more is put back for the next tick (docket's
 * `ExecutorUnavailableError` requeues a notify-lane run, not a miss), so many BGG watches due
 * together cannot hold the poll tick -- and the price checks behind them -- for long.
 */
export const MAX_BGG_WAITING = 2;
const MAX_TAG = 2_000;

/** A BGG thing id from a bare number or a `boardgamegeek.com/boardgame/<id>/...` address, or null. */
export function parseBggThingId(input: string): number | null {
  const raw = input.trim();
  if (/^[0-9]{1,9}$/.test(raw)) return Number(raw) > 0 ? Number(raw) : null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname !== BGG_HOST && url.hostname !== `www.${BGG_HOST}`) return null;
  const m = /^\/(boardgame|boardgameexpansion|boardgameaccessory|thing)\/([0-9]{1,9})(\/|$)/.exec(url.pathname);
  return m && Number(m[2]) > 0 ? Number(m[2]) : null;
}

export function bggThingUrl(id: number): string {
  return `https://${BGG_HOST}/xmlapi2/thing?id=${id}&marketplace=1`;
}

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    const lower = e.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/** The attributes of each `<name ...>` tag in `xml` (one listing's text, or the head before the listings), in order. */
function tagsAttrs(xml: string, name: string, limit = 50): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let at = 0;
  while (out.length < limit) {
    const start = xml.indexOf(`<${name}`, at);
    if (start < 0) break;
    at = start + name.length + 1;
    const after = xml.charAt(at);
    if (after !== " " && after !== "/" && after !== ">" && after !== "\t" && after !== "\n" && after !== "\r") continue;
    const end = xml.indexOf(">", at);
    if (end < 0 || end - start > MAX_TAG) break;
    const attrs: Record<string, string> = {};
    for (const m of xml.slice(start, end).matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g)) {
      attrs[(m[1] ?? "").toLowerCase()] = unescapeXml(m[2] ?? "");
    }
    out.push(attrs);
    at = end + 1;
  }
  return out;
}

const first = (xml: string, name: string): Record<string, string> | undefined => tagsAttrs(xml, name, 1)[0];

/** `<listing>` elements looked at in one answer, kept or not: the bound on the walk. */
export const MAX_SCANNED = 1_000;

/**
 * The marketplace listings in a `thing` answer: each `<listing>` inside `<marketplacelistings>`,
 * with its `price` (`currency`, `value`), `condition` and `link` (`href`), titled by the thing's
 * primary `<name>`; a seller's `notes` are not read (free text, never put in a DM). A listing without
 * a usable link is dropped. Each listing's tags are looked for only inside that listing's own text,
 * and at most `MAX_SCANNED` listings are looked at, so the walk is linear in the answer. Pure.
 */
export function parseMarketplace(xml: string): Listing[] {
  const open = xml.indexOf("<marketplacelistings");
  const head = open < 0 ? xml.slice(0, 200_000) : xml.slice(0, open);
  const names = tagsAttrs(head, "name");
  const primary = names.find((n) => n.type === "primary") ?? names[0];
  const title = clean(primary?.value ?? "", 150, true) || "A BGG listing";
  const out: Listing[] = [];
  if (open < 0) return out;
  const close = xml.indexOf("</marketplacelistings>", open);
  const stop = close < 0 ? xml.length : close;
  let at = open;
  for (let scanned = 0; scanned < MAX_SCANNED && out.length < MAX_LISTINGS; scanned++) {
    const start = xml.indexOf("<listing>", at);
    if (start < 0 || start >= stop) break;
    const endTag = xml.indexOf("</listing>", start);
    const end = endTag < 0 || endTag > stop ? stop : endTag;
    at = end + 1;
    const one = xml.slice(start, end);
    const url = safeUrl(first(one, "link")?.href ?? "");
    if (!url) continue;
    const price = first(one, "price");
    const value = price?.value !== undefined ? parsePrice(price.value) : null;
    const currency = (price?.currency ?? "").trim().toUpperCase();
    const condition = clean(first(one, "condition")?.value ?? "", 40, true);
    out.push({
      id: `bgg:${url}`,
      title,
      url,
      ...(value !== null ? { price: value } : {}),
      ...(/^[A-Z]{3}$/.test(currency) ? { currency } : {}),
      ...(condition ? { condition } : {}),
    });
  }
  return out;
}

export interface BggOptions {
  token: string;
  /** Raw bodies with no redirects followed (fetch.ts's `raw` and `noRedirects`): the XML as sent, fenced like every other read, and the token never leaves BGG's host. */
  fetch: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The `bgg` source: one request at a time, `BGG_SPACING_MS` apart, with the token. */
export function bggSource(o: BggOptions): Source {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = Number.NEGATIVE_INFINITY;
  let turn: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  const request = async (id: number): Promise<Listing[]> => {
    const wait = last + BGG_SPACING_MS - now();
    if (wait > 0) await sleep(wait);
    last = now();
    let status: number;
    let body: string;
    try {
      const response = await o.fetch.get(bggThingUrl(id), { authorization: `Bearer ${o.token}`, accept: "application/xml,text/xml;q=0.9,*/*;q=0.5" });
      status = response.status;
      body = response.body;
    } catch (err) {
      throw new SourceMiss(`BGG could not be read: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      last = now();
    }
    if (status === 401 || status === 403) throw new SourceUnavailableError("BGG rejected the token");
    if (status === 202 || status === 429 || status >= 500) throw new SourceMiss(`BGG is busy (HTTP ${status})`);
    // A redirect is not followed (the token goes to boardgamegeek.com only): it is a miss like any other answer.
    if (status !== 200) throw new SourceMiss(`BGG answered HTTP ${status}`);
    return parseMarketplace(body);
  };
  return {
    id: "bgg",
    search(target) {
      const id = parseBggThingId(target);
      if (id === null) return Promise.reject(new SourceMiss("that is not a BGG game"));
      if (waiting >= MAX_BGG_WAITING) return Promise.reject(new ExecutorUnavailableError("BGG reads are spaced out; this one waits for the next tick"));
      waiting++;
      const mine = turn.then(() => request(id)).finally(() => void waiting--);
      turn = mine.catch(() => {});
      return mine;
    },
  };
}
