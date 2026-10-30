import type { EbayBrowse, EbayRequest } from "@rackbops/docket-types";
import { readCapped } from "./fetch.js";

/**
 * The host's half of docket-types' eBay source (`ebaySource`, Rod, 2026-10-20: "Build it" on the
 * eBay Browse API card): eBay's own Browse API, with an application token the tracker mints from
 * the owner's eBay developer keys, `TRACKER_EBAY_CLIENT_ID` (eBay's App ID) and
 * `TRACKER_EBAY_CLIENT_SECRET` (its Cert ID). eBay's Dev ID is not needed for this.
 *
 * The token comes from eBay's client-credentials grant (`POST /identity/v1/oauth2/token`, scope
 * `https://api.ebay.com/oauth/api_scope`, developer.ebay.com, read 2026-10-20), is kept in memory
 * only, and is minted again a minute before eBay says it ends, or once when a call answers 401.
 * Two calls go through it: a search (`/buy/browse/v1/item_summary/search`) and, since docket 0.20.0,
 * one listing's full read (getItem, `/buy/browse/v1/item/<item id>`), both built by docket-types.
 * Both addresses are fixed on api.ebay.com, so no person names where the keys go; no redirect is
 * followed; a call gives up after `EBAY_TIMEOUT_MS`; at most `EBAY_MAX_BYTES` of an answer is read.
 * The keys and the token are never logged and never put in an error: a failed call says only what
 * went wrong in fixed words. This is the only way the tracker reads eBay: no eBay page is opened.
 */

export const EBAY_API = "https://api.ebay.com";
export const EBAY_TOKEN_PATH = "/identity/v1/oauth2/token";
export const EBAY_SCOPE = "https://api.ebay.com/oauth/api_scope";
export const EBAY_TIMEOUT_MS = 30_000;
export const EBAY_MAX_BYTES = 4 * 1024 * 1024;
/** How long before eBay's own end a token is minted again. */
const TOKEN_MARGIN_MS = 60_000;

export interface EbayKeys {
  clientId: string;
  clientSecret: string;
}

function visible(name: string, raw: string | undefined): string | null {
  const v = raw?.trim() ?? "";
  if (v === "") return null;
  // A header value: the runtime's error for a bad one quotes it, so refuse the load naming the setting only.
  if (!/^[!-~]+$/.test(v)) throw new Error(`${name} has a character in it that is not visible ASCII (letters, digits and punctuation only)`);
  return v;
}

/**
 * The eBay keys from `TRACKER_EBAY_CLIENT_ID` and `TRACKER_EBAY_CLIENT_SECRET`, or null when both
 * are unset or empty. One without the other refuses the load: a half-set pair is a mistake, never
 * a choice.
 */
export function parseEbayKeys(env: Record<string, string | undefined>): EbayKeys | null {
  const clientId = visible("TRACKER_EBAY_CLIENT_ID", env.TRACKER_EBAY_CLIENT_ID);
  const clientSecret = visible("TRACKER_EBAY_CLIENT_SECRET", env.TRACKER_EBAY_CLIENT_SECRET);
  if (clientId === null && clientSecret === null) return null;
  if (clientId === null || clientSecret === null) throw new Error("TRACKER_EBAY_CLIENT_ID and TRACKER_EBAY_CLIENT_SECRET go together: set both, or neither");
  return { clientId, clientSecret };
}

export interface EbayOptions {
  keys: EbayKeys;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

interface Answer {
  status: number;
  body: unknown;
}

/** The `EbayBrowse` docket-types' `ebaySource` runs each look through. */
export function createEbayBrowse(o: EbayOptions): EbayBrowse {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? EBAY_TIMEOUT_MS;
  const now = o.now ?? Date.now;
  const basic = Buffer.from(`${o.keys.clientId}:${o.keys.clientSecret}`).toString("base64");
  let token: { value: string; until: number } | null = null;
  let minting: Promise<string> | null = null;

  async function call(url: string, init: RequestInit): Promise<Answer> {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, redirect: "manual", signal });
    } catch {
      // A fixed message: the runtime's own can quote the request's headers, and so a key or the token.
      throw new Error(signal.aborted ? "eBay did not answer in time" : "eBay could not be reached");
    }
    let text: string;
    try {
      text = await readCapped(response, EBAY_MAX_BYTES);
    } catch {
      throw new Error(signal.aborted ? "eBay did not answer in time" : "eBay's answer could not be read");
    }
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  async function mint(): Promise<string> {
    const { status, body } = await call(`${EBAY_API}${EBAY_TOKEN_PATH}`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: EBAY_SCOPE }).toString(),
    });
    // eBay's word for keys it refuses is 401 (invalid_client); a 400 is a grant it would not give.
    if (status === 400 || status === 401 || status === 403) throw new EbayKeysRefused();
    if (status !== 200) throw new Error(`eBay's token service answered HTTP ${status}`);
    const b = body as { access_token?: unknown; expires_in?: unknown } | null;
    const value = typeof b?.access_token === "string" ? b.access_token : "";
    const seconds = typeof b?.expires_in === "number" && Number.isFinite(b.expires_in) ? b.expires_in : 0;
    if (!/^[!-~]{1,8192}$/.test(value) || seconds <= 0) throw new Error("eBay's token service gave no token");
    token = { value, until: now() + seconds * 1000 - TOKEN_MARGIN_MS };
    return value;
  }

  /** The token in hand, or one minted now; looks that start together share one minting. `stale` is one eBay refused: never handed back. */
  async function current(stale?: string): Promise<string> {
    if (token && now() < token.until && token.value !== stale) return token.value;
    if (minting) return minting;
    token = null;
    minting ??= mint().finally(() => {
      minting = null;
    });
    return minting;
  }

  function search(request: EbayRequest, value: string): Promise<Answer> {
    const query = new URLSearchParams(request.params).toString();
    return call(`${EBAY_API}${request.path}?${query}`, {
      method: "GET",
      headers: { authorization: `Bearer ${value}`, "x-ebay-c-marketplace-id": request.marketplace, accept: "application/json" },
    });
  }

  return async (request: EbayRequest) => {
    let value: string;
    try {
      value = await current();
    } catch (err) {
      // Keys eBay refuses read as eBay's own 401, so docket tells the owner at once.
      if (err instanceof EbayKeysRefused) return { status: 401, body: null };
      throw err;
    }
    const first = await search(request, value);
    if (first.status !== 401) return first;
    // A token eBay no longer takes (ended early, or revoked): one fresh one, then its answer stands.
    try {
      value = await current(value);
    } catch (err) {
      if (err instanceof EbayKeysRefused) return { status: 401, body: null };
      throw err;
    }
    return search(request, value);
  };
}

class EbayKeysRefused extends Error {
  constructor() {
    super("eBay refused the app's keys");
  }
}
