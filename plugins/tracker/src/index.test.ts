import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Executor, materialize } from "@rackbops/docket-core";
import { SlashCommandBuilder } from "discord.js";
import { makeFakeDelivery, makeFakeHost } from "../../../packages/testkit/index.js";
import pkg from "../package.json" with { type: "json" };
import { createPlugin, DB_DIR, DB_FILE, DISPOSE_WAIT_MS, idleWithin, TRACKER_TYPES } from "./index.js";
import { admit } from "./people.js";
import { MIGRATIONS, openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";
import { CITY_HALL } from "./web/execute-harness.js";
import { slash } from "./web/harness.js";
import { removeDir } from "./test-dirs.js";

const ADMIN = "111111111111111111";
const START = "2026-10-01T12:00:00.000Z";
const dirs: string[] = [];
/** The plugins and databases the tests made on a file in `dirs`. */
const opened: (ReturnType<typeof createPlugin> | Database)[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracker-"));
  dirs.push(dir);
  return dir;
}

/** `x`, disposed (a plugin) or closed (a database) after the test, however it ended. */
function closeAfter<T extends ReturnType<typeof createPlugin> | Database>(x: T): T {
  opened.push(x);
  return x;
}

/**
 * The `afterEach`: closes what the tests opened, and only then removes their directories, since
 * Windows refuses to delete a file still open (#232). A second dispose or close of one a test
 * already closed does nothing. `remove` is for the test of this order, at the end of the file.
 */
async function closeThenRemove(remove: (dir: string) => void = removeDir): Promise<void> {
  const closing = opened.splice(0);
  const removing = dirs.splice(0);
  for (const x of closing) await (x instanceof Database ? x.close() : x.dispose?.());
  for (const d of removing) remove(d);
}

afterEach(() => closeThenRemove());

function clockAt(iso: string) {
  let now = new Date(iso);
  return { now: () => new Date(now), set: (s: string) => (now = new Date(s)), advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const DUE = "2026-10-01T12:01:00.000Z";

/** A data file with one reminder of the admin's due at `DUE`, made before the plugin starts; its occurrence's id. */
async function seedDueReminder(dataDir: string): Promise<string> {
  mkdirSync(join(dataDir, DB_DIR));
  const db = openDatabase(join(dataDir, DB_DIR, DB_FILE));
  const store = new SqliteStore(db);
  const owner = await admit(store, ADMIN, new Date(START));
  const task = await store.createTask({
    ownerId: owner.id,
    type: "reminder",
    title: "stretch",
    config: { text: "stretch" },
    schedule: { kind: "once", at: DUE },
    lane: "notify",
    capabilities: ["notify"],
    at: START,
  });
  const occurrence = await materialize(store, task, owner, new Date(DUE));
  db.close();
  return occurrence?.id ?? "";
}

const healthz = (plugin: ReturnType<typeof createPlugin>) =>
  plugin.http!(new Request("http://x/tracker/healthz"), { path: "/healthz", clientIp: "unknown" });

describe("createPlugin", () => {
  it("is pure and refuses a malformed admin list, naming it", () => {
    expect(() => createPlugin(makeFakeHost({ name: "tracker", env: { TRACKER_ADMIN_DISCORD_IDS: "roshne" } }))).toThrow("TRACKER_ADMIN_DISCORD_IDS");
    const dataDir = tempDir();
    createPlugin(makeFakeHost({ name: "tracker", dataDir, env: { TRACKER_ADMIN_DISCORD_IDS: ADMIN } }));
    expect(existsSync(join(dataDir, DB_DIR, DB_FILE))).toBe(false);
  });

  it("declares exactly the commands it registers, an interactions handler, and the env keys it reads", () => {
    const plugin = createPlugin(makeFakeHost({ name: "tracker" }));
    expect(plugin.commands?.map((c) => c.name)).toEqual(pkg.botPlugin.commands);
    expect(pkg.botPlugin.commands).toEqual(["allow", "register", "remind", "renewal", "price", "research", "scout", "want", "tasks", "task", "settings", "web"]);
    expect(typeof plugin.interactions).toBe("function");
    expect(pkg.botPlugin.intents).toEqual([]);
    expect(pkg.botPlugin.env.map((e) => e.key)).toEqual([
      "TRACKER_ADMIN_DISCORD_IDS",
      "TRACKER_GUILD_ID",
      "TRACKER_GUILD_ROLES",
      "TRACKER_WEB_URL",
      "TRACKER_BUDGET_UNLIMITED",
      "TRACKER_CITY_HALL_URL",
      "TRACKER_CITY_HALL_KEY",
      "TRACKER_CITY_HALL_CAPABILITY",
      "TRACKER_CITY_HALL_ACCESS_CLIENT_ID",
      "TRACKER_CITY_HALL_ACCESS_CLIENT_SECRET",
      "TRACKER_FIRECRAWL_KEY",
      "TRACKER_BGG_TOKEN",
      "TRACKER_USR_URL",
      "TRACKER_USR_KEY",
      "TRACKER_USR_APP",
      "TRACKER_MAIL_DOMAIN",
      "TRACKER_MAIL_KEY",
    ]);
  });

  it("refuses a malformed TRACKER_GUILD_ID, and accepts it unset", () => {
    expect(() => createPlugin(makeFakeHost({ name: "tracker", env: { TRACKER_GUILD_ID: "my server" } }))).toThrow("TRACKER_GUILD_ID");
    createPlugin(makeFakeHost({ name: "tracker", env: { TRACKER_GUILD_ID: "123456789012345678" } }));
    createPlugin(makeFakeHost({ name: "tracker", env: { TRACKER_GUILD_ID: "" } }));
    createPlugin(makeFakeHost({ name: "tracker", env: { TRACKER_GUILD_ID: "123456789012345678,876543210987654321" } }));
    expect(() => createPlugin(makeFakeHost({ name: "tracker", env: { TRACKER_GUILD_ID: "123456789012345678,my server" } }))).toThrow('"my server"');
  });

  it("every command builds into valid slash-command JSON", () => {
    const plugin = createPlugin(makeFakeHost({ name: "tracker" }));
    for (const command of plugin.commands ?? []) {
      const json = command.build(new SlashCommandBuilder().setName(command.name)).toJSON();
      expect(json.name).toBe(command.name);
      expect(json.description.length).toBeGreaterThan(0);
    }
  });
});

describe("the plugin end to end on a real data file", () => {
  it("activates, seeds the admin, delivers a due reminder on its tick, and reports health", async () => {
    const dataDir = tempDir();
    const clock = clockAt(START);
    const delivery = makeFakeDelivery();
    const plugin = closeAfter(createPlugin(makeFakeHost({ name: "tracker", dataDir, env: { TRACKER_ADMIN_DISCORD_IDS: ADMIN }, ...delivery }), { clock }));

    expect((await healthz(plugin)).status).toBe(503);
    await plugin.activate!();
    expect(existsSync(join(dataDir, DB_DIR, DB_FILE))).toBe(true);
    expect((await healthz(plugin)).status).toBe(200);

    // A second connection to the same file stands in for the commands #79 will add.
    const store = new SqliteStore(closeAfter(openDatabase(join(dataDir, DB_DIR, DB_FILE))));
    const owner = await admit(store, ADMIN, clock.now());
    expect(owner.admin).toBe(true);
    const task = await store.createTask({
      ownerId: owner.id,
      type: "reminder",
      title: "stretch",
      config: { text: "stretch" },
      schedule: { kind: "once", at: "2026-10-01T12:01:00.000Z" },
      lane: "notify",
      capabilities: ["notify"],
      at: START,
    });
    const occurrence = await materialize(store, task, owner, clock.now());

    clock.set("2026-10-01T12:01:00.000Z");
    await plugin.ticks![0]!.run(new AbortController().signal);
    expect(delivery.calls.dm).toHaveLength(1);
    expect(delivery.calls.dm[0]).toMatchObject({ userId: ADMIN, message: { content: "stretch" } });
    expect(delivery.calls.dm[0]?.message.buttons?.map((b) => b.label)).toEqual(["Done", "Snooze 1h", "Reply"]);
    expect((await store.getOccurrence(occurrence?.id ?? ""))?.status).toBe("done");
    const ok = await healthz(plugin);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "ok", lastTickAt: "2026-10-01T12:01:00.000Z" });

    clock.set("2026-10-01T12:05:00.000Z");
    expect((await healthz(plugin)).status).toBe(503);

    expect((await plugin.http!(new Request("http://x/tracker/other"), { path: "/other", clientIp: "unknown" })).status).toBe(404);
    await plugin.dispose!();
    expect((await healthz(plugin)).status).toBe(503);
  });

  it("on a host without dm: the lane stays off and /healthz says why", async () => {
    const plugin = closeAfter(createPlugin(makeFakeHost({ name: "tracker", dataDir: tempDir() }), { clock: clockAt(START) }));
    await plugin.activate!();
    await plugin.ticks![0]!.run();
    const res = await healthz(plugin);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { status: string }).status).toBe("blocked");
    await plugin.dispose!();
  });

  it("recovers a run a crash left running after it fired: resumed from its record, its open claim never resent", async () => {
    const dataDir = tempDir();
    const clock = clockAt("2026-10-01T12:01:00.000Z");
    mkdirSync(join(dataDir, DB_DIR));
    const db = closeAfter(openDatabase(join(dataDir, DB_DIR, DB_FILE)));
    const store = new SqliteStore(db);
    const owner = await admit(store, ADMIN, clock.now());
    const task = await store.createTask({
      ownerId: owner.id,
      type: "reminder",
      title: "t",
      config: { text: "t" },
      schedule: { kind: "once", at: "2026-10-01T12:01:00.000Z" },
      lane: "notify",
      capabilities: ["notify"],
      at: START,
    });
    const occurrence = await materialize(store, task, owner, clock.now());
    const id = occurrence?.id ?? "";
    // The crash came mid-send: the run fired (its record stored), its copy planned and claimed.
    const record = { outcome: { notify: { text: "t", actions: ["done" as const] } }, costUsd: null, firedAt: START, appliedAt: START, resumes: 0 };
    await store.updateOccurrence(id, { status: "running", startedAt: START, record });
    await store.planDelivery(id, owner.id, START);
    await store.claimDelivery(id, owner.id, START);
    db.close();

    const delivery = makeFakeDelivery();
    const warnings: string[] = [];
    const plugin = closeAfter(
      createPlugin(
        makeFakeHost({ name: "tracker", dataDir, log: { info() {}, warn: (m) => void warnings.push(m), error() {} }, ...delivery }),
        { clock },
      ),
    );
    await plugin.activate!();
    expect(warnings.some((w) => w.includes("requeued 1 occurrence"))).toBe(true);
    expect(warnings.some((w) => w.includes(`delivery of ${id} to ${owner.id} claimed ${START} is unconfirmed`) && w.includes("will not be resent"))).toBe(true);
    await plugin.ticks![0]!.run();
    expect(delivery.calls.dm).toHaveLength(0);
    const reopened = new SqliteStore(closeAfter(openDatabase(join(dataDir, DB_DIR, DB_FILE))));
    const after = await reopened.getOccurrence(id);
    expect(after?.status).toBe("done");
    expect(after?.record).toEqual(record);
    expect((await reopened.listDeliveries({ occurrenceId: id })).map((d) => [d.status, d.retryAt])).toEqual([["unconfirmed", null]]);
    await plugin.dispose!();
  });

  it("the first start on a 0.8.0 database logs its open and unreported claims once, and resends none", async () => {
    const dataDir = tempDir();
    mkdirSync(join(dataDir, DB_DIR));
    // A schema 4 file as 0.8.0 left it: one claim never settled, one unconfirmed it never reported,
    // one unconfirmed it did report.
    const old = closeAfter(new Database(join(dataDir, DB_DIR, DB_FILE)));
    for (let v = 0; v < 4; v++) {
      old.exec(MIGRATIONS[v] as string);
      old.exec(`PRAGMA user_version = ${v + 1}`);
    }
    const T = "2026-09-30T12:00:00.000Z";
    old.exec(`INSERT INTO delivery_claims (occurrence_id, user_id, discord_id, status, message_id, channel_id, error, claimed_at, settled_at, reported_at)
              VALUES ('o1', 'u1', '111111111111111111', 'claimed', NULL, NULL, NULL, '${T}', NULL, NULL),
                     ('o2', 'u1', '111111111111111111', 'unconfirmed', NULL, NULL, 'socket hang up', '${T}', '${T}', NULL),
                     ('o3', 'u1', '111111111111111111', 'unconfirmed', NULL, NULL, 'reset', '${T}', '${T}', '${T}')`);
    old.close();

    const delivery = makeFakeDelivery();
    const warnings: string[] = [];
    const host = { name: "tracker", dataDir, log: { info() {}, warn: (m: string) => void warnings.push(m), error() {} }, ...delivery };
    const plugin = closeAfter(createPlugin(makeFakeHost(host), { clock: clockAt(START) }));
    await plugin.activate!();
    const claims = warnings.filter((w) => w.startsWith("delivery of "));
    expect(claims).toEqual([
      `delivery of o1 to u1 claimed ${T} is unconfirmed; it will not be resent`,
      `delivery of o2 to u1 claimed ${T} is unconfirmed (socket hang up); it will not be resent`,
    ]);
    await plugin.ticks![0]!.run();
    expect(delivery.calls.dm).toHaveLength(0);
    await plugin.dispose!();
    const reopened = new SqliteStore(closeAfter(openDatabase(join(dataDir, DB_DIR, DB_FILE))));
    expect((await reopened.listDeliveries()).map((d) => [d.occurrenceId, d.status, d.retryAt])).toEqual([
      ["o1", "unconfirmed", null],
      ["o2", "unconfirmed", null],
      ["o3", "unconfirmed", null],
    ]);

    // A second start logs none of them again.
    warnings.length = 0;
    const again = closeAfter(createPlugin(makeFakeHost(host), { clock: clockAt(START) }));
    await again.activate!();
    expect(warnings.filter((w) => w.startsWith("delivery of "))).toEqual([]);
    await again.dispose!();
  });

  it("a run a crash left running before it fired goes back unstarted and runs once", async () => {
    const dataDir = tempDir();
    const clock = clockAt("2026-10-01T12:01:00.000Z");
    mkdirSync(join(dataDir, DB_DIR));
    const db = closeAfter(openDatabase(join(dataDir, DB_DIR, DB_FILE)));
    const store = new SqliteStore(db);
    const owner = await admit(store, ADMIN, clock.now());
    const task = await store.createTask({
      ownerId: owner.id,
      type: "reminder",
      title: "t",
      config: { text: "t" },
      schedule: { kind: "once", at: "2026-10-01T12:01:00.000Z" },
      lane: "notify",
      capabilities: ["notify"],
      at: START,
    });
    const occurrence = await materialize(store, task, owner, clock.now());
    await store.updateOccurrence(occurrence?.id ?? "", { status: "running", startedAt: START });
    db.close();

    const delivery = makeFakeDelivery();
    const plugin = closeAfter(createPlugin(makeFakeHost({ name: "tracker", dataDir, ...delivery }), { clock }));
    await plugin.activate!();
    const reopened = new SqliteStore(closeAfter(openDatabase(join(dataDir, DB_DIR, DB_FILE))));
    expect((await reopened.getOccurrence(occurrence?.id ?? ""))?.startedAt).toBeNull();
    await plugin.ticks![0]!.run();
    await plugin.ticks![0]!.run();
    expect(delivery.calls.dm).toHaveLength(1);
    expect((await reopened.listDeliveries({ occurrenceId: occurrence?.id ?? "" })).map((d) => d.status)).toEqual(["sent"]);
    await plugin.dispose!();
  });

  it("a tick that starts after dispose touches nothing", async () => {
    const dataDir = tempDir();
    const delivery = makeFakeDelivery();
    const plugin = closeAfter(createPlugin(makeFakeHost({ name: "tracker", dataDir, ...delivery }), { clock: clockAt(START) }));
    await plugin.activate!();
    await plugin.dispose!();
    await plugin.ticks![0]!.run(new AbortController().signal);
    expect(delivery.calls.dm).toHaveLength(0);
  });

  it("a start that fails after the database opened closes it and keeps nothing", async () => {
    // A throw from the host's log: the last call in activate(), after every handle used to be set,
    // and one part way, after the execute lane is built.
    async function failedStart(line: string, env: Record<string, string>) {
      const dataDir = tempDir();
      await seedDueReminder(dataDir);
      const delivery = makeFakeDelivery();
      const started: Promise<void>[] = [];
      const refuse = (m: string) => {
        if (m.startsWith(line)) throw new Error(`the log refused: ${line}`);
      };
      const host = makeFakeHost({ name: "tracker", dataDir, env, log: { info: refuse, warn: refuse, error() {} }, ...delivery });
      const plugin = createPlugin(host, { clock: clockAt(DUE), executeStarted: (p) => void started.push(p) });
      await expect(plugin.activate!()).rejects.toThrow(`the log refused: ${line}`);
      // SQLite removes the -wal file when the last connection to the database closes.
      expect(existsSync(join(dataDir, DB_DIR, `${DB_FILE}-wal`))).toBe(false);
      expect((await healthz(plugin)).status).toBe(503);
      for (const t of plugin.ticks ?? []) await t.run(new AbortController().signal);
      expect(delivery.calls.dm).toHaveLength(0);
      expect(started).toHaveLength(0);
      expect(await slash(plugin, "tasks", ADMIN)).toBe("The tracker is starting up; try again in a minute.");
    }
    await failedStart("TRACKER_GUILD_ID is unset", {});
    await failedStart("execute lane on: city-hall", CITY_HALL);
  });

  /** A plugin with the reminder due whose DMs wait on a gate the test holds; `dmCalled` settles at the first DM. */
  async function heldDm() {
    const dataDir = tempDir();
    const occurrenceId = await seedDueReminder(dataDir);
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let reached = () => {};
    const dmCalled = new Promise<void>((r) => (reached = r));
    const dm = async () => {
      reached();
      await gate;
      return { guildId: null, channelId: "c", messageId: "m" };
    };
    const plugin = createPlugin(makeFakeHost({ name: "tracker", dataDir, dm }), { clock: clockAt(DUE) });
    await plugin.activate!();
    const ticking = plugin.ticks![0]!.run(new AbortController().signal);
    await dmCalled;
    return { dataDir, occurrenceId, plugin, release, ticking };
  }

  it("dispose waits for a notify tick in flight, so its DM is recorded as sent", async () => {
    const w = await heldDm();
    const disposing = w.plugin.dispose!();
    w.release();
    await disposing;
    await w.ticking;
    const reopened = openDatabase(join(w.dataDir, DB_DIR, DB_FILE));
    expect((await new SqliteStore(reopened).listDeliveries({ occurrenceId: w.occurrenceId })).map((d) => d.status)).toEqual(["sent"]);
    reopened.close();
    // So the next start has no unconfirmed send to report.
    const warnings: string[] = [];
    const again = createPlugin(makeFakeHost({ name: "tracker", dataDir: w.dataDir, log: { info() {}, warn: (m) => void warnings.push(m), error() {} } }), { clock: clockAt(DUE) });
    await again.activate!();
    expect(warnings.filter((m) => m.includes("unconfirmed"))).toEqual([]);
    await again.dispose!();
  });

  // A longer timeout than bun's 5 s, so a wait past the host's bound fails on the bound itself.
  it("dispose stops waiting after DISPOSE_WAIT_MS", async () => {
    const w = await heldDm();
    const begun = performance.now();
    await w.plugin.dispose!();
    const took = performance.now() - begun;
    expect(DISPOSE_WAIT_MS).toBe(1_500);
    expect(took).toBeGreaterThanOrEqual(DISPOSE_WAIT_MS - 50);
    expect(took).toBeLessThan(2_000);
    // The tick ends now, its write after the DM failing on the closed database: expected here.
    w.release();
    await w.ticking.catch(() => {});
  }, 10_000);

  it("closes the database and stays inactive when activate() fails", async () => {
    const dataDir = tempDir();
    mkdirSync(join(dataDir, DB_DIR));
    // A database from a newer plugin: activate() must refuse it and leave nothing open.
    const db = closeAfter(openDatabase(join(dataDir, DB_DIR, DB_FILE)));
    db.exec("PRAGMA user_version = 99");
    db.close();
    const plugin = closeAfter(createPlugin(makeFakeHost({ name: "tracker", dataDir }), { clock: clockAt(START) }));
    await expect(plugin.activate!()).rejects.toThrow("newer than this plugin knows");
    expect((await healthz(plugin)).status).toBe(503);
    await plugin.ticks![0]!.run();
  });

  it("health goes 503 on dispose and back to 200 on a second activate, with the data kept", async () => {
    const dataDir = tempDir();
    const clock = clockAt(START);
    const plugin = closeAfter(createPlugin(makeFakeHost({ name: "tracker", dataDir, env: { TRACKER_ADMIN_DISCORD_IDS: ADMIN }, ...makeFakeDelivery() }), { clock }));
    await plugin.activate!();
    await plugin.ticks![0]!.run();
    expect((await healthz(plugin)).status).toBe(200);
    await plugin.dispose!();
    expect((await healthz(plugin)).status).toBe(503);
    await plugin.activate!();
    expect((await healthz(plugin)).status).toBe(200);
    await plugin.dispose!();
    const store = new SqliteStore(closeAfter(openDatabase(join(dataDir, DB_DIR, DB_FILE))));
    expect((await store.findUserByDiscordId(ADMIN))?.admin).toBe(true);
  });

  it("registers reminder, renewal and price (#81), research (#82) and the scout (#83), the execute-lane types, which run only with an Executor, and the want-list watcher, plain and judged (#83)", () => {
    expect(Object.keys(TRACKER_TYPES).sort()).toEqual(["price", "reminder", "renewal", "research", "scout", "wantjudge", "wantlist"]);
  });
});

