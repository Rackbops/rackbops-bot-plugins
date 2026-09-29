import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url: a login token, a session id, a CSRF token. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the database keeps in place of a token or a session id. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time string equality (a length mismatch answers false at once; the length is not secret). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A token as `randomToken` makes it; anything else is refused before a lookup. */
export function isTokenShape(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
