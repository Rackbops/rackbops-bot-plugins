import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DeliveryFailedError, type Executor, Lanes, type Clock, type Fetch, type Notifier, noticeOnce, type TaskType } from "@rackbops/docket-core";
import { bggSource, pageSource, price, reminder, renewal, research, scout, type Source, wantjudgeType, wantlistType } from "@rackbops/docket-types";
import type { HostApi, Plugin } from "../../../packages/api/contract.js";
import { parseGuildIds, parseGuildRoles } from "./access.js";
import type { TickGate, TrackerDeps } from "./actions.js";
import { Admissions } from "./admissions.js";
import { Ceilings } from "./ceilings.js";
import { DeliveryHealth } from "./delivery-health.js";
import { createPageFetch } from "./fetch.js";
import { EXECUTE_EVERY_MS, ExecuteLane } from "./execute-lane.js";
import { type CityHallConfig, createCityHallExecutor, databaseId, JobRecords, parseCityHallConfig } from "./executor.js";
import type { Membership } from "./access.js";
import { type Interactionish, lookupMembership, type RoleGate, serial } from "./discord-common.js";
import { createSurface, type SurfaceWiring } from "./discord.js";
import { decideHealth, type HealthState, healthResponse } from "./health.js";
import { TaskLocks } from "./locks.js";
import { createDmNotifier } from "./notifier.js";
import { type NotifyTickKind, runNotifyTick } from "./notify-lane.js";
import { runDigests } from "./digest.js";
import { parseAdminIds, seedAdmins } from "./people.js";
import { openDatabase, vacuumOnce } from "./schema.js";
import { Roster } from "./roster.js";
import { SqliteStore } from "./store.js";
import { createWebHandler } from "./web/app.js";
import { parseWebUrl } from "./web/config.js";
import { ApiTokens } from "./web/api-tokens.js";
import { Sessions } from "./web/sessions.js";
import { LoginLinks } from "./web/signin-link.js";
import { BUDGET_UNLIMITED_KEY, executeBudget, parseBudgetUnlimited, UNLIMITED_IDLE_LOG, UNLIMITED_LOG } from "./usage.js";

/**
 * The task tracker (rackbops-bot-plugins#78; plan of record Rackbops/Tooling
 * research/city-hall-task-tracker.md, 5.1): the host of Rackbops/docket on a rackbops-discord-bot
 * instance: docket's Store on SQLite, the notify lane on the host's tick, people and the first
 * admin, `/tracker/healthz` (#78), and the Discord surface -- the slash commands, the admission and
 * membership gates, consent, the buttons and the Reply modal, and pausing delivery after repeated
 * failures (#79), the web area's first slice -- sign-in by one-time link, my tasks, history,
 * settings (#80) -- renewals and the price tracker, with the fenced page reads on a tick of
 * their own (#81) -- the web task editor (#80, slice 2) -- the admin view and forget-me (#80,
 * slice 3) -- the JSON task API with personal tokens (#80, slice 4) -- and the one-off research
 * request through city-hall, with its findings, on the execute lane (#82) -- and the daily "today
 * and overdue" digest after the runs on the `notify` tick (plan 5.5, digest.ts).
 *
 * `createPlugin` is pure: it validates `TRACKER_ADMIN_DISCORD_IDS`, `TRACKER_GUILD_ID`, `TRACKER_GUILD_ROLES`,
 * `TRACKER_WEB_URL`, the `TRACKER_CITY_HALL_*` settings (executor.ts) and `TRACKER_BUDGET_UNLIMITED` (usage.ts) and nothing else. The database is opened in `activate()` and closed in `dispose()`.
 */

/** The tracker's database: `<dataDir>/tracker/tracker.sqlite`, a directory of its own (mcp's convention). */
export const DB_DIR = "tracker";
export const DB_FILE = "tracker.sqlite";

