// The Spotify half: the authorization-code OAuth flow, the calls that build a playlist, and the
// player calls the listening party drives. `authorizeUrl`, `toTrackCandidates`, `chunkUris`,
// `hasScopes`, `classifyPlayerError` and `isDeadGrant` are pure and exported for the tests;
// everything that touches the network goes through an injected `fetch`.
//
// Scope note: scopes are requested INCREMENTALLY, a feature at a time -- see SPOTIFY_SCOPES and
// PARTY_SCOPES below. A consent screen that asks for less is one a user is more likely to accept.
//
// Quota note: this app lives in Spotify's Development Mode, which since 2026-02-11 allows at most
// FIVE authorised users per client id and requires the app owner to have Premium. Extended Quota
// Mode -- the only way past that -- has been limited to registered businesses with 250k+ monthly
// active users since 2025-05-15, so the five-user ceiling is permanent for an instance like this
// one. `/spotify connect` surfaces Spotify's own "user not registered" error verbatim, because
// that is the wall an operator will hit and no wording of ours explains it better.

import type { TrackCandidate } from "./matching.js";
import { defaultSleep, isRetryable, MAX_RETRIES, parseRetryAfter, retryDelay, type SleepLike } from "./retry.js";

const REQUEST_TIMEOUT_MS = 10_000;
const ACCOUNTS_BASE = "https://accounts.spotify.com";
const API_BASE = "https://api.spotify.com/v1";

/** Spotify caps one add-items request at 100 URIs. */
export const MAX_URIS_PER_ADD = 100;

/** Since the Feb 2026 dev-mode changes, `limit` on /search may not exceed 10. */
const SEARCH_LIMIT = 10;

/**
 * What `/spotify connect` asks for: exactly what building a playlist needs, and nothing else.
 *
 * Scopes are requested INCREMENTALLY rather than all up front (issue: the listening party). Asking
 * every connecting user for playback control would put a permission they may never use in front of
 * them, and with a five-user ceiling the cost of asking the handful who do want it to reconnect
 * once is trivial. The price is that a connection made before a feature shipped lacks that
 * feature's scopes, which is why `Connection.scopes` records what was actually granted and
 * `hasScopes` is checked before a call, turning a missing scope into a one-click reconnect prompt
 * instead of a raw 403.
 */
export const SPOTIFY_SCOPES = "playlist-modify-private playlist-modify-public";

/** What `/party` needs on top of the playlist scopes: read where someone is, and drive their player. */
export const PARTY_SCOPES = `${SPOTIFY_SCOPES} user-read-playback-state user-modify-playback-state`;

/**
 * Whether a granted scope string covers every scope in `required`. Spotify returns the granted set
 * space-separated and in its own order, so this compares as sets. An `undefined` grant is a
 * connection made before scopes were recorded: playlist-only, by construction, since those were the
 * only scopes ever requested then.
 */
export function hasScopes(granted: string | undefined, required: string): boolean {
  const have = new Set((granted ?? SPOTIFY_SCOPES).split(/\s+/).filter((s) => s !== ""));
  return required.split(/\s+/).every((scope) => scope === "" || have.has(scope));
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * `status` is the HTTP status when the failure came from Spotify rather than from the network, so
 * a caller can tell a missing scope (403) from an idle device (404) without re-parsing prose. It is
 * absent on a timeout or a connection failure, which is itself the signal that nothing was reached.
 * `code` is Spotify's own machine-readable error code when the body carried one as a string -- the
 * accounts host's `invalid_grant` / `invalid_client`; the API host's object-shaped bodies carry
 * none -- so a caller classifying a token failure never has to read its prose (`error` prefers the
 * human `error_description`, which is free to change).
 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string; status?: number; code?: string };

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
export function authorizeUrl(config: SpotifyConfig, state: string, scopes: string = SPOTIFY_SCOPES): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: scopes,
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
  duration_ms?: unknown;
}

