// The Warbandeer connector's inbound HTTP surface — see the bot's docs/adr/0001 (transport) and
// docs/adr/0002 (auth). `handleRequest` is pure/DI'd: every dependency arrives as a parameter, so
// `server.test.ts` calls it with hand-built `Request` objects and never binds a real port.
// `startWarbandeerServer` is the only thing that touches `Bun.serve`, called from the plugin's
// `createPlugin` -> `activate()`.
import {
  findAccountByToken,
  generateDeviceToken,
  hashToken,
  links,
  type LinksState,
  MAX_LINKED_ACCOUNTS_PER_USER,
  redeemLinkCode,
  saveLinks,
  touchLinkedAccount,
  upsertLinkedAccount,
} from "./links.js";
import { charactersDir, saveCharacterSnapshotTo, validateAccountLabel, validateCharacterPayload } from "./characters.js";

// Whether WARBANDEER_INGEST_PORT is set — replaces the bot's `config.warbandeerIngestPort !==
// undefined`. Set by createPlugin (which owns env parsing) before any command handler runs.
let configured = false;
export function setConnectorConfigured(value: boolean): void {
  configured = value;
}
export function warbandeerConnectorConfigured(): boolean {
  return configured;
}

/** Distinct from `warbandeerConnectorConfigured()`: that only says the env var is set, this says
 * the HTTP server actually bound its port. `createPlugin`'s `activate()` catches a
 * `startWarbandeerServer` failure (a privileged port, one already in use) rather than crashing —
 * but if it fails, `/link` must say so rather than minting a code that can never be redeemed
 * because nothing is listening. */
let serverRunning = false;
export function warbandeerServerRunning(): boolean {
  return serverRunning;
}

export interface RateLimiter {
  /** True if `key` is still under its limit for this call (and records the call); false if it
   * should be rejected. */
  allow(key: string): boolean;
}

/**
 * A simple fixed-window counter per key — good enough for this connector's scale (a handful of
 * guild members' own desktop apps, not a public API). Not persisted: a restart resets every
 * counter, which is fine, since the threat this defends is a hot loop within one process's
 * uptime, not a long-lived quota.
 *
 * Opportunistically sweeps expired entries once the map grows past `PRUNE_THRESHOLD`, so a
 * long-running process fed a stream of distinct keys (one per rotating IP, one per attacker-
 * chosen token) doesn't grow this map forever between restarts.
 */
const PRUNE_THRESHOLD = 10_000;

export function createRateLimiter(opts: { windowMs: number; max: number; now?: () => number }): RateLimiter {
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    allow(key: string): boolean {
      const t = now();
      if (windows.size > PRUNE_THRESHOLD) {
        for (const [k, w] of windows) {
          if (t >= w.resetAt) windows.delete(k);
        }
      }
      const w = windows.get(key);
      if (!w || t >= w.resetAt) {
        windows.set(key, { count: 1, resetAt: t + opts.windowMs });
        return true;
      }
      if (w.count >= opts.max) return false;
      w.count += 1;
      return true;
    },
  };
}

export type LinkResult = { ok: true; token: string } | { ok: false; error: string };
export type StoreCharactersResult = { ok: true } | { ok: false; error: string };

export interface WarbandeerDeps {
  /** Redeems a Link Code for `accountLabel`, minting and persisting a Device Token, or reports
   * why redemption failed. Owns its own persistence — the HTTP layer above doesn't touch `links`
   * directly. */
  redeemCode: (code: string, accountLabel: string) => Promise<LinkResult>;
  /** Resolves a bearer token to its owner, or `undefined` if it matches no Linked Account. */
  authenticate: (token: string) => { discordUserId: string; accountLabel: string } | undefined;
  /** Validates and persists a character payload for an already-authenticated owner. */
  storeCharacters: (discordUserId: string, accountLabel: string, raw: unknown) => Promise<StoreCharactersResult>;
  /** Per-token (`POST /characters`, post-auth) and per-IP (`POST /link`) — the tight limit that
   * actually bounds one identified pusher. */
  rateLimiter: RateLimiter;
  /** A separate, deliberately much higher-ceiling limiter for `POST /characters` requests that
   * fail to authenticate, keyed by IP — bounds the cost of a flood of garbage bearer tokens
   * (a hash + a full account scan each) from one address without colliding with several
   * legitimate users who happen to share that address (NAT, a household, the tunnel egress
   * itself if `CF-Connecting-IP` is ever absent) — see `startWarbandeerServer`'s doc comment. */
  authFailureLimiter: RateLimiter;
  /** Enforced before the body is ever parsed. */
  maxBodyBytes: number;
}

const DEFAULT_MAX_BODY_BYTES = 512 * 1024;

