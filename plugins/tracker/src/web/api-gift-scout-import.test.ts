import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { openDatabase } from "../schema.js";
import { SqliteStore } from "../store.js";
import { api, call, cleanup, CURLY, csrfOf, LARRY, makeToken, ORIGIN, people, press, signIn, STRANGER, world } from "./harness.js";

/**
 * docket 0.27.0's gift features, part two (rackbops-bot-plugins#386): a scout finding saved as a
 * gift idea from its DM's button and the task API, the watches an item follows (docket#101), and
 * importing a list after review (docket#102), through the plugin's own handlers. Every family,
 * scout and gift here is made up.
 */

afterEach(cleanup);

const AT = "2026-10-01T12:00:00.000Z";

async function setup() {
  const w = await world();
  await people(w.plugin);
  const larryJar = await signIn(w.plugin, LARRY);
  const larry = await makeToken(w, larryJar);
  const curly = await makeToken(w, await signIn(w.plugin, CURLY), "curly-agent");
  const db = openDatabase(w.dbPath);
  const store = new SqliteStore(db);
  const larryId = (await store.findUserByDiscordId(LARRY))?.id as string;
  const curlyId = (await store.findUserByDiscordId(CURLY))?.id as string;
  const task = (ownerId: string, type: string, title: string) =>
    store.createTask({ ownerId, type, title, config: type === "scout" ? { interests: ["birding"], lens: "general" } : {}, schedule: { kind: "calendar", every: 1, unit: "day", start: "2026-10-01" }, lane: type === "scout" ? "execute" : "notify", capabilities: ["notify"], at: AT });
  const scout = await task(larryId, "scout", "Scout: birding");
  const finding = (ownerId: string, taskId: string, text: string, source: string | null) =>
    store.addFinding({ taskId, ownerId, occurrenceId: "o9", type: "scout", text, tags: ["scout", "general"], source, at: AT });
  const f1 = await finding(larryId, scout.id, "Field guide to owls -- fits birding", "https://shop.example.com/owls");
  const f2 = await finding(larryId, scout.id, "Feeder camera -- fits birding", "https://shop.example.com/cam");
  return { ...w, larryJar, larry, curly, db, store, larryId, curlyId, scout, f1, f2, task };
}
type W = Awaited<ReturnType<typeof setup>>;

// biome-ignore lint/suspicious/noExplicitAny: test reads of JSON answers
type Json = any;
const read = async (res: Response): Promise<Json> => res.json();
const items = async (w: W): Promise<Json[]> => (await read(await api(w.plugin, "GET", "/gifts/items?includeArchived=true", { token: w.larry }))).records;
/** The scout task's row and every finding, as stored: what a save must never change. */
function taskAndFindings(path: string): string {
  const db = new Database(path);
  try {
    return JSON.stringify([db.query("SELECT * FROM tasks ORDER BY seq").all(), db.query("SELECT * FROM findings ORDER BY seq").all()]);
  } finally {
    db.close();
  }
}

/** A scout run's DM text as docket-types' renderScout lays it out: `N. title`, then `   <url>`. */
const scoutDm = (rows: [string, string][]): string =>
  ["Scout: birding", "", `${rows.length} new finds:`, ...rows.flatMap(([title, url], i) => ["", `${i + 1}. ${title}`, "   fits birding", `   <${url}>`])].join("\n");

async function dmNotifier(w: W) {
  const { createDmNotifier } = await import("../notifier.js");
  const sent: { to: string; buttons: string[] }[] = [];
  const notifier = createDmNotifier({
    store: w.store,
    clock: { now: () => new Date(AT) },
    log: { info() {}, warn() {}, error() {} },
    dm: async (to, m) => {
      sent.push({ to, buttons: (m.buttons ?? []).map((b) => `${b.customId}|${b.label}`) });
      return { guildId: null, channelId: "c", messageId: "m" };
    },
  });
  return { sent, notifier };
}

