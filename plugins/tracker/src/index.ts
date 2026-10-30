import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DeliveryFailedError, type Executor, Lanes, type Clock, type Fetch, type Notifier, noticeOnce, type TaskType } from "@rackbops/docket-core";
import { bggSource, ebaySource, inboxSource, pageSource, shopifySource, price, type ReadInbox, type ReadSources, reminder, renewal, researchType, news, scout, type Source, type SourceId, wantjudgeType, wantlistType } from "@rackbops/docket-types";
import { createEbayBrowse, parseEbayKeys } from "./ebay.js";
import { forgetEbayMessages } from "./ebay-forget.js";
import { createFirecrawlScrape, parseFirecrawlKey } from "./firecrawl.js";
import type { HostApi, Plugin } from "../../../packages/api/contract.js";
import { parseGuildIds, parseGuildRoles } from "./access.js";
import type { TickGate, TrackerDeps } from "./actions.js";
import { Admissions } from "./admissions.js";
import { Ceilings } from "./ceilings.js";
import { DeliveryHealth } from "./delivery-health.js";
import { createBggFetch, createPageFetch, type PageFetchOptions } from "./fetch.js";
import { EXECUTE_MIN_GAP_MS, ExecuteLane } from "./execute-lane.js";
import { type CityHallConfig, createCityHallExecutor, databaseId, JobRecords, parseCityHallConfig } from "./executor.js";
import type { Membership } from "./access.js";
import { clientMemberFetch, hostMemberFetch, type Interactionish, lookupMembership, type RoleGate, serial } from "./discord-common.js";
import { createSurface, type SurfaceWiring } from "./discord.js";
import { decideHealth, type HealthState, healthResponse } from "./health.js";
import { WantInbox } from "./inbox.js";
import { createIntake, INTAKE_CAPABILITY_KEY, INTAKE_KEY, IntakeJobIds, parseIntakeCapability, parseIntakeMode } from "./intake.js";
import { IntakeConversations } from "./intake-store.js";
import { parseIntakeId } from "./buttons.js";
import { ResearchSources } from "./research-sources.js";
import { TaskLocks } from "./locks.js";
import { createDmNotifier } from "./notifier.js";
import { type NotifyTickKind, runNotifyTick } from "./notify-lane.js";
import { runDigests } from "./digest.js";
import { parseAdminIds, seedAdmins } from "./people.js";
import { openDatabase, vacuumOnce } from "./schema.js";
import { Roster } from "./roster.js";
import { SqliteStore } from "./store.js";
import { createWebHandler } from "./web/app.js";
import { handleMailInbound, MAIL_PATH } from "./web/mail-inbound.js";
import { MailAddresses, parseMailConfig } from "./mail.js";
import { parseWebUrl } from "./web/config.js";
import { ApiIdempotency } from "./web/api-idempotency.js";
import { ApiTokens } from "./web/api-tokens.js";
import { Sessions } from "./web/sessions.js";
import { LoginLinks } from "./web/signin-link.js";
import { createUsrClient, parseUsrConfig } from "./usr.js";
import { parseDelegates } from "./web/api-delegation.js";
import { UsrVerifier } from "./usr-identity.js";
import { UsrLinks } from "./usr-links.js";
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
 * `TRACKER_WEB_URL`, the `TRACKER_CITY_HALL_*` settings (executor.ts), the `TRACKER_USR_*` settings (usr.ts: a
 * half-set link refuses to load), `TRACKER_BUDGET_UNLIMITED` (usage.ts) and the `TRACKER_MAIL_*` settings (mail.ts),
 * reads `TRACKER_BGG_TOKEN`, `TRACKER_FIRECRAWL_KEY` and the `TRACKER_EBAY_CLIENT_*` pair (ebay.ts: a half-set pair
 * refuses to load), and nothing else. The database is opened in `activate()` and closed in `dispose()`.
 */

/** The tracker's database: `<dataDir>/tracker/tracker.sqlite`, a directory of its own (mcp's convention). */
export const DB_DIR = "tracker";
export const DB_FILE = "tracker.sqlite";

/**
 * How long `dispose()` waits for the ticks in flight before it closes the database: under the
 * host's own 2 s bound on a plugin's dispose (rackbops-discord-bot's `PLUGIN_DISPOSE_TIMEOUT_MS`),
 * leaving it room for the close.
 */
export const DISPOSE_WAIT_MS = 1_500;