function extractBearerToken(authHeader: string | null): string | undefined {
  const m = authHeader?.match(/^Bearer (.+)$/);
  return m?.[1];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Rejects an over-limit body before it's ever fully buffered: `Content-Length` is checked first
 * (so a declared-oversized request never reads a single byte), then the body is streamed and the
 * running total checked after every chunk, aborting the read the moment it crosses the cap — a
 * missing or lying `Content-Length` (the common case: `Request` doesn't set one for a body given
 * as a string/stream) must not let the whole body buffer into memory before the check runs.
 */
async function readBodyWithCap(req: Request, maxBytes: number): Promise<string | undefined> {
  const declared = req.headers.get("Content-Length");
  if (declared && Number(declared) > maxBytes) return undefined;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonObjectBody(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The whole request lifecycle, DI'd. `clientIp` is resolved by the caller (Cloudflare Tunnel
 * forwards the real visitor IP in `CF-Connecting-IP`; `startWarbandeerServer` falls back to the
 * raw connection IP when that header is absent) rather than here, so the rate-limit logic tests
 * against a fixed IP string with no real socket involved.
 */
export async function handleRequest(req: Request, clientIp: string, deps: WarbandeerDeps): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/link") {
    if (!deps.rateLimiter.allow(`link:${clientIp}`)) {
      return new Response("too many requests", { status: 429 });
    }
    const body = await readBodyWithCap(req, deps.maxBodyBytes);
    if (body === undefined) return new Response("payload too large", { status: 413 });
    const parsed = parseJsonObjectBody(body);
    // Trimmed/uppercased so a code copy-pasted with stray whitespace, or typed lowercase,
    // still matches — generateLinkCode() always mints uppercase hex.
    const code = typeof parsed?.code === "string" ? parsed.code.trim().toUpperCase() : undefined;
    const rawAccountLabel = typeof parsed?.accountLabel === "string" ? parsed.accountLabel : undefined;
    if (!code || !rawAccountLabel) {
      return new Response("code and accountLabel are required", { status: 400 });
    }
    const labelResult = validateAccountLabel(rawAccountLabel);
    if (!labelResult.ok) return new Response(labelResult.error, { status: 400 });
    const result = await deps.redeemCode(code, labelResult.accountLabel);
    if (!result.ok) return new Response(result.error, { status: 400 });
    return jsonResponse({ token: result.token });
  }

  if (req.method === "POST" && url.pathname === "/characters") {
    // Rate-limited by IP BEFORE authentication, on a separate and much more generous limiter
    // than the per-token one below: bounds the cost of a flood of garbage bearer tokens (a hash
    // + a full accounts scan each) without punishing several legitimate users who happen to
    // share an address.
    if (!deps.authFailureLimiter.allow(`characters-ip:${clientIp}`)) {
      return new Response("too many requests", { status: 429 });
    }
    const token = extractBearerToken(req.headers.get("Authorization"));
    if (!token) return new Response("unauthorized", { status: 401 });
    const owner = deps.authenticate(token);
    if (!owner) return new Response("unauthorized", { status: 401 });
    // Rate-limited per token too — an authenticated pusher is identified by its token
    // regardless of which address it pushes from.
    if (!deps.rateLimiter.allow(`push:${token}`)) {
      return new Response("too many requests", { status: 429 });
    }
    const body = await readBodyWithCap(req, deps.maxBodyBytes);
    if (body === undefined) return new Response("payload too large", { status: 413 });
    const parsed = parseJsonObjectBody(body);
    if (parsed === undefined) return new Response("invalid JSON", { status: 400 });
    const result = await deps.storeCharacters(owner.discordUserId, owner.accountLabel, parsed);
    if (!result.ok) return new Response(result.error, { status: 400 });
    return new Response(null, { status: 204 });
  }

  return new Response("not found", { status: 404 });
}

/**
 * The real, I/O-performing deps — everything logged here names the account/user involved, never
 * the token or `Authorization` header itself (ADR-0002's "the token must never reach a log
 * line"). Exported so `server.test.ts` can exercise the real auth + persistence wiring end to end
 * — this is exactly the seam where a concurrent-write data-loss bug and an unauthenticated
 * auth-wiring gap both hid behind an all-stubs test suite; see that file's "real wiring" suite.
 *
 * `overrides` lets a test supply a throwaway in-memory `linksState` + a no-op `persistLinks` and a
 * temp-dir `charactersBaseDir`, so exercising the real auth/persistence WIRING never touches the
 * real `data/links.json`/`data/characters/`. Production (`startWarbandeerServer`) always calls this
 * with no arguments.
 */