describe("save a scout finding as a gift idea (docket#101)", () => {
  it("the DM button saves it once, as the presser's own idea linked by source, and leaves the scout and its findings as they were", async () => {
    const w = await setup();
    const before = taskAndFindings(w.dbPath);
    const said = await press(w.plugin, `tracker:g.f.${w.f1.id}`, LARRY);
    expect(said).toEqual([`Saved as a gift idea. See it on <${ORIGIN}/tracker/gifts>.`]);
    const saved = await items(w);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ title: "Field guide to owls -- fits birding", planning: "idea", url: "https://shop.example.com/owls", source: { kind: "scout", ref: `${w.scout.id}/${w.f1.id}` } });
    expect(await press(w.plugin, `tracker:g.f.${w.f1.id}`, LARRY)).toEqual([`Already saved as a gift idea. See it on <${ORIGIN}/tracker/gifts>.`]);
    expect(await press(w.plugin, `tracker:g.f.${w.f1.id}`, CURLY)).toEqual(["That finding is not one of yours, or is gone."]);
    expect((await press(w.plugin, `tracker:g.f.${w.f1.id}`, STRANGER))[0]).not.toContain("Saved");
    expect(await items(w)).toHaveLength(1);
    expect((await read(await api(w.plugin, "GET", "/gifts/items", { token: w.curly }))).records).toEqual([]);
    expect(taskAndFindings(w.dbPath)).toBe(before);
    w.db.close();
  });

  it("the task API saves one (201), refuses a second (409 already_saved) and another person's or a mismatched task (404), and shows finding ids", async () => {
    const w = await setup();
    const before = taskAndFindings(w.dbPath);
    const shown = await read(await api(w.plugin, "GET", `/tasks/${w.scout.id}`, { token: w.larry }));
    expect(shown.findings.map((f: Json) => f.id)).toEqual([w.f1.id, w.f2.id]);
    const body = { taskId: w.scout.id, findingId: w.f2.id };
    const made = await api(w.plugin, "POST", "/gifts/finding-ideas", { token: w.larry, body });
    expect(made.status).toBe(201);
    expect((await read(made)).record).toMatchObject({ recordKind: "item", title: "Feeder camera -- fits birding", source: { kind: "scout", ref: `${w.scout.id}/${w.f2.id}` } });
    const again = await api(w.plugin, "POST", "/gifts/finding-ideas", { token: w.larry, body });
    expect(again.status).toBe(409);
    expect((await read(again)).error.code).toBe("already_saved");
    expect((await api(w.plugin, "POST", "/gifts/finding-ideas", { token: w.curly, body: { taskId: w.scout.id, findingId: w.f1.id } })).status).toBe(404);
    expect((await api(w.plugin, "POST", "/gifts/finding-ideas", { token: w.larry, body: { taskId: "t99", findingId: w.f1.id } })).status).toBe(404);
    expect((await api(w.plugin, "POST", "/gifts/finding-ideas", { token: w.larry, body: { taskId: w.scout.id, findingId: w.f1.id, extra: 1 } })).status).toBe(400);
    expect(await items(w)).toHaveLength(1);
    expect(taskAndFindings(w.dbPath)).toBe(before);
    w.db.close();
  });

  it("puts a numbered button per DM item on the owner's copy of the scout run's DM only", async () => {
    const w = await setup();
    const { sent, notifier } = await dmNotifier(w);
    const text = scoutDm([["Field guide to owls", "https://shop.example.com/owls"], ["Feeder camera", "https://shop.example.com/cam"]]);
    await notifier.sendDm(w.larryId, { text, ref: { taskId: w.scout.id, occurrenceId: "o9" } });
    await notifier.sendDm(w.curlyId, { text, ref: { taskId: w.scout.id, occurrenceId: "o9" } });
    await notifier.sendDm(w.larryId, { text: "Scout: birding\n\nNothing new this time.", ref: { taskId: w.scout.id, occurrenceId: "o1" } });
    expect(sent[0]?.buttons).toEqual(["tracker:r.o.o9|Reply", `tracker:g.f.${w.f1.id}|1. Save as gift idea`, `tracker:g.f.${w.f2.id}|2. Save as gift idea`]);
    expect(sent[1]?.buttons).toEqual(["tracker:r.o.o9|Reply"]);
    expect(sent[2]?.buttons).toEqual(["tracker:r.o.o1|Reply"]);
    w.db.close();
  });

  it("numbers each button by the DM's own item, so a link an earlier run stored gets its own number's button", async () => {
    const w = await setup();
    // An earlier run (o1) stored the lamp; this run (o9) shows it again first, then the owls.
    const lamp = await w.store.addFinding({ taskId: w.scout.id, ownerId: w.larryId, occurrenceId: "o1", type: "scout", text: "Bird lamp -- fits birding", tags: ["scout", "general"], source: "https://shop.example.com/lamp", at: "2026-09-30T12:00:00.000Z" });
    const { sent, notifier } = await dmNotifier(w);
    const text = scoutDm([["Bird lamp", "https://shop.example.com/lamp"], ["Field guide to owls", "https://shop.example.com/owls"]]);
    await notifier.sendDm(w.larryId, { text, ref: { taskId: w.scout.id, occurrenceId: "o9" } });
    expect(sent[0]?.buttons).toEqual(["tracker:r.o.o9|Reply", `tracker:g.f.${lamp.id}|1. Save as gift idea`, `tracker:g.f.${w.f1.id}|2. Save as gift idea`]);
    // Stored by this run too, and again by a later one: the button takes this run's own row.
    const lampNow = await w.store.addFinding({ taskId: w.scout.id, ownerId: w.larryId, occurrenceId: "o9", type: "scout", text: "Bird lamp -- fits birding", tags: ["scout", "general"], source: "https://shop.example.com/lamp", at: AT });
    await w.store.addFinding({ taskId: w.scout.id, ownerId: w.larryId, occurrenceId: "o10", type: "scout", text: "Field guide to owls -- fits birding", tags: ["scout", "general"], source: "https://shop.example.com/owls", at: "2026-10-02T12:00:00.000Z" });
    await notifier.sendDm(w.larryId, { text, ref: { taskId: w.scout.id, occurrenceId: "o9" } });
    expect(sent[1]?.buttons).toEqual(["tracker:r.o.o9|Reply", `tracker:g.f.${lampNow.id}|1. Save as gift idea`, `tracker:g.f.${w.f1.id}|2. Save as gift idea`]);
    w.db.close();
  });

  it("gives an eBay finding no button, nor an item with no finding, and keeps the others' numbers", async () => {
    const w = await setup();
    const ebay = await w.store.addFinding({ taskId: w.scout.id, ownerId: w.larryId, occurrenceId: "o9", type: "scout", text: "Owl print -- fits birding", tags: ["scout", "general"], source: "https://www.ebay.com/itm/123456", at: AT });
    const tagged = await w.store.addFinding({ taskId: w.scout.id, ownerId: w.larryId, occurrenceId: "o9", type: "scout", text: "Owl mug -- fits birding", tags: ["scout", "ebay"], source: "https://shop.example.com/mug", at: AT });
    const { sent, notifier } = await dmNotifier(w);
    const text = scoutDm([
      ["Owl print", "https://www.ebay.com/itm/123456"],
      ["Owl mug", "https://shop.example.com/mug"],
      ["Something never stored", "https://shop.example.com/ghost"],
      ["Feeder camera", "https://shop.example.com/cam"],
    ]);
    await notifier.sendDm(w.larryId, { text, ref: { taskId: w.scout.id, occurrenceId: "o9" } });
    expect(sent[0]?.buttons).toEqual(["tracker:r.o.o9|Reply", `tracker:g.f.${w.f2.id}|4. Save as gift idea`]);
    expect(sent[0]?.buttons.join(" ")).not.toContain(ebay.id);
    expect(sent[0]?.buttons.join(" ")).not.toContain(tagged.id);
    w.db.close();
  });
});

