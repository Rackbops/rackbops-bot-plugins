import { afterEach, describe, expect, it } from "bun:test";
import { api, call, cleanup, CURLY, csrfOf, hidden, type Jar, LARRY, makeToken, ORIGIN, people, signIn, world } from "./harness.js";

/**
 * docket 0.27.0's gift features on the family gift pages (rackbops-bot-plugins#386): filter groups
 * (docket#98), "Roll over to next year" (docket#99) and the gift form's duplicate warnings
 * (docket#100), signed in as a browser is. Every family here is made up.
 */

afterEach(cleanup);

// biome-ignore lint/suspicious/noExplicitAny: test reads of JSON answers
type Json = any;

async function setup() {
  const w = await world();
  await people(w.plugin);
  const jar = await signIn(w.plugin, LARRY);
  const csrf = await csrfOf(w.plugin, jar);
  const token = await makeToken(w, jar);
  return { ...w, jar, csrf, token };
}
type W = Awaited<ReturnType<typeof setup>>;

const post = (w: W, path: string, fields: [string, string][], jar: Jar = w.jar, csrf = w.csrf) => call(w.plugin, "POST", path, { jar, origin: ORIGIN, form: [["csrf", csrf], ...fields] });
const get = (w: W, path: string, jar: Jar = w.jar) => call(w.plugin, "GET", path, { jar });

async function create(w: W, collection: string, fields: unknown): Promise<Json> {
  const res = await api(w.plugin, "POST", `/gifts/${collection}`, { token: w.token, body: fields });
  const body = (await res.json()) as Json;
  if (res.status !== 201) throw new Error(`create ${collection}: ${res.status} ${JSON.stringify(body)}`);
  return body.record;
}
const list = async (w: W, collection: string): Promise<Json[]> => ((await (await api(w.plugin, "GET", `/gifts/${collection}?includeArchived=true`, { token: w.token })).json()) as Json).records;
const person = (displayName: string, labels: string[] = []) => ({ displayName, kind: "person", memberIds: [], labels, interests: [], avoid: [], notes: null });
const occasion = (title: string, date: string, groupIds: string[] = []) => ({ kind: "christmas", title, date, timeZone: null, year: Number(date.slice(0, 4)), currency: "USD", budgetMinor: null, groupIds, includeIds: [], excludeIds: [] });
const occasionOf = (res: Response) => new URL(res.headers.get("location") ?? "", ORIGIN).searchParams.get("occasion") ?? "";

