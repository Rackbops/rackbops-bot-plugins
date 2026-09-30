import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Clock, Fetch, Notifier, TaskType } from "@rackbops/docket-core";
import { price, reminder, renewal } from "@rackbops/docket-types";
import type { HostApi, Plugin } from "../../../packages/api/contract.js";
import { parseGuildId } from "./access.js";
import type { TickGate, TrackerDeps } from "./actions.js";
import { Admissions } from "./admissions.js";
import { ClaimStore } from "./claims.js";
import { DeliveryHealth } from "./delivery-health.js";
import { createPageFetch } from "./fetch.js";
import type { Membership } from "./access.js";
import { type Interactionish, lookupMembership, serial } from "./discord-common.js";
import { createSurface, type SurfaceWiring } from "./discord.js";
import { decideHealth, type HealthState, healthResponse } from "./health.js";
import { createDmNotifier, reportUnconfirmed } from "./notifier.js";
import { type NotifyTickKind, runNotifyTick } from "./notify-lane.js";
import { parseAdminIds, seedAdmins } from "./people.js";
import { openDatabase, vacuumOnce } from "./schema.js";
import { Roster } from "./roster.js";
import { SqliteStore } from "./store.js";
import { createWebHandler } from "./web/app.js";
import { parseWebUrl } from "./web/config.js";
import { Sessions } from "./web/sessions.js";
import { LoginLinks } from "./web/signin-link.js";

/**
 * The task tracker (rackbops-bot-plugins#78; plan of record Rackbops/Tooling
 * research/city-hall-task-tracker.md, 5.1): the host of Rackbops/docket on a rackbops-discord-bot
 * instance: docket's Store on SQLite, the notify lane on the host's tick, people and the first
 * admin, `/tracker/healthz` (#78), and the Discord surface -- the slash commands, the admission and
 * membership gates, consent, the buttons and the Reply modal, and pausing delivery after repeated
 * failures (#79), the web area's first slice -- sign-in by one-time link, my tasks, history,
 * settings (#80) -- renewals and the price tracker, with the fenced page reads on a tick of
 * their own (#81) -- the web task editor (#80, slice 2) -- and the admin view and forget-me (#80,
 * slice 3).
 *
 * `createPlugin` is pure: it validates `TRACKER_ADMIN_DISCORD_IDS`, `TRACKER_GUILD_ID` and
 * `TRACKER_WEB_URL` and nothing else. The database is opened in `activate()` and closed in `dispose()`.
 */

/** The tracker's database: `<dataDir>/tracker/tracker.sqlite`, a directory of its own (mcp's convention). */
export const DB_DIR = "tracker";
export const DB_FILE = "tracker.sqlite";

/**
 * The task types this host runs: the notify-lane types whose ports are all wired -- `price` reads
 * pages through the fenced Fetch port (fetch.ts, #81). The execute-lane types need an Executor (the
 * city-hall adapter), which does not exist yet, so a task of those types is never run here -- docket
 * fails such a run with "no task type".
 */
export const TRACKER_TYPES: Readonly<Record<string, TaskType<unknown>>> = Object.freeze({
  reminder: reminder as TaskType<unknown>,
  renewal: renewal as TaskType<unknown>,
  price: price as TaskType<unknown>,
});

export interface TrackerOptions {
  clock?: Clock;
  /** The database path; defaults to `<dataDir>/tracker/tracker.sqlite`. Tests pass ":memory:". */
  dbPath?: string;
  types?: Readonly<Record<string, TaskType<unknown>>>;
  /** Test seam for the page reads; defaults to the fenced `createPageFetch`, given the tick's signal. */
  fetch?: (signal?: AbortSignal) => Fetch;
  /** Test seam for the membership lookup (discord.ts). */
  membership?: SurfaceWiring["membership"];
  /** Test seam for the web area's member re-check; null = no Discord client yet. Defaults to the
   *  client captured from the interactions (below). */
  webMembership?: (discordId: string) => Promise<Membership | null>;
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
  const webOrigin = parseWebUrl(host.env.TRACKER_WEB_URL);
  const clock: Clock = options.clock ?? { now: () => new Date() };
  const types = options.types ?? TRACKER_TYPES;
  const pageFetch = options.fetch ?? ((signal?: AbortSignal) => createPageFetch(signal ? { signal } : {}));
  const health: HealthState = { activatedAt: null, lastTickAt: null, blocked: null };
  let db: Database | null = null;
  let store: SqliteStore | null = null;
  let claims: ClaimStore | null = null;
  let delivery: DeliveryHealth | null = null;
  let deps: TrackerDeps | null = null;
  let warnedNoDm = false;
  const dm = host.dm?.bind(host);
  // One queue for every store write, from Discord and from the web area alike.
  const queue = serial();
  const surface = createSurface({
    deps: () => deps,
    guildId,
    log: host.log,
    queue,
    web: webOrigin ? { origin: webOrigin, name: host.name, gated: guildId !== null } : null,
    ...(options.membership ? { membership: options.membership } : {}),
  });