describe("the watches a gift follows (docket#101)", () => {
  it("links two of the owner's watches and reads them back; refuses another's task (400), a stale revision (409) and the field anywhere else", async () => {
    const w = await setup();
    const kettle = await w.task(w.larryId, "price", "Kettle price");
    const lego = await w.task(w.larryId, "wantlist", "Lego want-list");
    const theirs = await w.task(w.curlyId, "price", "Curly's lamp");
    const chore = await w.task(w.larryId, "reminder", "Bins out");
    const item = (await read(await api(w.plugin, "POST", "/gifts/items", { token: w.larry, body: { title: "Kettle", url: null, productKey: null, variant: null, notes: null, source: { kind: "manual", ref: null }, planning: "idea", estimateMinor: null, currency: null } }))).record;
    const before = taskAndFindings(w.dbPath);
    const linked = await api(w.plugin, "POST", `/gifts/items/${item.id}/watches`, { token: w.larry, body: { expectedRevision: 1, watchTaskIds: [kettle.id, lego.id] } });
    expect(linked.status).toBe(200);
    expect((await read(linked)).record).toMatchObject({ revision: 2, watchTaskIds: [kettle.id, lego.id] });
    expect((await read(await api(w.plugin, "GET", `/gifts/items/${item.id}`, { token: w.larry }))).record.watchTaskIds).toEqual([kettle.id, lego.id]);
    for (const bad of [[theirs.id], [chore.id], ["t999"]]) {
      const res = await api(w.plugin, "POST", `/gifts/items/${item.id}/watches`, { token: w.larry, body: { expectedRevision: 2, watchTaskIds: bad } });
      expect(res.status).toBe(400);
      expect((await read(res)).error.code).toBe("invalid");
    }
    const stale = await api(w.plugin, "POST", `/gifts/items/${item.id}/watches`, { token: w.larry, body: { expectedRevision: 1, watchTaskIds: [] } });
    expect(stale.status).toBe(409);
    expect((await api(w.plugin, "POST", `/gifts/items/${item.id}/watches`, { token: w.curly, body: { expectedRevision: 2, watchTaskIds: [] } })).status).toBe(404);
    // docket does not check the field itself, so no other write may set it.
    expect((await api(w.plugin, "PATCH", `/gifts/items/${item.id}`, { token: w.larry, body: { expectedRevision: 2, watchTaskIds: [theirs.id] } })).status).toBe(400);
    expect((await api(w.plugin, "POST", "/gifts/batch", { token: w.larry, body: { writes: [{ op: "update", collection: "items", id: item.id, expectedRevision: 2, fields: { watchTaskIds: [theirs.id] } }] } }).then(read)).results[0].status).toBe(400);
    expect((await read(await api(w.plugin, "GET", `/gifts/items/${item.id}`, { token: w.larry }))).record).toMatchObject({ revision: 2, watchTaskIds: [kettle.id, lego.id] });
    expect(taskAndFindings(w.dbPath)).toBe(before);
    w.db.close();
  });

  it("takes only live watches: a done or archived one is refused, unless the item already follows it", async () => {
    const w = await setup();
    const kettle = await w.task(w.larryId, "price", "Kettle price");
    const old = await w.task(w.larryId, "price", "Old toaster price");
    const shelved = await w.task(w.larryId, "wantlist", "Shelved want-list");
    const item = (await read(await api(w.plugin, "POST", "/gifts/items", { token: w.larry, body: { title: "Kettle", url: null, productKey: null, variant: null, notes: null, source: { kind: "manual", ref: null }, planning: "idea", estimateMinor: null, currency: null } }))).record;
    const link = (expectedRevision: number, watchTaskIds: string[]) => api(w.plugin, "POST", `/gifts/items/${item.id}/watches`, { token: w.larry, body: { expectedRevision, watchTaskIds } });
    expect((await link(1, [kettle.id, old.id])).status).toBe(200);
    await w.store.updateTask(old.id, { status: "done", at: AT });
    await w.store.updateTask(shelved.id, { status: "archived", at: AT });
    for (const bad of [[kettle.id, shelved.id], [kettle.id, old.id, shelved.id]]) {
      const res = await link(2, bad);
      expect(res.status).toBe(400);
      expect((await read(res)).error.code).toBe("invalid");
    }
    // Already followed, so it may stay while the item's other watches change.
    const kept = await link(2, [old.id]);
    expect(kept.status).toBe(200);
    expect((await read(kept)).record.watchTaskIds).toEqual([old.id]);
    // Once dropped, the done watch is not offered again, nor taken.
    expect((await link(3, [])).status).toBe(200);
    expect((await link(4, [old.id])).status).toBe(400);
    const page = await (await call(w.plugin, "GET", `/gifts/items/${item.id}`, { jar: w.larryJar })).text();
    expect(page).toContain("Kettle price");
    expect(page).not.toContain("Old toaster price");
    expect(page).not.toContain("Shelved want-list");
    expect((await api(w.plugin, "POST", "/gifts/items/i999/watches", { token: w.larry, body: { expectedRevision: 1, watchTaskIds: [] } })).status).toBe(404);
    w.db.close();
  });

  it("the item's web page says which scout it came from, lists its watches by title and links them from a form", async () => {
    const w = await setup();
    const kettle = await w.task(w.larryId, "price", "Kettle price");
    await w.task(w.curlyId, "price", "Curly's lamp");
    await press(w.plugin, `tracker:g.f.${w.f1.id}`, LARRY);
    const [idea] = await items(w);
    const pageOf = async () => (await call(w.plugin, "GET", `/gifts/items/${idea.id}`, { jar: w.larryJar })).text();
    let body = await pageOf();
    expect(body).toContain(`From scout: <a class="rb-link" href="/tracker/tasks/${w.scout.id}">Scout: birding</a>`);
    expect(body).toContain("Kettle price");
    expect(body).not.toContain("Curly&#39;s lamp");
    const gifts = await (await call(w.plugin, "GET", "/gifts", { jar: w.larryJar })).text();
    expect(gifts).toContain(`href="/tracker/gifts/items/${idea.id}">Field guide to owls -- fits birding</a> <span class="rb-badge rb-badge--info">from scout</span>`);
    const csrf = await csrfOf(w.plugin, w.larryJar);
    const saved = await call(w.plugin, "POST", `/gifts/items/${idea.id}`, { jar: w.larryJar, origin: ORIGIN, form: [["csrf", csrf], ["revision", "1"], ["watch", kettle.id]] });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`/tracker/gifts/items/${idea.id}?done=watches`);
    body = await (await call(w.plugin, "GET", `/gifts/items/${idea.id}?done=watches`, { jar: w.larryJar })).text();
    expect(body).toContain("Watches saved.");
    expect(body).toContain(`<li><a class="rb-link" href="/tracker/tasks/${kettle.id}">Kettle price</a></li>`);
    const stale = await call(w.plugin, "POST", `/gifts/items/${idea.id}`, { jar: w.larryJar, origin: ORIGIN, form: [["csrf", csrf], ["revision", "1"]] });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("It changed while you were editing.");
    expect((await call(w.plugin, "GET", `/gifts/items/${idea.id}`, { jar: await signIn(w.plugin, CURLY) })).status).toBe(404);
    w.db.close();
  });
});

