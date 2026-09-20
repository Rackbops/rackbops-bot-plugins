// The OAuth callback surface. Same shape as warbandeer's ingest server (bot ADR-0001): a pure,
// fully-DI'd `handleCallback` that `server.test.ts` drives with hand-built `Request` objects, and
// one thin `startCallbackServer` that is the only thing touching `Bun.serve`.
//
// This binds a port inside the container and `docker-compose.yml` publishes none, so the only route
// in from outside the compose network is the opt-in `cloudflared` sidecar -- which is also what
// makes SPOTIFY_REDIRECT_URI an HTTPS URL Spotify will accept as a registered redirect.

import type { Result } from "./spotify.js";

/** A fixed-window limiter, per warbandeer's: enough to bound a hot loop within one process uptime. */
export interface RateLimiter {
  allow(key: string): boolean;
}

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

export interface CallbackDeps {
  /** The path component of SPOTIFY_REDIRECT_URI -- the only path this server answers on. */
  callbackPath: string;
  /** Consumes the `state` token, yielding the Discord user who started the handshake. */
  redeemState(
    stateToken: string,
  ): Promise<{ ok: true; discordUserId: string; scopes?: string } | { ok: false; error: string }>;
  exchangeCode(code: string): Promise<Result<{ accessToken: string; refreshToken: string; scopes?: string }>>;
  /** Persists the connection. Never logs or echoes the refresh token. `scopes` is what Spotify says
   *  the grant carries, so a later feature can check for its own scope before it calls. */
  saveConnection(discordUserId: string, refreshToken: string, scopes?: string): Promise<void>;
  rateLimiter: RateLimiter;
}

/** Escapes text before it goes into the HTML response -- `error` comes straight off the query
 *  string, so reflecting it raw would be a stored-nothing but very real XSS. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(title)}</title>` +
      `<style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;` +
      `align-items:center;justify-content:center;background:#121212;color:#f5f5f5;padding:24px}` +
      `main{max-width:32rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}` +
      `p{margin:0;color:#b3b3b3;line-height:1.5}</style></head>` +
      `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/**
 * The whole callback lifecycle. Returns an HTML page in every case -- a human's browser lands here,
 * not a program, so a bare 400 with a one-word body would leave someone staring at a blank tab with
 * no idea whether their account connected.
 */
export async function handleCallback(req: Request, clientIp: string, deps: CallbackDeps): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "GET" || url.pathname !== deps.callbackPath) {
    return page("Not found", "Nothing here.", 404);
  }
  if (!deps.rateLimiter.allow(`callback:${clientIp}`)) {
    return page("Slow down", "Too many attempts from this address. Try again in a minute.", 429);
  }

  const stateToken = url.searchParams.get("state");
  // Spotify sends `error=access_denied` when the user clicks Cancel on the consent screen. That is
  // a normal outcome, not a failure worth alarming anyone about -- but the pending handshake still
  // has to be consumed, so the abandoned link cannot be completed later.
  const oauthError = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (stateToken === null) {
    return page("Something went wrong", "That link is missing its state token. Run /spotify connect again.", 400);
  }

  const redeemed = await deps.redeemState(stateToken);
  if (!redeemed.ok) return page("That link didn't work", redeemed.error, 400);

  if (oauthError !== null) {
    return page(
      "Not connected",
      oauthError === "access_denied"
        ? "You declined the Spotify permission request. Nothing was connected."
        : `Spotify reported: ${oauthError}`,
      200,
    );
  }
  if (code === null) {
    return page("Something went wrong", "Spotify didn't send an authorization code. Run /spotify connect again.", 400);
  }

  const exchanged = await deps.exchangeCode(code);
  if (!exchanged.ok) return page("Couldn't finish connecting", exchanged.error, 502);

  // Spotify's own answer wins; the scopes the handshake ASKED for are the fallback, for the case
  // where a token response omits `scope` -- recording nothing there would leave a genuinely
  // party-capable connection looking playlist-only until the user reconnected for no reason.
  await deps.saveConnection(
    redeemed.discordUserId,
    exchanged.value.refreshToken,
    exchanged.value.scopes ?? redeemed.scopes,
  );
  return page("Spotify connected", "You can close this tab and go back to Discord.", 200);
}

/**
 * Started from `activate()` only when MUSIC_CALLBACK_PORT is set -- absent config means no server
 * at all, matching warbandeer's fail-closed rule. `CF-Connecting-IP` is trusted for the same reason
 * and with the same caveat as warbandeer's: Cloudflare's edge sets it for anything that genuinely
 * transits its network, and nothing else can reach this port today, but a future container on the
 * same compose network could set it to anything since nothing here re-verifies the path.
 */
export function startCallbackServer(
  port: number,
  deps: CallbackDeps,
): { stop: () => void; port: number } {
  const server = Bun.serve({
    port,
    // The callback is a bare GET with query parameters; nothing legitimate carries a body.
    maxRequestBodySize: 8 * 1024,
    idleTimeout: 30,
    fetch: (req, srv) => {
      const clientIp = req.headers.get("CF-Connecting-IP") ?? srv.requestIP(req)?.address ?? "unknown";
      return handleCallback(req, clientIp, deps);
    },
  });
  const boundPort = server.port ?? port;
  console.log(`[music] Spotify callback server listening on :${boundPort}${deps.callbackPath}`);
  return { port: boundPort, stop: () => server.stop() };
}
