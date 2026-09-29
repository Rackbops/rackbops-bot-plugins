import { describe, expect, it } from "bun:test";
import { STORE_CONTRACT } from "@rackbops/docket-core";
import { migrate, openDatabase } from "./schema.js";
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
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    db.exec("PRAGMA user_version = 99");
    expect(() => migrate(db)).toThrow(/newer than this plugin knows/);
  });
});
