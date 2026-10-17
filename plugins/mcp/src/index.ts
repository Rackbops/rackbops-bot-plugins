import type { HostApi, Plugin } from "../../../packages/api/contract.js";
import { createRateLimiter } from "./auth.js";
import { agentCommand } from "./commands.js";
import { createDrainLock, createEditQueue, createUnpersistedOutcomes, drainAndPersist } from "./drain.js";
import { handleMcpHttp, type HttpDeps } from "./http.js";
import { createRegistryStore } from "./registry.js";
import { createDeliveryStore } from "./store.js";

/**
 * The MCP bridge plugin (Tooling#742/#743): the service side of docs/bridge-protocol.md, served
 * under `/mcp/`, plus the `/agent` slash command and its two registration/pairing endpoints.
 * `createPlugin` is pure -- it only reads `MCP_BRIDGE_TOKEN` and builds the (stateless until
 * activate()) stores, rate limiter and drain lock; `MCP_BRIDGE_TOKEN`'s `format` is validated by
 * `ops/bot-ops.sh env-set` only, never here (contract.ts's own PluginEnvKey doc comment). An unset
 * or blank value means http.ts answers 503; a non-blank value of any shape is used, trimmed, as the token.
 */
export function createPlugin(host: HostApi): Plugin {
  const store = createDeliveryStore(host.dataDir, host.storage, host.log);
  const registry = createRegistryStore(host.dataDir, host.storage);
  const limiter = createRateLimiter();
  // Shared with http.ts (below) so a caller's retry and this plugin's own re-drive tick can never
  // drain the SAME request_id at once -- see drain.ts's DrainLock doc comment for why that race is
  // real (the tick doesn't update the stored state until its attempt settles, so a retry racing it
  // would still see "unknown" and start a second attempt of its own).
  const drainLock = createDrainLock();
  // Tooling#746 decision 3: serializes edit application per message_ref, shared the same way as
  // drainLock above -- an HTTP-triggered edit and the tick's re-drive of an "unknown" edit must never
  // read-modify-write the same original's lastEditSeq concurrently.
  const editQueue = createEditQueue();
  // Outcomes sent to Discord whose final write failed (#140); see drain.ts's UnpersistedOutcomes.
  const unpersisted = createUnpersistedOutcomes();
  // Flipped by dispose() (decision 6): the tick's re-drive loop checks this between deliveries so a
  // shutdown stops it from starting another once the grace period is spent. HTTP-triggered drains
  // need no equivalent guard -- the host stops routing new requests to this plugin before dispose()
  // ever runs (index.ts's shutdown handler stops the HTTP listener first).
  let disposed = false;

  const httpDeps: HttpDeps = {
    host,
    store,
    registry,
    editQueue,
    unpersisted,
    // A cleared key (`MCP_BRIDGE_TOKEN=`) can reach the plugin as ""; treat it as unset, not as a token.
    token: host.env.MCP_BRIDGE_TOKEN?.trim() || undefined,
    limiter,
    drainLock,
    now: () => new Date(),
    log: host.log,
  };

  return {
    commands: [agentCommand(registry)],
    async http(request, info) {
      return handleMcpHttp(request, info, httpDeps);
    },
    ticks: [
      {
        name: "redrive",
        /** Decision 6: first retries the write (only the write) for outcomes held in `unpersisted` and prunes
         *  that map on the 8-day rule (#140), then re-drives every `unknown` entry not held there (a restart
         *  left it without a caller ever retrying it) and prunes anything 8+ days old. Honours `signal`/`disposed` BETWEEN
         *  deliveries, not mid-attempt -- `attemptDelivery` itself takes no signal, the same way
         *  `host.post`/`host.announce` take none. Skips (rather than waits for) an id the drain
         *  lock says a caller's retry already claimed; that retry owns writing its outcome. Each
         *  id is isolated in its own try/catch: one id's failure (a store read/write throwing) is
         *  logged and the loop moves on, rather than aborting the whole tick and skipping every
         *  later id plus the prune pass that follows (review finding, Tooling#742) -- the same
         *  isolation `pluginTicks`/`activatePlugins` already apply per plugin, one level up. */
        async run(signal) {
          // First retry the write for outcomes that already went out (#140): no Discord call is repeated.
          for (const [requestId] of unpersisted.entries()) {
            if (disposed || signal?.aborted === true) return;
            if (!drainLock.tryStart(requestId)) continue;
            try {
              // Re-read under the lock: a caller's retry may have replaced or cleared it since the snapshot.
              const held = unpersisted.get(requestId);
              if (held === undefined) continue;
              await store.set(requestId, held);
              unpersisted.delete(requestId);
            } catch (err) {
              host.log.error(`persisting the outcome of delivery ${requestId} failed again`, err);
            } finally {
              drainLock.finish(requestId);
            }
          }
          unpersisted.prune(() => new Date());
          for (const requestId of await store.list()) {
            if (disposed || signal?.aborted === true) return;
            if (unpersisted.get(requestId) !== undefined) continue; // already sent; only the write is outstanding
            try {
              const current = await store.get(requestId);
              if (current === undefined || current.state !== "unknown") continue;
              if (!drainLock.tryStart(requestId)) continue;
              try {
                // An HTTP drain may have settled, with its write failing, since the check above.
                if (unpersisted.get(requestId) !== undefined) continue;
                await drainAndPersist(httpDeps, requestId, current);
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