/**
 * The task types this host runs: the notify-lane types -- `price` reads pages through the fenced
 * Fetch port (fetch.ts, #81) -- and `research` (#82), the execute-lane type, which runs only while
 * the city-hall Executor is configured (executor.ts): without it the execute lane is not ticked and
 * `/research` makes nothing -- and `scout` (#83), the interest scout, the plugin's own execute-lane
 * type (scout-type.ts), under the same switch -- and `wantlist` (#83), the want-list watcher, on the
 * `poll` tick like `price`, reading pasted pages here; `createPlugin` swaps in one that also reads
 * BoardGameGeek once `TRACKER_BGG_TOKEN` is set -- and `wantjudge` (#83), the same watch with the
 * model looking at each new listing first (wantjudge-type.ts): an execute-lane type, under the
 * execute lane's switch, its plain-code reads through the same Fetch port.
 */
export const TRACKER_TYPES: Readonly<Record<string, TaskType<unknown>>> = Object.freeze({
  reminder: reminder as TaskType<unknown>,
  renewal: renewal as TaskType<unknown>,
  price: price as TaskType<unknown>,
  research: research as TaskType<unknown>,
  scout: scout as TaskType<unknown>,
  wantlist: wantlistType({ page: pageSource }) as TaskType<unknown>,
  wantjudge: wantjudgeType({ page: pageSource }) as TaskType<unknown>,
});

/** `TRACKER_BGG_TOKEN`: BGG's Bearer token for a registered application, or null when unset or empty. */
export function parseBggToken(raw: string | undefined): string | null {
  const token = raw?.trim() ?? "";
  return token === "" ? null : token;
}

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
  /** Test seam for the city-hall Executor's HTTP (executor.ts). */
  cityHallFetch?: typeof fetch;
  /** Test seam: an Executor in place of the city-hall one, as if configured. */
  executor?: Executor;
  /** Test seam: a BGG source in place of the token's (want-bgg.ts), as if `TRACKER_BGG_TOKEN` were set. */
  bgg?: Source;
  /** Test seam: each execute tick's background work as it starts, so a test can await it. */
  executeStarted?: (work: Promise<void>) => void;
  /** Test seam: false leaves the daily digest (digest.ts) off the notify tick, for tests that count every DM. On by default. */
  digest?: boolean;
}

/** A Notifier for a host without `dm`: every send is refused, and nothing went out. */
const NO_DM: Notifier = {
  async sendDm() {
    throw new DeliveryFailedError("this bot has no host.dm (rackbops-discord-bot#736)");
  },
};

