// Turning a stored refresh token into a usable access token, in one place because both the command
// layer and the party runner need it and they must agree about what a dead connection means.

import { commit, putConnection, removeConnection, musicState } from "./store.js";
import { isDeadGrant, type SpotifyClient } from "./spotify.js";

/**
 * Why no token could be had. `revoked` is the only kind that changed stored state (the dead
 * connection is gone); `unavailable` left the connection exactly as it was, so the next call may
 * well succeed; `not-connected` never had one, or had it removed by `/spotify disconnect` while the
 * refresh was out.
 */
export type TokenFailureKind = "not-connected" | "revoked" | "unavailable";

export type TokenResult =
  | { ok: true; accessToken: string; scopes?: string }
  | { ok: false; error: string; kind: TokenFailureKind };

// One refresh in flight per Discord user, process-wide. The party runner refreshes a member at every
// track start and in every sweep, and a command can land during either; a second refresh for the
// same user while one is out would race it (#146), so it joins the one in flight instead and gets
// the same answer. Keyed by user id alone -- there is one Spotify client -- and an entry lives
// exactly as long as its refresh.
const inFlight = new Map<string, Promise<TokenResult>>();

/**
 * Trades the caller's stored refresh token for a usable access token, persisting a rotated refresh
 * token when Spotify issues one.
 *
 * A refresh fails for two unrelated reasons, and only one of them is about the stored token. When
 * Spotify says the grant itself is dead (HTTP 400 `invalid_grant`: the refresh token is invalid,
 * expired or revoked), the connection is DROPPED here -- leaving it in place would make every later
 * command fail the same way with no hint that reconnecting is the fix. When Spotify could not be
 * reached, was slow, rate-limited (429) or erroring (5xx), or refused the app's own credentials
 * (`invalid_client`), the stored token is as good as it ever was and is KEPT: the party sweep
 * refreshes every member's token once a minute and every track start refreshes it again, so
 * dropping it on a blip would silently disconnect a whole party and send everyone back through
 * consent (#133). `isDeadGrant` decides, from Spotify's error code rather than its prose, and it
 * errs towards keeping: a dead grant that arrives in any other shape is kept and fails again on the
 * next call, so the kept-path reply also says to reconnect if it keeps failing -- `/spotify connect`
 * overwrites the stored token, which is the way out.
 *
 * The refresh takes up to ten seconds, and the stored connection can move while it is out:
 * `/spotify disconnect` removes it, a `/spotify connect` callback replaces it, and another refresh
 * for the same user would rotate it. The last cannot happen (one refresh in flight per user, above);
 * the first two are handled by re-reading the connection AFTER the await and writing only when its
 * token is still the one this refresh sent. Gone meanwhile: nothing is written and the answer is
 * `not-connected`, token in hand or not -- the user asked the bot to forget it. Replaced meanwhile:
 * nothing is written either, the fresh grant wins (it may carry new scopes); a successful refresh
 * still answers with the token it got, a failed one answers `unavailable`, never `revoked`, so the
 * fresh grant is never removed on the old one's account (#146).
 *
 * The granted scopes come back too: Spotify reports them on every refresh, so a grant the user
 * narrowed in their Spotify settings is noticed here rather than as a 403 in the middle of a party.
 * They are persisted for the same reason -- the next command can check before it calls.
 */
export async function accessTokenFor(spotify: SpotifyClient, discordUserId: string): Promise<TokenResult> {
  const pending = inFlight.get(discordUserId);
  if (pending !== undefined) return pending;
  const run = refreshOnce(spotify, discordUserId).finally(() => inFlight.delete(discordUserId));
  inFlight.set(discordUserId, run);
  return run;
}

async function refreshOnce(spotify: SpotifyClient, discordUserId: string): Promise<TokenResult> {
  const connection = musicState().connections[discordUserId];
  if (connection === undefined) return notConnected();
  const refreshed = await spotify.refresh(connection.refreshToken);
  // Everything below is decided against the connection as it is NOW, not as it was before the await.
  const stored = musicState().connections[discordUserId];
  if (stored === undefined) return notConnected();
  const unchanged = stored.refreshToken === connection.refreshToken;
  if (!refreshed.ok) {
    if (!isDeadGrant(refreshed) || !unchanged) return unavailable(refreshed.error);
    await commit(removeConnection(musicState(), discordUserId));
    return revoked(refreshed.error);
  }
  const rotated = refreshed.value.refreshToken;
  const scopes = refreshed.value.scopes;
  if (unchanged && (rotated !== undefined || scopes !== undefined)) {
    await commit(putConnection(musicState(), discordUserId, rotated ?? stored.refreshToken, stored.connectedAt, scopes));
  }
  const result: TokenResult = { ok: true, accessToken: refreshed.value.accessToken };
  const known = scopes ?? musicState().connections[discordUserId]?.scopes;
  if (known !== undefined) result.scopes = known;
  return result;
}

function notConnected(): TokenResult {
  return {
    ok: false,
    kind: "not-connected",
    error: "You haven't connected Spotify yet -- run `/spotify connect` first.",
  };
}

function unavailable(detail: string): TokenResult {
  return {
    ok: false,
    kind: "unavailable",
    error:
      `Spotify couldn't refresh your connection right now (${detail}). ` +
      "Your link is still saved -- try again in a moment, and if it keeps failing, " +
      "run `/spotify connect` again.",
  };
}

function revoked(detail: string): TokenResult {
  return {
    ok: false,
    kind: "revoked",
    error: `Your Spotify connection is no longer valid (${detail}). Run \`/spotify connect\` to reconnect.`,
  };
}
