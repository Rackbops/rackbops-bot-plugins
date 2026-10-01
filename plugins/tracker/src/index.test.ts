import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@rackbops/docket-core";
import { SlashCommandBuilder } from "discord.js";
import { makeFakeDelivery, makeFakeHost } from "../../../packages/testkit/index.js";
import pkg from "../package.json" with { type: "json" };
import { createPlugin, DB_DIR, DB_FILE, TRACKER_TYPES } from "./index.js";
import { admit } from "./people.js";
import { MIGRATIONS, openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

const ADMIN = "111111111111111111";
const START = "2026-10-01T12:00:00.000Z";
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracker-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function clockAt(iso: string) {
  let now = new Date(iso);
  return { now: () => new Date(now), set: (s: string) => (now = new Date(s)) };
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
    expect(pkg.botPlugin.commands).toEqual(["allow", "register", "remind", "renewal", "price", "research", "tasks", "task", "settings", "web"]);
    expect(typeof plugin.interactions).toBe("function");
    expect(pkg.botPlugin.intents).toEqual([]);
    expect(pkg.botPlugin.env.map((e) => e.key)).toEqual([
      "TRACKER_ADMIN_DISCORD_IDS",
      "TRACKER_GUILD_ID",
      "TRACKER_WEB_URL",
      "TRACKER_CITY_HALL_URL",
      "TRACKER_CITY_HALL_KEY",
      "TRACKER_CITY_HALL_CAPABILITY",
      "TRACKER_CITY_HALL_ACCESS_CLIENT_ID",
      "TRACKER_CITY_HALL_ACCESS_CLIENT_SECRET",
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
    const plugin = createPlugin(makeFakeHost({ name: "tracker", dataDir, env: { TRACKER_ADMIN_DISCORD_IDS: ADMIN }, ...delivery }), { clock });

    expect((await healthz(plugin)).status).toBe(503);
    await plugin.activate!();
    expect(existsSync(join(dataDir, DB_DIR, DB_FILE))).toBe(true);
    expect((await healthz(plugin)).status).toBe(200);

    // A second connection to the same file stands in for the commands #79 will add.
    const store = new SqliteStore(openDatabase(join(dataDir, DB_DIR, DB_FILE)));
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
    const plugin = createPlugin(makeFakeHost({ name: "tracker", dataDir: tempDir() }), { clock: clockAt(START) });
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
    const db = openDatabase(join(dataDir, DB_DIR, DB_FILE));
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
    const plugin = createPlugin(
      makeFakeHost({ name: "tracker", dataDir, log: { info() {}, warn: (m) => void warnings.push(m), error() {} }, ...delivery }),
      { clock },
    );
    await plugin.activate!();
    expect(warnings.some((w) => w.includes("requeued 1 occurrence"))).toBe(true);
    expect(warnings.some((w) => w.includes(`delivery of ${id} to ${owner.id} claimed ${START} is unconfirmed`) && w.includes("will not be resent"))).toBe(true);
    await plugin.ticks![0]!.run();
    expect(delivery.calls.dm).toHaveLength(0);
    const reopened = new SqliteStore(openDatabase(join(dataDir, DB_DIR, DB_FILE)));
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
    const old = new Database(join(dataDir, DB_DIR, DB_FILE));
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
    const plugin = createPlugin(makeFakeHost(host), { clock: clockAt(START) });
    await plugin.activate!();
    const claims = warnings.filter((w) => w.startsWith("delivery of "));
    expect(claims).toEqual([
      `delivery of o1 to u1 claimed ${T} is unconfirmed; it will not be resent`,
      `delivery of o2 to u1 claimed ${T} is unconfirmed (socket hang up); it will not be resent`,
    ]);
    await plugin.ticks![0]!.run();
    expect(delivery.calls.dm).toHaveLength(0);
    await plugin.dispose!();
    const reopened = new SqliteStore(openDatabase(join(dataDir, DB_DIR, DB_FILE)));
    expect((await reopened.listDeliveries()).map((d) => [d.occurrenceId, d.status, d.retryAt])).toEqual([
      ["o1", "unconfirmed", null],
      ["o2", "unconfirmed", null],
      ["o3", "unconfirmed", null],
    ]);

    // A second start logs none of them again.
    warnings.length = 0;
    const again = createPlugin(makeFakeHost(host), { clock: clockAt(START) });
    await again.activate!();
    expect(warnings.filter((w) => w.startsWith("delivery of "))).toEqual([]);
    await again.dispose!();
  });

  it("a run a crash left running before it fired goes back unstarted and runs once", async () => {
    const dataDir = tempDir();
    const clock = clockAt("2026-10-01T12:01:00.000Z");
    mkdirSync(join(dataDir, DB_DIR));
    const db = openDatabase(join(dataDir, DB_DIR, DB_FILE));
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
    const plugin = createPlugin(makeFakeHost({ name: "tracker", dataDir, ...delivery }), { clock });
    await plugin.activate!();
    const reopened = new SqliteStore(openDatabase(join(dataDir, DB_DIR, DB_FILE)));
    expect((await reopened.getOccurrence(occurrence?.id ?? ""))?.startedAt).toBeNull();
    await plugin.ticks![0]!.run();
    await plugin.ticks![0]!.run();
    expect(delivery.calls.dm).toHaveLength(1);
    expect((await reopened.listDeliveries({ occurrenceId: occurrence?.id ?? "" })).map((d) => d.status)).toEqual(["sent"]);
    await plugin.dispose!();
  });

  it("a tick after dispose, or one the host abandoned across it, touches nothing", async () => {
    const dataDir = tempDir();
    const delivery = makeFakeDelivery();
    const plugin = createPlugin(makeFakeHost({ name: "tracker", dataDir, ...delivery }), { clock: clockAt(START) });
    await plugin.activate!();
    await plugin.dispose!();
    await plugin.ticks![0]!.run(new AbortController().signal);
    expect(delivery.calls.dm).toHaveLength(0);
  });

  it("closes the database and stays inactive when activate() fails", async () => {
    const dataDir = tempDir();
    mkdirSync(join(dataDir, DB_DIR));
    // A database from a newer plugin: activate() must refuse it and leave nothing open.
    const db = openDatabase(join(dataDir, DB_DIR, DB_FILE));
    db.exec("PRAGMA user_version = 99");
    db.close();
    const plugin = createPlugin(makeFakeHost({ name: "tracker", dataDir }), { clock: clockAt(START) });
    await expect(plugin.activate!()).rejects.toThrow("newer than this plugin knows");
    expect((await healthz(plugin)).status).toBe(503);
    await plugin.ticks![0]!.run();
  });

  it("health goes 503 on dispose and back to 200 on a second activate, with the data kept", async () => {
    const dataDir = tempDir();
    const clock = clockAt(START);
    const plugin = createPlugin(makeFakeHost({ name: "tracker", dataDir, env: { TRACKER_ADMIN_DISCORD_IDS: ADMIN }, ...makeFakeDelivery() }), { clock });
    await plugin.activate!();
    await plugin.ticks![0]!.run();
    expect((await healthz(plugin)).status).toBe(200);
    await plugin.dispose!();
    expect((await healthz(plugin)).status).toBe(503);
    await plugin.activate!();
    expect((await healthz(plugin)).status).toBe(200);
    await plugin.dispose!();
    const store = new SqliteStore(openDatabase(join(dataDir, DB_DIR, DB_FILE)));
    expect((await store.findUserByDiscordId(ADMIN))?.admin).toBe(true);
  });

  it("registers reminder, renewal and price (#81) and research (#82), the one execute-lane type, which runs only with an Executor", () => {
    expect(Object.keys(TRACKER_TYPES).sort()).toEqual(["price", "reminder", "renewal", "research"]);
  });
});