describe("filter groups on the gift pages", () => {
  it("makes a group from labels, previews and saves an occasion with its matches, and shows its labels", async () => {
    const w = await setup();
    const ann = await create(w, "recipients", person("Ann", ["cousin"]));
    const bea = await create(w, "recipients", person("Bea", ["Cousin"]));
    await create(w, "recipients", person("Cal", ["aunt"]));
    expect((await post(w, "/gifts/new/group", [["name", "Cousins"], ["labels", "cousin"]])).status).toBe(303);
    const [cousins] = await list(w, "groups");
    expect(cousins).toMatchObject({ name: "Cousins", memberIds: [], filter: { labels: ["cousin"] } });
    const fields: [string, string][] = [["kind", "christmas"], ["title", "Christmas 2026"], ["date", "2026-12-25"], ["currency", "USD"], ["group", cousins.id]];
    const preview = await post(w, "/gifts/new/occasion", [...fields, ["step", "preview"]]);
    expect(preview.status).toBe(200);
    const shown = await preview.text();
    expect(shown).toContain("Who this occasion will cover (2)");
    expect(shown).toContain("<p>Ann, Bea</p>");
    expect(shown).toContain("Cousins (everyone labelled cousin)");
    const saved = await post(w, "/gifts/new/occasion", [...fields, ["step", "save"]]);
    expect(saved.status).toBe(303);
    const id = occasionOf(saved);
    expect((await list(w, "occasion-recipients")).filter((r) => r.occasionId === id).map((r) => r.recipientId)).toEqual([ann.id, bea.id]);
    // The overview's group filter finds a filter group's members by its labels.
    const overview = await (await get(w, `/gifts?occasion=${id}&group=${cousins.id}`)).text();
    expect([...overview.matchAll(/data-recipient="([^"]+)"/g)].map((m) => m[1])).toEqual([ann.id, bea.id]);
  });
});

describe("the gift form's duplicate warnings", () => {
  it("shows a warning and writes nothing, then gives it anyway with repeatOf", async () => {
    const w = await setup();
    const ann = await create(w, "recipients", person("Ann"));
    const xmas = await create(w, "occasions", occasion("Christmas 2026", "2026-12-25"));
    const later = await create(w, "occasions", occasion("Christmas 2027", "2027-12-25"));
    const gift = (occasionId: string): [string, string][] => [["title", "Castle set"], ["url", "https://shop.example/castle"], ["currency", "USD"], ["occasion", occasionId], ["for", ann.id], ["quantity", "1"], ["step", "save"]];
    expect((await post(w, "/gifts/new/gift", gift(xmas.id))).status).toBe(303);
    const [first] = await list(w, "allocations");
    const warned = await post(w, "/gifts/new/gift", gift(later.id));
    expect(warned.status).toBe(409);
    const body = await warned.text();
    expect(body).toContain("Already planned or given");
    expect(body).toContain("Castle set for Ann, planned on Christmas 2026");
    expect(body).toContain("Give it anyway");
    expect(hidden(body, "repeatOf")).toBe(first.id);
    expect((await list(w, "items")).length).toBe(1);
    expect((await list(w, "allocations")).length).toBe(1);
    expect((await post(w, "/gifts/new/gift", [...gift(later.id), ["repeatOf", first.id]])).status).toBe(303);
    const made = (await list(w, "allocations")).find((a) => a.occasionId === later.id);
    expect(made.repeatOf).toEqual([first.id]);
  });
});

describe("Roll over to next year", () => {
  async function christmas(w: W) {
    const ann = await create(w, "recipients", person("Ann"));
    const bea = await create(w, "recipients", person("Bea"));
    const aunts = await create(w, "groups", { name: "Aunts", memberIds: [ann.id, bea.id] });
    const xmas = await create(w, "occasions", occasion("Christmas 2026", "2026-12-25", [aunts.id]));
    await create(w, "occasion-recipients", { occasionId: xmas.id, recipientId: ann.id, target: 1, budgetMinor: 2500, decision: "planning", skipReason: null });
    await create(w, "occasion-recipients", { occasionId: xmas.id, recipientId: bea.id, target: null, budgetMinor: null, decision: "planning", skipReason: null });
    const book = await create(w, "items", { title: "Book", url: null, productKey: null, variant: null, notes: null, source: { kind: "manual", ref: null }, planning: "selected", estimateMinor: null, currency: null });
    const idea = await create(w, "allocations", { itemId: book.id, occasionId: xmas.id, recipientIds: [bea.id], quantity: 1, shared: false, purchaseId: null, handoff: "none", givenOn: null });
    return { ann, bea, xmas, book, idea };
  }

  it("links from the occasion, previews with the picked idea, and sets up exactly the preview shown", async () => {
    const w = await setup();
    const c = await christmas(w);
    const path = `/gifts/occasions/${c.xmas.id}/rollover`;
    expect(await (await get(w, `/gifts?occasion=${c.xmas.id}`)).text()).toContain(`href="/tracker/gifts/occasions/${c.xmas.id}/rollover">Roll over to next year</a>`);
    const first = await get(w, path);
    expect(first.status).toBe(200);
    const shown = await first.text();
    expect(shown).toContain("New occasion: Christmas 2027, 2027-12-25.");
    expect(shown).toContain("25.00 USD");
    expect(shown).toContain(`value="${c.idea.id}"> Book for Bea`);
    // A stale confirm (the token of the page before the pick) makes nothing and shows the page again.
    const stale = await post(w, path, [["token", hidden(shown, "token")], ["idea", c.idea.id], ["step", "confirm"]]);
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("changed since that preview");
    const picked = await post(w, path, [["token", hidden(shown, "token")], ["idea", c.idea.id], ["step", "preview"]]);
    expect(picked.status).toBe(200);
    const again = await picked.text();
    expect(again).toContain(`value="${c.idea.id}" checked`);
    const made = await post(w, path, [["token", hidden(again, "token")], ["idea", c.idea.id], ["step", "confirm"]]);
    expect(made.status).toBe(303);
    const id = occasionOf(made);
    expect(new URL(made.headers.get("location") ?? "", ORIGIN).searchParams.get("done")).toBe("rolled");
    const occasions = await list(w, "occasions");
    expect(occasions.find((o) => o.id === id)).toMatchObject({ title: "Christmas 2027", date: "2027-12-25" });
    expect((await list(w, "allocations")).filter((a) => a.occasionId === id)).toEqual([expect.objectContaining({ itemId: c.book.id, recipientIds: [c.bea.id], repeatOf: [c.idea.id] })]);
    // Another member sees no such page.
    const curly = await signIn(w.plugin, CURLY);
    expect((await get(w, path, curly)).status).toBe(404);
  });
});
