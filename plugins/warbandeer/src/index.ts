import type { HostApi, Plugin } from "../../../packages/api/contract.js";
import { loadLinks } from "./links.js";
import { initCharacters, MAX_ACCOUNT_LABEL_LENGTH } from "./characters.js";
import { handleLinkCommand, handleUnlinkCommand } from "./link-command.js";
import { setConnectorConfigured, startWarbandeerServer } from "./server.js";

/**
 * The Warbandeer plugin. `createPlugin` is pure: it parses and validates `WARBANDEER_INGEST_PORT`
 * (throwing to have the host skip the plugin on an invalid value — the same error text the bot's
 * config threw at boot, per src/config.ts:116) and returns the `/link` and `/unlink` commands.
 * All I/O — loading `links.json`, binding the characters store, starting the ingest server — runs
 * in `activate()`, after the host's `takeOver()`.
 */
export function createPlugin(host: HostApi): Plugin {
  const portRaw = host.env.WARBANDEER_INGEST_PORT;
  let port: number | undefined;
  if (portRaw !== undefined) {
    const n = Number(portRaw);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new Error(`WARBANDEER_INGEST_PORT must be a valid port number, got "${portRaw}"`);
    }
    port = n;
  }
  // `configured` = the env var is set (a valid value; an invalid one threw above and the host skips
  // the plugin). `/link` reports "not configured" vs "failed to start" off this + the running flag.
  setConnectorConfigured(port !== undefined);

  // Captured only on a SUCCESSFUL activate() — stays undefined if the port was never configured,
  // or if startWarbandeerServer threw (the try/catch below never assigns it). dispose() below is a
  // no-op in either case: there is nothing this plugin instance opened that it needs to close.
  let stopServer: (() => void) | undefined;

  return {
    commands: [
      {
        name: "link",
        build: (builder) => builder.setDescription("Link the Warbandeer desktop app to your Discord account"),
        handle: handleLinkCommand,
      },
      {
        name: "unlink",
        build: (builder) =>
          builder
            .setDescription("Unlink a Warbandeer desktop account from your Discord account")
            .addStringOption((o) =>
              o
                .setName("account_label")
                .setDescription("Which linked account (only needed if you have more than one)")
                .setRequired(false)
                // Sourced from characters.ts's own constant, not a repeated literal — without this,
                // Discord's own 6000-char default lets a value through that unlinkReply() can't fit
                // into a 2000-char reply.
                .setMaxLength(MAX_ACCOUNT_LABEL_LENGTH),
            ),
        handle: handleUnlinkCommand,
      },
    ],
    async activate() {
      await loadLinks(host.dataDir, host.storage);
      initCharacters(host.dataDir, host.storage);
      // Absent WARBANDEER_INGEST_PORT means the connector never starts at all — fail closed
      // (ADR-0001) rather than binding a port nobody asked for. Bun.serve throwing (a privileged
      // port under the non-root user, the port already in use) must not crash the bot: the host
      // catches nothing here, so this try/catch keeps the plugin alive with /link reporting the
      // feature disabled (warbandeerServerRunning() stays false).
      if (port !== undefined) {
        try {
          const server = startWarbandeerServer(port);
          stopServer = server.stop;
        } catch (err) {
          host.log.error(
            `connector failed to start on :${port} — the bot keeps running without it; /link will report the feature disabled. ` +
              "Check the port isn't already in use and isn't a privileged one the container's non-root user can't bind.",
            err,
          );
        }
      }
    },
    // #184: the host calls this once, on the way out — a docker stop, a self-update's retire,
    // SIGINT — inside its own shutdown grace. Closes the ingest server activate() opened, if it
    // ever did; must not throw (the host isolates a throw and continues disposing other plugins,
    // but there is nothing to isolate here — server.stop() itself doesn't throw).
    async dispose() {
      if (stopServer !== undefined) {
        stopServer();
        host.log.info("ingest server stopped");
      }
    },
  };
}