const CSV = ["title,recipients,occasion,quantity,price,colour", "Scarf,Ann;Bea,Winter fair,2,25.00,red", "Book,Ann,Winter fair,x,10.00,blue", "Socks,,,1,,green"].join("\n");

describe("importing a list of gifts (docket#102)", () => {
  it("reviews a CSV with an unknown column and a bad row, imports only the approved rows, and creates nothing twice", async () => {
    const w = await setup();
    const reviewed = await read(await api(w.plugin, "POST", "/gifts/import/review", { token: w.larry, body: { format: "csv", text: CSV, currency: "USD" } }));
    expect(reviewed.staged).toEqual({ unknownColumns: ["colour"], problems: [] });
    expect(reviewed.rows.map((r: Json) => [r.title, r.status])).toEqual([["Scarf", "new"], ["Book", "invalid"], ["Socks", "ready"]]);
    expect(reviewed.rows[1].problems).toEqual(["quantity must be a whole number of at least 1"]);
    expect(await items(w)).toEqual([]);
    const keys = reviewed.rows.map((r: Json) => r.key);
    const apply = (approve: string[], reviewToken = reviewed.reviewToken) => api(w.plugin, "POST", "/gifts/import", { token: w.larry, body: { format: "csv", text: CSV, currency: "USD", reviewToken, approve } });
    const res = await apply([keys[0]]);
    expect(res.status).toBe(200);
    const { outcomes } = await read(res);
    expect(outcomes.map((o: Json) => o.status)).toEqual(["applied"]);
    const all = async (c: string) => (await read(await api(w.plugin, "GET", `/gifts/${c}?includeArchived=true`, { token: w.larry }))).records;
    const counts = async () => Promise.all(["recipients", "occasions", "items", "allocations", "occasion-recipients"].map(async (c) => (await all(c)).length));
    expect(await counts()).toEqual([2, 1, 1, 1, 2]);
    expect((await all("occasions"))[0]).toMatchObject({ title: "Winter fair", kind: "custom", currency: "USD" });
    expect((await all("allocations"))[0]).toMatchObject({ quantity: 2, shared: false, purchaseId: null });
    // The people and the occasion now exist, so the review moved on: the old token is stale.
    const stale = await apply([keys[0]]);
    expect(stale.status).toBe(409);
    expect((await read(stale)).error.code).toBe("stale_review");
    const again = await read(await api(w.plugin, "POST", "/gifts/import/review", { token: w.larry, body: { format: "csv", text: CSV, currency: "USD" } }));
    expect(again.rows[0].status).toBe("ready");
    expect((await apply([keys[0]], again.reviewToken)).status).toBe(200);
    expect(await counts()).toEqual([2, 1, 1, 1, 2]);
    expect((await apply(["nope"], again.reviewToken)).status).toBe(400);
    expect((await api(w.plugin, "POST", "/gifts/import/review", { token: w.larry, body: { format: "csv", text: "x".repeat(200 * 1024 + 1) } })).status).toBe(413);
    // A long list passes the task API's usual 16 KiB body cap: the import routes take up to 640 KiB.
    const long = Array.from({ length: 400 }, (_, i) => `Gift number ${i} ${"y".repeat(220)}`).join("\n");
    expect((await api(w.plugin, "POST", "/gifts/import/review", { token: w.larry, body: { format: "list", text: long } })).status).toBe(200);
    expect((await api(w.plugin, "POST", "/gifts/import/review", { token: w.larry, body: { format: "tsv", text: CSV } })).status).toBe(400);
    expect((await read(await api(w.plugin, "GET", "/gifts/items", { token: w.curly }))).records).toEqual([]);
    w.db.close();
  });

  it("the web page reviews the list, offers only ready and new rows to tick, and imports the ticked ones", async () => {
    const w = await setup();
    const csrf = await csrfOf(w.plugin, w.larryJar);
    expect(await (await call(w.plugin, "GET", "/gifts", { jar: w.larryJar })).text()).toContain('href="/tracker/gifts/import">Import a list</a>');
    expect((await call(w.plugin, "GET", "/gifts/import", { jar: w.larryJar })).status).toBe(200);
    const form = [["csrf", csrf], ["format", "csv"], ["text", CSV], ["currency", "USD"]] as [string, string][];
    const review = await (await call(w.plugin, "POST", "/gifts/import", { jar: w.larryJar, origin: ORIGIN, form: [...form, ["step", "review"]] })).text();
    expect(review).toContain("Columns not imported: colour.");
    const ticks = [...review.matchAll(/name="row" value="([^"]+)"/g)].map((m) => m[1] as string);
    expect(ticks).toHaveLength(2);
    expect(review).toContain("quantity must be a whole number of at least 1");
    const token = /name="token" value="([^"]+)"/.exec(review)?.[1] ?? "";
    const done = await call(w.plugin, "POST", "/gifts/import", { jar: w.larryJar, origin: ORIGIN, form: [...form, ["step", "import"], ["token", token], ["row", ticks[1] as string]] });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Imported 1 of 1");
    expect((await items(w)).map((i) => i.title)).toEqual(["Socks"]);
    const stale = await call(w.plugin, "POST", "/gifts/import", { jar: w.larryJar, origin: ORIGIN, form: [...form, ["step", "import"], ["token", "old"], ["row", ticks[0] as string]] });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("Something changed since the review");
    expect((await items(w)).map((i) => i.title)).toEqual(["Socks"]);
    w.db.close();
  });
});

