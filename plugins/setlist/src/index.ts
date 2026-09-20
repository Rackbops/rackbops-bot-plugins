import type { HostApi, Plugin } from "../../../packages/api/contract.js";
import { resolveConfig } from "./config.js";
import { initCommands, setlistCommands } from "./commands.js";
import { createSetlistFmClient } from "./setlistfm.js";
import { createSpotifyClient } from "./spotify.js";
import { createRateLimiter, startCallbackServer } from "./server.js";
import { commit, initStore, putConnection, redeemPendingAuth, setlistState } from "./store.js";

/**
 * The setlist plugin: `/setlist` turns a setlist.fm show into a Spotify playlist, `/spotify`
 * connects and disconnects the caller's Spotify account.
 *
 * `createPlugin` is pure -- it resolves and validates the five env keys (throwing only on a value
 * that is SET but unusable, so the host skips just this plugin and logs why) and builds the two API
 * clients, which are themselves inert until called. All I/O -- loading `setlist.json`, binding the
 * OAuth callback port -- happens in `activate()`, after the host's `takeOver()`.
 *
 * Every piece of config is optional and independently absent: no setlist.fm key means `/setlist`
 * reports what is missing, no callback port means `/spotify connect` says the feature is off. An
 * enabled-but-unconfigured plugin still loads and still registers its commands.
 */
export function createPlugin(host: HostApi): Plugin {
  const config = resolveConfig(host.env);
  const setlistFm = config.setlistFmKey !== undefined ? createSetlistFmClient(config.setlistFmKey) : undefined;
  const spotify = config.spotify !== undefined ? createSpotifyClient(config.spotify) : undefined;

  // Flipped true only once the callback server has actually bound. `/spotify connect` reads it so
  // it never mints an authorize link whose redirect lands on nothing.
  let serverRunning = false;
  let stopServer: (() => void) | undefined;

  initCommands({ config, setlistFm, spotify, serverRunning: () => serverRunning });

  return {
    commands: setlistCommands(),

    async activate() {
      await initStore(host);

      // Fail closed: no port, or an incomplete Spotify app, means no listener at all rather than a
      // port bound for a flow that cannot complete.
      if (config.callbackPort === undefined || config.spotify === undefined || spotify === undefined) return;

      const spotifyClient = spotify;
      try {
        const server = startCallbackServer(config.callbackPort, {
          callbackPath: config.spotify.callbackPath,
          rateLimiter: createRateLimiter({ windowMs: 60_000, max: 30 }),
          redeemState: async (stateToken) => {
            const redeemed = redeemPendingAuth(setlistState(), stateToken, Date.now());
            // Persisted either way: the token is consumed on a failed redemption too, so a leaked
            // callback URL cannot be replayed.
            await commit(redeemed.state);
            if (redeemed.ok) return { ok: true, discordUserId: redeemed.discordUserId };
            return {
              ok: false,
              error:
                redeemed.reason === "expired"
                  ? "That connect link has expired. Run /spotify connect again for a fresh one."
                  : "That connect link isn't valid any more. Run /spotify connect again.",
            };
          },
          exchangeCode: (code) => spotifyClient.exchangeCode(code),
          saveConnection: async (discordUserId, refreshToken) => {
            await commit(putConnection(setlistState(), discordUserId, refreshToken, Date.now()));
            // The user id is safe to log; the refresh token never is.
            host.log.info(`connected Spotify for discord user ${discordUserId}`);
          },
        });
        stopServer = server.stop;
        serverRunning = true;
      } catch (err) {
        // Bun.serve throwing (a privileged port under the container's non-root user, a port already
        // in use) must not crash the bot: the plugin stays loaded with /spotify connect reporting
        // the feature disabled.
        host.log.error(
          `Spotify callback server failed to start on :${config.callbackPort} -- the bot keeps running without it; ` +
            "/spotify connect will report the feature disabled. Check the port isn't already in use " +
            "and isn't a privileged one the container's non-root user can't bind.",
          err,
        );
      }
    },

    async dispose() {
      if (stopServer !== undefined) {
        serverRunning = false;
        stopServer();
        host.log.info("Spotify callback server stopped");
      }
    },
  };
}
