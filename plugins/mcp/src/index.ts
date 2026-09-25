import type { HostApi, Plugin } from "../../../packages/api/contract.js";
import { createRateLimiter } from "./auth.js";
import { createDrainLock, drainAndPersist } from "./drain.js";
import { handleMcpHttp, type HttpDeps } from "./http.js";
import { createDeliveryStore } from "./store.js";

/**
 * The MCP bridge plugin (Tooling#742): the service side of docs/bridge-protocol.md, served under
 * `/mcp/`. `createPlugin` is pure -- it only reads `MCP_BRIDGE_TOKEN` and builds the (stateless
 * until activate()) store, rate limiter and drain lock; `MCP_BRIDGE_TOKEN`'s `format` is validated
 * by `ops/bot-ops.sh env-set` only, never here (contract.ts's own PluginEnvKey doc comment) -- an
 * unset or malformed value both just mean http.ts answers 503.
 */
export function createPlugin(host: HostApi): Plugin {
  const store = createDeliveryStore(host.dataDir, host.storage, host.log);
  const limiter = createRateLimiter();
  // Shared with http.ts (below) so a caller's retry and this plugin's own re-drive tick can never
  // drain the SAME request_id at once -- see drain.ts's DrainLock doc comment for why that race is
  // real (the tick doesn't update the stored state until its attempt settles, so a retry racing it
  // would still see "unknown" and start a second attempt of its own).
  const drainLock = createDrainLock();
  // Flipped by dispose() (decision 6): the tick's re-drive loop checks this between deliveries so a
  // shutdown stops it from starting another once the grace period is spent. HTTP-triggered drains
  // need no equivalent guard -- the host stops routing new requests to this plugin before dispose()
  // ever runs (index.ts's shutdown handler stops the HTTP listener first).
  let disposed = false;

  const httpDeps: HttpDeps = {
    host,
    store,
    token: host.env.MCP_BRIDGE_TOKEN,
    limiter,
    drainLock,
    now: () => new Date(),
    log: host.log,
  };

  return {
    async http(request, info) {
      return handleMcpHttp(request, info, httpDeps);
    },
    ticks: [
      {
        name: "redrive",
        /** Decision 6: re-drives every `unknown` entry (a restart left it without a caller ever
         *  retrying it) and prunes anything 8+ days old. Honours `signal`/`disposed` BETWEEN
         *  deliveries, not mid-attempt -- `attemptDelivery` itself takes no signal, the same way
         *  `host.post`/`host.announce` take none. Skips (rather than waits for) an id the drain
         *  lock says a caller's retry already claimed; that retry owns writing its outcome. Each
         *  id is isolated in its own try/catch: one id's failure (a store read/write throwing) is
         *  logged and the loop moves on, rather than aborting the whole tick and skipping every
         *  later id plus the prune pass that follows (review finding, Tooling#742) -- the same
         *  isolation `pluginTicks`/`activatePlugins` already apply per plugin, one level up. */
        async run(signal) {
          for (const requestId of await store.list()) {
            if (disposed || signal?.aborted === true) return;
            try {
              const current = await store.get(requestId);
              if (current === undefined || current.state !== "unknown") continue;
              if (!drainLock.tryStart(requestId)) continue;
              try {
                await drainAndPersist(host, requestId, current, store.set, host.log);
              } finally {
                drainLock.finish(requestId);
              }
            } catch (err) {
              host.log.error(`redrive of delivery ${requestId} failed`, err);
            }
          }
          if (disposed || signal?.aborted === true) return;
          const pruned = await store.prune(() => new Date());
          if (pruned.length > 0) host.log.info(`pruned ${pruned.length} deliveries older than 8 days`);
        },
      },
    ],
    // A restart mid-delivery leaves no caller retry and no drain in flight to ever resolve it --
    // decision 6 turns every `pending` into `unknown` here so the tick above picks it back up.
    async activate() {
      await store.markPendingUnknown();
    },
    async dispose() {
      disposed = true;
    },
  };
}