describe("a list too large to import (docket#102)", () => {
  it("the web page and the task API both say to import it in parts, and nothing is written", async () => {
    const w = await setup();
    const csrf = await csrfOf(w.plugin, w.larryJar);
    const message = "That list is too large: import it in parts.";
    // Over the 640 KiB form cap: the form is never read.
    const huge = await call(w.plugin, "POST", "/gifts/import", { jar: w.larryJar, origin: ORIGIN, form: [["csrf", csrf], ["format", "list"], ["text", "z".repeat(640 * 1024 + 1)], ["step", "review"]] });
    expect(huge.status).toBe(413);
    expect(await huge.text()).toContain(message);
    // Under the form cap but over the 200 KiB text cap.
    const long = await call(w.plugin, "POST", "/gifts/import", { jar: w.larryJar, origin: ORIGIN, form: [["csrf", csrf], ["format", "list"], ["text", "z".repeat(200 * 1024 + 1)], ["step", "review"]] });
    expect(long.status).toBe(413);
    expect(await long.text()).toContain(message);
    for (const path of ["/gifts/import/review", "/gifts/import"]) {
      const extra = path === "/gifts/import" ? { reviewToken: "x", approve: [] } : {};
      const text = await api(w.plugin, "POST", path, { token: w.larry, body: { format: "list", text: "z".repeat(200 * 1024 + 1), ...extra } });
      expect(text.status).toBe(413);
      expect((await read(text)).error).toEqual({ code: "too_large", message });
      const body = await api(w.plugin, "POST", path, { token: w.larry, body: { format: "list", text: "z".repeat(640 * 1024 + 1), ...extra } });
      expect(body.status).toBe(413);
      expect((await read(body)).error).toEqual({ code: "too_large", message });
    }
    // Any other form over its cap is still a plain bad request.
    expect((await call(w.plugin, "POST", "/settings", { jar: w.larryJar, origin: ORIGIN, form: [["csrf", csrf], ["x", "z".repeat(640 * 1024 + 1)]] })).status).toBe(400);
    expect(await items(w)).toEqual([]);
    w.db.close();
  });
});

