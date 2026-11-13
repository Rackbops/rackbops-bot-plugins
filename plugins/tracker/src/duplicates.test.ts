import { describe, expect, it } from "bun:test";
import { findDuplicates } from "./duplicates.js";
import { admit } from "./people.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

/** #390: which of a person's tasks a new task's fields repeat. */

const START = "2026-10-01T12:00:00.000Z";

async function setup() {
  const store = new SqliteStore(openDatabase(":memory:"));
  const larry = await admit(store, "111111111111111111", new Date(START));
  const bob = await admit(store, "222222222222222222", new Date(START));
  const make = (ownerId: string, type: string, title: string, config: Record<string, unknown>) =>
    store.createTask({ ownerId, type, title, config, schedule: null, lane: "notify", capabilities: ["notify"], at: START });
  return { store, larry, bob, make };
}

const fields = (o: Record<string, string>) => new URLSearchParams(o);

describe("findDuplicates", () => {
  it("matches an eBay API search by its words, ignoring case and spacing, plain or judged", async () => {
    const { store, larry, make } = await setup();
    const plain = await make(larry.id, "wantlist", "Arkham Drowned City", { source: "ebay", target: "arkham horror drowned city" });
    const judged = await make(larry.id, "wantjudge", "Arkham Drowned City (judged)", { source: "ebay", target: "Arkham Horror  Drowned City" });
    const found = await findDuplicates({ store }, larry, "wantlist", fields({ name: "x", source: "eBay", target: "  ARKHAM horror drowned   city " }));
    expect(found.map((f) => f.id)).toEqual([plain.id, judged.id]);
    expect(found[1]).toMatchObject({ type: "wantjudge", status: "active", title: "Arkham Drowned City (judged)" });
  });

  it("uses the name as the search when no target is given, as the create does", async () => {
    const { store, larry, make } = await setup();
    const t = await make(larry.id, "wantlist", "Wingspan", { source: "shopify", target: "wingspan" });
    expect((await findDuplicates({ store }, larry, "wantlist", fields({ name: "Wingspan", source: "shopify" }))).map((f) => f.id)).toEqual([t.id]);
  });

  it("does not match another source, another search, another person, or a different kind", async () => {
    const { store, larry, bob, make } = await setup();
    await make(larry.id, "wantlist", "Wingspan", { source: "shopify", target: "wingspan" });
    await make(larry.id, "wantlist", "Wingspan Oceania", { source: "ebay", target: "wingspan oceania" });
    await make(bob.id, "wantlist", "Wingspan", { source: "ebay", target: "wingspan" });
    await make(larry.id, "news", "Wingspan", { subject: "wingspan" });
    expect(await findDuplicates({ store }, larry, "wantlist", fields({ name: "Wingspan", source: "ebay", target: "wingspan" }))).toEqual([]);
  });

  it("counts a paused task, not a done or archived (deleted) one", async () => {
    const { store, larry, make } = await setup();
    const paused = await make(larry.id, "wantlist", "A", { source: "ebay", target: "wingspan" });
    const done = await make(larry.id, "wantlist", "B", { source: "ebay", target: "wingspan" });
    const gone = await make(larry.id, "wantlist", "C", { source: "ebay", target: "wingspan" });
    await store.updateTask(paused.id, { status: "paused", at: START });
    await store.updateTask(done.id, { status: "done", at: START });
    await store.updateTask(gone.id, { status: "archived", at: START });
    const found = await findDuplicates({ store }, larry, "wantlist", fields({ name: "x", source: "ebay", target: "wingspan" }));
    expect(found.map((f) => [f.id, f.status])).toEqual([[paused.id, "paused"]]);
  });

  it("matches an inbox eBay watch by its words, a BGG game by its id, and a page by its address", async () => {
    const { store, larry, make } = await setup();
    const inbox = await make(larry.id, "wantlist", "Wingspan", { source: "inbox", target: `ebay-${"a".repeat(24)}`, search: "Wingspan" });
    const bgg = await make(larry.id, "wantlist", "Brass", { source: "bgg", target: "224517" });
    const page = await make(larry.id, "wantlist", "Shop", { source: "page", target: "https://shop.example/arkham" });
    expect((await findDuplicates({ store }, larry, "wantlist", fields({ name: "wingspan", source: "ebay" }))).map((f) => f.id)).toEqual([inbox.id]);
    expect((await findDuplicates({ store }, larry, "wantlist", fields({ name: "x", source: "bgg", target: "https://boardgamegeek.com/boardgame/224517/brass-birmingham" }))).map((f) => f.id)).toEqual([bgg.id]);
    expect((await findDuplicates({ store }, larry, "wantlist", fields({ name: "x", source: "page", target: "https://shop.example/arkham" }))).map((f) => f.id)).toEqual([page.id]);
    // A BGG inbox watch named by words in its target is found by them.
    const words = await make(larry.id, "wantlist", "Brass words", { source: "inbox", target: `bgg-${"b".repeat(24)}`, search: "Brass Birmingham" });
    expect((await findDuplicates({ store }, larry, "wantlist", fields({ name: "x", source: "bgg", target: "brass  birmingham" }))).map((f) => f.id)).toEqual([words.id]);
    // A BGG inbox watch named by words is not the same as one for a game id.
    expect(await findDuplicates({ store }, larry, "wantlist", fields({ name: "Brass", source: "bgg" }))).toEqual([]);
  });

  it("matches a news watch by subject and a price by its page; leaves reminders alone", async () => {
    const { store, larry, make } = await setup();
    const news = await make(larry.id, "news", "Platinum Blonde", { subject: "Platinum Blonde, the Canadian band" });
    const price = await make(larry.id, "price", "Lamp", { url: "https://shop.example/lamp", dropPercent: 10, baseline: 50 });
    await make(larry.id, "reminder", "water", { text: "water the plants" });
    expect((await findDuplicates({ store }, larry, "news", fields({ subject: "platinum blonde,  the Canadian band" }))).map((f) => f.id)).toEqual([news.id]);
    expect((await findDuplicates({ store }, larry, "price", fields({ url: "https://shop.example/lamp" }))).map((f) => f.id)).toEqual([price.id]);
    expect(await findDuplicates({ store }, larry, "reminder", fields({ text: "water the plants", when: "2026-10-02 09:00" }))).toEqual([]);
  });
  it("matches a Noble Knight watch by its product, whatever form of its address", async () => {
    const { store, larry, make } = await setup();
    const t = await make(larry.id, "wantlist", "Edge", { source: "nobleknight", target: "https://www.nobleknight.com/P/2147942033" });
    const again = await findDuplicates({ store }, larry, "wantlist", fields({ name: "Edge again", source: "nobleknight", target: "https://uk.nobleknight.com/P/2147942033/Edge-of-the-Earth/?awid=1" }));
    expect(again.map((f) => f.id)).toEqual([t.id]);
    expect(await findDuplicates({ store }, larry, "wantlist", fields({ name: "Hemlock", source: "nobleknight", target: "https://www.nobleknight.com/P/2148112695" }))).toEqual([]);
    expect(await findDuplicates({ store }, larry, "wantlist", fields({ name: "Edge page", source: "page", target: "https://www.nobleknight.com/P/2147942033" }))).toEqual([]);
  });
});