/**
 * Shapes `/search`'s track rows into the minimum `TrackCandidate` shape `matching.ts` needs,
 * dropping any row missing a URI or name. A local track (`spotify:local:...`) is dropped too:
 * those cannot be added to a playlist through the API and would fail the whole add-items call if
 * one slipped in.
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
    const candidate: TrackCandidate = {
      uri,
      name,
      artistNames,
      popularity: typeof track.popularity === "number" ? track.popularity : 0,
    };
    // Only when Spotify actually sent a usable number: a party that armed its next-track timer on
    // a zero or a NaN would advance instantly and skip the whole queue in a burst.
    if (typeof track.duration_ms === "number" && Number.isFinite(track.duration_ms) && track.duration_ms > 0) {
      candidate.durationMs = track.duration_ms;
    }
    candidates.push(candidate);
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
   * The space-separated scope set Spotify says this token actually carries. Present on both the
   * code exchange and a refresh, and stored on the connection so a feature can check for its scope
   * BEFORE making a call that would 403.
   */
  scopes?: string;
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

/** One of the caller's Spotify players, as `/me/player/devices` reports it. */
export interface SpotifyDevice {
  id: string;
  name: string;
  isActive: boolean;
}

/** What `/me/player` says is happening right now. `undefined` track = nothing is playing. */
export interface PlaybackState {
  isPlaying: boolean;
  progressMs: number;
  trackUri?: string;
  durationMs?: number;
  deviceId?: string;
}

export interface SpotifyClient {
  /** Trades the callback's `code` for the first token pair. */
  exchangeCode(code: string): Promise<Result<{ accessToken: string; refreshToken: string; scopes?: string }>>;
  /** Trades a stored refresh token for a usable access token (and possibly a rotated refresh token). */
  refresh(refreshToken: string): Promise<Result<SpotifyTokens>>;
  // The three calls a `/setlist` build makes (`searchTracks` is also what `/party add` calls). They
  // retry a bounded number of times (#192): `searchTracks` on a rate limit or a server error, the
  // two POSTs (`createPlaylist`, `addTracks`) on a rate limit only, since repeating a POST that a
  // server error followed could duplicate it. Each takes an optional trailing `signal`: once it
  // fires it cancels the request and ends the retries before the next wait.
  searchTracks(accessToken: string, query: string, signal?: AbortSignal): Promise<Result<TrackCandidate[]>>;
  createPlaylist(
    accessToken: string,
    name: string,
    description: string,
    signal?: AbortSignal,
  ): Promise<Result<PlaylistCreated>>;
  /** Adds in 100-URI batches, in order; the first failed batch aborts and is reported. */
  addTracks(
    accessToken: string,
    playlistId: string,
    uris: readonly string[],
    signal?: AbortSignal,
  ): Promise<Result<number>>;

  // The player half -- everything below needs PARTY_SCOPES and a Premium account, and each one can
  // fail with "no active device", which is the ordinary state of a Spotify account nobody is
  // currently using. `classifyPlayerError` turns those failures into something sayable.
  //
  // Each takes an optional trailing `signal`: the host's tick signal, which the party sweep passes
  // so its calls are cancelled with it (#147). A call aborted that way fails like any other that
  // could not reach Spotify; the 10-second bound applies either way.

