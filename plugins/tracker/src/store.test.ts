import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { STORE_CONTRACT } from "@rackbops/docket-core";
import { Admissions } from "./admissions.js";
import { makeFakeHost } from "../../../packages/testkit/index.js";
import { createPlugin } from "./index.js";
import { META_TABLE, MIGRATIONS, migrate, openDatabase, vacuumOnce } from "./schema.js";
import { SqliteStore } from "./store.js";

describe("SqliteStore passes docket's STORE_CONTRACT", () => {
  for (const c of STORE_CONTRACT) {
    it(c.name, async () => {
      await c.run(new SqliteStore(openDatabase(":memory:")));
    });
  }
});

describe("SqliteStore beyond the contract", () => {
  it("ids keep counting after a delete, so a deleted occurrence's id is never handed out again", async () => {
    const store = new SqliteStore(openDatabase(":memory:"));
    const at = "2026-03-02T12:00:00.000Z";
    const a = await store.createOccurrence({ taskId: "t1", lane: "notify", dueAt: at, dedupeKey: "a", at });
    expect(await store.deleteOccurrence(a?.id ?? "")).toBe(true);
    const b = await store.createOccurrence({ taskId: "t1", lane: "notify", dueAt: at, dedupeKey: "b", at });
    expect(a?.id).toBe("o1");
    expect(b?.id).toBe("o2");
  });

  it("an id of another kind, or not an id at all, finds nothing", async () => {
    const store = new SqliteStore(openDatabase(":memory:"));
    const u = await store.createUser({ discordId: "d1", at: "2026-03-02T12:00:00.000Z" });
    expect(await store.getUser(u.id)).not.toBeNull();
    expect(await store.getTask(u.id)).toBeNull();
    expect(await store.getUser("u01")).toBeNull();
    expect(await store.getUser("u1; DROP TABLE users")).toBeNull();
  });

  it("migrating twice is a no-op, and a newer schema than this plugin knows refuses to open", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    db.exec("PRAGMA user_version = 99");
    expect(() => migrate(db)).toThrow(/newer than this plugin knows/);
  });

  it("migrates a 0.1.0 database in place: its people stay, admitted by the configuration, not yet registered", async () => {
    const db = new Database(":memory:");
    db.transaction(() => {
      db.exec(MIGRATIONS[0] as string);
      db.exec("PRAGMA user_version = 1");
    })();
    const old = await new SqliteStore(db).createUser({ discordId: "111111111111111111", at: "2026-09-29T12:00:00.000Z" });
    migrate(db);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    const admissions = new Admissions(db);
    expect(admissions.get(old.id)).toEqual({ userId: old.id, admittedBy: null, admittedAt: "2026-09-29T12:00:00.000Z", registeredAt: null });
    admissions.markRegistered(old.id, "2026-10-01T12:00:00.000Z");
    admissions.markRegistered(old.id, "2026-10-02T12:00:00.000Z");
    admissions.record(old.id, "u9", "2026-10-03T12:00:00.000Z");
    expect(admissions.get(old.id).registeredAt).toBe("2026-10-01T12:00:00.000Z");
    expect(admissions.isRegistered(old.id)).toBe(true);
  });

  it("migrates a 0.8.0 database to docket 0.4.0's store: every row survives, claims become deliveries, never resent", async () => {
    const db = new Database(":memory:");
    for (let v = 0; v < 4; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v] as string);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
    // What 0.8.0 left: a person (usr_subject null, as every release wrote it), a task, a run that was
    // delivered, one left running mid-send, one queued; a price point; a claim of every status.
    const AT = "2026-09-29T12:00:00.000Z";
    const LATER = "2026-09-29T12:05:00.000Z";
    db.exec(`INSERT INTO users (discord_id, usr_subject, display_name, time_zone, preferred_hour, admin, created_at)
             VALUES ('111111111111111111', NULL, 'Larry', 'America/New_York', 8, 1, '${AT}'),
                    ('222222222222222222', NULL, 'Curly', 'UTC', 9, 0, '${AT}')`);
    db.exec(`INSERT INTO tasks (owner_id, type, title, config, state, schedule, lane, capabilities, status, created_at, updated_at)
             VALUES ('u1', 'reminder', 'pills', '{"text":"pills"}', 'null', '{"kind":"calendar","every":1,"unit":"day","start":"2026-09-29","hour":8}', 'notify', '["notify"]', 'active', '${AT}', '${AT}')`);
    db.exec(`INSERT INTO occurrences (task_id, lane, due_at, started_at, finished_at, status, late, dedupe_key, summary, cost_usd, error, created_at)
             VALUES ('t1', 'notify', '${AT}', '${AT}', '${AT}', 'done', 0, 'sched:t1:a', 'sent', NULL, NULL, '${AT}'),
                    ('t1', 'notify', '${LATER}', '${LATER}', NULL, 'running', 0, 'sched:t1:b', NULL, NULL, NULL, '${AT}'),
                    ('t1', 'notify', '2026-09-30T12:00:00.000Z', NULL, NULL, 'queued', 0, 'sched:t1:c', NULL, NULL, NULL, '${AT}')`);
    db.exec(`INSERT INTO events (occurrence_id, agent, type, text, at) VALUES ('o1', 'docket', 'delivered', 'u1 m1', '${AT}')`);
    db.exec(`INSERT INTO series (task_id, at, value, unit, note) VALUES ('t1', '${AT}', 12.5, 'USD', 'observed')`);
    db.exec(`INSERT INTO delivery_claims (occurrence_id, user_id, discord_id, status, message_id, channel_id, error, claimed_at, settled_at, reported_at)
             VALUES ('o1', 'u1', '111111111111111111', 'sent', 'm1', 'c1', NULL, '${AT}', '${AT}', NULL),
                    ('o1', 'u2', '222222222222222222', 'failed', NULL, NULL, 'recipient cannot be messaged', '${AT}', '${AT}', NULL),
                    ('o2', 'u1', '111111111111111111', 'claimed', NULL, NULL, NULL, '${LATER}', NULL, NULL),
                    ('o2', 'u2', '222222222222222222', 'unconfirmed', NULL, NULL, 'socket hang up', '${LATER}', '${LATER}', '${LATER}')`);
    const before = {
      users: db.query("SELECT seq, discord_id, display_name, time_zone, preferred_hour, admin, created_at FROM users ORDER BY seq").all(),
      tasks: db.query("SELECT * FROM tasks ORDER BY seq").all(),
      occurrences: db.query("SELECT * FROM occurrences ORDER BY seq").all(),
      events: db.query("SELECT * FROM events ORDER BY seq").all(),
      series: db.query("SELECT * FROM series ORDER BY seq").all(),
    };

    expect(migrate(db)).toBe(4);
    // `db.query` caches a statement by its text, columns and all; read afresh after the ALTERs.
    const all = (sql: string) => db.prepare(sql).all();
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
    // Every row survives with its values; the new columns are null on the old rows.
    const cols = (t: string) => (all(`PRAGMA table_info(${t})`) as { name: string }[]).map((c) => c.name);
    expect(cols("users")).not.toContain("usr_subject");
    expect(all("SELECT seq, discord_id, display_name, time_zone, preferred_hour, admin, created_at FROM users ORDER BY seq")).toEqual(before.users);
    expect(all("SELECT * FROM tasks ORDER BY seq")).toEqual(before.tasks);
    expect(all("SELECT * FROM occurrences ORDER BY seq")).toEqual(before.occurrences.map((o) => ({ ...(o as object), record: null })));
    expect(all("SELECT * FROM events ORDER BY seq")).toEqual(before.events);
    expect(all("SELECT * FROM series ORDER BY seq")).toEqual(before.series.map((p) => ({ ...(p as object), key: null })));
    expect(all("SELECT name FROM sqlite_master WHERE name = 'delivery_claims'")).toEqual([]);
    expect(all("SELECT name FROM sqlite_master WHERE name = 'users_usr_subject'")).toEqual([]);

    const store = new SqliteStore(db);
    // The claims, as docket's deliveries: none owed, so none is ever sent again.
    expect(
      (await store.listDeliveries()).map((d) => [d.occurrenceId, d.userId, d.status, d.messageId, d.error, d.attempts, d.retryAt, d.claimedAt, d.settledAt]),
    ).toEqual([
      ["o1", "u1", "sent", "m1", null, 0, null, AT, AT],
      ["o1", "u2", "failed", null, "recipient cannot be messaged", 1, null, AT, AT],
      // Never settled, or settled and never reported: left claimed for the first start's recover()
      // to settle and log.
      ["o2", "u1", "claimed", null, null, 0, null, LATER, null],
      ["o2", "u2", "unconfirmed", null, "socket hang up", 0, null, LATER, LATER],
    ]);
    expect(await store.listDeliveries({ dueBefore: "2099-01-01T00:00:00.000Z" })).toEqual([]);
    expect(await store.planDelivery("o2", "u1", LATER)).toBeNull();
    expect(await store.claimDelivery("o2", "u1", LATER)).toBeNull();
    // The store reads the old rows as docket 0.4.0's shapes, and takes the new columns.
    expect((await store.getUser("u1"))?.displayName).toBe("Larry");
    expect((await store.getOccurrence("o1"))?.record).toBeNull();
    expect((await store.listSeries("t1")).map((p) => [p.value, p.key])).toEqual([[12.5, null]]);
    const keyed = await store.addSeriesPoint({ taskId: "t1", at: LATER, value: 11, key: "o2:0" });
    expect((await store.addSeriesPoint({ taskId: "t1", at: LATER, value: 99, key: "o2:0" })).id).toBe(keyed.id);
    expect(await store.requeueRunning()).toEqual(["o2"]);
    expect((await store.getOccurrence("o2"))?.startedAt).toBeNull();
    expect((await store.createUser({ discordId: "333333333333333333", at: LATER })).id).toBe("u3");
    // And it passes as a store: a fresh occurrence, a guarded start, a delivery planned and claimed.
    const o = await store.createOccurrence({ taskId: "t1", lane: "notify", dueAt: LATER, dedupeKey: "sched:t1:d", at: LATER });
    expect((await store.updateOccurrenceIf(o?.id ?? "", "queued", { status: "running" }))?.status).toBe("running");
    expect((await store.planDelivery(o?.id ?? "", "u1", LATER))?.status).toBe("pending");
    expect((await store.claimDelivery(o?.id ?? "", "u1", LATER))?.status).toBe("claimed");
  });

  it("vacuums an existing database once, so rows deleted before secure_delete leave no bytes; the VACUUM bumps no schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracker-vacuum-"));
    try {
      const path = join(dir, "tracker.sqlite");
      const MARK = "MARKER-a1b2c3d4e5f6";
      const old = new Database(path, { create: true });
      old.exec("PRAGMA secure_delete = OFF");
      for (let v = 0; v < 3; v++) {
        old.exec(MIGRATIONS[v] as string);
        old.exec(`PRAGMA user_version = ${v + 1}`);
      }
      old.query("INSERT INTO users (discord_id, display_name, time_zone, preferred_hour, admin, created_at) VALUES ('1', ?, 'UTC', 9, 0, 'x')").run(MARK.repeat(50));
      old.query("DELETE FROM users").run();
      old.close();
      const bytes = () => [path, `${path}-wal`].map((p) => (existsSync(p) ? readFileSync(p).toString("latin1") : "")).join("");
      expect(bytes()).toContain(MARK); // what a copy of the file would still show
      const db = openDatabase(path);
      expect(vacuumOnce(db, path)).toEqual({ ran: true });
      expect(vacuumOnce(db, path)).toEqual({ ran: false }); // once
      db.close();
      expect(bytes()).not.toContain(MARK);

      // The VACUUM is kept outside the versioned schema (tracker_meta): the version is the migrations'
      // alone. A later migration (4, 0.7.0's API tokens; 5, 0.9.0's docket 0.4.0 store) is what
      // blocks a rollback to 0.6.0, whose migrate() refuses a user_version above its three migrations.
      const again = new Database(path);
      const version = (again.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      expect(version).toBe(MIGRATIONS.length);
      expect(MIGRATIONS).toHaveLength(5);
      const known060 = 3;
      expect(() => {
        if (version > known060) throw new Error(`tracker database is at schema ${version}, newer than this plugin knows (${known060})`);
      }).toThrow("newer than this plugin knows");
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a VACUUM that fails does not fail activation: it is logged, and the next start runs it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tracker-vacuum-"));
    try {
      const dbPath = join(dir, "tracker.sqlite");
      openDatabase(dbPath).close(); // an existing database, never vacuumed
      const reader = new Database(dbPath, { readonly: true });
      reader.exec("BEGIN");
      reader.query("SELECT * FROM users").all();
      const warnings: string[] = [];
      const plugin = createPlugin(
        makeFakeHost({ name: "tracker", env: {}, log: { info() {}, warn: (m: string) => void warnings.push(m), error() {} } }),
        { dbPath },
      );
      await plugin.activate!();
      expect(warnings.some((m) => m.includes("could not vacuum the tracker's database"))).toBe(true);
      const marked = () => {
        const db = new Database(dbPath, { readonly: true });
        try {
          return db.query(`SELECT count(*) AS n FROM ${META_TABLE}`).get() as { n: number };
        } finally {
          db.close();
        }
      };
      expect(marked().n).toBe(0);
      reader.exec("COMMIT");
      reader.close();
      await plugin.dispose!();
      warnings.length = 0;
      await plugin.activate!();
      expect(warnings.filter((m) => m.includes("vacuum"))).toEqual([]);
      expect(marked().n).toBe(1);
      await plugin.dispose!();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a file-backed store (WAL) keeps its data across a close and reopen, and keeps counting ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tracker-store-"));
    try {
      const path = join(dir, "tracker.sqlite");
      const at = "2026-03-02T12:00:00.000Z";
      const db = openDatabase(path);
      expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      const first = new SqliteStore(db);
      const u = await first.createUser({ discordId: "111111111111111111", at });
      const t = await first.createTask({ ownerId: u.id, type: "reminder", title: "t", config: { text: "t" }, schedule: null, lane: "notify", capabilities: ["notify"], at });
      await first.createOccurrence({ taskId: t.id, lane: "notify", dueAt: at, dedupeKey: "k", at });
      db.close();

      const again = new SqliteStore(openDatabase(path));
      expect((await again.findUserByDiscordId("111111111111111111"))?.id).toBe(u.id);
      expect((await again.getTask(t.id))?.config).toEqual({ text: "t" });
      expect(await again.createOccurrence({ taskId: t.id, lane: "notify", dueAt: at, dedupeKey: "k", at })).toBeNull();
      expect((await again.createUser({ discordId: "222222222222222222", at })).id).toBe("u2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
