// The Spotify half: the authorization-code OAuth flow, and the three API calls that build a
// playlist. `authorizeUrl`, `toTrackCandidates` and `chunkUris` are pure and exported for the
// tests; everything that touches the network goes through an injected `fetch`.
//
// Scope note: `playlist-modify-private` and `playlist-modify-public` are the only scopes asked for.
// Creating a playlist and adding tracks needs nothing else, and a consent screen that asks for
// less is one a user is more likely to accept.
//
// Quota note: this app lives in Spotify's Development Mode, which since 2026-02-11 allows at most
// FIVE authorised users per client id and requires the app owner to have Premium. Extended Quota
// Mode -- the only way past that -- has been limited to registered businesses with 250k+ monthly
// active users since 2025-05-15, so the five-user ceiling is permanent for an instance like this
// one. `/spotify connect` surfaces Spotify's own "user not registered" error verbatim, because
// that is the wall an operator will hit and no wording of ours explains it better.

import type { TrackCandidate } from "./matching.js";

const REQUEST_TIMEOUT_MS = 10_000;
const ACCOUNTS_BASE = "https://accounts.spotify.com";
const API_BASE = "https://api.spotify.com/v1";

/** Spotify caps one add-items request at 100 URIs. */
export const MAX_URIS_PER_ADD = 100;

/** Since the Feb 2026 dev-mode changes, `limit` on /search may not exceed 10. */
const SEARCH_LIMIT = 10;

export const SPOTIFY_SCOPES = "playlist-modify-private playlist-modify-public";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------

/**
 * The URL to send a user to for consent. `state` is the single-use, expiring token this plugin
 * minted for one Discord user -- Spotify hands it back on the callback, and it is the ONLY thing
 * tying the browser that completes the flow to the Discord account that started it.
 *
 * `show_dialog=true` so a second user on a shared browser session is actually asked, instead of
 * silently re-authorising whoever is already signed in to Spotify.
 */
export function authorizeUrl(config: SpotifyConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: SPOTIFY_SCOPES,
    state,
    show_dialog: "true",
  });
  return `${ACCOUNTS_BASE}/authorize?${params.toString()}`;
}

interface RawTrack {
  uri?: unknown;
  name?: unknown;
  popularity?: unknown;
  artists?: unknown;
}

/**
 * Shapes `/search`'s track rows into the minimum `matching.ts` scores against, dropping any row
 * missing a URI or name. A local track (`spotify:local:...`) is dropped too: those cannot be added
 * to a playlist through the API and would fail the whole add-items call if one slipped in.
 */
export function toTrackCandidates(body: unknown): TrackCandidate[] {
  const items = (body as { tracks?: { items?: unknown } })?.tracks?.items;
  if (!Array.isArray(items)) return [];
  const candidates: TrackCandidate[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const track = item as RawTrack;
    const uri = typeof track.uri === "string" ? track.uri : undefined;
    const name = typeof track.name === "string" ? track.name : undefined;
    if (uri === undefined || name === undefined) continue;
    if (!uri.startsWith("spotify:track:")) continue;
    const artistNames = Array.isArray(track.artists)
      ? track.artists
          .map((a) => (typeof a === "object" && a !== null ? (a as { name?: unknown }).name : undefined))
          .filter((n): n is string => typeof n === "string")
      : [];
    candidates.push({
      uri,
      name,
      artistNames,
      popularity: typeof track.popularity === "number" ? track.popularity : 0,
    });
  }
  return candidates;
}

/** Splits URIs into add-items-sized batches. Exported so the 100-item boundary is tested directly. */
export function chunkUris(uris: readonly string[], size = MAX_URIS_PER_ADD): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < uris.length; i += size) chunks.push(uris.slice(i, i + size));
  return chunks;
}

// ---------------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------------

export interface SpotifyTokens {
  accessToken: string;
  /**
   * Present only when Spotify issued a NEW refresh token. Spotify rotates them at its discretion,
   * and a rotated token silently replaces the old one -- so the caller must persist this whenever
   * it is set, or the next refresh fails with `invalid_grant` and the user has to reconnect.
   */
  refreshToken?: string;
}

export interface PlaylistCreated {
  id: string;
  /** The open.spotify.com link, for the reply. */
  url: string;
}

export interface SpotifyClient {
  /** Trades the callback's `code` for the first token pair. */
  exchangeCode(code: string): Promise<Result<{ accessToken: string; refreshToken: string }>>;
  /** Trades a stored refresh token for a usable access token (and possibly a rotated refresh token). */
  refresh(refreshToken: string): Promise<Result<SpotifyTokens>>;
  searchTracks(accessToken: string, query: string): Promise<Result<TrackCandidate[]>>;
  createPlaylist(accessToken: string, name: string, description: string): Promise<Result<PlaylistCreated>>;
  /** Adds in 100-URI batches, in order; the first failed batch aborts and is reported. */
  addTracks(accessToken: string, playlistId: string, uris: readonly string[]): Promise<Result<number>>;
}