  /** Starts ONE track at a position. `deviceId` omitted = whatever device is currently active. */
  play(
    accessToken: string,
    uri: string,
    positionMs: number,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<Result<undefined>>;
  /** Current playback, or `undefined` when Spotify answers 204 (nothing playing anywhere). */
  playbackState(accessToken: string, signal?: AbortSignal): Promise<Result<PlaybackState | undefined>>;
  devices(accessToken: string, signal?: AbortSignal): Promise<Result<SpotifyDevice[]>>;
  /** Makes a device the active one, so a `play` with no `deviceId` lands there. */
  transfer(accessToken: string, deviceId: string, signal?: AbortSignal): Promise<Result<undefined>>;
}

export type PlayerProblem = "scope" | "premium" | "no-device" | "other";

/**
 * Classifies a failed player call. Spotify is consistent about the statuses but not about the
 * prose, so the status decides wherever it can and the message is only consulted to tell the two
 * 403s apart -- a missing scope (the user must reconnect) from a free account (nothing to be done).
 *
 * 404 on a player endpoint means "no active device", not "no such endpoint": Spotify returns it
 * when the account has no player awake to receive the command, which is the single most common
 * failure in practice and the one with a real remedy the user can act on.
 */
export function classifyPlayerError(status: number | undefined, message: string): PlayerProblem {
  // Underscores collapse to spaces so Spotify's machine-readable reason (`NO_ACTIVE_DEVICE`) and
  // its human message ("Player command failed: No active device found") match the same check --
  // which of the two reaches us depends on which shape the error body took.
  const text = message.toLowerCase().replace(/_/g, " ");
  if (status === 403) return text.includes("premium") ? "premium" : "scope";
  if (status === 404 || text.includes("no active device")) return "no-device";
  return "other";
}

/**
 * Whether a failed token call means the GRANT is dead -- the refresh token invalid, expired or
 * revoked -- as opposed to Spotify being unreachable, slow, rate-limiting or erroring, or the app's
 * own credentials being refused. OAuth 2.0 (RFC 6749 section 5.2) calls a dead grant
 * `invalid_grant` and gives it HTTP 400, and BOTH halves must hold here: a different status or a
 * different code is not one. `invalid_client` is the operator's client id or secret, which
 * reconnecting cannot fix; the RFC wants it as a 401 when the client authenticates by header, as
 * this one does, but whichever status Spotify actually uses its code is not `invalid_grant`, so it
 * is kept either way. A 400 whose body carried no readable code is not treated as dead either:
 * dropping a stored token on ambiguity is the failure #133 is about. The price of that strictness
 * is a dead grant arriving in some other shape being kept and failing on every call -- the reply
 * on that path says to reconnect if it keeps failing, and a connect overwrites the stored token.
 */
export function isDeadGrant(failure: { status?: number; code?: string }): boolean {
  return failure.status === 400 && failure.code === "invalid_grant";
}

/**
 * Spotify's error bodies are `{ error: { message } }` on the API and `{ error, error_description }`
 * on the accounts host. Surfacing the real message matters more here than a tidy generic one --
 * "User not registered in the Developer Dashboard" is the dev-mode five-user ceiling, and an
 * operator who sees it knows exactly what to do. The accounts host's `error` string is the
 * machine-readable code and comes back separately as `code`, so `isDeadGrant` reads that and not
 * the prose.
 */
async function describeFailure(response: Response): Promise<{ error: string; code?: string }> {
  let detail = "";
  let code: string | undefined;
  try {
    const body = (await response.json()) as {
      error?: unknown;
      error_description?: unknown;
    };
    if (typeof body.error === "object" && body.error !== null) {
      const message = (body.error as { message?: unknown }).message;
      if (typeof message === "string") detail = message;
    } else if (typeof body.error === "string") {
      code = body.error;
      detail = typeof body.error_description === "string" ? body.error_description : body.error;
    } else if (typeof body.error_description === "string") detail = body.error_description;
  } catch {
    // A non-JSON error body (a proxy's HTML 502) leaves `detail` empty -- the status alone is then
    // the whole message, which is still actionable.
  }
  const status = `Spotify returned HTTP ${response.status}`;
  const error = detail === "" ? status : `${status}: ${detail}`;
  return code === undefined ? { error } : { error, code };
}

export function createSpotifyClient(
  config: SpotifyConfig,
  fetchImpl: FetchLike = fetch,
  sleepImpl: SleepLike = defaultSleep,
): SpotifyClient {
  const basicAuth = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;

  /**
   * One request, or with `opts.retry` a bounded run of them. Only the three BUILD calls retry
   * (`searchTracks`, `createPlaylist`, `addTracks`): a `/setlist` runs from ~50 searches (more for a
   * set of covers) against a quota pooled across every dev-mode app the developer owns, so a 429
   * mid-build would otherwise
   * throw away every song matched so far. The token calls and the four player calls do not: the
   * runner's sweep and a party's plays run under the host's bounds and must stay one request long,
   * and the token refresh is the single flight shared with every command.
   *
   * The two retry policies differ on purpose. A search is a read, safe to repeat on any retryable
   * status ("any": a 429 or a 5xx). `createPlaylist` and `addTracks` are POSTs, which are NOT
   * idempotent: a 5xx can follow a request Spotify DID apply, and repeating it would make a second
   * playlist, or add a batch of tracks twice (Spotify allows duplicates). A 429 is a rate limit,
   * which a client is expected to back off from and retry (RFC 6585; Spotify's guidance), so those
   * retry on a 429 alone ("rate-limit"), on the assumption that a rate-limited request was not
   * processed. Any other failure is reported as it is; for a failed `addTracks` the reply then
   * points at the playlist that was made (#192), while a `createPlaylist` that Spotify applied but
   * answered with a 5xx or a timeout leaves a playlist nothing can point at.
   *
   * A retry waits as `setlistfm.ts` does (`retry.ts`): a `Retry-After` wins, one past the cap ends
   * the retries, and a transport failure (a timeout, DNS) is never retried. A `signal` that has
   * already fired ends them before the next wait; one that fires DURING a wait (up to the cap) does
   * not cut it short, and the next attempt then fails at once on the combined signal.
   */
  async function call(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
    opts: { retry?: "any" | "rate-limit" } = {},
  ): Promise<Result<unknown>> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        // The client's own bound always applies; a caller's signal (the host's tick signal) is added
        // to it, so the request ends at whichever comes first.
        const bounded = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        response = await fetchImpl(url, {
          ...init,
          signal: signal === undefined ? bounded : AbortSignal.any([bounded, signal]),
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        return { ok: false, error: timedOut ? "Spotify took too long to answer" : "couldn't reach Spotify" };
      }
      if (!response.ok) {
        const failure = { ok: false as const, ...(await describeFailure(response)), status: response.status };
        const retryable =
          opts.retry === "any"
            ? isRetryable(response.status)
            : opts.retry === "rate-limit" && response.status === 429;
        if (!retryable || attempt === MAX_RETRIES) return failure;
        const delay = retryDelay(attempt, parseRetryAfter(response.headers.get("Retry-After"), Date.now()));
        if (delay === undefined || signal?.aborted === true) return failure;
        await sleepImpl(delay);
        continue;
      }
      // 201/204 bodies: addTracks gets a snapshot object, but nothing reads it.
      if (response.status === 204) return { ok: true, value: undefined };
      try {
        return { ok: true, value: await response.json() };
      } catch {
        return { ok: true, value: undefined };
      }
    }
  }

