import { afterEach, describe, expect, it } from "bun:test";
import { api, cleanup, CURLY, LARRY, makeToken, people, signIn, world } from "./harness.js";

/**
 * docket 0.27.0's gift features in the task API (rackbops-bot-plugins#386): filter groups
 * (docket#98), "set up next year" (docket#99) and duplicate warnings (docket#100), through the
 * plugin's own `http` handler. Every family here is made up.
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

const person = (displayName: string, labels: string[] = []) => ({ displayName, kind: "person", memberIds: [], labels, interests: [], avoid: [], notes: null });
const occasion = (title: string, date: string, groupIds: string[] = [], kind = "christmas") => ({
  kind,
  title,
  date,
  timeZone: null,
  year: Number(date.slice(0, 4)),
  currency: "USD",
  budgetMinor: 50000,
  groupIds,
  includeIds: [],
  excludeIds: [],
});
const item = (title: string, url: string | null = null) => ({
  title,
  url,
  productKey: null,
  variant: null,
  notes: null,
  source: { kind: "manual", ref: null },
  planning: "selected",
  estimateMinor: 2500,
  currency: "USD",
});
const allocation = (itemId: string, occasionId: string, recipientIds: string[], extra: Record<string, unknown> = {}) => ({
  itemId,
  occasionId,
  recipientIds,
  quantity: 1,
  shared: false,
  purchaseId: null,
  handoff: "none",
  givenOn: null,
  ...extra,
});
const row = (occasionId: string, recipientId: string, target: number | null = null, budgetMinor: number | null = null) => ({ occasionId, recipientId, target, budgetMinor, decision: "planning", skipReason: null });

async function create(w: W, collection: string, fields: unknown, token = w.larry): Promise<Json> {
  const res = await api(w.plugin, "POST", `/gifts/${collection}`, { token, body: fields });
  const body = await read(res);
  if (res.status !== 201) throw new Error(`create ${collection}: ${res.status} ${JSON.stringify(body)}`);
  return body.record;
}
const list = async (w: W, collection: string, query = ""): Promise<Json[]> => (await read(await api(w.plugin, "GET", `/gifts/${collection}?includeArchived=true${query}`, { token: w.larry }))).records;

describe("filter groups (docket#98)", () => {
  it("round-trips a group's labels, refuses what docket refuses as 400, and turns back into a list with filter null", async () => {
    const w = await setup();
    const cousins = await create(w, "groups", { name: "Cousins", memberIds: [], filter: { labels: ["Cousin"] } });
    expect(cousins).toMatchObject({ name: "Cousins", memberIds: [], filter: { labels: ["Cousin"] } });
    expect((await read(await api(w.plugin, "GET", `/gifts/groups/${cousins.id}`, { token: w.larry }))).record.filter).toEqual({ labels: ["Cousin"] });
    const patched = await read(await api(w.plugin, "PATCH", `/gifts/groups/${cousins.id}`, { token: w.larry, body: { expectedRevision: 1, filter: { labels: ["cousin", "adult"] } } }));
    expect(patched.record).toMatchObject({ revision: 2, filter: { labels: ["cousin", "adult"] } });
    for (const bad of [{ filter: { labels: [] } }, { filter: { labels: ["x"], age: 3 } }, { filter: { labels: ["x"] }, memberIds: ["gr1"] }]) {
      const res = await api(w.plugin, "POST", "/gifts/groups", { token: w.larry, body: { name: "Bad", memberIds: [], ...bad } });
      expect(res.status).toBe(400);
      expect((await read(res)).error.code).toBe("invalid");
    }
    const listed = await read(await api(w.plugin, "PATCH", `/gifts/groups/${cousins.id}`, { token: w.larry, body: { expectedRevision: 2, filter: null } }));
    expect(listed.record).toMatchObject({ revision: 3, filter: null, memberIds: [] });
  });

  it("syncs an occasion to exactly the label matches, moves the token when a label moves, and applies it", async () => {
    const w = await setup();
    const ann = await create(w, "recipients", person("Ann", ["cousin"]));
    const bea = await create(w, "recipients", person("Bea", ["Cousin ", "adult"]));
    const cal = await create(w, "recipients", person("Cal"));
    await create(w, "recipients", person("Dee", ["aunt"]));
    const cousins = await create(w, "groups", { name: "Cousins", memberIds: [], filter: { labels: ["cousin"] } });
    const xmas = await create(w, "occasions", occasion("Christmas 2026", "2026-12-25", [cousins.id]));
    const path = `/gifts/occasions/${xmas.id}/sync`;
    const first = await read(await api(w.plugin, "GET", path, { token: w.larry }));
    expect(first.preview.roster).toEqual([ann.id, bea.id]);
    expect(first.preview.added.map((a: Json) => a.recipientId)).toEqual([ann.id, bea.id]);
    // Cal gains the label: the matches move, and so does the token, though no group's revision did.
    expect((await api(w.plugin, "PATCH", `/gifts/recipients/${cal.id}`, { token: w.larry, body: { expectedRevision: 1, labels: ["cousin"] } })).status).toBe(200);
    const second = await read(await api(w.plugin, "GET", path, { token: w.larry }));
    expect(second.preview.roster).toEqual([ann.id, bea.id, cal.id]);
    expect(second.preview.groupRevisions).toEqual(first.preview.groupRevisions);
    expect(second.previewToken).not.toBe(first.previewToken);
    const stale = await api(w.plugin, "POST", path, { token: w.larry, body: { previewToken: first.previewToken, decisions: {} } });
    expect(stale.status).toBe(409);
    expect((await read(stale)).error.code).toBe("stale_preview");
    expect(await list(w, "occasion-recipients")).toEqual([]);
    const applied = await api(w.plugin, "POST", path, { token: w.larry, body: { previewToken: second.previewToken, decisions: {} } });
    expect(applied.status).toBe(200);
    expect((await read(applied)).roster.map((r: Json) => r.recipientId)).toEqual([ann.id, bea.id, cal.id]);
  });

  it("refuses the members route on a filter group with 409 filter_group, dry run or not, and changes nothing", async () => {
    const w = await setup();
    const ann = await create(w, "recipients", person("Ann", ["cousin"]));
    const cousins = await create(w, "groups", { name: "Cousins", memberIds: [], filter: { labels: ["cousin"] } });
    for (const body of [{ add: [ann.id], dryRun: true }, { add: [ann.id], expectedRevision: 1 }, { remove: [ann.id], expectedRevision: 1 }]) {
      const res = await api(w.plugin, "POST", `/gifts/groups/${cousins.id}/members`, { token: w.larry, body });
      expect(res.status).toBe(409);
      const e = (await read(res)).error;
      expect(e.code).toBe("filter_group");
      expect(e.message).toBe("This group is a saved filter over your labels; change its labels instead.");
    }
    expect((await read(await api(w.plugin, "GET", `/gifts/groups/${cousins.id}`, { token: w.larry }))).record).toMatchObject({ revision: 1, memberIds: [] });
    // A static group still takes the members route as before.
    const aunts = await create(w, "groups", { name: "Aunts", memberIds: [] });
    expect((await api(w.plugin, "POST", `/gifts/groups/${aunts.id}/members`, { token: w.larry, body: { add: [ann.id], expectedRevision: 1 } })).status).toBe(200);
  });
});

/** Larry's Christmas 2026 for the Aunts (Ann, Bea): a scarf bought for Ann, a book planned for Bea, and a mug planned for Ann. */
async function christmas(w: W) {
  const ann = await create(w, "recipients", person("Ann"));
  const bea = await create(w, "recipients", person("Bea"));
  const aunts = await create(w, "groups", { name: "Aunts", memberIds: [ann.id, bea.id] });
  const xmas = await create(w, "occasions", { ...occasion("Christmas 2026", "2026-12-25", [aunts.id]), deadline: "2026-12-15" });
  await create(w, "occasion-recipients", row(xmas.id, ann.id, 2, 3000));
  await create(w, "occasion-recipients", row(xmas.id, bea.id));
  const scarf = await create(w, "items", item("Scarf"));
  const bought = await create(w, "purchases", {
    itemId: scarf.id,
    merchant: "Corner Shop",
    currency: "USD",
    unitPriceMinor: 2000,
    ordered: 1,
    received: 1,
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
  const scarfGift = await create(w, "allocations", allocation(scarf.id, xmas.id, [ann.id], { purchaseId: bought.id, handoff: "wrapped" }));
  const book = await create(w, "items", item("Book"));
  const bookGift = await create(w, "allocations", allocation(book.id, xmas.id, [bea.id]));
  const mug = await create(w, "items", item("Mug"));
  const mugGift = await create(w, "allocations", allocation(mug.id, xmas.id, [ann.id]));
  return { ann, bea, aunts, xmas, scarfGift, book, bookGift, mugGift };
}

describe("rollover (docket#99)", () => {
  it("previews next year with the picked idea only, no purchase or given state, and the token over the choices", async () => {
    const w = await setup();
    const c = await christmas(w);
    const path = `/gifts/occasions/${c.xmas.id}/rollover`;
    const res = await api(w.plugin, "GET", `${path}?ideaIds=${c.bookGift.id}`, { token: w.larry });
    expect(res.status).toBe(200);
    const { preview, previewToken } = await read(res);
    expect(preview.occasion).toMatchObject({ title: "Christmas 2027", date: "2027-12-25", year: 2027, deadline: "2027-12-15", groupIds: [c.aunts.id] });
    expect(preview.roster).toEqual([
      { recipientId: c.ann.id, target: 2, budgetMinor: 3000, carried: true },
      { recipientId: c.bea.id, target: null, budgetMinor: null, carried: true },
    ]);
    expect(preview.ideas).toEqual([{ fromAllocationId: c.bookGift.id, itemId: c.book.id, recipientIds: [c.bea.id], dropped: [], quantity: 1, shared: false }]);
    // The bought, wrapped scarf is never pickable; the unbought mug is, but was not picked.
    expect(preview.pickable).toEqual([c.bookGift.id, c.mugGift.id]);
    expect(previewToken).toMatch(/^[0-9a-f]{32}$/);
    const plain = await read(await api(w.plugin, "GET", path, { token: w.larry }));
    expect(plain.preview.ideas).toEqual([]);
    expect(plain.previewToken).not.toBe(previewToken);
    const custom = await read(await api(w.plugin, "GET", `${path}?date=2027-12-24&title=${encodeURIComponent("Christmas Eve 2027")}&deadline=`, { token: w.larry }));
    expect(custom.preview.occasion).toMatchObject({ title: "Christmas Eve 2027", date: "2027-12-24", deadline: null });
    const scarf = await api(w.plugin, "GET", `${path}?ideaIds=${c.scarfGift.id}`, { token: w.larry });
    expect(scarf.status).toBe(400);
    expect((await read(scarf)).error.code).toBe("invalid");
  });

  it("makes it from the reviewed token, replays a retry with the same Idempotency-Key, and refuses a stale token", async () => {
    const w = await setup();
    const c = await christmas(w);
    const path = `/gifts/occasions/${c.xmas.id}/rollover`;
    const { previewToken } = await read(await api(w.plugin, "GET", `${path}?ideaIds=${c.bookGift.id}`, { token: w.larry }));
    const wrong = await api(w.plugin, "POST", path, { token: w.larry, body: { previewToken: "0".repeat(32), ideaIds: [c.bookGift.id] } });
    expect(wrong.status).toBe(409);
    expect((await read(wrong)).error.code).toBe("stale_preview");
    // The same token sent without the picks it was made with names another preview: refused too.
    expect((await api(w.plugin, "POST", path, { token: w.larry, body: { previewToken } })).status).toBe(409);
    expect((await list(w, "occasions")).length).toBe(1);
    const send = () => api(w.plugin, "POST", path, { token: w.larry, body: { previewToken, ideaIds: [c.bookGift.id] }, headers: { "idempotency-key": "rollover-2027-a" } });
    const made = await send();
    expect(made.status).toBe(201);
    const body = await read(made);
    expect(body.occasion).toMatchObject({ title: "Christmas 2027", date: "2027-12-25", recordKind: "occasion" });
    expect(body.roster.map((r: Json) => [r.recipientId, r.target, r.budgetMinor, r.decision])).toEqual([
      [c.ann.id, 2, 3000, "planning"],
      [c.bea.id, null, null, "planning"],
    ]);
    const gifts = await list(w, "allocations", `&occasionId=${body.occasion.id}`);
    expect(gifts).toEqual([expect.objectContaining({ itemId: c.book.id, recipientIds: [c.bea.id], purchaseId: null, handoff: "none", repeatOf: [c.bookGift.id] })]);
    const again = await send();
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(await read(again)).toEqual(body);
    expect((await list(w, "occasions")).length).toBe(2);
    // The old occasion was never written.
    expect((await read(await api(w.plugin, "GET", `/gifts/occasions/${c.xmas.id}`, { token: w.larry }))).record.revision).toBe(1);
    // Something moved since a preview: its token no longer names what would be made.
    const before = await read(await api(w.plugin, "GET", path, { token: w.larry }));
    expect((await api(w.plugin, "PATCH", `/gifts/groups/${c.aunts.id}`, { token: w.larry, body: { expectedRevision: 1, name: "The aunts" } })).status).toBe(200);
    const moved = await api(w.plugin, "POST", path, { token: w.larry, body: { previewToken: before.previewToken } });
    expect(moved.status).toBe(409);
    expect((await read(moved)).error.code).toBe("stale_preview");
  });

  it("is the same 404 for another member, preview or make", async () => {
    const w = await setup();
    const c = await christmas(w);
    const path = `/gifts/occasions/${c.xmas.id}/rollover`;
    const { previewToken } = await read(await api(w.plugin, "GET", path, { token: w.larry }));
    // The api-gifts.test.ts sweep's rule, kept here for the rollover routes (that sweep is at the rate limit's burst).
    for (const [method, body] of [["GET", undefined], ["POST", { previewToken }]] as const) {
      const theirs = await api(w.plugin, method, path, { token: w.curly, ...(body ? { body } : {}) });
      const unknown = await api(w.plugin, method, "/gifts/occasions/go999/rollover", { token: w.curly, ...(body ? { body } : {}) });
      expect(theirs.status).toBe(404);
      expect(await theirs.text()).toBe(await unknown.text());
    }
    expect((await api(w.plugin, "GET", "/gifts/occasions/go999/rollover", { token: w.larry })).status).toBe(404);
    expect((await list(w, "occasions")).length).toBe(1);
  });
});

describe("duplicate warnings (docket#100)", () => {
  async function shop(w: W) {
    const ann = await create(w, "recipients", person("Ann"));
    const xmas = await create(w, "occasions", occasion("Christmas 2026", "2026-12-25"));
    const birthday = await create(w, "occasions", occasion("Ann's birthday 2027", "2027-03-02", [], "birthday"));
    const lego = await create(w, "items", item("Castle set", "https://www.shop.example/castle?utm_source=mail"));
    const first = await create(w, "allocations", allocation(lego.id, xmas.id, [ann.id]));
    return { ann, xmas, birthday, lego, first };
  }

  it("refuses the same item for the same person on another live occasion with 409 and the report, writing nothing; repeatOf accepts it", async () => {
    const w = await setup();
    const s = await shop(w);
    const again = allocation(s.lego.id, s.birthday.id, [s.ann.id]);
    const res = await api(w.plugin, "POST", "/gifts/allocations", { token: w.larry, body: again });
    expect(res.status).toBe(409);
    const e = (await read(res)).error;
    expect(e.code).toBe("possible_duplicate");
    expect(e.warnings).toEqual([{ allocationId: s.first.id, itemId: s.lego.id, occasionId: s.xmas.id, recipientIds: [s.ann.id], where: "open", match: "item", accepted: false }]);
    expect(e.possible).toEqual([]);
    expect((await list(w, "allocations")).map((a) => a.id)).toEqual([s.first.id]);
    const accepted = await api(w.plugin, "POST", "/gifts/allocations", { token: w.larry, body: { ...again, repeatOf: [s.first.id] } });
    expect(accepted.status).toBe(201);
    const made = await read(accepted);
    expect(made.record.repeatOf).toEqual([s.first.id]);
    expect(made.duplicates).toBeUndefined();
  });

  it("lets a possible duplicate through with 201 and `duplicates`, and refuses a batch create's warning row alone", async () => {
    const w = await setup();
    const s = await shop(w);
    // The same title, no link: only a possible duplicate.
    const lookalike = await create(w, "items", item("Castle Set"));
    const res = await api(w.plugin, "POST", "/gifts/allocations", { token: w.larry, body: allocation(lookalike.id, s.birthday.id, [s.ann.id]) });
    expect(res.status).toBe(201);
    const body = await read(res);
    expect(body.duplicates).toEqual([{ allocationId: s.first.id, itemId: s.lego.id, occasionId: s.xmas.id, recipientIds: [s.ann.id], where: "open", match: "title", accepted: false }]);
    expect(body.record.repeatOf).toBeUndefined();
    const batch = await read(
      await api(w.plugin, "POST", "/gifts/batch", {
        token: w.larry,
        body: { writes: [{ op: "create", collection: "allocations", fields: allocation(s.lego.id, s.birthday.id, [s.ann.id]) }, { op: "create", collection: "items", fields: item("Socks") }] },
      }),
    );
    expect(batch.results.map((r: Json) => r.status)).toEqual([409, 201]);
    expect(batch.results[0].body.error.code).toBe("possible_duplicate");
    expect((await list(w, "allocations")).length).toBe(2);
  });

  it("still refuses a bad or foreign allocation as before, never with a warning first", async () => {
    const w = await setup();
    const s = await shop(w);
    const theirs = await create(w, "occasions", occasion("Christmas 2026", "2026-12-25"), w.curly);
    expect((await api(w.plugin, "POST", "/gifts/allocations", { token: w.larry, body: allocation(s.lego.id, theirs.id, [s.ann.id]) })).status).toBe(404);
    expect((await api(w.plugin, "POST", "/gifts/allocations", { token: w.larry, body: allocation(s.lego.id, s.birthday.id, [s.ann.id], { quantity: 0 }) })).status).toBe(400);
  });
});
