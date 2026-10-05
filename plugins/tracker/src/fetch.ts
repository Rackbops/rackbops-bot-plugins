import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Fetch, FetchResponse } from "@rackbops/docket-core";
import { isEbayHost, NEVER_EBAY } from "@rackbops/docket-types";
import { pageForExtraction } from "./page.js";

/**
 * docket's Fetch port for the price tracker (rackbops-bot-plugins#81, plan 5.3: "the price
 * tracker's fetch and compare" on the notify side, no model). Any registered person names the URL,
 * and the bot runs on roshne's own host, so a read is fenced to the public internet:
 *
 * - `http:` or `https:` only, on the scheme's default port, with no user name or password in it;
 * - every address the host name resolves to must be public: no loopback, private, link-local,
 *   carrier-grade NAT, multicast, documentation or reserved range, IPv4 or IPv6 (mapped and NAT64
 *   forms read as the IPv4 inside them). One such address refuses the whole read;
 * - redirects are followed by hand, at most `MAX_REDIRECTS`, each hop checked the same way;
 * - a read gives up after `TIMEOUT_MS`, or when the tick's signal aborts, and keeps at most
 *   `MAX_BYTES` of the body (a price is in the page's head or its JSON-LD, well inside that);
 * - the body handed back is `pageForExtraction`'s (page.ts): only what price extraction reads,
 *   rebuilt so docket's extraction patterns cannot take quadratic time on it.
 *
 * The check resolves the name and then `fetch` resolves it again, so a DNS server that answers
 * differently the second time (rebinding) is not stopped by this; the host's own network is the
 * last fence. What a refusal says goes into the task's run summary, so a refusal made here names
 * the host name and the reason, never a resolved address (a network error from the runtime itself
 * is passed on as it comes).
 */

export const TIMEOUT_MS = 15_000;
export const MAX_BYTES = 3 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const USER_AGENT = "Mozilla/5.0 (compatible; RackbopsClerk/1.0; price tracker)";

export class FetchRefusedError extends Error {
  override name = "FetchRefusedError";
}

/** The host name's addresses; `node:dns` in production, a table in the tests. */
export type Resolve = (host: string) => Promise<string[]>;

export interface PageFetchOptions {
  resolve?: Resolve;
  fetchImpl?: typeof fetch;
  /** The tick's signal: once aborted, a read in flight stops. */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * Hand back the body as sent (still capped at `maxBytes`), not `pageForExtraction`'s: for a reader
   * that parses it with no backtracking pattern of its own (the BGG source's XML, docket-types' `bggSource`).
   */
  raw?: boolean;
  /** Hand back a redirect as it came, never following it: for a read that carries a credential (BGG's token). */
  noRedirects?: boolean;
}

/**
 * docket-types' page reads carry `NEVER_EBAY`: a directive to this port, never sent. Any hop to
 * eBay is refused, so a pasted page that redirects to eBay is not read either (roshne's rule:
 * eBay's own saved-search alerts cover eBay; the tracker never reads it).
 */
export { isEbayHost, NEVER_EBAY };

const systemResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function v4Parts(ip: string): number[] | null {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : null;
}

function isPublicV4(ip: string): boolean {
  const p = v4Parts(ip);
  if (!p) return false;
  const [a = 0, b = 0, c = 0] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this network, private, loopback, multicast, reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/** An IPv6 address as eight 16-bit groups, or null. Handles `::` and a trailing dotted IPv4. */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const v4 = v4Parts(text.slice(lastColon + 1));
    if (!v4) return null;
    const hex = (hi: number, lo: number) => ((hi << 8) | lo).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hex(v4[0] ?? 0, v4[1] ?? 0)}:${hex(v4[2] ?? 0, v4[3] ?? 0)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN)));
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const known = head.length + rest.length;
  if (halves.length === 1 && known !== 8) return null;
  if (known > 8) return null;
  const groups = [...head, ...new Array<number>(8 - known).fill(0), ...rest];
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isPublicV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    // ::, ::1, IPv4-compatible (deprecated): never public; ::ffff:a.b.c.d is the IPv4 inside.
    return g5 === 0xffff ? isPublicV4(embedded) : false;
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPublicV4(embedded); // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2001 && g1 < 0x0200) return false; // IETF protocol assignments (Teredo, ORCHID, ...)
  if (g0 === 0x2002) return false; // 6to4: carries an IPv4 that is not checked here
  return (g0 & 0xe000) === 0x2000; // global unicast is 2000::/3
}

