// Turning a stored refresh token into a usable access token, in one place because both the command
// layer and the party runner need it and they must agree about what a dead connection means.

import { commit, putConnection, removeConnection, musicState } from "./store.js";
import type { SpotifyClient } from "./spotify.js";

export type TokenResult =
  | { ok: true; accessToken: string; scopes?: string }
  | { ok: false; error: string };

/**
 * Trades the caller's stored refresh token for a usable access token, persisting a rotated refresh
 * token when Spotify issues one. A refresh that fails is almost always a revoked or superseded
 * grant, so the dead connection is DROPPED here -- leaving it in place would make every later
 * command fail the same way with no hint that reconnecting is the fix.
 *
 * The granted scopes come back too: Spotify reports them on every refresh, so a grant the user
 * narrowed in their Spotify settings is noticed here rather than as a 403 in the middle of a party.
 * They are persisted for the same reason -- the next command can check before it calls.
 */
export async function accessTokenFor(spotify: SpotifyClient, discordUserId: string): Promise<TokenResult> {
  const connection = musicState().connections[discordUserId];
  if (connection === undefined) {
    return { ok: false, error: "You haven't connected Spotify yet -- run `/spotify connect` first." };
  }
  const refreshed = await spotify.refresh(connection.refreshToken);
  if (!refreshed.ok) {
    await commit(removeConnection(musicState(), discordUserId));
    return {
      ok: false,
      error: `Your Spotify connection is no longer valid (${refreshed.error}). Run \`/spotify connect\` to reconnect.`,
    };
  }
  const rotated = refreshed.value.refreshToken;
  const scopes = refreshed.value.scopes;
  if (rotated !== undefined || scopes !== undefined) {
    await commit(
      putConnection(musicState(), discordUserId, rotated ?? connection.refreshToken, connection.connectedAt, scopes),
    );
  }
  const result: TokenResult = { ok: true, accessToken: refreshed.value.accessToken };
  const known = scopes ?? musicState().connections[discordUserId]?.scopes;
  if (known !== undefined) result.scopes = known;
  return result;
}
