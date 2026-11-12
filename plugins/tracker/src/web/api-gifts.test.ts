import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { GIFT_TABLES } from "../gift-store.js";
import { GIFT_COLLECTIONS, MAX_GIFT_BATCH, giftMethods, giftRoute } from "./api-gifts.js";
import { ADMIN, api, cleanup, CURLY, LARRY, makeToken, people, press, signIn, slash, world } from "./harness.js";

/**
 * The gift ledger's routes in the task API (rackbops-bot-plugins#383), through the plugin's own
 * `http` handler. Every family fixture here is made up.
 */

afterEach(cleanup);

async function setup() {
  const w = await world();
  await people(w.plugin);
  const larry = await makeToken(w, await signIn(w.plugin, LARRY));
  const curly = await makeToken(w, await signIn(w.plugin, CURLY), "curly-agent");
  return { ...w, larry, curly };
}
type W = Awaited<ReturnType<typeof setup>>;

// biome-ignore lint/suspicious/noExplicitAny: test reads of JSON answers
type Json = any;
const read = async (res: Response): Promise<Json> => res.json();

const person = (displayName: string) => ({ displayName, kind: "person", memberIds: [], labels: [], interests: [], avoid: [], notes: null });
const christmas = (groupIds: string[] = []) => ({
  kind: "christmas",
  title: "Christmas 2026",
  date: "2026-12-25",
  timeZone: null,
  year: 2026,
  currency: "USD",
  budgetMinor: 50000,
  groupIds,
  includeIds: [],
  excludeIds: [],
});
const item = (title: string) => ({
  title,
  url: null,
  productKey: null,
  variant: null,
  notes: null,
  source: { kind: "manual", ref: null },
  planning: "selected",
  estimateMinor: 2500,
  currency: "USD",
});
const purchase = (itemId: string, ordered: number) => ({
  itemId,
  merchant: "Corner Shop",
  currency: "USD",
  unitPriceMinor: 2000,
  ordered,
  received: 0,
  cancelled: 0,
  returned: 0,
  taxMinor: 0,
  shippingMinor: 0,
  discountMinor: 0,
  totalComplete: true,
  refundedMinor: 0,
  purchasedOn: "2026-11-20",
  reference: null,
});

async function create(w: W, collection: string, fields: unknown, token = w.larry): Promise<Json> {
  const res = await api(w.plugin, "POST", `/gifts/${collection}`, { token, body: fields });
  const body = await read(res);
  if (res.status !== 201) throw new Error(`create ${collection}: ${res.status} ${JSON.stringify(body)}`);
  return body.record;
}

/** Larry's small ledger: two people, a group, an occasion on it with its roster, a gift bought for one. */
async function ledger(w: W) {
  const ann = await create(w, "recipients", person("Ann"));
  const bea = await create(w, "recipients", person("Bea"));
  const aunts = await create(w, "groups", { name: "Aunts", memberIds: [ann.id, bea.id] });
  const xmas = await create(w, "occasions", christmas([aunts.id]));
  const row = (recipientId: string) => ({ occasionId: xmas.id, recipientId, target: null, budgetMinor: 2500, decision: "planning", skipReason: null });
  const annRow = await create(w, "occasion-recipients", row(ann.id));
  const beaRow = await create(w, "occasion-recipients", row(bea.id));
  const scarf = await create(w, "items", item("Scarf"));
  const bought = await create(w, "purchases", purchase(scarf.id, 1));
  const gift = await create(w, "allocations", {
    itemId: scarf.id,
    occasionId: xmas.id,
    recipientIds: [ann.id],
    quantity: 1,
    shared: false,
    purchaseId: bought.id,
    handoff: "none",
    givenOn: null,
  });
  return { ann, bea, aunts, xmas, annRow, beaRow, scarf, bought, gift };
}

