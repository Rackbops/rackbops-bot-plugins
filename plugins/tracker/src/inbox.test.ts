import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { acceptListing, inboxSite, MAX_INBOX_ROWS, newInboxKey, WantInbox } from "./inbox.js";
import { MIGRATIONS, migrate, openDatabase } from "./schema.js";

/** The want-list inboxes (inbox.ts) and their table, schema migration 8. */

const AT = new Date("2026-10-05T12:00:00.000Z");

function listing(n: number) {
  const l = acceptListing({ title: `Wingspan ${n}`, url: `https://www.ebay.com/itm/${100000000 + n}` });
  if (!l) throw new Error("refused");
  return l;
}

describe("WantInbox", () => {
  it("keys are the site, a dash and 24 random hex digits, and only those are read as a site", () => {
    const a = newInboxKey("ebay");
    expect(a).toMatch(/^ebay-[0-9a-f]{24}$/);
    expect(newInboxKey("ebay")).not.toBe(a);
    expect(inboxSite(a)).toBe("ebay");
    expect(inboxSite(newInboxKey("bgg"))).toBe("bgg");
    expect(inboxSite("ebay-xyz")).toBeNull();
    expect(inboxSite("https://www.ebay.com/")).toBeNull();
  });

  it("stores only the six cleaned fields, reads oldest first per key, and keeps the newest rows of a key", () => {
    const inbox = new WantInbox(openDatabase(":memory:"));
    const raw = { title: "  Wingspan\n Oceania ", url: "https://www.ebay.com/itm/x/123456789?_trksid=1#top", price: "US $30.50", extra: "dropped", seller: 5 };
    const cleaned = acceptListing(raw);
    expect(cleaned).not.toBeNull();
    if (!cleaned) return;
    inbox.add("t1", "ebay-a", [cleaned], AT);
    expect(inbox.read("ebay-a")).toEqual([{ title: "Wingspan Oceania", url: "https://www.ebay.com/itm/123456789", price: 30.5 }]);
    expect(acceptListing("text")).toBeNull();
    expect(acceptListing([raw])).toBeNull();
    expect(acceptListing({ title: "x", url: "javascript:alert(1)" })).toBeNull();

    inbox.add("t2", "ebay-b", [listing(1)], AT);
    inbox.add("t1", "ebay-a", Array.from({ length: MAX_INBOX_ROWS + 10 }, (_, i) => listing(i)), AT);
    expect(inbox.count("ebay-a")).toBe(MAX_INBOX_ROWS);
    const read = inbox.read("ebay-a");
    expect(read[0]?.title).toBe("Wingspan 10");
    expect(read.at(-1)?.title).toBe(`Wingspan ${MAX_INBOX_ROWS + 9}`);
    expect(inbox.read("ebay-b")).toHaveLength(1);
    expect(inbox.read("ebay-none")).toEqual([]);
  });
});

describe("migration 8", () => {
  it("is purely additive: a database at 7 keeps every table, row and index as it was, and gains want_inbox", () => {
    const db = new Database(":memory:");
    for (let v = 0; v < 7; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v] as string);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
    db.exec(`INSERT INTO users (discord_id, display_name, time_zone, preferred_hour, admin, created_at) VALUES ('1', 'Larry', 'UTC', 9, 1, '${AT.toISOString()}')`);
    const schema = () => db.query("SELECT type, name, sql FROM sqlite_master WHERE name != 'sqlite_sequence' ORDER BY name").all() as { name: string }[];
    // `db.prepare`, not `db.query`: a cached statement keeps its columns across a later ALTER.
    const users = () => db.prepare("SELECT * FROM users").all();
    const before = { schema: schema(), users: users() };

    expect(migrate(db)).toBe(7);
    // Every later migration runs too; migration 9's users.usr_subject has its own test (usr.test.ts),
    // so users' own definition is left out here.
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    const later = (s: { name: string }) => s.name === "users" || s.name === "users_usr_subject";
    const after = schema().filter((s) => !later(s));
    expect(after.filter((s) => !s.name.startsWith("want_inbox"))).toEqual(before.schema.filter((s) => !later(s)));
    expect(after.filter((s) => s.name.startsWith("want_inbox")).map((s) => s.name)).toEqual(["want_inbox", "want_inbox_key", "want_inbox_task"]);
    expect(users()).toEqual(before.users.map((u) => ({ ...(u as object), usr_subject: null })));
  });
});
