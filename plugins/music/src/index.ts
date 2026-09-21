import type { HostApi, Plugin } from "../../../packages/api/contract.js";
import { resolveConfig } from "./config.js";
import { initCommands, musicCommands, musicInteractions } from "./commands.js";
import { createSetlistFmClient } from "./setlistfm.js";
import { createSpotifyClient } from "./spotify.js";
import { createRateLimiter, startCallbackServer } from "./server.js";
import { initMatchLog, recordRun } from "./matchlog.js";
import { initParties, type Party } from "./party.js";
import { notifyParty } from "./notify.js";
import { createPartyRunner, realScheduler, type PartyRunner } from "./runner.js";
import { accessTokenFor } from "./tokens.js";
import { commit, initStore, putConnection, redeemPendingAuth, musicState } from "./store.js";

/**
 * The music plugin: `/setlist` turns a setlist.fm show into a Spotify playlist, `/spotify`
 * connects and disconnects the caller's Spotify account. Named for the domain rather than the one
 * feature, like `wow` -- it already owns the Spotify account link, which any later music feature
 * would share, and the name is the `PLUGINS=` token and the `data/plugins/<name>` directory, so it
 * cannot be changed once this ships.
 *
 * `createPlugin` is pure -- it resolves and validates the five env keys (throwing only on a value
 * that is SET but unusable, so the host skips just this plugin and logs why) and builds the two API
 * clients, which are themselves inert until called. All I/O -- loading `music.json`, binding the
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

  // The party's clock. Track boundaries ride on the runner's own timers rather than the host's
  // 60-second tick -- that tick is shared with every other plugin and runs its checks in sequence,
  // so it is the wrong place to land a track change. The tick below only repairs: it re-arms a
  // timer lost to a restart and corrects a member who has drifted.
  let runner: PartyRunner | undefined;
  if (spotify !== undefined) {
    const client = spotify;
    runner = createPartyRunner({
      spotify: client,
      accessTokenFor: (discordUserId) => accessTokenFor(client, discordUserId),
      now: () => Date.now(),
      schedule: realScheduler,
      notify: (party: Party, message: string) => notifyParty(party, message),
      log: host.log,
    });
  }

  initCommands({
    config,
    setlistFm,
    spotify,
    runner,
    serverRunning: () => serverRunning,
    matchLog: { record: recordRun },
  });

  const activeRunner = runner;

  return {
    commands: musicCommands(),

    ticks:
      activeRunner === undefined
        ? []
        : [
            {
              name: "party-sweep",
              run: () => activeRunner.sweep(),
            },
          ],

    // The host routes every component interaction whose `customId` starts with `music:` here --
    // `/setlist`'s same-day show picker and the party's Join button both. `musicInteractions` tells
    // them apart and answers an id it doesn't recognise rather than leaving Discord to show
    // "interaction failed".
    interactions: musicInteractions,

    async activate() {
      await initStore(host);
      await initParties(host);
      await initMatchLog(host);

      // Fail closed: no port, or an incomplete Spotify app, means no listener at all rather than a
      // port bound for a flow that cannot complete.
      if (config.callbackPort === undefined || config.spotify === undefined || spotify === undefined) return;

      const spotifyClient = spotify;
      try {
        const server = startCallbackServer(config.callbackPort, {
          callbackPath: config.spotify.callbackPath,
          rateLimiter: createRateLimiter({ windowMs: 60_000, max: 30 }),
          redeemState: async (stateToken) => {
            const redeemed = redeemPendingAuth(musicState(), stateToken, Date.now());
            // Persisted either way: the token is consumed on a failed redemption too, so a leaked
            // callback URL cannot be replayed.
            await commit(redeemed.state);
            if (redeemed.ok) {
              const answer: { ok: true; discordUserId: string; scopes?: string } = {
                ok: true,
                discordUserId: redeemed.discordUserId,
              };
              if (redeemed.scopes !== undefined) answer.scopes = redeemed.scopes;
              return answer;
            }
            return {
              ok: false,
              error:
                redeemed.reason === "expired"
                  ? "That connect link has expired. Run /spotify connect again for a fresh one."
                  : "That connect link isn't valid any more. Run /spotify connect again.",
            };
          },
          exchangeCode: (code) => spotifyClient.exchangeCode(code),
          saveConnection: async (discordUserId, refreshToken, scopes) => {
            await commit(putConnection(musicState(), discordUserId, refreshToken, Date.now(), scopes));
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
      // Timers first: a fired-mid-shutdown advance would try to play on players the bot is about to
      // stop steering, and `dispose` is bounded, so it must not wait on a Spotify round trip.
      activeRunner?.stopAll();
      if (stopServer !== undefined) {
        serverRunning = false;
        stopServer();
        host.log.info("Spotify callback server stopped");
      }
    },
  };
}