  async function tokenCall(body: URLSearchParams): Promise<Result<SpotifyTokens & { refreshToken?: string }>> {
    const result = await call(`${ACCOUNTS_BASE}/api/token`, {
      method: "POST",
      headers: { Authorization: basicAuth, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!result.ok) return result;
    const parsed = result.value as { access_token?: unknown; refresh_token?: unknown; scope?: unknown };
    if (typeof parsed?.access_token !== "string") {
      return { ok: false, error: "Spotify's token response had no access token" };
    }
    const tokens: SpotifyTokens = { accessToken: parsed.access_token };
    if (typeof parsed.refresh_token === "string") tokens.refreshToken = parsed.refresh_token;
    // Spotify reports the granted set on both the exchange and every refresh, so a grant the user
    // narrowed in their Spotify settings shows up here rather than as a 403 mid-party.
    if (typeof parsed.scope === "string") tokens.scopes = parsed.scope;
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
      const value: { accessToken: string; refreshToken: string; scopes?: string } = {
        accessToken: result.value.accessToken,
        refreshToken: result.value.refreshToken,
      };
      if (result.value.scopes !== undefined) value.scopes = result.value.scopes;
      return { ok: true, value };
    },

    async refresh(refreshToken) {
      return tokenCall(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }));
    },

    async searchTracks(accessToken, query, signal) {
      const params = new URLSearchParams({ q: query, type: "track", limit: String(SEARCH_LIMIT) });
      const result = await call(
        `${API_BASE}/search?${params.toString()}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        signal,
        { retry: "any" },
      );
      if (!result.ok) return result;
      return { ok: true, value: toTrackCandidates(result.value) };
    },

    async createPlaylist(accessToken, name, description, signal) {
      const result = await call(
        `${API_BASE}/me/playlists`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          // Private by default: a playlist auto-created from a Discord command should not appear on
          // the user's public profile unless they choose to make it so.
          body: JSON.stringify({ name, description, public: false }),
        },
        signal,
        { retry: "rate-limit" },
      );
      if (!result.ok) return result;
      const created = result.value as { id?: unknown; external_urls?: { spotify?: unknown } };
      if (typeof created?.id !== "string") return { ok: false, error: "Spotify didn't return a playlist id" };
      const url =
        typeof created.external_urls?.spotify === "string"
          ? created.external_urls.spotify
          : `https://open.spotify.com/playlist/${created.id}`;
      return { ok: true, value: { id: created.id, url } };
    },

    async addTracks(accessToken, playlistId, uris, signal) {
      let added = 0;
      for (const chunk of chunkUris(uris)) {
        const result = await call(
          `${API_BASE}/playlists/${encodeURIComponent(playlistId)}/items`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ uris: chunk }),
          },
          signal,
          { retry: "rate-limit" },
        );
        // A partial failure leaves the playlist half-filled on purpose: the tracks that DID land are
        // still useful, and the reply names how many made it rather than pretending nothing happened.
        if (!result.ok) return { ok: false, error: `${result.error} (after adding ${added} of ${uris.length})` };
        added += chunk.length;
      }
      return { ok: true, value: added };
    },

    async play(accessToken, uri, positionMs, deviceId, signal) {
      const query = deviceId === undefined ? "" : `?device_id=${encodeURIComponent(deviceId)}`;
      const result = await call(
        `${API_BASE}/me/player/play${query}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          // One explicit URI rather than a context: the bot is the sequencer, so every member is told
          // exactly which track to be on. Handing Spotify a playlist context would let each member's
          // own shuffle or repeat setting decide what comes next, and they would drift apart.
          body: JSON.stringify({ uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) }),
        },
        signal,
      );
      if (!result.ok) return result;
      return { ok: true, value: undefined };
    },

    async playbackState(accessToken, signal) {
      const result = await call(
        `${API_BASE}/me/player`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        signal,
      );
      if (!result.ok) return result;
      // 204 (nothing playing) comes back from `call` as an undefined value, and is a normal answer
      // here rather than a failure -- it is what the party sees when a member has closed Spotify.
      if (result.value === undefined) return { ok: true, value: undefined };
      const body = result.value as {
        is_playing?: unknown;
        progress_ms?: unknown;
        item?: { uri?: unknown; duration_ms?: unknown };
        device?: { id?: unknown };
      };
      const state: PlaybackState = {
        isPlaying: body.is_playing === true,
        progressMs: typeof body.progress_ms === "number" ? body.progress_ms : 0,
      };
      if (typeof body.item?.uri === "string") state.trackUri = body.item.uri;
      if (typeof body.item?.duration_ms === "number") state.durationMs = body.item.duration_ms;
      if (typeof body.device?.id === "string") state.deviceId = body.device.id;
      return { ok: true, value: state };
    },

    async devices(accessToken, signal) {
      const result = await call(
        `${API_BASE}/me/player/devices`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        signal,
      );
      if (!result.ok) return result;
      const raw = (result.value as { devices?: unknown })?.devices;
      if (!Array.isArray(raw)) return { ok: true, value: [] };
      const devices: SpotifyDevice[] = [];
      for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) continue;
        const device = entry as { id?: unknown; name?: unknown; is_active?: unknown };
        // A device with a null id cannot be targeted (Spotify reports restricted ones that way),
        // so it is dropped rather than offered as somewhere playback could be sent.
        if (typeof device.id !== "string") continue;
        devices.push({
          id: device.id,
          name: typeof device.name === "string" ? device.name : "Unnamed device",
          isActive: device.is_active === true,
        });
      }
      return { ok: true, value: devices };
    },

    async transfer(accessToken, deviceId, signal) {
      const result = await call(
        `${API_BASE}/me/player`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          // `play: false` -- transferring must not start whatever was paused on that device; the
          // party decides what plays, and it does that with its own `play` call a moment later.
          body: JSON.stringify({ device_ids: [deviceId], play: false }),
        },
        signal,
      );
      if (!result.ok) return result;
      return { ok: true, value: undefined };
    },
  };
}
