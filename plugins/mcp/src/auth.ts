// Bearer-token auth + per-clientIp failure lockout (Tooling#742 decision 3). The token unset -> 503
// case is checked by the caller (http.ts) BEFORE this ever runs; this module only ever sees a
// configured token. Never logs the presented token, only the clientIp.
import { createHash, timingSafeEqual } from "node:crypto";
import type { PluginLog } from "../../../packages/api/contract.js";

const WINDOW_MS = 60_000;
/** "More than 10 failures a minute" (decision 3): the 11th failure in a window is still answered
 *  401 like any other -- it is what PUSHES the count past 10. Lockout (429) starts from the NEXT
 *  request after that, for the rest of the window, regardless of whether that request's own token
 *  would have been correct. */
const MAX_FAILURES = 10;

export interface RateLimiter {
  isLocked(clientIp: string, now: Date): boolean;
  recordFailure(clientIp: string, now: Date): void;
}

/** One counter per `clientIp`, reset the first time a window has elapsed since it was last touched --
 *  never proactively swept, so a client that stops sending requests just stops being tracked. */
export function createRateLimiter(): RateLimiter {
  const windows = new Map<string, { windowStart: number; count: number }>();
  return {
    isLocked(clientIp, now) {
      const entry = windows.get(clientIp);
      if (entry === undefined) return false;
      if (now.getTime() - entry.windowStart >= WINDOW_MS) return false;
      return entry.count > MAX_FAILURES;
    },
    recordFailure(clientIp, now) {
      const entry = windows.get(clientIp);
      if (entry === undefined || now.getTime() - entry.windowStart >= WINDOW_MS) {
        windows.set(clientIp, { windowStart: now.getTime(), count: 1 });
      } else {
        entry.count += 1;
      }
    },
  };
}

/** `crypto.timingSafeEqual(sha256(given), sha256(expected))` (decision 3, literally) -- hashing
 *  first gives both sides the same fixed length, which timingSafeEqual requires and a raw compare
 *  of two possibly-different-length tokens could not satisfy without leaking length by throwing. */
function constantTimeEqual(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export type AuthResult = { ok: true } | { ok: false; status: 401 | 429 };

/** `expectedToken` must already be confirmed configured (non-empty) by the caller -- decision 3's
 *  503-before-auth check. */
export function checkAuth(
  request: Request,
  clientIp: string,
  expectedToken: string,
  limiter: RateLimiter,
  now: () => Date,
  log: PluginLog,
): AuthResult {
  const at = now();
  if (limiter.isLocked(clientIp, at)) return { ok: false, status: 429 };
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (given === undefined || given.length === 0 || !constantTimeEqual(given, expectedToken)) {
    limiter.recordFailure(clientIp, at);
    log.warn(`auth failed from ${clientIp}`);
    return { ok: false, status: 401 };
  }
  return { ok: true };
}
