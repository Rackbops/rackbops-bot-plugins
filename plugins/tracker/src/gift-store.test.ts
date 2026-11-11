import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { GIFT_STORE_CONTRACT, GiftLedger, type GiftWriteMeta } from "@rackbops/docket-core";
import { GIFT_TABLES, SqliteGiftStore, ensureGiftTables } from "./gift-store.js";
import { admit } from "./people.js";
import { Roster } from "./roster.js";
import { MIGRATIONS, migrate, openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";
import { removeDir } from "./test-dirs.js";

const AT = "2026-11-11T12:00:00.000Z";

describe("SqliteGiftStore passes docket's GIFT_STORE_CONTRACT", () => {
  for (const c of GIFT_STORE_CONTRACT) {
    it(c.name, async () => {
      await c.run(new SqliteGiftStore(openDatabase(":memory:")));
    });
  }
});

const meta = (ownerId: string, idempotencyKey?: string): GiftWriteMeta => ({
  ownerId,
  actor: ownerId,
  source: "web",
  at: AT,
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});

const person = (displayName: string) => ({
  displayName,
  kind: "person" as const,
  memberIds: [],
  labels: [],
  interests: [],
  avoid: [],
  notes: null,
});

/** Every table's rows, for "nothing changed". */
function snapshot(db: Database, tables: readonly string[]): string {
  return JSON.stringify(tables.map((t) => [t, db.query(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
}

function tablesOf(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
}

/** One row in every table, its columns filled by declared type: a database at today's schema, in use. */
function fillEveryTable(db: Database): void {
  for (const table of tablesOf(db)) {
    if (table === "sqlite_sequence") continue;
    const columns = (db.query(`PRAGMA table_info(${table})`).all() as { name: string; type: string; pk: number }[]).filter(
      (c) => !(c.pk === 1 && c.name === "seq"),
    );
    const values = columns.map((c) => (c.type === "INTEGER" ? 7 : c.type === "REAL" ? 1.5 : `${table}.${c.name}`));
    db.query(`INSERT INTO ${table} (${columns.map((c) => c.name).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
  }
}

describe("the gift tables are added without a schema version", () => {
  it("upgrade: a database at schema 13 with a row in every table reads back unchanged after the gift tables arrive", () => {
    const dir = mkdtempSync(join(tmpdir(), "gifts-upgrade-"));
    try {
      const path = join(dir, "tracker.sqlite");
      const old = new Database(path, { create: true });
      migrate(old); // the numbered schema only, as tracker 0.43.0 leaves it
      fillEveryTable(old);
      const before = tablesOf(old);
      const rows = snapshot(old, before);
      const schema = JSON.stringify(old.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all());
      old.close();

      const db = openDatabase(path);
      try {
        expect(snapshot(db, before)).toBe(rows);
        const now = db.query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE '%gift_%' ORDER BY name").all();
        expect(JSON.stringify(now)).toBe(schema);
        expect(tablesOf(db).filter((t) => !before.includes(t)).sort()).toEqual([...GIFT_TABLES].sort());
        expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(13);
      } finally {
        db.close();
      }
    } finally {
      removeDir(dir);
    }
  });

  it("rollback: a database holding gifts stays at schema 13, which tracker 0.43.0's own check accepts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gifts-rollback-"));
    try {
      const path = join(dir, "tracker.sqlite");
      const db = openDatabase(path);
      await new GiftLedger(new SqliteGiftStore(db)).create("recipient", meta("u1"), person("Ann"));
      db.close();
      // tracker 0.43.0's migrate refuses only `user_version > 13`, the length of its MIGRATIONS.
      expect(MIGRATIONS.length).toBe(13);
      const older = new Database(path);
      try {
        expect((older.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(13);
        expect(migrate(older)).toBe(13);
      } finally {
        older.close();
      }
    } finally {
      removeDir(dir);
    }
  });

  it("is idempotent: opening again keeps the gifts", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteGiftStore(db);
    const ann = await store.create("recipient", meta("u1"), person("Ann"));
    ensureGiftTables(db);
    new SqliteGiftStore(db);
    expect(await store.get("recipient", "u1", ann.id)).toEqual(ann);
  });
});

describe("SqliteGiftStore beyond the contract", () => {
  it("an id names one kind: another kind's prefix, a bad number or another owner's id reads as missing", async () => {
    const store = new SqliteGiftStore(openDatabase(":memory:"));
    const occasion = await store.create("occasion", meta("u1"), {
      kind: "christmas",
      title: "Christmas 2026",
      date: "2026-12-25",
      timeZone: null,
      year: 2026,
      currency: "USD",
      budgetMinor: null,
      groupIds: [],
      includeIds: [],
      excludeIds: [],
    });
    const ann = await store.create("recipient", meta("u1"), person("Ann"));
    const row = await store.create("occasionRecipient", meta("u1"), {
      occasionId: occasion.id,
      recipientId: ann.id,
      target: null,
      budgetMinor: null,
      decision: "planning",
      skipReason: null,
    });
    expect([occasion.id, ann.id, row.id]).toEqual(["go1", "gr2", "gor3"]);
    expect(await store.get("occasion", "u1", row.id)).toBeNull();
    expect(await store.get("occasionRecipient", "u1", "gor03")).toBeNull();
    expect(await store.get("recipient", "u2", ann.id)).toBeNull();
    expect(await store.list("occasionRecipient", "u1", { occasionId: occasion.id })).toEqual([row]);
  });

  it("ids keep counting after forget-me, so an erased record's id is never handed out again", async () => {
    const store = new SqliteGiftStore(openDatabase(":memory:"));
    const ann = await store.create("recipient", meta("u1"), person("Ann"));
    await store.forgetOwner("u1");
    const bea = await store.create("recipient", meta("u1"), person("Bea"));
    expect([ann.id, bea.id]).toEqual(["gr1", "gr2"]);
  });

  it("forget-me erases the person's gift ledger in its own transaction, and nobody else's", async () => {
    const db = openDatabase(":memory:");
    const people = new SqliteStore(db);
    const larry = await admit(people, "111111111111111111", new Date(AT));
    const curly = await admit(people, "222222222222222222", new Date(AT));
    const store = new SqliteGiftStore(db);
    const gifts = new GiftLedger(store);
    const his = await gifts.create("recipient", meta(larry.id, "k1"), person("Mom"));
    await gifts.update("recipient", his.id, meta(larry.id, "k2"), his.revision, { notes: "scarves" });
    const theirs = await gifts.create("recipient", meta(curly.id, "k1"), person("Dad"));

    const erased = new Roster(db).erase(larry.id);

    expect([erased.rows.gift_records, erased.rows.gift_events, erased.rows.gift_idempotency]).toEqual([1, 2, 2]);
    for (const table of GIFT_TABLES) {
      expect(db.query(`SELECT count(*) AS n FROM ${table} WHERE owner_id = ?`).get(larry.id)).toEqual({ n: 0 });
    }
    expect(await gifts.get("recipient", curly.id, theirs.id)).toMatchObject({ displayName: "Dad" });
    expect((await store.listEvents(curly.id)).length).toBe(1);
  });
});
