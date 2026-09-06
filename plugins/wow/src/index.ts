import type { HostApi, Plugin } from "../../../packages/api/contract.js";
import { initWowConfig } from "./config.js";
import { wowCommands } from "./commands.js";
import { wowTicks } from "./ticks.js";
import { initWowStore } from "./store.js";

/**
 * The WoW plugin. `createPlugin` is pure: it resolves and validates the WoW env keys (throwing to have
 * the host skip the plugin on an invalid `WOW_REGION`/`DMF_TIMEZONE` — the same error text the bot's
 * config threw at boot, src/config.ts:77,105) and returns the `/dmf`, `/reset`, `/status`, `/transmog`
 * commands plus the DMF / weekly-reset / realm scheduler ticks. All I/O — seeding and loading the
 * `wow.json` dedup store — runs in `activate()`, after the host's `takeOver()`.
 */
export function createPlugin(host: HostApi): Plugin {
  initWowConfig(host.env);
  return {
    commands: wowCommands(),
    ticks: wowTicks(host),
    async activate() {
      await initWowStore(host);
    },
  };
}