/**
 * Spotify's error bodies are `{ error: { message } }` on the API and `{ error, error_description }`
 * on the accounts host. Surfacing the real message matters more here than a tidy generic one --
 * "User not registered in the Developer Dashboard" is the dev-mode five-user ceiling, and an
 * operator who sees it knows exactly what to do.
 */
async function describeFailure(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await response.json()) as {
      error?: unknown;
      error_description?: unknown;
    };
    if (typeof body.error === "object" && body.error !== null) {
      const message = (body.error as { message?: unknown }).message;
      if (typeof message === "string") detail = message;
    } else if (typeof body.error_description === "string") detail = body.error_description;
    else if (typeof body.error === "string") detail = body.error;
  } catch {
    // A non-JSON error body (a proxy's HTML 502) leaves `detail` empty -- the status alone is then
    // the whole message, which is still actionable.
  }
  const status = `Spotify returned HTTP ${response.status}`;
  return detail === "" ? status : `${status}: ${detail}`;
}

export function createSpotifyClient(config: SpotifyConfig, fetchImpl: FetchLike = fetch): SpotifyClient {
  const basicAuth = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;

  async function call(url: string, init: RequestInit): Promise<Result<unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      return { ok: false, error: timedOut ? "Spotify took too long to answer" : "couldn't reach Spotify" };
    }
    if (!response.ok) return { ok: false, error: await describeFailure(response) };
    // 201/204 bodies: addTracks gets a snapshot object, but nothing reads it.
    if (response.status === 204) return { ok: true, value: undefined };
    try {
      return { ok: true, value: await response.json() };
    } catch {
      return { ok: true, value: undefined };
    }
  }

  async function tokenCall(body: URLSearchParams): Promise<Result<SpotifyTokens & { refreshToken?: string }>> {
    const result = await call(`${ACCOUNTS_BASE}/api/token`, {
      method: "POST",
      headers: { Authorization: basicAuth, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!result.ok) return result;
    const parsed = result.value as { access_token?: unknown; refresh_token?: unknown };
    if (typeof parsed?.access_token !== "string") {
      return { ok: false, error: "Spotify's token response had no access token" };
    }
    const tokens: SpotifyTokens = { accessToken: parsed.access_token };
    if (typeof parsed.refresh_token === "string") tokens.refreshToken = parsed.refresh_token;
    return { ok: true, value: tokens };
  }

  return {
    async exchangeCode(code) {
      const result = await tokenCall(
        new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri }),
      );
      if (!result.ok) return result;
      // The initial exchange always carries a refresh token; without one there is nothing to store
      // and the connection would silently expire in an hour, so treat its absence as a failure.
      if (result.value.refreshToken === undefined) {
        return { ok: false, error: "Spotify didn't return a refresh token" };
      }
      return { ok: true, value: { accessToken: result.value.accessToken, refreshToken: result.value.refreshToken } };
    },

    async refresh(refreshToken) {
      return tokenCall(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }));
    },

    async searchTracks(accessToken, query) {
      const params = new URLSearchParams({ q: query, type: "track", limit: String(SEARCH_LIMIT) });
      const result = await call(`${API_BASE}/search?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!result.ok) return result;
      return { ok: true, value: toTrackCandidates(result.value) };
    },

    async createPlaylist(accessToken, name, description) {
      const result = await call(`${API_BASE}/me/playlists`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        // Private by default: a playlist auto-created from a Discord command should not appear on
        // the user's public profile unless they choose to make it so.
        body: JSON.stringify({ name, description, public: false }),
      });
      if (!result.ok) return result;
      const created = result.value as { id?: unknown; external_urls?: { spotify?: unknown } };
      if (typeof created?.id !== "string") return { ok: false, error: "Spotify didn't return a playlist id" };
      const url =
        typeof created.external_urls?.spotify === "string"
          ? created.external_urls.spotify
          : `https://open.spotify.com/playlist/${created.id}`;
      return { ok: true, value: { id: created.id, url } };
    },

    async addTracks(accessToken, playlistId, uris) {
      let added = 0;
      for (const chunk of chunkUris(uris)) {
        const result = await call(`${API_BASE}/playlists/${encodeURIComponent(playlistId)}/items`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ uris: chunk }),
        });
        // A partial failure leaves the playlist half-filled on purpose: the tracks that DID land are
        // still useful, and the reply names how many made it rather than pretending nothing happened.
        if (!result.ok) return { ok: false, error: `${result.error} (after adding ${added} of ${uris.length})` };
        added += chunk.length;
      }
      return { ok: true, value: added };
    },
  };
}
