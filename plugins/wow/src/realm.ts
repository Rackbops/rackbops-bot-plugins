import { config } from "./config.js";
import { blizzardConfigured, blizzardGet } from "./blizzard.js";

// Connected-realm status via the Blizzard Game Data API (client-credentials OAuth).
// The token itself moved to ./blizzard once a second caller (the character profile read
// behind /transmog) needed it — it was never realm-specific.
export type RealmStatus = "UP" | "DOWN";

export function realmWatchConfigured(): boolean {
  return Boolean(blizzardConfigured() && config.realmSlug);
}

// Decide what (if anything) to announce given the last-known status and a fresh reading.
// A missing `prev` is the first-ever reading (no stored status): seed it silently, never a
// phantom. After that, status persists across restarts, so a genuine transition that happened
// while offline is announced on the next reading -- a real, if late, transition, not a
// phantom. `null` = announce nothing.
export function decideRealmTransition(
  prev: RealmStatus | undefined,
  next: RealmStatus,
): "up" | "down" | null {
  if (prev === undefined || prev === next) return null;
  return next === "DOWN" ? "down" : "up";
}

/** The Blizzard connected-realm search URL, keyed on realm slug. Shared by `realmExists` and
 * `realmStatus` — the only two callers. */
export function connectedRealmSearchUrl(slug: string): string {
  return (
    `https://${config.region}.api.blizzard.com/data/wow/search/connected-realm` +
    `?namespace=dynamic-${config.region}&realms.slug=${encodeURIComponent(slug)}&_pageSize=1`
  );
}

/**
 * Whether `slug` names a realm in the configured region.
 *
 * Exists to separate two causes the character endpoint can't: Blizzard returns the *same* 404 for
 * a character that doesn't exist and a realm that doesn't exist, so the only way to tell them
 * apart is to ask about the realm on its own. Called only on the failure path, so a successful
 * lookup never pays for it.
 *
 * **Fails open.** If this check can't complete, it reports `true` — an outage or a rate limit must
 * not turn "we couldn't ask" into "your realm is wrong", which would send someone chasing a typo
 * that isn't there. That collapses "couldn't ask" and "exists" into one boolean, which is fine for
 * this function's one caller (`transmog.ts` just picks between two error messages) but would be
 * wrong for a caller that needs to tell them apart. Deliberately left a boolean rather than a
 * `"exists" | "missing" | "unknown"` tri-state until a second caller actually needs that
 * distinction — don't build it speculatively.
 */
export async function realmExists(slug: string): Promise<boolean> {
  try {
    const res = await blizzardGet(connectedRealmSearchUrl(slug));
    if (!res.ok) return true;
    const data = (await res.json()) as { results?: unknown[] };
    return (data.results?.length ?? 0) > 0;
  } catch {
    return true;
  }
}

interface RealmIndexEntry {
  name: string;
  slug: string;
}

/**
 * Comparison key for matching user-typed realm names against Blizzard's realm index:
 * case/accent-preserving but strips everything that isn't a letter or digit, so hyphens, spaces,
 * apostrophes and parentheses all stop mattering. Exported for its own tests — this is the piece
 * that has to get "Azjol-Nerub" and "Aggra (Português)" right (#32).
 */
export function normalizeRealmName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Find `realm` in a realm index by name and return its canonical Blizzard slug, or undefined if
 * nothing matches. Pure — takes the index as data — so it's testable against fixtures without a
 * live API call.
 */
export function matchRealmIndex(entries: RealmIndexEntry[], realm: string): string | undefined {
  const key = normalizeRealmName(realm);
  return entries.find((e) => normalizeRealmName(e.name) === key)?.slug;
}

// Realm lists change rarely (a merge or a new realm, at most a few times a year), so the index is
// cached for the process lifetime rather than time-limited like the OAuth token in ./blizzard.
let realmIndexCache = new Map<string, RealmIndexEntry[]>();

async function fetchRealmIndex(region: string): Promise<RealmIndexEntry[]> {
  // .has(), not a truthiness check on .get() — an empty-but-fetched result is a legitimate cache
  // hit, and it keeps a malformed response (see the `?? []` below) from looking "not yet cached"
  // and being re-fetched on every subsequent call.
  if (realmIndexCache.has(region)) return realmIndexCache.get(region)!;
  const url =
    `https://${region}.api.blizzard.com/data/wow/realm/index` +
    `?namespace=dynamic-${region}&locale=en_US`;
  const res = await blizzardGet(url);
  if (!res.ok) throw new Error(`Blizzard realm index failed: ${res.status}`);
  const data = (await res.json()) as { realms?: RealmIndexEntry[] };
  const realms = data.realms ?? [];
  realmIndexCache.set(region, realms);
  return realms;
}

/**
 * Resolve `realm` (raw user input) to Blizzard's canonical slug via the realm index, for the one
 * case `realmSlug`'s heuristic in ../wow/transmog.ts can't get right on its own: a literal hyphen
 * in the realm's NAME (Azjol-Nerub, Arak-arahm) that Blizzard's slug drops but the heuristic
 * keeps (#32). Meant to be called only after the heuristic slug has already failed both the
 * equipment fetch and `realmExists`, so a working lookup never pays for the extra call.
 *
 * Fails open (undefined) on any error, same as `realmExists` — the caller already has a fallback
 * error message for "couldn't resolve this realm".
 */
export async function resolveCanonicalSlug(
  realm: string,
  region: string,
): Promise<string | undefined> {
  try {
    return matchRealmIndex(await fetchRealmIndex(region), realm);
  } catch {
    return undefined;
  }
}

/** Test-only: drop the cached index so a test can control what the next fetch sees. */
export function _resetRealmIndex(): void {
  realmIndexCache = new Map();
}

export async function realmStatus(): Promise<RealmStatus> {
  // String(...): config.realmSlug is optional in the type even though realmWatchConfigured()
  // guards every real caller; matches the old template literal's coercion of undefined -> "undefined".
  const res = await blizzardGet(connectedRealmSearchUrl(String(config.realmSlug)));
  if (!res.ok) throw new Error(`Blizzard realm query failed: ${res.status}`);
  const data = (await res.json()) as {
    results: { data: { status: { type: RealmStatus } } }[];
  };
  const status = data.results[0]?.data.status.type;
  if (!status) throw new Error(`Realm "${config.realmSlug}" not found in ${config.region}`);
  return status;
}
