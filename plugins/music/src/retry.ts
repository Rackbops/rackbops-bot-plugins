// The retry policy both HTTP clients share: setlist.fm's (every call) and Spotify's (the build
// calls only -- see `spotify.ts`). Moved out of `setlistfm.ts` with the same logic and numbers
// (`MAX_RETRIES` and `defaultSleep` gained `export` for the Spotify client, and `SleepLike`'s
// comment no longer points at `FetchLike`) so there is one set of numbers and one reading of
// `Retry-After`, not two that drift (#192).

/** Injected so the retry tests don't actually wait. */
export type SleepLike = (ms: number) => Promise<void>;

/**
 * Whether a status is worth trying again. 429 is a rate limit (setlist.fm's free tier is a small
 * number of requests per second, and one `/setlist` can fire two calls back to back; Spotify's
 * quota is pooled across a developer's apps), and a 5xx is the server having a moment. Every other
 * 4xx is a statement about the REQUEST -- a bad key, a missing id -- and repeating it unchanged
 * only wastes the user's time.
 */
export function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Reads a `Retry-After` header into milliseconds. Both forms in RFC 9110 are accepted: a count of
 * seconds (what setlist.fm sends) and an HTTP-date. Returns `undefined` when the header is absent
 * or unreadable, which the caller treats as "back off on your own schedule" rather than as an
 * error -- a malformed header must not be the reason a request fails.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** Attempts AFTER the first one, for a retryable status. */
export const MAX_RETRIES = 3;
/** The first backoff step; each retry after that doubles it. */
const BACKOFF_BASE_MS = 500;
/**
 * The longest this will sit on any one retry. A `/setlist` runs behind a deferred Discord reply,
 * so a long sleep is not a crash -- but it is an unexplained silence, and a sustained rate-limit
 * can come with a `Retry-After` of a minute or more (setlist.fm sends whole minutes). Past this,
 * giving up immediately and telling the user to try again in a minute beats making them watch a
 * spinner for it.
 */
const MAX_BACKOFF_MS = 5_000;

/**
 * How long to wait before retry number `attempt` (0-based), or `undefined` to stop retrying now.
 *
 * A server-supplied `Retry-After` wins over our own backoff -- it is the only number that knows
 * when the limit actually lifts -- but one longer than `MAX_BACKOFF_MS` ends the retries instead
 * of being clamped down to it: hammering the endpoint again before the server said we could is
 * exactly what the header exists to prevent.
 */
export function retryDelay(attempt: number, retryAfterMs: number | undefined): number | undefined {
  if (retryAfterMs !== undefined) return retryAfterMs > MAX_BACKOFF_MS ? undefined : retryAfterMs;
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

export const defaultSleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
