import { clip } from "./clip.js";
import { config } from "./config.js";

// Shared Blizzard API access: the client-credentials token, cached until just before it expires.
//
// Client credentials are enough for everything the bot reads — connected-realm status (Game Data)
// and character profiles (Profile API, public characters). Neither needs per-user OAuth or a
// Battle.net account link.

let token: { value: string; expiresAt: number } | undefined;

export function blizzardConfigured(): boolean {
  return Boolean(config.blizzardClientId && config.blizzardClientSecret);
}

/** Upper bound on one Blizzard request (headers and body). Without it a connection that is accepted but
 *  never answered hangs the caller indefinitely, and the host keeps that tick marked in flight (#158). */
const BLIZZARD_FETCH_TIMEOUT_MS = 10_000;

/** The host's tick signal (when there is one) combined with the per-request timeout. */
function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(BLIZZARD_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function blizzardToken(signal?: AbortSignal): Promise<string> {
  if (token && Date.now() < token.expiresAt) return token.value;
  const res = await fetch("https://oauth.battle.net/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${config.blizzardClientId}:${config.blizzardClientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: requestSignal(signal),
  });
  if (!res.ok) throw new Error(`Blizzard OAuth failed: ${res.status} ${clip(await res.text())}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  // Expire a minute early so a request can't set off mid-flight with a token about to lapse.
  token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return token.value;
}

/** Reset the cached token. Tests only — production has no reason to drop a valid token. */
export function _resetBlizzardToken(): void {
  token = undefined;
}

/** Authorized GET against any Blizzard endpoint. Response handling stays with each caller. */
export async function blizzardGet(url: string, signal?: AbortSignal): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${await blizzardToken(signal)}` }, signal: requestSignal(signal) });
}