describe("the execute tick", () => {
  /** A plugin with an Executor handed in, no run ever due, counting the lane's starts; `execute` lets each start settle. */
  async function executing() {
    const clock = clockAt(START);
    const started: Promise<void>[] = [];
    const executor: Executor = {
      async run() {
        throw new Error("no execute-lane run is due in these tests");
      },
    };
    const plugin = createPlugin(makeFakeHost({ name: "tracker", dataDir: tempDir() }), { clock, executor, executeStarted: (p) => void started.push(p) });
    await plugin.activate!();
    const execute = async () => {
      await plugin.ticks!.find((t) => t.name === "execute")!.run(new AbortController().signal);
      await Promise.all(started);
    };
    return { plugin, clock, started, execute };
  }

  it("the execute lane starts on a host tick that comes a little under a minute after the last", async () => {
    const w = await executing();
    await w.execute();
    expect(w.started).toHaveLength(1);
    // This round's earlier checks took 50 ms less than the last round's.
    w.clock.advance(59_950);
    await w.execute();
    expect(w.started).toHaveLength(2);
    await w.plugin.dispose!();
  });

  it("a second execute tick within 5 s starts nothing", async () => {
    const w = await executing();
    await w.execute();
    w.clock.advance(4_999);
    await w.execute();
    expect(w.started).toHaveLength(1);
    w.clock.advance(1);
    await w.execute();
    expect(w.started).toHaveLength(2);
    await w.plugin.dispose!();
  });

  it("a round after a slow one still starts the lane", async () => {
    const w = await executing();
    await w.execute();
    // The last round's earlier checks took 30.5 s (a poll tick near its bound), this round's 0.1 s.
    w.clock.advance(29_600);
    await w.execute();
    expect(w.started).toHaveLength(2);
    await w.plugin.dispose!();
  });
});