describe("an occasion's shop-by day and digest opt-in (docket#103)", () => {
  it("round-trips through the task API and the web form", async () => {
    const w = await setup();
    const fields = { kind: "birthday", title: "Ann 2026", date: "2026-12-20", timeZone: null, year: 2026, currency: "USD", budgetMinor: null, groupIds: [], includeIds: [], excludeIds: [], deadline: "2026-12-15", digest: true };
    const made = (await read(await api(w.plugin, "POST", "/gifts/occasions", { token: w.larry, body: fields }))).record;
    expect((await read(await api(w.plugin, "GET", `/gifts/occasions/${made.id}`, { token: w.larry }))).record).toMatchObject({ deadline: "2026-12-15", digest: true });
    const csrf = await csrfOf(w.plugin, w.larryJar);
    const page = await (await call(w.plugin, "GET", "/gifts/new/occasion", { jar: w.larryJar })).text();
    expect(page).toContain('name="deadline"');
    expect(page).toContain('name="digest" value="1"');
    const res = await call(w.plugin, "POST", "/gifts/new/occasion", {
      jar: w.larryJar,
      origin: ORIGIN,
      form: [["csrf", csrf], ["kind", "christmas"], ["title", "Christmas 2026"], ["date", "2026-12-25"], ["deadline", "2026-12-18"], ["digest", "1"], ["currency", "USD"], ["step", "save"]],
    });
    expect(res.status).toBe(303);
    const occasions = (await read(await api(w.plugin, "GET", "/gifts/occasions", { token: w.larry }))).records;
    expect(occasions.find((o: Json) => o.title === "Christmas 2026")).toMatchObject({ deadline: "2026-12-18", digest: true });
    w.db.close();
  });
});