  async function tick(kind: NotifyTickKind, signal?: AbortSignal) {
    if (!store || !claims) return;
    const outcome = await runNotifyTick(
      {
        store,
        claims,
        clock,
        types,
        dm,
        log: host.log,
        kind,
        ...(kind === "poll" ? { fetch: pageFetch(signal) } : {}),
        ...(delivery ? { health: delivery } : {}),
      },
      signal,
    );
    if (outcome.kind === "no-dm") {
      if (!warnedNoDm) host.log.warn("notify lane is off: this bot has no host.dm (rackbops-discord-bot#736)");
      warnedNoDm = true;
      return;
    }
    if (outcome.kind === "aborted") return;
    // Health tracks the reminders' tick; a slow page on `poll` says nothing about it.
    if (kind === "notify") health.lastTickAt = clock.now();
    const { ran, failed } = outcome.result;
    if (failed > 0) host.log.warn(`${kind === "poll" ? "poll" : "notify"} lane: ${ran} ran, ${failed} failed`);
  }

  // The ticks still running (one the host stopped waiting on included): forget-me waits for none
  // to be, so a DM in flight to the person cannot write about them after they are erased (admin.ts).
  const running = new Set<Promise<unknown>>();
  const tracked = (p: Promise<void>): Promise<void> => {
    running.add(p);
    const done = () => void running.delete(p);
    void p.then(done, done);
    return p;
  };
  const lanes: TickGate = {
    busy: () => running.size > 0,
    async idle(ms) {
      const until = Date.now() + ms;
      while (running.size > 0) {
        const left = until - Date.now();
        if (left <= 0) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.allSettled([...running]), new Promise((r) => (timer = setTimeout(r, left)))]);
        clearTimeout(timer);
      }
      return true;
    },
  };

  // The web area's member re-check needs Discord, and the host API has no member lookup: it asks
  // through the discord.js Client of the last interaction the plugin handled (`interaction.client`
  // is the bot's one long-lived Client). Held here only, never stored; none until the first one.
  let discordClient: Interactionish["client"] | null = null;
  const capture = (interaction: unknown) => {
    const client = (interaction as { client?: Interactionish["client"] }).client;
    if (client) discordClient = client;
  };
  const clientMembership = async (discordId: string): Promise<Membership | null> => {
    if (!discordClient) return null;
    return lookupMembership({ guildId: null, user: { id: discordId }, client: discordClient }, guildId, discordId, host.log);
  };
  const web = createWebHandler({
    name: host.name,
    origin: webOrigin,
    deps: () => deps,
    queue,
    guildId,
    membership: options.webMembership ?? clientMembership,
  });
  const interactions = surface.interactions;

  return {
    commands: surface.commands.map((c) => ({
      ...c,
      handle: (interaction) => {
        capture(interaction);
        return c.handle(interaction);
      },
    })),
    interactions: (interaction) => {
      capture(interaction);
      return interactions(interaction);
    },

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
        const vacuum = vacuumOnce(opened, path);
        if ("error" in vacuum) host.log.warn(`could not vacuum the tracker's database (${vacuum.error}); trying again at the next start`);
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
        fetch: pageFetch(),
        dm,
        log: host.log,
        notifier: dm ? createDmNotifier({ store: openedStore, claims: openedClaims, dm, clock, log: host.log, health: delivery }) : NO_DM,
        logins: new LoginLinks(opened),
        sessions: new Sessions(opened),
        roster: new Roster(opened),
        configuredAdmins: new Set(adminIds),
        lanes,
        webEditor: webOrigin !== null,
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
        run: (signal) => tracked(tick("notify", signal)),
      },
      {
        // The price tracker's page reads (#81), on a tick of their own after `notify`: the host awaits
        // a plugin's ticks in order and stops waiting on one after 30 s, so a slow page never holds up
        // a reminder due now (notify-lane.ts).
        name: "poll",
        run: (signal) => tracked(tick("poll", signal)),
      },
    ],

    async http(request, info) {
      if (info.path === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
        return healthResponse(decideHealth(health, clock.now()));
      }
      return web(request, info);
    },
  };
}
