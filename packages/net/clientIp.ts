// Shared client-IP resolution for a plugin's own HTTP listener (Rackbops/rackbops-bot-plugins#69).
// `CF-Connecting-IP` is set by Cloudflare's edge for anything that genuinely transits its network,
// but nothing about a raw HTTP request proves it actually came that way -- a header is just text a
// caller supplies. Every listener that trusted it unconditionally (warbandeer's ingest server,
// music's Spotify callback) documented this exact gap in their own comments: another container on
// the same compose network could set the header to anything, since nothing re-verified it. This
// module is that verification: the header is honored only from a peer address that resolves to the
// deployment's own Cloudflare Tunnel sidecar (`TRUSTED_PROXY_HOST`); everything else falls back to
// the real connection peer, so an untrusted caller can never claim a fresh identity per request.
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export interface TrustedProxy {
  /** Synchronous, so a listener's per-request hot path never awaits a DNS lookup. Checks the
   *  CURRENTLY cached address set; see `refresh()` for how that set gets populated. */
  isTrusted(peerAddress: string): boolean;
  /** Re-resolves `host` and replaces the cached address set. Never throws -- a transient DNS
   *  failure leaves the existing set (if any) in place rather than revoking trust that was already
   *  established, or crashing a plugin's `activate()` over a momentarily-unreachable resolver. */
  refresh(): Promise<void>;
}

/** Re-resolution is capped at once per this window, triggered by a cache miss in `isTrusted`
 *  (never by a timer) -- compose can recreate the tunnel sidecar with a new address at any time,
 *  but a hot loop of misses (an attacker deliberately varying its own address) must not turn into a
 *  hot loop of DNS lookups either. */
const REFRESH_THROTTLE_MS = 60_000;

async function defaultLookup(host: string): Promise<string[]> {
  const results = await dnsLookup(host, { all: true });
  return results.map((r) => r.address);
}

/**
 * Normalizes an IPv4-mapped IPv6 address (`::ffff:x.x.x.x`) down to its plain IPv4 form. Found
 * during round-2 gate testing: `Bun.serve` with no explicit `hostname` (every call site in this
 * repo) binds dual-stack, and an IPv4 peer connecting to that listener is reported by
 * `srv.requestIP()` in mapped notation -- confirmed directly (`bun -e` against a real listener),
 * not assumed. `dns.promises.lookup` never returns that notation for an IPv4 result, so without
 * this the trusted-address Set and the peer address `isTrusted` is asked to check would never
 * match for a real IPv4 tunnel sidecar: the whole fix would silently never engage. Applied on BOTH
 * sides of the comparison (the resolved set and the incoming peer) so it doesn't matter which form
 * either one happens to arrive in. Anything else (a real IPv6 address, an already-plain IPv4 one)
 * passes through unchanged.
 */
function canonicalAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  return mapped?.[1] ?? address;
}

/**
 * `opts.host` is the compose hostname of the Cloudflare Tunnel sidecar in front of this listener
 * (env `TRUSTED_PROXY_HOST`; see each plugin's `botPlugin.env` entry for the deployed example
 * value). `undefined` means "not configured": `isTrusted` always returns `false` and the header is
 * never honored -- fail closed, matching every other unconfigured-feature rule in this repo.
 * `opts.lookup`/`opts.now` are test seams; production always resolves real DNS and reads the real
 * clock.
 */
export function createTrustedProxy(opts: {
  host: string | undefined;
  lookup?: (host: string) => Promise<string[]>;
  now?: () => number;
}): TrustedProxy {
  const host = opts.host;
  const lookup = opts.lookup ?? defaultLookup;
  const now = opts.now ?? Date.now;
  let addresses = new Set<string>();
  let lastRefreshAt = -Infinity;
  let inFlight: Promise<void> | undefined;

  function doRefresh(): Promise<void> {
    if (host === undefined) return Promise.resolve();
    if (inFlight) return inFlight;
    lastRefreshAt = now();
    inFlight = (async () => {
      try {
        addresses = new Set((await lookup(host)).map(canonicalAddress));
      } catch {
        // Leave `addresses` as it was -- see the interface doc comment.
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  }

  return {
    isTrusted(peerAddress: string): boolean {
      if (host === undefined) return false;
      const trusted = addresses.has(canonicalAddress(peerAddress));
      // Fire-and-forget: THIS call still answers from the address set as it stood when the
      // request arrived. The miss that triggers a refresh is itself still correctly untrusted --
      // refreshing can only help a LATER request, never retroactively change this one's answer.
      if (!trusted && now() - lastRefreshAt >= REFRESH_THROTTLE_MS) void doRefresh();
      return trusted;
    },
    refresh: doRefresh,
  };
}

/**
 * `CF-Connecting-IP` is honored only when `peerAddress` is a trusted proxy address AND the header
 * is present and a syntactically valid IP literal -- an untrusted peer, a missing header, or a
 * header that isn't an IP all fall back to `peerAddress` itself, which in turn falls back to
 * `"unknown"` if the caller has no peer address to report (Bun's `requestIP` can return `null` for
 * a request over an already-closed socket).
 *
 * A repeated header collapses to one comma-joined string per the Fetch `Headers` contract; only
 * the FIRST value is honored, the same defensive convention as a standard `X-Forwarded-For` chain
 * -- Cloudflare's edge only ever sets this header once for a request that genuinely transited it,
 * so a second value can only be something a caller appended trying to look like an earlier hop.
 */
export function clientIpFrom(req: Request, peerAddress: string | undefined, proxy: TrustedProxy): string {
  if (peerAddress !== undefined && proxy.isTrusted(peerAddress)) {
    const header = req.headers.get("CF-Connecting-IP");
    if (header !== null) {
      const first = (header.split(",")[0] ?? "").trim();
      if (isIP(first) !== 0) return first;
    }
  }
  return peerAddress ?? "unknown";
}
