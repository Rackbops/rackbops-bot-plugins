import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Clock, Notifier, TaskType } from "@rackbops/docket-core";
import { reminder, renewal } from "@rackbops/docket-types";
import type { HostApi, Plugin } from "../../../packages/api/contract.js";
import { parseGuildId } from "./access.js";
import type { TrackerDeps } from "./actions.js";
import { Admissions } from "./admissions.js";
import { ClaimStore } from "./claims.js";
import { DeliveryHealth } from "./delivery-health.js";
import { createSurface, type SurfaceWiring } from "./discord.js";
import { decideHealth, type HealthState, healthResponse } from "./health.js";
import { createDmNotifier, reportUnconfirmed } from "./notifier.js";
import { runNotifyTick } from "./notify-lane.js";
import { parseAdminIds, seedAdmins } from "./people.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

/**
 * The task tracker (rackbops-bot-plugins#78; plan of record Rackbops/Tooling
 * research/city-hall-task-tracker.md, 5.1): the host of Rackbops/docket on a rackbops-discord-bot
 * instance: docket's Store on SQLite, the notify lane on the host's tick, people and the first
 * admin, `/tracker/healthz` (#78), and the Discord surface -- the slash commands, the admission and
 * membership gates, consent, the buttons and the Reply modal, and pausing delivery after repeated
 * failures (#79).
 *
 * `createPlugin` is pure: it validates `TRACKER_ADMIN_DISCORD_IDS` and `TRACKER_GUILD_ID` and
 * nothing else. The database is opened in `activate()` and closed in `dispose()`.
 */

/** The tracker's database: `<dataDir>/tracker/tracker.sqlite`, a directory of its own (mcp's convention). */
export const DB_DIR = "tracker";
export const DB_FILE = "tracker.sqlite";

/**
 * The task types this host runs: the notify-lane types whose ports are all wired. `price` needs the
 * Fetch port and the execute-lane types an Executor (the city-hall adapter); neither exists yet, so
 * a task of those types is never run here -- docket fails such a run with "no task type".
 */
export const TRACKER_TYPES: Readonly<Record<string, TaskType<unknown>>> = Object.freeze({
  reminder: reminder as TaskType<unknown>,
  renewal: renewal as TaskType<unknown>,
});

export interface TrackerOptions {
  clock?: Clock;
  /** The database path; defaults to `<dataDir>/tracker/tracker.sqlite`. Tests pass ":memory:". */
  dbPath?: string;
  types?: Readonly<Record<string, TaskType<unknown>>>;
  /** Test seam for the membership lookup (discord.ts). */
  membership?: SurfaceWiring["membership"];
}

/** A Notifier for a host without `dm`: every send is refused, before anything is claimed. */
const NO_DM: Notifier = {
  async sendDm() {
    throw new Error("this bot has no host.dm (rackbops-discord-bot#736)");
  },
};

export function createPlugin(host: HostApi, options: TrackerOptions = {}): Plugin {
  const adminIds = parseAdminIds(host.env.TRACKER_ADMIN_DISCORD_IDS);
  const guildId = parseGuildId(host.env.TRACKER_GUILD_ID);
  const clock: Clock = options.clock ?? { now: () => new Date() };
  const types = options.types ?? TRACKER_TYPES;
  const health: HealthState = { activatedAt: null, lastTickAt: null, blocked: null };
  let db: Database | null = null;
  let store: SqliteStore | null = null;
  let claims: ClaimStore | null = null;
  let delivery: DeliveryHealth | null = null;
  let deps: TrackerDeps | null = null;
  let warnedNoDm = false;
  const dm = host.dm?.bind(host);
  const surface = createSurface({
    deps: () => deps,
    guildId,
    log: host.log,
    ...(options.membership ? { membership: options.membership } : {}),
  });

  return {
    commands: surface.commands,
    interactions: surface.interactions,

    async activate() {
      let path = options.dbPath;
      if (path === undefined) {
        const dir = join(host.dataDir, DB_DIR);
        mkdirSync(dir, { recursive: true });
        path = join(dir, DB_FILE);
      }
      const opened = openDatabase(path);
      const openedStore = new SqliteStore(opened);
      const openedClaims = new ClaimStore(opened);
      try {
        const granted = await seedAdmins(openedStore, adminIds, clock.now());
        const admissions = new Admissions(opened);
        for (const id of adminIds) {
          const admin = await openedStore.findUserByDiscordId(id);
          if (admin) admissions.record(admin.id, null, clock.now().toISOString());
        }
        if (granted.length > 0) host.log.info(`made ${granted.length} admin(s) from TRACKER_ADMIN_DISCORD_IDS`);
        // docket's recover(): work a crash left running goes back to the queue; delivery claims keep
        // it from sending twice.
        const requeued = await openedStore.requeueRunning();
        if (requeued.length > 0) host.log.warn(`requeued ${requeued.length} occurrence(s) left running: ${requeued.join(", ")}`);
        for (const c of openedClaims.listUnsettled()) reportUnconfirmed(openedClaims, host.log, c, clock.now().toISOString());
      } catch (err) {
        opened.close();
        throw err;
      }
      db = opened;
      store = openedStore;
      claims = openedClaims;
      // The owner of a task a recipient's failures paused is told once, by a plain DM: not counted
      // toward the owner's own pause (they may simply be offline), and `/tasks` shows it regardless.
      delivery = new DeliveryHealth(opened, openedStore, {
        log: host.log,
        ...(dm
          ? {
              tellOwner: async (owner, text) => {
                if (owner.discordId) await dm(owner.discordId, { content: text });
              },
            }
          : {}),
      });
      deps = {
        store: openedStore,
        admissions: new Admissions(opened),
        health: delivery,
        clock,
        types,
        dm,
        log: host.log,
        notifier: dm ? createDmNotifier({ store: openedStore, claims: openedClaims, dm, clock, log: host.log, health: delivery }) : NO_DM,
      };
      if (guildId === null) host.log.warn("TRACKER_GUILD_ID is unset: no membership gate, only the admission list");
      health.blocked = typeof host.dm === "function" ? null : "this bot has no host.dm (it predates rackbops-discord-bot#736)";
      health.activatedAt = clock.now();
    },

    async dispose() {
      // Null the handles first: a tick the host abandoned, or one that starts after this, finds no
      // store and returns instead of touching a closed database.
      health.activatedAt = null;
      deps = null;
      delivery = null;
      store = null;
      claims = null;
      const closing = db;
      db = null;
      closing?.close();
    },

    ticks: [
      {
        name: "notify",
        async run(signal) {
          if (!store || !claims) return;
          const outcome = await runNotifyTick(
            { store, claims, clock, types, dm, log: host.log, ...(delivery ? { health: delivery } : {}) },
            signal,
          );
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
