import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Clock, TaskType } from "@rackbops/docket-core";
import { TASK_TYPES } from "@rackbops/docket-types";
import type { HostApi, Plugin } from "../../../packages/api/contract.js";
import { ClaimStore } from "./claims.js";
import { decideHealth, type HealthState, healthResponse } from "./health.js";
import { runNotifyTick } from "./notify-lane.js";
import { parseAdminIds, seedAdmins } from "./people.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

/**
 * The task tracker (rackbops-bot-plugins#78; plan of record Rackbops/Tooling
 * research/city-hall-task-tracker.md, 5.1): the host of Rackbops/docket on a rackbops-discord-bot
 * instance. This first slice is the core -- docket's Store on SQLite, the notify lane on the host's
 * tick, people and the first admin, `/tracker/healthz`. No commands yet (#79), no buttons (they
 * wait on rackbops-discord-bot#323).
 *
 * `createPlugin` is pure: it validates `TRACKER_ADMIN_DISCORD_IDS` and nothing else. The database
 * is opened in `activate()` and closed in `dispose()`.
 */

/** The tracker's database, directly under the host's data directory (contract: `dataDir`). */
export const DB_FILE = "tracker.sqlite";

export interface TrackerOptions {
  clock?: Clock;
  /** The database path; defaults to `<dataDir>/tracker.sqlite`. Tests pass ":memory:". */
  dbPath?: string;
  types?: Readonly<Record<string, TaskType<unknown>>>;
}

export function createPlugin(host: HostApi, options: TrackerOptions = {}): Plugin {
  const adminIds = parseAdminIds(host.env.TRACKER_ADMIN_DISCORD_IDS);
  const clock: Clock = options.clock ?? { now: () => new Date() };
  const types = options.types ?? TASK_TYPES;
  const health: HealthState = { activatedAt: null, lastTickAt: null, blocked: null };
  let db: Database | null = null;
  let store: SqliteStore | null = null;
  let claims: ClaimStore | null = null;
  let warnedNoDm = false;

  return {
    commands: [],

    async activate() {
      db = openDatabase(options.dbPath ?? join(host.dataDir, DB_FILE));
      store = new SqliteStore(db);
      claims = new ClaimStore(db);
      const now = clock.now();
      const granted = await seedAdmins(store, adminIds, now);
      if (granted.length > 0) host.log.info(`made ${granted.length} admin(s) from TRACKER_ADMIN_DISCORD_IDS`);
      // docket's recover(): work a crash left running goes back to the queue; delivery claims keep
      // it from sending twice.
      const requeued = await store.requeueRunning();
      if (requeued.length > 0) host.log.warn(`requeued ${requeued.length} occurrence(s) left running: ${requeued.join(", ")}`);
      for (const c of claims.listUnsettled()) {
        host.log.warn(`delivery of ${c.occurrenceId} to ${c.userId} is unconfirmed since ${c.claimedAt}; it will not be resent`);
      }
      if (typeof host.dm !== "function") health.blocked = "this bot has no host.dm (it predates rackbops-discord-bot#736)";
      health.activatedAt = clock.now();
    },

    async dispose() {
      health.activatedAt = null;
      db?.close();
      db = null;
    },

    ticks: [
      {
        name: "notify",
        async run(signal) {
          if (!store || !claims) return;
          const outcome = await runNotifyTick({ store, claims, clock, types, dm: host.dm?.bind(host), log: host.log }, signal);
          if (outcome.kind === "no-dm") {
            if (!warnedNoDm) host.log.warn("notify lane is off: this bot has no host.dm (rackbops-discord-bot#736)");
            warnedNoDm = true;
            return;
          }
          if (outcome.kind === "aborted") return;
          health.lastTickAt = clock.now();
          const { ran, failed } = outcome.result;
          if (failed > 0) host.log.warn(`notify lane: ${ran} ran, ${failed} failed`);
        },
      },
    ],

    async http(request, info) {
      if (info.path === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
        return healthResponse(decideHealth(health, clock.now()));
      }
      return new Response("Not found", { status: 404 });
    },
  };
}