/** True when `ip` is an address a read may go to: public unicast, IPv4 or IPv6. */
export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPublicV4(ip);
  if (version === 6) return isPublicV6(ip);
  return false;
}

/**
 * Why `raw` is not a URL a price tracker may read, or null when it may (the checks that need no
 * network: scheme, port, credentials, an address literal). The resolved addresses are checked at
 * each read.
 */
export function urlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a web address.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Only http and https pages can be tracked.";
  if (url.username !== "" || url.password !== "") return "A page address with a user name or password in it cannot be tracked.";
  if (url.port !== "") return "Only pages on the standard web ports can be tracked.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return "Only public web pages can be tracked.";
  }
  if (isIP(host) !== 0 && !isPublicAddress(host)) return "Only public web pages can be tracked.";
  return null;
}

/** `p`, or a refusal once `signal` aborts first: a name lookup takes no signal of its own. */
function orAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

async function checkHost(url: URL, resolve: Resolve, signal: AbortSignal, neverEbay = false): Promise<void> {
  const problem = urlProblem(url.href);
  if (problem) throw new FetchRefusedError(problem);
  if (neverEbay && isEbayHost(url.hostname)) throw new FetchRefusedError("it leads to eBay, which I never read");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host) !== 0) addresses = [host];
  else {
    try {
      addresses = await orAbort(resolve(host), signal);
    } catch {
      signal.throwIfAborted();
      throw new FetchRefusedError(`the name ${host} did not resolve`);
    }
  }
  if (addresses.length === 0) throw new FetchRefusedError(`the name ${host} did not resolve`);
  if (!addresses.every(isPublicAddress)) throw new FetchRefusedError(`${host} is not on the public internet`);
}

/** Reads at most `max` bytes of the body, then stops the download. */
async function readCapped(response: Response, max: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - size;
    chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
    size += Math.min(value.byteLength, room);
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** A caller's headers for one hop: a credential (the BGG token) never follows a redirect to another origin, as a browser's would not. */
function sameOriginOnly(headers: Record<string, string>, sameOrigin: boolean): Record<string, string> {
  if (sameOrigin) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !["authorization", "cookie", "proxy-authorization"].includes(k.toLowerCase())));
}

/** The Fetch port, fenced as the file's comment says. */
export function createPageFetch(o: PageFetchOptions = {}): Fetch {
  const resolve = o.resolve ?? systemResolve;
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = o.maxBytes ?? MAX_BYTES;
  return {
    async get(raw: string, headers: Record<string, string> = {}): Promise<FetchResponse> {
      const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      let url = new URL(raw);
      const origin = url.origin;
      const neverEbay = Object.keys(headers).some((k) => k.toLowerCase() === NEVER_EBAY);
      const sent = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== NEVER_EBAY));
      for (let hop = 0; ; hop++) {
        await checkHost(url, resolve, signal, neverEbay);
        signal.throwIfAborted();
        const response = await fetchImpl(url.href, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", ...sameOriginOnly(sent, url.origin === origin) },
        });
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location && !o.noRedirects) {
          await response.body?.cancel().catch(() => {});
          if (hop >= MAX_REDIRECTS) throw new FetchRefusedError(`more than ${MAX_REDIRECTS} redirects`);
          url = new URL(location, url);
          continue;
        }
        const out: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          out[key] = value;
        });
        const body = await readCapped(response, maxBytes);
        return { status: response.status, body: o.raw ? body : pageForExtraction(body), headers: out };
      }
    },
  };
}