export function createProductionDeps(overrides?: {
  linksState?: LinksState;
  persistLinks?: () => Promise<void>;
  charactersBaseDir?: string;
}): WarbandeerDeps {
  const state = overrides?.linksState ?? links;
  const persistLinks = overrides?.persistLinks ?? saveLinks;
  const charactersBaseDir = overrides?.charactersBaseDir ?? charactersDir();
  return {
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    rateLimiter: createRateLimiter({ windowMs: 60_000, max: 30 }),
    // Deliberately ~10x the per-token limit above — see WarbandeerDeps's doc comment.
    authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 300 }),
    redeemCode: async (code, accountLabel) => {
      const now = Date.now();
      const redeemed = redeemLinkCode(state, code, now);
      state.pending = redeemed.state.pending;
      state.accounts = redeemed.state.accounts;
      if (!redeemed.ok) {
        await persistLinks();
        console.error(`[warbandeer] /link redeem failed (${redeemed.reason})`);
        return { ok: false, error: redeemed.reason === "expired" ? "code expired" : "unknown code" };
      }
      const existingCount = state.accounts[redeemed.discordUserId]?.length ?? 0;
      const alreadyLinked = state.accounts[redeemed.discordUserId]?.some((a) => a.accountLabel === accountLabel) ?? false;
      if (!alreadyLinked && existingCount >= MAX_LINKED_ACCOUNTS_PER_USER) {
        await persistLinks();
        return {
          ok: false,
          error: `you already have ${MAX_LINKED_ACCOUNTS_PER_USER} linked accounts — unlink one before adding another`,
        };
      }
      const token = generateDeviceToken();
      const next = upsertLinkedAccount(state, redeemed.discordUserId, accountLabel, hashToken(token), now);
      state.accounts = next.accounts;
      await persistLinks();
      console.log(`[warbandeer] linked accountLabel="${accountLabel}" for discord user ${redeemed.discordUserId}`);
      return { ok: true, token };
    },
    authenticate: (token) => {
      const match = findAccountByToken(state, token);
      return match ? { discordUserId: match.discordUserId, accountLabel: match.account.accountLabel } : undefined;
    },
    storeCharacters: async (discordUserId, accountLabel, raw) => {
      const validated = validateCharacterPayload(raw, accountLabel);
      if (!validated.ok) {
        console.error(`[warbandeer] rejected a push for discord user ${discordUserId}: ${validated.error}`);
        return validated;
      }
      await saveCharacterSnapshotTo(charactersBaseDir, discordUserId, validated.snapshot);
      const next = touchLinkedAccount(state, discordUserId, accountLabel, Date.now());
      state.accounts = next.accounts;
      await persistLinks();
      return { ok: true };
    },
  };
}

/**
 * Started from `createPlugin`'s `activate()` only when `WARBANDEER_INGEST_PORT` is set — absent
 * config means this is never called at all (ADR-0001's "fail closed when unconfigured"). Binds to
 * every interface inside the container (`Bun.serve` defaults to `0.0.0.0` — deliberate: `cloudflared`
 * reaches this bot as a separate container over the compose network, at `http://bot:<port>`, which a
 * loopback-only bind would refuse), but `docker-compose.yml` publishes no host port for it — the
 * only route in from outside the compose network is the opt-in `cloudflared` tunnel sidecar.
 *
 * `CF-Connecting-IP` is trusted unconditionally, with no check that the request actually came
 * through the tunnel. This is trustworthy for its INTENDED path: Cloudflare's edge sets this
 * header itself from the connection it actually observed, and a client cannot override what
 * Cloudflare writes for a request that genuinely transits Cloudflare's network. The gap is anything
 * that reaches this port WITHOUT going through Cloudflare: nothing else can today (no published host
 * port), but another container on the same compose network later could set this header to anything,
 * since nothing here re-verifies it. `deps` is optional so tests can start a real listener (real
 * `Bun.serve`, port 0 for an OS-assigned free port) against injected fake deps instead of the real
 * `links.json`/`data/characters/`.
 */
export function startWarbandeerServer(
  port: number,
  deps: WarbandeerDeps = createProductionDeps(),
): { stop: () => void; port: number } {
  const server = Bun.serve({
    port,
    // A backstop well ABOVE handleRequest's own readBodyWithCap (deps.maxBodyBytes) rather than
    // equal to it — Bun enforces this at the transport layer before `fetch` ever runs, so if the
    // two were the same threshold, Bun's own limit would win the race and reset the connection
    // (ECONNRESET) instead of letting readBodyWithCap's streamed check produce a clean 413.
    // Derived from deps.maxBodyBytes (NOT the DEFAULT_MAX_BODY_BYTES constant) so a caller that
    // overrides maxBodyBytes can't reintroduce exactly this gap by way of the two values silently
    // drifting apart; this exists purely to bound Bun's own buffering if the app-level check were
    // ever bypassed — the real, precise, test-covered enforcement is deps.maxBodyBytes itself.
    maxRequestBodySize: deps.maxBodyBytes * 4,
    idleTimeout: 30,
    fetch: (req, srv) => {
      const clientIp = req.headers.get("CF-Connecting-IP") ?? srv.requestIP(req)?.address ?? "unknown";
      return handleRequest(req, clientIp, deps);
    },
  });
  serverRunning = true;
  // server.port is `number | undefined` in Bun's types (undefined only applies to a unix-socket
  // server, which this never is) — falls back to the requested `port` so the type holds without an
  // assertion; when `port` was 0 (OS-assigned), server.port is always the real bound number.
  const boundPort = server.port ?? port;
  console.log(`[warbandeer] ingest server listening on :${boundPort}`);
  return {
    port: boundPort,
    stop: () => {
      serverRunning = false;
      server.stop();
    },
  };
}