describe("this file's cleanup (#232)", () => {
  it("closes every plugin and database a test opened before it removes the directory", async () => {
    const dataDir = tempDir();
    const path = join(dataDir, DB_DIR, DB_FILE);
    const plugin = closeAfter(createPlugin(makeFakeHost({ name: "tracker", dataDir }), { clock: clockAt(START) }));
    await plugin.activate!();
    closeAfter(openDatabase(path));
    expect(existsSync(`${path}-wal`)).toBe(true);
    // SQLite deletes a database's write-ahead log when its last connection closes, so a log still
    // there when the directory is removed is a plugin or a connection still open.
    const walAtRemoval: boolean[] = [];
    await closeThenRemove((dir) => {
      walAtRemoval.push(existsSync(`${path}-wal`));
      removeDir(dir);
    });
    expect(walAtRemoval).toEqual([false]);
    expect(existsSync(dataDir)).toBe(false);
  });
});

describe("idleWithin, forget-me's wait for the ticks (#160)", () => {
  it("is true at once with no tick, false when one outlasts the wait, and true once the last one ends", async () => {
    const running = new Set<Promise<unknown>>();
    expect(await idleWithin(running, 50)).toBe(true);
    let end = () => {};
    const held = new Promise<void>((r) => (end = r));
    // Removed as it settles, as index.ts's `tracked` does.
    running.add(held);
    void held.then(() => running.delete(held));
    const started = Date.now();
    expect(await idleWithin(running, 30)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    const waiting = idleWithin(running, 5_000);
    end();
    expect(await waiting).toBe(true);
  });
});
