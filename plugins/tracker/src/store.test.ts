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
    expect(await store.deleteQueuedOccurrences("t1")).toBe(1);
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

  it("vacuums an existing database once, so rows deleted before secure_delete leave no bytes; schema stays 3", () => {
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

      // 0.5.0 still opens it after a downgrade: its migrate() refused only a user_version above its
      // three migrations, and it never reads tracker_meta.
      const again = new Database(path);
      const version = (again.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      expect(version).toBe(3);
      const known050 = 3;
      expect(() => {
        if (version > known050) throw new Error(`tracker database is at schema ${version}, newer than this plugin knows (${known050})`);
      }).not.toThrow();
      expect(MIGRATIONS).toHaveLength(known050);
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