export function createPlugin(host: HostApi, options: TrackerOptions = {}): Plugin {
  const adminIds = parseAdminIds(host.env.TRACKER_ADMIN_DISCORD_IDS);
  const guildIds = parseGuildIds(host.env.TRACKER_GUILD_ID);
  // The Discord-role check (plan 1.1, 5.5): the configured admins skip the role, never the membership.
  const roleGate: RoleGate = { roles: parseGuildRoles(host.env.TRACKER_GUILD_ROLES, guildIds), exempt: new Set(adminIds) };
  const webOrigin = parseWebUrl(host.env.TRACKER_WEB_URL);
  const cityHall = parseCityHallConfig(host.env);
  // Budgets off for the alpha (roshne, 2026-10-02): no daily ceiling holds a run; usage is still recorded.
  const budgetUnlimited = parseBudgetUnlimited(host.env[BUDGET_UNLIMITED_KEY]);
  const cityHallConfig: CityHallConfig | null = cityHall.config;
  // The execute lane runs only when fully set up (or a test hands an Executor in).
  const executeOn = cityHallConfig !== null || options.executor !== undefined;
  const clock: Clock = options.clock ?? { now: () => new Date() };
  const bggToken = parseBggToken(host.env.TRACKER_BGG_TOKEN);
  // BGG's answers are XML, read by want-bgg.ts's own bounded parser: the raw body, fenced like every read.
  const bgg = options.bgg ?? (bggToken ? bggSource({ token: bggToken, fetch: createPageFetch({ raw: true, noRedirects: true }) }) : null);
  const types =
    options.types ??
    (bgg
      ? { ...TRACKER_TYPES, wantlist: wantlistType({ page: pageSource, bgg }) as TaskType<unknown>, wantjudge: wantjudgeType({ page: pageSource, bgg }) as TaskType<unknown> }
      : TRACKER_TYPES);
  const pageFetch = options.fetch ?? ((signal?: AbortSignal) => createPageFetch(signal ? { signal } : {}));
  const health: HealthState = { activatedAt: null, lastTickAt: null, blocked: null };
  let db: Database | null = null;
  let store: SqliteStore | null = null;
  let delivery: DeliveryHealth | null = null;
  let deps: TrackerDeps | null = null;
  let warnedNoDm = false;
  let executeLane: ExecuteLane | null = null;
  let jobRecords: JobRecords | null = null;
  let executeRun: Promise<void> | null = null;
  let lastExecute = Number.NEGATIVE_INFINITY;
  // While forget-me runs (from its wait for the ticks to its erasure), no execute tick starts.
  let forgetting = 0;
  const dm = host.dm?.bind(host);
  // One queue for every store write, from Discord and from the web area alike, and one lock per task
  // that the ticks and the queue's replies and edits of that task share (locks.ts).
  const queue = serial();
  const locks = new TaskLocks();
  const surface = createSurface({
    deps: () => deps,
    guildIds,
    roleGate,
    log: host.log,
    queue,
    web: webOrigin ? { origin: webOrigin, name: host.name, gated: guildIds !== null } : null,
    ...(options.membership ? { membership: options.membership } : {}),
  });

  async function tick(kind: NotifyTickKind, signal?: AbortSignal) {
    if (!store) return;
    const outcome = await runNotifyTick(
      {
        store,
        locks,
        clock,
        types,
        dm,
        log: host.log,
        kind,
        // The execute tick's tasks wait a minute rather than wait on city-hall (execute-lane.ts).
        skip: (taskId) => locks.reserved(taskId),
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
    // The daily digest (plan 5.5, digest.ts), after the runs due now: a reminder never waits on it.
    if (kind === "notify" && options.digest !== false && deps && store) {
      const r = await runDigests({ store, notifier: deps.notifier, log: host.log, ...(delivery ? { health: delivery } : {}) }, clock.now(), signal);
      if (r.failed > 0) host.log.warn(`digest: ${r.sent} sent, ${r.failed} failed`);
    }
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
    async excludeExecute(fn) {
      forgetting++;
      try {
        return await fn();
      } finally {
        forgetting--;
      }
    },
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

  /**
   * The execute lane (execute-lane.ts), started in the background so it never holds up a host tick:
   * one at a time, at most once per `EXECUTE_EVERY_MS`, tracked like the other ticks so forget-me
   * waits for it.
   */
  function startExecute(): void {
    if (!store || !executeLane || executeRun || forgetting > 0) return;
    const at = clock.now().getTime();
    if (at - lastExecute < EXECUTE_EVERY_MS) return;
    lastExecute = at;
    const lane = executeLane;
    const records = jobRecords;
    const work = (async () => {
      try {
        const r = await lane.tick();
        if (r.failed > 0) host.log.warn(`execute lane: ${r.ran} ran, ${r.failed} failed`);
        // The record of a Job whose run is gone, or finished a month ago, goes (executor.ts).
        if (records && store) records.prune(clock.now());
      } catch (err) {
        // A closed store after dispose, or a Store error: logged; the next tick tries again.
        if (store) host.log.error("execute lane tick failed", err);
      }
    })();
    executeRun = tracked(work).finally(() => {
      executeRun = null;
    });
    options.executeStarted?.(executeRun);
  }

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
    return lookupMembership({ guildId: null, user: { id: discordId }, client: discordClient }, guildIds, discordId, host.log, roleGate);
  };
  const web = createWebHandler({
    name: host.name,
    origin: webOrigin,
    deps: () => deps,
    queue,
    guildIds,
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
        // docket's recover(), once at start: work a crash left running goes back to the queue (a run
        // that fired resumes from its record, never running its type again), and every send left
        // mid-way is settled unconfirmed and never resent -- logged here, as the admin's notice.
        const open = await openedStore.listDeliveries({ status: "claimed" });
        const requeued = await new Lanes({ store: openedStore, clock, types, notifier: NO_DM }).recover();
        if (requeued.length > 0) host.log.warn(`requeued ${requeued.length} occurrence(s) left running: ${requeued.join(", ")}`);
        for (const c of open) {
          const why = c.error ? ` (${c.error})` : "";
          host.log.warn(`delivery of ${c.occurrenceId} to ${c.userId} claimed ${c.claimedAt ?? "?"} is unconfirmed${why}; it will not be resent`);
        }
      } catch (err) {
        opened.close();
        throw err;
      }
      db = opened;
      store = openedStore;
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
      const notifier = dm ? createDmNotifier({ store: openedStore, dm, clock, log: host.log, health: delivery }) : NO_DM;
      let executor: Executor | null = null;
      if (options.executor) executor = options.executor;
      else if (cityHallConfig) {
        jobRecords = new JobRecords(opened);
        executor = createCityHallExecutor({
          config: cityHallConfig,
          records: jobRecords,
          databaseId: databaseId(opened),
          log: host.log,
          now: () => clock.now(),
          notice: async (key, text) => void (await noticeOnce(openedStore, notifier, key, clock.now(), { text })),
          ...(options.cityHallFetch ? { fetchImpl: options.cityHallFetch } : {}),
        });
      }
      // One docket Lanes for the execute lane while active: it keeps the usage-limit pause (execute-lane.ts).
      // Its budget is docket's defaults with each person's raised ceiling read before every run (ceilings.ts),
      // or none at all while TRACKER_BUDGET_UNLIMITED is on (usage.ts).
      const ceilings = new Ceilings(opened);
      executeLane = executor ? new ExecuteLane({ store: openedStore, clock, types, notifier, executor, locks, fetch: pageFetch(), budget: executeBudget(ceilings, budgetUnlimited) }) : null;
      // One line either way: the budgets-off line only when a model run can actually happen.
      if (budgetUnlimited) host.log.info(executeLane ? UNLIMITED_LOG : UNLIMITED_IDLE_LOG);
      if (cityHallConfig) host.log.info(`execute lane on: city-hall ${cityHallConfig.url}, capability ${cityHallConfig.capability}`);
      else if ("missing" in cityHall && cityHall.missing.length > 0) host.log.warn(`execute lane is off, so /research is unavailable: ${cityHall.missing.join(", ")} not set`);
      deps = {
        store: openedStore,
        admissions: new Admissions(opened),
        health: delivery,
        clock,
        types,
        fetch: pageFetch(),
        dm,
        log: host.log,
        notifier,
        locks,
        logins: new LoginLinks(opened),
        sessions: new Sessions(opened),
        apiTokens: new ApiTokens(opened),
        roster: new Roster(opened),
        ceilings,
        budgetUnlimited,
        configuredAdmins: new Set(adminIds),
        lanes,
        webEditor: webOrigin !== null,
        research: executeOn,
        bgg: bgg !== null,
      };
      if (guildIds === null) host.log.warn("TRACKER_GUILD_ID is unset: no membership gate, only the admission list");
      else if (roleGate.roles !== null) host.log.info(`role check on for ${roleGate.roles.size} of ${guildIds.length} server(s)`);
      health.blocked = typeof host.dm === "function" ? null : "this bot has no host.dm (it predates rackbops-discord-bot#736)";
      health.activatedAt = clock.now();
    },

    async dispose() {
      // Null the handles first: a tick the host abandoned, or one that starts after this, finds no
      // store and returns instead of touching a closed database.
      health.activatedAt = null;
      deps = null;
      delivery = null;
      executeLane = null;
      jobRecords = null;
      store = null;
      const closing = db;
      db = null;
      // An execute tick in flight finishes its city-hall call (each is bounded) before the database
      // closes, so a result collected is recorded; past 5 s it is asked again after the restart.
      const inFlight = executeRun;
      if (inFlight) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([inFlight, new Promise((r) => (timer = setTimeout(r, 5_000)))]);
        clearTimeout(timer);
      }
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
      // The execute lane (#82), only when the city-hall Executor is set up: started in the
      // background, so the host's wait on it is none and no reminder waits on a model.
      ...(executeOn
        ? [
            {
              name: "execute",
              run: async () => startExecute(),
            },
          ]
        : []),
    ],

    async http(request, info) {
      if (info.path === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
        return healthResponse(decideHealth(health, clock.now()));
      }
      return web(request, info);
    },
  };
}