/**
 * The task types this host runs: the notify-lane types -- `price` reads pages through the fenced
 * Fetch port (fetch.ts, #81) -- and `research` (#82), the execute-lane type, which runs only while
 * the city-hall Executor is configured (executor.ts): without it the execute lane is not ticked and
 * `/research` makes nothing -- and `scout` (#83), the interest scout, the plugin's own execute-lane
 * type (docket-types' `scout`), under the same switch -- and `wantlist` (#83), the want-list watcher, on the
 * `poll` tick like `price`, reading pasted pages here; `createPlugin` swaps in one that also reads
 * BoardGameGeek once `TRACKER_BGG_TOKEN` is set -- and `wantjudge` (#83), the same watch with the
 * model looking at each new listing first (docket-types' `wantjudge`): an execute-lane type, under the
 * execute lane's switch, its plain-code reads through the same Fetch port -- and `news` (plan item
 * 153), the news watch (docket-types' `news`), an execute-lane type under the same switch.
 *
 * These are the types without a database: the want-list pair here reads pasted pages only, and
 * `research` runs web requests only (a browser request here is told it cannot be run). `createPlugin`
 * builds the pair it runs over `wantSources`, adding the `inbox` source (the listings sent in for a
 * watch, inbox.ts) over the database it opens, and BGG when its token is set, and the research type
 * over `readSources` (the pages a browser gathered for a request, research-sources.ts, 0.28.0).
 */
export const TRACKER_TYPES: Readonly<Record<string, TaskType<unknown>>> = Object.freeze({
  reminder: reminder as TaskType<unknown>,
  renewal: renewal as TaskType<unknown>,
  price: price as TaskType<unknown>,
  research: researchType() as TaskType<unknown>,
  scout: scout as TaskType<unknown>,
  news: news as TaskType<unknown>,
  wantlist: wantlistType({ page: pageSource }) as TaskType<unknown>,
  wantjudge: wantjudgeType({ page: pageSource }) as TaskType<unknown>,
});

/**
 * The want-list pair over `sources`: docket-types' `wantlist` and `wantjudge`, which read a watch's
 * listings through whichever source its config names (a page, BGG, or its inbox).
 */
export function wantTypes(sources: Partial<Record<SourceId, Source>>): { wantlist: TaskType<unknown>; wantjudge: TaskType<unknown> } {
  return { wantlist: wantlistType(sources) as TaskType<unknown>, wantjudge: wantjudgeType(sources) as TaskType<unknown> };
}

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
  /** Test seam: a BGG source in place of the token's (docket-types' `bggSource`), as if `TRACKER_BGG_TOKEN` were set. */
  bgg?: Source;
  /** Test seam: a Shopify source in place of the key's (docket-types' `shopifySource`), as if `TRACKER_FIRECRAWL_KEY` were set. */
  shopify?: Source;
  /** Test seam for the key's Firecrawl calls (firecrawl.ts). */
  firecrawlFetch?: typeof fetch;
  /** Test seam: an eBay source in place of the keys' (docket-types' `ebaySource`), as if `TRACKER_EBAY_CLIENT_*` were set. */
  ebay?: Source;
  /** Test seam for the keys' eBay calls (ebay.ts). */
  ebayFetch?: typeof fetch;
  /** Test seam for the token's BGG reads: the name lookup and HTTP under `createBggFetch`, which still decides raw and redirects. */
  bggNetwork?: Pick<PageFetchOptions, "resolve" | "fetchImpl">;
  /** Test seam: each execute tick's background work as it starts, so a test can await it. */
  executeStarted?: (work: Promise<void>) => void;
  /** Test seam: false leaves the daily digest (digest.ts) off the notify tick, for tests that count every DM. On by default. */
  digest?: boolean;
  /** Test seam for the usr link's HTTP (usr.ts). */
  usrFetch?: typeof fetch;
  /** Test seam: forget-me's wait for a running tick, in ms (admin.ts `TICK_WAIT_MS` by default). */
  tickWaitMs?: number;
  /** Test seam: an Executor for the intake's turns (intake.ts) in place of the city-hall one; `executor` otherwise. */
  intakeExecutor?: Executor;
  /** Test seams for the intake's wait on a turn: its sleep, its poll interval and its limit, in ms. */
  intakeSleep?: (ms: number) => Promise<void>;
  intakePollMs?: number;
  intakeWaitMs?: number;
}

/**
 * `TickGate.idle`: waits until `running` (the ticks in flight, removed as each settles) is empty, at
 * most `ms`. True when it emptied, false when the time ran out with one still running.
 */
