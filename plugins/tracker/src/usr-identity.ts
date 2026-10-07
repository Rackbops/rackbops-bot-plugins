/**
 * The web area's sign-in through our usr (usr.ts, slice 3 of Rod's "Wire it"): usr's `nz_id` cookie,
 * an ES256 JWT it sets on the shared parent domain, verified offline against usr's JWKS as usr
 * `docs/sso-verifier.md` says -- signature (ES256, P-256), `iss` "usr", `exp`, and never a delegation
 * token (header `typ` "dlg+jwt", or an `act` claim). Keys are cached for `JWKS_TTL_MS` and fetched
 * again on an unknown `kid`, at most every `JWKS_RETRY_MS`. WebCrypto only: no dependency.
 */

export const SSO_COOKIE = "nz_id";
export const JWKS_TTL_MS = 5 * 60 * 1000;
export const JWKS_RETRY_MS = 30 * 1000;
export const JWKS_TIMEOUT_MS = 5000;
/** usr's tokens are a few hundred bytes; anything far bigger is not one. */
const MAX_TOKEN = 8192;
const MAX_JWKS = 64 * 1024;

export interface UsrIdentity {
  /** usr's opaque user id: the person's `usr_subject`. */
  sub: string;
  /** Every app's roles, `app:role`. */
  roles: string[];
}

export interface UsrVerifierOptions {
  /** usr's origin (usr.ts's `UsrConfig.url`). */
  url: string;
  fetchImpl?: typeof fetch;
  /** Milliseconds since the epoch; the plugin's clock. */
  now: () => number;
}

interface Key {
  kid: string;
  key: CryptoKey;
}

function decode(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export class UsrVerifier {
  private keys: Key[] = [];
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private pending: Promise<void> | null = null;

  constructor(private readonly o: UsrVerifierOptions) {}

  /** The identity in an `nz_id` token, or null when it is missing, malformed, unsigned by usr, expired or a delegation token. */
  async verify(token: string | null): Promise<UsrIdentity | null> {
    if (!token || token.length > MAX_TOKEN) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    const header = decode(h) as { alg?: unknown; kid?: unknown; typ?: unknown } | null;
    if (!header || header.alg !== "ES256" || header.typ === "dlg+jwt" || typeof header.kid !== "string") return null;
    const key = (await this.keyFor(header.kid, false)) ?? (await this.keyFor(header.kid, true));
    if (!key) return null;
    const signature = Buffer.from(s, "base64url");
    if (signature.length !== 64) return null;
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const claims = decode(p) as { iss?: unknown; sub?: unknown; exp?: unknown; act?: unknown; roles?: unknown } | null;
    if (!claims || claims.iss !== "usr" || claims.act !== undefined) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= this.o.now()) return null;
    if (typeof claims.sub !== "string" || claims.sub === "") return null;
    const roles = Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === "string") : [];
    return { sub: claims.sub, roles };
  }

  private async keyFor(kid: string, force: boolean): Promise<CryptoKey | null> {
    const age = this.o.now() - this.fetchedAt;
    if (age < 0 || age >= JWKS_TTL_MS || (force && age >= JWKS_RETRY_MS)) await this.refresh();
    return this.keys.find((k) => k.kid === kid)?.key ?? null;
  }

  /** One JWKS fetch at a time; a failed one keeps the old keys and counts as a fetch, so it is not retried at once. */
  private refresh(): Promise<void> {
    if (!this.pending) {
      this.pending = this.load().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    this.fetchedAt = this.o.now();
    try {
      const res = await (this.o.fetchImpl ?? fetch)(`${this.o.url}/.well-known/jwks.json`, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
      });
      if (!res.ok) return;
      // A JWKS is a few hundred bytes; read no more than MAX_JWKS of whatever comes.
      if (Number(res.headers.get("content-length") ?? 0) > MAX_JWKS) return;
      const text = await res.text();
      if (text.length > MAX_JWKS) return;
      const body = JSON.parse(text) as { keys?: unknown };
      if (!Array.isArray(body.keys)) return;
      const keys: Key[] = [];
      for (const k of body.keys as (JsonWebKey & { kid?: unknown })[]) {
        if (typeof k.kid !== "string" || k.kty !== "EC" || k.crv !== "P-256") continue;
        try {
          // The public half only, whatever else the entry carries.
          const jwk: JsonWebKey = { kty: "EC", crv: "P-256", ...(k.x !== undefined ? { x: k.x } : {}), ...(k.y !== undefined ? { y: k.y } : {}) };
          keys.push({ kid: k.kid, key: await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]) });
        } catch {
          // A key the runtime cannot read is skipped, not fatal.
        }
      }
      this.keys = keys;
    } catch {
      // usr unreachable: keep what we had.
    }
  }
}

/**
 * Where a browser without a valid `nz_id` goes: usr re-mints the cookie from its own session (or
 * shows its sign-in) and sends the browser back to `returnTo`, which usr honours only under its
 * cookie domain (usr `src/server/lib/sso.ts` `safeReturnUrl`).
 */
export function refreshUrl(usrUrl: string, returnTo: string): string {
  return `${usrUrl}/api/auth/sso/refresh?return=${encodeURIComponent(returnTo)}`;
}