function giftRows(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return JSON.stringify(GIFT_TABLES.map((t) => [t, db.query(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  } finally {
    db.close();
  }
}

describe("the gift routes", () => {
  it("create, read back, list and change a record at the revision read; archiving hides it from lists", async () => {
    const w = await setup();
    const ann = await create(w, "recipients", person("Ann"));
    expect(ann).toMatchObject({ id: "gr1", revision: 1, archived: false, displayName: "Ann", recordKind: "recipient" });
    expect((await read(await api(w.plugin, "GET", "/gifts/recipients/gr1", { token: w.larry }))).record).toEqual(ann);
    const changed = await read(await api(w.plugin, "PATCH", "/gifts/recipients/gr1", { token: w.larry, body: { expectedRevision: 1, notes: "likes scarves" } }));
    expect(changed.record).toMatchObject({ revision: 2, notes: "likes scarves", displayName: "Ann" });
    const archived = await api(w.plugin, "PATCH", "/gifts/recipients/gr1", { token: w.larry, body: { expectedRevision: 2, archived: true } });
    expect((await read(archived)).record).toMatchObject({ revision: 3, archived: true });
    expect((await read(await api(w.plugin, "GET", "/gifts/recipients", { token: w.larry }))).records).toEqual([]);
    const all = await read(await api(w.plugin, "GET", "/gifts/recipients?includeArchived=true", { token: w.larry }));
    expect(all.records.map((r: { id: string }) => r.id)).toEqual(["gr1"]);
  });

  it("refuses incomplete, unknown or bad fields with every problem named, and a filter the collection does not take", async () => {
    const w = await setup();
    const res = await api(w.plugin, "POST", "/gifts/recipients", { token: w.larry, body: { displayName: "", nickname: "A" } });
    expect(res.status).toBe(400);
    const body = await read(res);
    expect(body.error.code).toBe("invalid");
    expect(body.error.problems).toContain("nickname is not a recipient field");
    expect(body.error.problems).toContain("kind is missing");
    const noRevision = await api(w.plugin, "PATCH", "/gifts/recipients/gr1", { token: w.larry, body: { notes: "x" } });
    expect([noRevision.status, (await read(noRevision)).error.code]).toEqual([400, "invalid"]);
    const filter = await api(w.plugin, "GET", "/gifts/recipients?occasionId=go1", { token: w.larry });
    expect(filter.status).toBe(400);
    expect((await api(w.plugin, "GET", "/gifts/presents", { token: w.larry })).status).toBe(404);
    const method = await api(w.plugin, "DELETE", "/gifts/recipients/gr1", { token: w.larry });
    expect([method.status, method.headers.get("allow")]).toEqual([405, "GET, PATCH"]);
    expect((await api(w.plugin, "PATCH", "/gifts/recipients/gr1", { token: w.larry, body: { expectedRevision: 1 }, headers: { "if-match": '"0123456789abcdef"' } })).status).toBe(400);
  });

  it("another member's token gets the unknown record's 404 on every gift route for the owner's ids, and their lists never hold the owner's rows", async () => {
    const w = await setup();
    const l = await ledger(w);
    const before = giftRows(w.dbPath);
    const admin = await makeToken(w, await signIn(w.plugin, ADMIN), "admin-agent");
    const tries: [string, string, unknown?][] = [];
    for (const [collection, record] of [
      ["recipients", l.ann],
      ["groups", l.aunts],
      ["occasions", l.xmas],
      ["occasion-recipients", l.annRow],
      ["items", l.scarf],
      ["purchases", l.bought],
      ["allocations", l.gift],
    ] as const) {
      tries.push(["GET", `/gifts/${collection}/${record.id}`], ["PATCH", `/gifts/${collection}/${record.id}`, { expectedRevision: 1, archived: true }]);
    }
    tries.push(
      ["POST", `/gifts/groups/${l.aunts.id}/members`, { expectedRevision: 1, remove: [l.ann.id] }],
      ["POST", `/gifts/groups/${l.aunts.id}/members`, { add: [], dryRun: true }],
      ["GET", `/gifts/occasions/${l.xmas.id}/sync`],
      ["POST", `/gifts/occasions/${l.xmas.id}/sync`, { previewToken: "x", decisions: {} }],
      ["GET", `/gifts/occasions/${l.xmas.id}/summary`],
    );
    for (const token of [w.curly, admin]) {
      for (const [method, path, input] of tries) {
        const theirs = await api(w.plugin, method, path, { token, ...(input !== undefined ? { body: input } : {}) });
        const unknown = await api(w.plugin, method, path.replace(/\/g([a-z]+)\d+/, "/g$1999"), { token, ...(input !== undefined ? { body: input } : {}) });
        expect(`${method} ${path} ${theirs.status}`).toBe(`${method} ${path} 404`);
        expect(await theirs.text()).toBe(await unknown.text());
      }
      // A write naming the owner's records is refused as not found too: nothing of theirs can be pointed at.
      const pointing = await api(w.plugin, "POST", "/gifts/groups", { token, body: { name: "Mine", memberIds: [l.ann.id] } });
      expect(pointing.status).toBe(404);
      // Their own item, occasion and person, with one of Larry's ids swapped in at a time.
      const mine = {
        itemId: (await create(w, "items", item("Mine"), token)).id,
        occasionId: (await create(w, "occasions", christmas(), token)).id,
        recipientIds: [(await create(w, "recipients", person("Kin"), token)).id],
        quantity: 1,
        shared: false,
        purchaseId: null,
        handoff: "none",
        givenOn: null,
      };
      expect((await api(w.plugin, "POST", "/gifts/allocations", { token, body: mine })).status).toBe(201);
      for (const swap of [{ itemId: l.scarf.id }, { occasionId: l.xmas.id }, { recipientIds: [l.ann.id] }, { purchaseId: l.bought.id }]) {
        const res = await api(w.plugin, "POST", "/gifts/allocations", { token, body: { ...mine, ...swap } });
        expect(`${Object.keys(swap)[0]} ${res.status}`).toBe(`${Object.keys(swap)[0]} 404`);
      }
      expect((await api(w.plugin, "POST", "/gifts/purchases", { token, body: purchase(l.scarf.id, 1) })).status).toBe(404);
      const batch = await read(
        await api(w.plugin, "POST", "/gifts/batch", { token, body: { writes: [{ op: "update", collection: "recipients", id: l.ann.id, expectedRevision: 1, fields: { notes: "mine" } }] } }),
      );
      expect(batch.results[0].status).toBe(404);
      for (const collection of Object.keys(GIFT_COLLECTIONS)) {
        const list = await read(await api(w.plugin, "GET", `/gifts/${collection}?includeArchived=true`, { token }));
        const larrys = list.records.filter((r: { ownerId: string }) => r.ownerId === l.ann.ownerId);
        expect(`${collection} ${larrys.length}`).toBe(`${collection} 0`);
      }
      // Their spend is their own planned allocation only: Larry's 2000 bought never shows.
      expect((await read(await api(w.plugin, "GET", "/gifts/spend", { token }))).spend).toMatchObject([{ currency: "USD", plannedMinor: 2500, spentMinor: 0 }]);
    }
    // The others' own records were written; Larry's rows are exactly as they were.
    const larryRows = (dump: string) => JSON.stringify(JSON.parse(dump).map(([t, rows]: [string, { owner_id: string }[]]) => [t, rows.filter((r) => r.owner_id === l.ann.ownerId)]));
    expect(larryRows(giftRows(w.dbPath))).toBe(larryRows(before));
  });

  it("a task's notification recipient gets no gift access through the task they were shared", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "wrap the presents", when: "9am", repeat: "day" } });
    await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } });
    await press(w.plugin, "tracker:a.t.t1", CURLY);
    const l = await ledger(w);
    expect((await api(w.plugin, "GET", `/gifts/recipients/${l.ann.id}`, { token: w.curly })).status).toBe(404);
    expect((await read(await api(w.plugin, "GET", "/gifts/recipients", { token: w.curly }))).records).toEqual([]);
    expect((await api(w.plugin, "GET", `/gifts/occasions/${l.xmas.id}/summary`, { token: w.curly })).status).toBe(404);
  });

  it("a replayed Idempotency-Key gives one write; a stale revision is 409 and changes nothing", async () => {
    const w = await setup();
    const key = { "idempotency-key": "gift-create-0001" };
    const first = await api(w.plugin, "POST", "/gifts/recipients", { token: w.larry, body: person("Ann"), headers: key });
    const again = await api(w.plugin, "POST", "/gifts/recipients", { token: w.larry, body: person("Ann"), headers: key });
    expect([first.status, again.status, again.headers.get("idempotency-replayed")]).toEqual([201, 201, "true"]);
    expect(await again.json()).toEqual(await first.json());
    expect((await read(await api(w.plugin, "GET", "/gifts/recipients", { token: w.larry }))).records).toHaveLength(1);
    const other = await api(w.plugin, "POST", "/gifts/recipients", { token: w.larry, body: person("Bea"), headers: key });
    expect([other.status, (await read(other)).error.code]).toEqual([409, "idempotency_conflict"]);

    await api(w.plugin, "PATCH", "/gifts/recipients/gr1", { token: w.larry, body: { expectedRevision: 1, notes: "first" } });
    const before = giftRows(w.dbPath);
    const stale = await api(w.plugin, "PATCH", "/gifts/recipients/gr1", { token: w.larry, body: { expectedRevision: 1, notes: "second" } });
    expect(stale.status).toBe(409);
    expect((await read(stale)).error).toMatchObject({ code: "revision_conflict", currentRevision: 2 });
    expect(giftRows(w.dbPath)).toBe(before);
  });

  it("edits a group's members, previewed first, without touching the people", async () => {
    const w = await setup();
    const l = await ledger(w);
    const cal = await create(w, "recipients", person("Cal"));
    const path = `/gifts/groups/${l.aunts.id}/members`;
    const dry = await read(await api(w.plugin, "POST", path, { token: w.larry, body: { add: [cal.id, l.ann.id], remove: [l.bea.id], dryRun: true } }));
    expect(dry).toEqual({ added: [cal.id], removed: [l.bea.id], memberIds: [l.ann.id, cal.id], revision: 1 });
    // A preview refuses what the write would: an id that is no recipient of Larry's.
    expect((await api(w.plugin, "POST", path, { token: w.larry, body: { add: ["gr999"], dryRun: true } })).status).toBe(404);
    expect((await read(await api(w.plugin, "GET", `/gifts/groups/${l.aunts.id}`, { token: w.larry }))).record.revision).toBe(1);
    const done = await read(await api(w.plugin, "POST", path, { token: w.larry, body: { expectedRevision: 1, add: [cal.id], remove: [l.bea.id] } }));
    expect(done.record).toMatchObject({ revision: 2, memberIds: [l.ann.id, cal.id] });
    expect((await read(await api(w.plugin, "GET", `/gifts/recipients/${l.bea.id}`, { token: w.larry }))).record.archived).toBe(false);
  });

  it("syncs an occasion's roster with its groups only as previewed, with a decision for each bought gift on someone leaving", async () => {
    const w = await setup();
    const l = await ledger(w);
    await api(w.plugin, "POST", `/gifts/groups/${l.aunts.id}/members`, { token: w.larry, body: { expectedRevision: 1, remove: [l.ann.id] } });
    const shown = await read(await api(w.plugin, "GET", `/gifts/occasions/${l.xmas.id}/sync`, { token: w.larry }));
    expect(shown.preview.roster).toEqual([l.bea.id]);
    expect(shown.preview.removed.map((r: { row: { id: string } }) => r.row.id)).toEqual([l.annRow.id]);
    expect(shown.preview.affected).toEqual([{ allocationId: l.gift.id, revision: 1, recipientIds: [l.ann.id], dropped: [l.ann.id], bought: true }]);
    const path = `/gifts/occasions/${l.xmas.id}/sync`;
    // A decision docket would read as unassign unless refused here: a bare word, a misspelt action, an empty one, a reassign to nobody.
    const unchanged = giftRows(w.dbPath);
    for (const bad of ["keep", { action: "KEEP" }, {}, null, { action: "reassign" }, { action: "keep", recipientIds: [] }]) {
      const res = await api(w.plugin, "POST", `/gifts/occasions/${l.xmas.id}/sync`, { token: w.larry, body: { previewToken: shown.previewToken, decisions: { [l.gift.id]: bad } } });
      expect(`${JSON.stringify(bad)} ${res.status}`).toBe(`${JSON.stringify(bad)} 400`);
    }
    expect(giftRows(w.dbPath)).toBe(unchanged);
    // No decision for the bought scarf: nothing is planned or written.
    const undecided = await api(w.plugin, "POST", path, { token: w.larry, body: { previewToken: shown.previewToken, decisions: {} } });
    expect(undecided.status).toBe(400);
    // A gift in the preview moved since: refused, the owner previews again.
    await api(w.plugin, "PATCH", `/gifts/allocations/${l.gift.id}`, { token: w.larry, body: { expectedRevision: 1, handoff: "wrapped" } });
    const before = giftRows(w.dbPath);
    const stale = await api(w.plugin, "POST", path, { token: w.larry, body: { previewToken: shown.previewToken, decisions: { [l.gift.id]: { action: "reassign", recipientIds: [l.bea.id] } } } });
    expect([stale.status, (await read(stale)).error.code]).toEqual([409, "stale_preview"]);
    expect(giftRows(w.dbPath)).toBe(before);
    const fresh = await read(await api(w.plugin, "GET", path, { token: w.larry }));
    const applied = await api(w.plugin, "POST", path, { token: w.larry, body: { previewToken: fresh.previewToken, decisions: { [l.gift.id]: { action: "reassign", recipientIds: [l.bea.id] } } } });
    expect(applied.status).toBe(200);
    expect((await read(applied)).roster.map((r: { recipientId: string }) => r.recipientId)).toEqual([l.bea.id]);
    expect((await read(await api(w.plugin, "GET", `/gifts/allocations/${l.gift.id}`, { token: w.larry }))).record.recipientIds).toEqual([l.bea.id]);
    // Ann herself, and her archived row, stay.
    expect((await read(await api(w.plugin, "GET", `/gifts/occasion-recipients/${l.annRow.id}`, { token: w.larry }))).record.archived).toBe(true);
  });

  it("summarizes an occasion's coverage, budget and cost, and the ledger's spend per currency", async () => {
    const w = await setup();
    const l = await ledger(w);
    const s = await read(await api(w.plugin, "GET", `/gifts/occasions/${l.xmas.id}/summary`, { token: w.larry }));
    expect(s.coverage.map((c: { recipientId: string; status: string }) => [c.recipientId, c.status])).toEqual([
      [l.ann.id, "awaiting"],
      [l.bea.id, "needs-planning"],
    ]);
    expect(s.counts).toEqual({ awaiting: 1, "needs-planning": 1 });
    expect(s.budget).toEqual({ currency: "USD", budgetMinor: 50000, recipientBudgetsMinor: 5000, recipients: 2 });
    expect(s.cost).toEqual([{ currency: "USD", minor: 2000 }]);
    const spend = await read(await api(w.plugin, "GET", "/gifts/spend", { token: w.larry }));
    expect(spend.spend).toEqual([{ currency: "USD", plannedMinor: 0, spentMinor: 2000, pendingRefundMinor: 0, refundedMinor: 0, netMinor: 2000, incomplete: false }]);
  });

  it("splits one purchase line over two occasions' gifts, in the order they were made, never counting it whole twice", async () => {
    const w = await setup();
    const l = await ledger(w); // one scarf bought for Ann at Christmas
    const birthday = await create(w, "occasions", { ...christmas(), kind: "birthday", title: "Bea's birthday", date: "2027-03-01", year: 2027, groupIds: [] });
    await create(w, "occasion-recipients", { occasionId: birthday.id, recipientId: l.bea.id, target: null, budgetMinor: null, decision: "planning", skipReason: null });
    await api(w.plugin, "PATCH", `/gifts/purchases/${l.bought.id}`, { token: w.larry, body: { expectedRevision: 1, ordered: 3, taxMinor: 300 } }); // 3 x 2000 + 300
    await create(w, "allocations", { itemId: l.scarf.id, occasionId: birthday.id, recipientIds: [l.bea.id], quantity: 2, shared: false, purchaseId: l.bought.id, handoff: "none", givenOn: null });
    const xmas = await read(await api(w.plugin, "GET", `/gifts/occasions/${l.xmas.id}/summary`, { token: w.larry }));
    const bday = await read(await api(w.plugin, "GET", `/gifts/occasions/${birthday.id}/summary`, { token: w.larry }));
    expect([xmas.cost, bday.cost]).toEqual([[{ currency: "USD", minor: 2100 }], [{ currency: "USD", minor: 4200 }]]);
    // A return empties the last bucket filled: the birthday's second unit, not Christmas's.
    await api(w.plugin, "PATCH", `/gifts/purchases/${l.bought.id}`, { token: w.larry, body: { expectedRevision: 2, returned: 1 } });
    const after = await read(await api(w.plugin, "GET", `/gifts/occasions/${l.xmas.id}/summary`, { token: w.larry }));
    expect(after.coverage[0]).toMatchObject({ recipientId: l.ann.id, status: "awaiting", bought: 1 });
    const bea = await read(await api(w.plugin, "GET", `/gifts/occasions/${birthday.id}/summary`, { token: w.larry }));
    expect(bea.coverage[0]).toMatchObject({ recipientId: l.bea.id, bought: 1 });
  });

  it("a batch writes each row in order with its own outcome; a refused row leaves the others as they went", async () => {
    const w = await setup();
    const res = await api(w.plugin, "POST", "/gifts/batch", {
      token: w.larry,
      body: {
        writes: [
          { op: "create", collection: "recipients", fields: person("Ann") },
          { op: "create", collection: "recipients", fields: { displayName: "Bea" } },
          { op: "update", collection: "recipients", id: "gr1", expectedRevision: 1, fields: { notes: "scarves" } },
          { op: "update", collection: "recipients", id: "gr1", expectedRevision: 1, fields: { notes: "hats" } },
          { op: "delete", collection: "recipients", id: "gr1", fields: {} },
        ],
      },
    });
    expect(res.status).toBe(200);
    const { results } = await read(res);
    expect(results.map((r: { index: number; status: number }) => [r.index, r.status])).toEqual([
      [0, 201],
      [1, 400],
      [2, 200],
      [3, 409],
      [4, 400],
    ]);
    expect(results[2].body.record).toMatchObject({ id: "gr1", revision: 2, notes: "scarves" });
    const too = await api(w.plugin, "POST", "/gifts/batch", { token: w.larry, body: { writes: Array.from({ length: MAX_GIFT_BATCH + 1 }, () => ({})) } });
    expect(too.status).toBe(400);
  });
});

describe("the gift route table", () => {
  it("names a route for each collection, record and view, and no other path", () => {
    expect(giftRoute("/gifts/recipients")).toEqual({ kind: "collection", collection: "recipients" });
    expect(giftRoute("/gifts/occasion-recipients/gor3")).toEqual({ kind: "record", collection: "occasion-recipients", id: "gor3" });
    expect(giftRoute("/gifts/groups/gg1/members")).toEqual({ kind: "members", id: "gg1" });
    expect(giftRoute("/gifts/occasions/go1/sync")).toEqual({ kind: "sync", id: "go1" });
    expect(giftRoute("/gifts/occasions/go1/summary")).toEqual({ kind: "summary", id: "go1" });
    expect(giftRoute("/gifts/spend")).toEqual({ kind: "spend" });
    expect(giftRoute("/gifts/batch")).toEqual({ kind: "batch" });
    for (const path of ["/gifts/toString", "/gifts/__proto__", "/gifts/items/gi1/members", "/gifts/recipients/gr1/sync", "/gifts"]) expect(giftRoute(path)).toBeNull();
    expect(giftMethods({ kind: "spend" })).toEqual(["GET"]);
  });
});