export async function idleWithin(running: ReadonlySet<Promise<unknown>>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (running.size > 0) {
    const left = until - Date.now();
    if (left <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...running]), new Promise((r) => (timer = setTimeout(r, left)))]);
    clearTimeout(timer);
  }
  return true;
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
  // The link to our usr (usr.ts): checked at load, so a half-set link refuses to start; off while unset.
  const usrConfig = parseUsrConfig(host.env);
  const delegates = parseDelegates(host.env, usrConfig !== null);
  // The alert-email route (mail.ts): both settings or neither, checked at load.
  const mailConfig = parseMailConfig(host.env);
  const usrClient = usrConfig ? createUsrClient({ config: usrConfig, ...(options.usrFetch ? { fetchImpl: options.usrFetch } : {}) }) : null;
  // Budgets off for the alpha (roshne, 2026-10-02): no daily ceiling holds a run; usage is still recorded.
  const budgetUnlimited = parseBudgetUnlimited(host.env[BUDGET_UNLIMITED_KEY]);
  const cityHallConfig: CityHallConfig | null = cityHall.config;
  // The plain-language intake (intake.ts): who may DM Clerk a request, and the tag its turns name.
  const intakeMode = parseIntakeMode(host.env[INTAKE_KEY]);
  const intakeCapability = parseIntakeCapability(host.env[INTAKE_CAPABILITY_KEY]);
  const intakeIds = new IntakeJobIds();
  // The execute lane runs only when fully set up (or a test hands an Executor in).
  const executeOn = cityHallConfig !== null || options.executor !== undefined;
  const clock: Clock = options.clock ?? { now: () => new Date() };
  const bggToken = parseBggToken(host.env.TRACKER_BGG_TOKEN);
  // BGG's answers are XML, read by docket-types' own bounded BGG parser: the raw body, fenced like every read.
  const bgg = options.bgg ?? (bggToken ? bggSource({ token: bggToken, fetch: createBggFetch(options.bggNetwork ?? {}) }) : null);
  // Shopify's store search for want-list watches (firecrawl.ts), only with a Firecrawl key.
  const firecrawlKey = parseFirecrawlKey(host.env.TRACKER_FIRECRAWL_KEY);
  const shopify =
    options.shopify ?? (firecrawlKey ? shopifySource(createFirecrawlScrape({ key: firecrawlKey, ...(options.firecrawlFetch ? { fetchImpl: options.firecrawlFetch } : {}) })) : null);
  // eBay's own Browse API for want-list watches (ebay.ts), only with the eBay keys: the one way the tracker reads eBay.
  const ebayKeys = parseEbayKeys(host.env);
  const ebay = options.ebay ?? (ebayKeys ? ebaySource(createEbayBrowse({ keys: ebayKeys, ...(options.ebayFetch ? { fetchImpl: options.ebayFetch } : {}) })) : null);
  // The want-list inboxes (inbox.ts) live in the database `activate()` opens; until then, and after
  // `dispose()`, an inbox reads as empty (no tick runs then anyway). An eBay watch, and a BGG one
  // made while the bot has no BGG token, get their listings only this way: the want-list watcher
  // never opens eBay, and an inbox watch opens neither site (Rod, 2026-10-05).
  let inbox: WantInbox | null = null;
  const readInbox: ReadInbox = async (key) => inbox?.read(key) ?? [];
  // The pages gathered for a browser research request (research-sources.ts) live there too, and read
  // as none the same way: a run that finds none makes no model call and tells the owner.
  let sources: ResearchSources | null = null;
  const readSources: ReadSources = async (taskId) => sources?.read(taskId) ?? [];
  // Only with the web area, whose task API is the one way pages arrive: without it, docket-types
  // 0.9.0 would DM a first answer asking for pages nobody could send and wait 14 days for them.
  const types = options.types ?? {
    ...TRACKER_TYPES,
    research: researchType(webOrigin ? { readSources } : {}) as TaskType<unknown>,
    ...wantTypes({ page: pageSource, inbox: inboxSource(readInbox), ...(bgg ? { bgg } : {}), ...(shopify ? { shopify } : {}), ...(ebay ? { ebay } : {}) }),
  };
  const pageFetch = options.fetch ?? ((signal?: AbortSignal) => createPageFetch(signal ? { signal } : {}));
  const health: HealthState = { activatedAt: null, lastTickAt: null, blocked: null };
  let db: Database | null = null;
  let store: SqliteStore | null = null;
  let delivery: DeliveryHealth | null = null;
  let deps: TrackerDeps | null = null;
  let warnedNoDm = false;
  let executeLane: ExecuteLane | null = null;
  let jobRecords: JobRecords | null = null;
  let conversations: IntakeConversations | null = null;
  let intakeExecutor: Executor | null = null;
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
    // eBay API watches' DMs are not kept past six hours (ebay-forget.ts).
    if (kind === "notify" && db) forgetEbay(db, false);
    // Idle intake conversations close, and week-old ended ones go (intake-store.ts).
    if (kind === "notify" && conversations) {
      try {
        conversations.purge(clock.now());
      } catch (err) {
        host.log.warn(`intake: clearing old conversations failed (${err instanceof Error ? err.name : "error"})`);
      }
    }
    // The daily digest (plan 5.5, digest.ts), after the runs due now: a reminder never waits on it.
    if (kind === "notify" && options.digest !== false && deps && store) {
      const r = await runDigests({ store, notifier: deps.notifier, log: host.log, ...(delivery ? { health: delivery } : {}) }, clock.now(), signal);
      if (r.failed > 0) host.log.warn(`digest: ${r.sent} sent, ${r.failed} failed`);
    }
  }

  /** ebay-forget.ts, never in the way of the digest or a tick: a failure is logged. */
  function forgetEbay(on: Database, sweepAll: boolean): void {
    try {
      forgetEbayMessages(on, clock.now(), sweepAll);
    } catch (err) {
      host.log.warn(`ebay: clearing old eBay DMs failed (${err instanceof Error ? err.name : "error"})`);
    }
  }

  // The ticks still running (one the host stopped waiting on included): forget-me waits for none
  // to be, so a DM in flight to the person cannot write about them after they are erased (admin.ts),
  // and so does `dispose()`, before it closes the database.
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
    idle: (ms) => idleWithin(running, ms),
  };

  /**
   * The execute lane (execute-lane.ts), started in the background so it never holds up a host tick:
   * one at a time, at most once per host tick (a second call within `EXECUTE_MIN_GAP_MS` is skipped),
   * tracked like the other ticks so forget-me waits for it. Not a full minute: the host's rounds start
   * a minute apart, and this tick runs after every earlier check of the round, however long they took.
   */
  function startExecute(): void {
    if (!store || !executeLane || executeRun || forgetting > 0) return;
    const at = clock.now().getTime();
    if (at - lastExecute < EXECUTE_MIN_GAP_MS) return;
    lastExecute = at;
    const lane = executeLane;
    const records = jobRecords;
    const work = (async () => {
      try {
        const r = await lane.tick();
        if (r.failed > 0) host.log.warn(`execute lane: ${r.ran} ran, ${r.failed} failed`);
        // The record of a Job whose run is gone, or finished a month ago, goes (executor.ts).
        if (records && store) records.prune(clock.now());
        // So do the gathered pages of a research request that has ended (research-sources.ts).
        if (sources && store) sources.purgeEnded();
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

  // The web area's member re-check, the task API's and intake's need Discord. The host's own lookup
  // (`host.member`, rackbops-discord-bot#623) answers with no interaction, so a restart blocks
  // nobody; an older host has none, and then the lookup asks through the discord.js Client of the
  // last interaction the plugin handled (`interaction.client` is the bot's one long-lived Client),
  // held here only, never stored, and none until the first one.
  let discordClient: Interactionish["client"] | null = null;
  const capture = (interaction: unknown) => {
    const client = (interaction as { client?: Interactionish["client"] }).client;
    if (client) discordClient = client;
  };
  const hostMember = typeof host.member === "function" ? host.member.bind(host) : null;
  const clientMembership = async (discordId: string): Promise<Membership | null> => {
    const fetch = hostMember ? hostMemberFetch(hostMember) : discordClient ? clientMemberFetch(discordClient) : null;
    if (!fetch) return null;
    // `client` is read only by lookupMembership's default fetch, and a fetch is always passed here.
    const asking = { guildId: null, user: { id: discordId }, client: discordClient as Interactionish["client"] };
    return lookupMembership(asking, guildIds, discordId, host.log, roleGate, fetch);
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
  const intake = createIntake({
    mode: intakeMode,
    deps: () => deps,
    conversations: () => conversations,
    executor: () => intakeExecutor,
    ids: intakeIds,
    queue,
    // As a command's: no gate without TRACKER_GUILD_ID; with one, the host's lookup, or on an older
    // host unknown until an interaction gave the Client.
    membership: async (discordId) => (guildIds === null ? "not-checked" : ((await clientMembership(discordId)) ?? "unknown")),
    log: host.log,
    ...(options.intakeSleep ? { sleep: options.intakeSleep } : {}),
    ...(options.intakePollMs !== undefined ? { pollMs: options.intakePollMs } : {}),
    ...(options.intakeWaitMs !== undefined ? { waitMs: options.intakeWaitMs } : {}),
  });

  return {
    commands: surface.commands.map((c) => ({
      ...c,
      handle: (interaction) => {
        capture(interaction);
        return c.handle(interaction);
      },
    })),
    interactions: async (interaction) => {
      capture(interaction);
      // A draft card's Save, Change or Cancel (intake.ts); every other press as before.
      if (parseIntakeId(interaction.customId) && interaction.isMessageComponent() && (await intake.press(interaction))) return;
      return interactions(interaction);
    },

    // A DM a person sent the bot (rackbops-discord-bot's DM seam): the intake reads it while TRACKER_INTAKE is on.
    directMessage: (message) => intake.directMessage(message),

    async activate() {
      let path = options.dbPath;
      if (path === undefined) {
        const dir = join(host.dataDir, DB_DIR);
        mkdirSync(dir, { recursive: true });
        path = join(dir, DB_FILE);
      }
      const opened = openDatabase(path);
      try {
        const openedStore = new SqliteStore(opened);
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
        // Built as locals and kept only once every call that can throw is past (#203): a start that
        // fails part way leaves no handle a tick could find, and its database closed (below).
        const openedInbox = new WantInbox(opened);
        const openedSources = new ResearchSources(opened);
        const openedConversations = new IntakeConversations(opened);
        // The owner of a task a recipient's failures paused is told once, by a plain DM: not counted
        // toward the owner's own pause (they may simply be offline), and `/tasks` shows it regardless.
        const openedDelivery = new DeliveryHealth(opened, openedStore, {
          log: host.log,
          ...(dm
            ? {
                tellOwner: async (owner, text) => {
                  if (owner.discordId) await dm(owner.discordId, { content: text });
                },
              }
            : {}),
        });
        const notifier = dm ? createDmNotifier({ store: openedStore, dm, clock, log: host.log, health: openedDelivery }) : NO_DM;
        let executor: Executor | null = null;
        let records: JobRecords | null = null;
        if (options.executor) executor = options.executor;
        else if (cityHallConfig) {
          records = new JobRecords(opened);
          executor = createCityHallExecutor({
            config: cityHallConfig,
            records,
            databaseId: databaseId(opened),
            log: host.log,
            now: () => clock.now(),
            notice: async (key, text) => void (await noticeOnce(openedStore, notifier, key, clock.now(), { text })),
            ...(options.cityHallFetch ? { fetchImpl: options.cityHallFetch } : {}),
          });
        }
        // The intake's turns: their own city-hall Executor, Job ids in memory (intake.ts), its own tag when set.
        let turns: Executor | null = options.intakeExecutor ?? options.executor ?? null;
        if (!turns && cityHallConfig) {
          turns = createCityHallExecutor({
            config: { ...cityHallConfig, capability: intakeCapability ?? cityHallConfig.capability },
            records: intakeIds,
            databaseId: databaseId(opened),
            log: host.log,
            now: () => clock.now(),
            // No admin notices: every turn is a new Job key, so they would come once per DM. The person
            // hears that the assistant is busy, and the execute lane's own Executor tells the admins.
            ...(options.cityHallFetch ? { fetchImpl: options.cityHallFetch } : {}),
          });
        }
        if (intakeMode !== "off") {
          if (turns) host.log.info(`intake on for ${intakeMode}${cityHallConfig ? `, capability ${intakeCapability ?? cityHallConfig.capability}` : ""}`);
          else host.log.warn(`${INTAKE_KEY} is ${intakeMode}, but the execute lane is off, so a DM is answered that the assistant is not set up`);
        }
        // One docket Lanes for the execute lane while active: it keeps the usage-limit pause (execute-lane.ts).
        // Its budget is docket's defaults with each person's raised ceiling read before every run (ceilings.ts),
        // or none at all while TRACKER_BUDGET_UNLIMITED is on (usage.ts).
        const ceilings = new Ceilings(opened);
        const lane = executor ? new ExecuteLane({ store: openedStore, clock, types, notifier, executor, locks, fetch: pageFetch(), budget: executeBudget(ceilings, budgetUnlimited) }) : null;
        // One line either way: the budgets-off line only when a model run can actually happen.
        if (budgetUnlimited) host.log.info(lane ? UNLIMITED_LOG : UNLIMITED_IDLE_LOG);
        if (cityHallConfig) host.log.info(`execute lane on: city-hall ${cityHallConfig.url}, capability ${cityHallConfig.capability}`);
        else if ("missing" in cityHall && cityHall.missing.length > 0) host.log.warn(`execute lane is off, so /research is unavailable: ${cityHall.missing.join(", ")} not set`);
        if (usrConfig) host.log.info(`usr link on: ${usrConfig.url}, app ${usrConfig.app}`);
        if (delegates.size > 0) host.log.info(`task API takes usr delegation tokens from ${[...delegates].join(", ")}`);
        const openedDeps: TrackerDeps = {
          store: openedStore,
          admissions: new Admissions(opened),
          health: openedDelivery,
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
          apiIdempotency: new ApiIdempotency(opened),
          roster: new Roster(opened),
          ceilings,
          budgetUnlimited,
          configuredAdmins: new Set(adminIds),
          lanes,
          ...(options.tickWaitMs !== undefined ? { tickWaitMs: options.tickWaitMs } : {}),
          webEditor: webOrigin !== null,
          research: executeOn,
          bgg: bgg !== null,
          shopify: shopify !== null,
          ebay: ebay !== null,
          inbox: openedInbox,
          sources: openedSources,
          mail: mailConfig ? new MailAddresses(opened, mailConfig.domain) : null,
          usr:
            usrConfig && usrClient
              ? {
                  client: usrClient,
                  url: usrConfig.url,
                  verifier: new UsrVerifier({ url: usrConfig.url, now: () => clock.now().getTime(), ...(options.usrFetch ? { fetchImpl: options.usrFetch } : {}) }),
                  app: usrConfig.app,
                  links: new UsrLinks(opened),
                  delegates,
                }
              : null,
        };
        if (guildIds === null) host.log.warn("TRACKER_GUILD_ID is unset: no membership gate, only the admission list");
        else if (roleGate.roles !== null) host.log.info(`role check on for ${roleGate.roles.size} of ${guildIds.length} server(s)`);
        const activatedAt = clock.now();
        // Nothing from here on can throw.
        db = opened;
        // Every eBay watch run past six hours, once, whatever its age (ebay-forget.ts); the ticks then take the newest.
        forgetEbay(opened, true);
        store = openedStore;
        inbox = openedInbox;
        sources = openedSources;
        conversations = openedConversations;
        intakeExecutor = turns;
        delivery = openedDelivery;
        jobRecords = records;
        executeLane = lane;
        deps = openedDeps;
        health.blocked = dm ? null : "this bot has no host.dm (it predates rackbops-discord-bot#736)";
        health.activatedAt = activatedAt;
      } catch (err) {
        opened.close();
        throw err;
      }
    },

    async dispose() {
      // Null the handles first: a tick that starts after this finds no store and returns instead of
      // touching a closed database.
      health.activatedAt = null;
      deps = null;
      delivery = null;
      executeLane = null;
      jobRecords = null;
      store = null;
      inbox = null;
      sources = null;
      conversations = null;
      intakeExecutor = null;
      const closing = db;
      db = null;
      // A tick already running (notify, poll or execute: each is `tracked`) keeps the store it read,
      // so the database closes once none is, and a DM one sent is recorded as sent. The host's stop
      // aborts the ticks it waits on and drains them for up to 5 s (rackbops-discord-bot's
      // `PLUGIN_TICK_ABORT_GRACE_MS`) before it calls this, so what is left here is what it no longer
      // waits on: the execute lane's background run, or a tick past that grace. One still running
      // after `DISPOSE_WAIT_MS` can fail its last write: a send it made is then logged unconfirmed at
      // the next start and not resent. The host bounds each plugin's dispose at 2 s (#202).
      await lanes.idle(DISPOSE_WAIT_MS);
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
      // eBay's alert emails, from the Email Worker (web/mail-inbound.ts): its own bearer, never a session.
      if (info.path === MAIL_PATH) return handleMailInbound({ config: mailConfig, deps: () => deps, queue }, request);
      return web(request, info);
    },
  };
}
