import { afterEach, describe, expect, it } from "bun:test";
import { parseMoney } from "./gifts-web.js";
import { api, call, cleanup, CURLY, csrfOf, type Jar, LARRY, makeToken, ORIGIN, people, signIn, world } from "./harness.js";

/**
 * The family gift pages (rackbops-bot-plugins#384), through the plugin's own `http` handler, signed
 * in as a browser is. Every family here is made up.
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

async function post(w: W, path: string, fields: [string, string][], jar: Jar = w.jar, csrf = w.csrf): Promise<Response> {
  return call(w.plugin, "POST", path, { jar, origin: ORIGIN, form: [["csrf", csrf], ...fields] });
}

async function page(w: W, path: string, jar: Jar = w.jar): Promise<string> {
  const res = await call(w.plugin, "GET", path, { jar });
  expect(res.status).toBe(200);
  return res.text();
}

async function apiCreate(w: W, collection: string, fields: unknown): Promise<Json> {
  const res = await api(w.plugin, "POST", `/gifts/${collection}`, { token: w.token, body: fields });
  const body = (await res.json()) as Json;
  if (res.status !== 201) throw new Error(`create ${collection}: ${res.status} ${JSON.stringify(body)}`);
  return body.record;
}

async function idsByName(w: W): Promise<Record<string, string>> {
  const body = (await (await api(w.plugin, "GET", "/gifts/recipients", { token: w.token })).json()) as Json;
  return Object.fromEntries(body.records.map((r: Json) => [r.displayName, r.id]));
}

const counts = (body: string) =>
  Object.fromEntries([...body.matchAll(/data-stage="([a-z-]+)">(\d+)</g)].map((m) => [m[1], Number(m[2])]));
const rowsShown = (body: string) => [...body.matchAll(/data-recipient="([^"]+)"/g)].map((m) => m[1]);

const purchase = (itemId: string, ordered: number, received: number, returned = 0) => ({
  itemId,
  merchant: "Corner Shop",
  currency: "USD",
  unitPriceMinor: 1500,
  ordered,
  received,
  cancelled: 0,
  returned,
  taxMinor: 0,
  shippingMinor: 0,
  discountMinor: 0,
  totalComplete: true,
  refundedMinor: 0,
  purchasedOn: "2026-11-20",
  reference: null,
});

/**
 * Larry's synthetic family, built through the pages where a page can build it: Aunts (Ann, Bea,
 * Cal) and Cousins (Cal, Dee, Eve, Fay, Gil, Kim) overlap at Cal; the Hills household (Hal, Ivy)
 * is included by hand. Six calendars for six people, one returned; one shared household gift on
 * order; one mug already given; Kim has nothing yet.
 */
async function family(w: W) {
  for (const name of ["Ann", "Bea", "Cal", "Dee", "Eve", "Fay", "Gil", "Kim", "Hal", "Ivy"]) {
    expect((await post(w, "/gifts/new/person", [["name", name], ["kind", "person"]])).status).toBe(303);
  }
  let id = await idsByName(w);
  const hills = await post(w, "/gifts/new/person", [["name", "The Hills"], ["kind", "household"], ["member", id.Hal ?? ""], ["member", id.Ivy ?? ""]]);
  expect(hills.status).toBe(303);
  id = await idsByName(w);
  const members = (names: string[]): [string, string][] => names.map((n) => ["member", id[n] ?? ""]);
  expect((await post(w, "/gifts/new/group", [["name", "Aunts"], ...members(["Ann", "Bea", "Cal"])])).status).toBe(303);
  expect((await post(w, "/gifts/new/group", [["name", "Cousins"], ...members(["Cal", "Dee", "Eve", "Fay", "Gil", "Kim"])])).status).toBe(303);
  const groups = (await (await api(w.plugin, "GET", "/gifts/groups", { token: w.token })).json()) as Json;
  const groupId = Object.fromEntries(groups.records.map((g: Json) => [g.name, g.id])) as Record<string, string>;
  const occasionForm: [string, string][] = [
    ["kind", "christmas"],
    ["title", "Christmas 2026"],
    ["date", "2026-12-25"],
    ["currency", "usd"],
    ["budget", "600"],
    ["group", groupId.Aunts ?? ""],
    ["group", groupId.Cousins ?? ""],
    ["include", id["The Hills"] ?? ""],
  ];
  const saved = await post(w, "/gifts/new/occasion", occasionForm);
  expect(saved.status).toBe(303);
  const occasionId = new URL(saved.headers.get("location") ?? "", ORIGIN).searchParams.get("occasion") ?? "";
  expect(occasionId).not.toBe("");

  const giftFor = async (title: string, names: string[], shared = false) => {
    const fields: [string, string][] = [["title", title], ["estimate", "15"], ["currency", "USD"], ["occasion", occasionId], ["quantity", "1"], ...names.map((n): [string, string] => ["for", id[n] ?? ""])];
    if (shared) fields.push(["shared", "1"]);
    expect((await post(w, "/gifts/new/gift", fields)).status).toBe(303);
  };
  await giftFor("Calendar", ["Ann", "Bea", "Cal", "Dee", "Eve", "Fay"]);
  await giftFor("Board game", ["The Hills"], true);
  await giftFor("Mug", ["Gil"]);
  const allocations = ((await (await api(w.plugin, "GET", "/gifts/allocations", { token: w.token })).json()) as Json).records as Json[];
  const items = ((await (await api(w.plugin, "GET", "/gifts/items", { token: w.token })).json()) as Json).records as Json[];
  const allocationOf = (title: string) => allocations.find((a) => a.itemId === items.find((i) => i.title === title)?.id);

  // The board game through the purchase form: one unit on order, not yet arrived.
  const game = allocationOf("Board game");
  expect((await post(w, "/gifts/new/purchase", [["gift", game.id], ["merchant", "Game Shop"], ["currency", "USD"], ["price", "40"], ["on", "2026-11-21"]])).status).toBe(303);
  // Six calendars arrived, one went back: five people stay covered (docket#96's buckets fill in order).
  const calendar = allocationOf("Calendar");
  const six = await apiCreate(w, "purchases", purchase(calendar.itemId, 6, 6));
  const linked = await api(w.plugin, "PATCH", `/gifts/allocations/${calendar.id}`, { token: w.token, body: { expectedRevision: calendar.revision, purchaseId: six.id } });
  expect(linked.status).toBe(200);
  const returned = await api(w.plugin, "PATCH", `/gifts/purchases/${six.id}`, { token: w.token, body: { expectedRevision: six.revision, returned: 1 } });
  expect(returned.status).toBe(200);
  const mug = allocationOf("Mug");
  const one = await apiCreate(w, "purchases", purchase(mug.itemId, 1, 1));
  const given = await api(w.plugin, "PATCH", `/gifts/allocations/${mug.id}`, { token: w.token, body: { expectedRevision: mug.revision, purchaseId: one.id, handoff: "given", givenOn: "2026-11-25" } });
  expect(given.status).toBe(200);
  return { id, groupId, occasionId };
}

describe("the family gift overview", () => {
  it("counts the synthetic family by docket's rules: overlap once, six copies less one return, a household gift, one given", async () => {
    const w = await setup();
    const { id, groupId, occasionId } = await family(w);
    const body = await page(w, `/gifts?occasion=${occasionId}`);
    expect(body).toContain("Christmas 2026");
    expect(counts(body)).toEqual({ "needs-planning": 1, planned: 1, bought: 6, ready: 0, given: 1, skipped: 0 });
    const shown = rowsShown(body);
    // Cal is in both groups and on the roster once; the Hills came in by hand.
    expect(shown.length).toBe(9);
    expect(shown.filter((r) => r === id.Cal)).toHaveLength(1);
    expect(shown).toContain(id["The Hills"]);
    expect(shown).not.toContain(id.Hal);
    // Fay's copy is the one that went back; the board game counts once for the household.
    expect(body).toMatch(new RegExp(`data-recipient="${id.Fay}"><td>Fay</td><td>Planned</td>`));
    expect(body).toMatch(new RegExp(`data-recipient="${id.Kim}"><td>Kim</td><td>Needs planning</td>`));
    expect(body).toMatch(/<td>Calendar<\/td><td>Ann, Bea, Cal, Dee, Eve, Fay<\/td><td class="rb-num">6<\/td>/);
    expect(body).toMatch(/<td>Board game <span class="rb-badge">shared<\/span><\/td><td>The Hills<\/td><td class="rb-num">1<\/td>/);
    expect(body).toContain("Budget: 600.00 USD");
    expect(body).toContain("Review changes to its groups");

    // Filters: a group, a stage, and a household member finding the household's row.
    expect(rowsShown(await page(w, `/gifts?occasion=${occasionId}&group=${groupId.Aunts}`)).sort()).toEqual([id.Ann, id.Bea, id.Cal].sort());
    const planned = await page(w, `/gifts?occasion=${occasionId}&stage=planned`);
    expect(rowsShown(planned)).toEqual([id.Fay]);
    // The stage filter narrows the rows; the counts still show every column.
    expect(counts(planned)).toEqual(counts(body));
    expect(rowsShown(await page(w, `/gifts?occasion=${occasionId}&person=${id.Hal}`))).toEqual([id["The Hills"]]);
    // A household chosen finds its members' rows: Dee and Eve as one household.
    expect((await post(w, "/gifts/new/person", [["name", "Dee and Eve"], ["kind", "household"], ["member", id.Dee ?? ""], ["member", id.Eve ?? ""]])).status).toBe(303);
    const pair = (await idsByName(w))["Dee and Eve"];
    expect(rowsShown(await page(w, `/gifts?occasion=${occasionId}&person=${pair}`)).sort()).toEqual([id.Dee, id.Eve].sort());
    // An occasion id that is not on the list shows nothing, never another occasion.
    const unknown = await page(w, "/gifts?occasion=go999");
    expect(rowsShown(unknown)).toEqual([]);
    expect(unknown).toContain("That occasion is not on your list.");
    expect(await page(w, `/gifts?occasion=${occasionId}&done=constructor`)).not.toContain("rb-alert--success");
    // With no occasion named, the first open one is shown.
    expect(counts(await page(w, "/gifts")).bought).toBe(6);
  });

  it("shows another member nothing of this owner's: no rows, no names, no sync page, and writes cannot touch it", async () => {
    const w = await setup();
    const { id, occasionId } = await family(w);
    const curly = await signIn(w.plugin, CURLY);
    const theirs = await page(w, `/gifts?occasion=${occasionId}`, curly);
    for (const name of ["Christmas 2026", "Calendar", "Ann", "The Hills"]) expect(theirs).not.toContain(name);
    expect(rowsShown(theirs)).toEqual([]);
    expect((await call(w.plugin, "GET", `/gifts/occasions/${occasionId}/sync`, { jar: curly })).status).toBe(404);
    const form = await page(w, "/gifts/new/gift", curly);
    expect(form).not.toContain("Christmas 2026");
    // A gift naming Larry's occasion and people is refused; Larry's ledger is unchanged.
    const before = await page(w, `/gifts?occasion=${occasionId}`);
    const refused = await post(w, "/gifts/new/gift", [["title", "Sneaky"], ["estimate", ""], ["occasion", occasionId], ["for", id.Ann ?? ""], ["quantity", "1"]], curly, await csrfOf(w.plugin, curly));
    expect(refused.status).toBe(400);
    expect(await page(w, `/gifts?occasion=${occasionId}`)).toBe(before);
    // Signed out, the pages are not served.
    expect((await call(w.plugin, "GET", "/gifts")).status).not.toBe(200);
  });

  it("refuses a post without the page's csrf, and re-renders a form with what was wrong", async () => {
    const w = await setup();
    const forged = await call(w.plugin, "POST", "/gifts/new/person", { jar: w.jar, origin: ORIGIN, form: [["csrf", "nope"], ["name", "Ann"], ["kind", "person"]] });
    expect(forged.status).toBe(403);
    const blank = await post(w, "/gifts/new/person", [["name", ""], ["kind", "person"]]);
    expect(blank.status).toBe(400);
    expect(await blank.text()).toContain("Not saved");
    const badBudget = await post(w, "/gifts/new/occasion", [["kind", "birthday"], ["title", "Ann's birthday"], ["currency", "USD"], ["budget", "lots"]]);
    expect(badBudget.status).toBe(400);
    const text = await badBudget.text();
    expect(text).toContain("The budget is an amount");
    expect(text).toContain('value="Ann&#39;s birthday"');
    expect(((await (await api(w.plugin, "GET", "/gifts/occasions", { token: w.token })).json()) as Json).records).toEqual([]);
  });

  it("previews who an occasion covers before saving it, without writing anything", async () => {
    const w = await setup();
    for (const name of ["Ann", "Bea", "Cal"]) await post(w, "/gifts/new/person", [["name", name], ["kind", "person"]]);
    const id = await idsByName(w);
    await post(w, "/gifts/new/group", [["name", "Aunts"], ["member", id.Ann ?? ""], ["member", id.Bea ?? ""]]);
    const groups = ((await (await api(w.plugin, "GET", "/gifts/groups", { token: w.token })).json()) as Json).records as Json[];
    const res = await post(w, "/gifts/new/occasion", [["step", "preview"], ["kind", "christmas"], ["title", "Xmas"], ["currency", "USD"], ["group", groups[0].id], ["include", id.Cal ?? ""], ["exclude", id.Bea ?? ""]]);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Who this occasion will cover (2)");
    expect(body).toContain("Ann, Cal");
    expect(body).toContain("Left out: Bea");
    expect(((await (await api(w.plugin, "GET", "/gifts/occasions", { token: w.token })).json()) as Json).records).toEqual([]);
  });

  it("syncs an occasion with a changed group only as the review page decided", async () => {
    const w = await setup();
    const { id, groupId, occasionId } = await family(w);
    // Fay leaves Cousins; her calendar copy is not bought (the return), so the review asks about it.
    const cousins = ((await (await api(w.plugin, "GET", `/gifts/groups/${groupId.Cousins}`, { token: w.token })).json()) as Json).record;
    const without = cousins.memberIds.filter((m: string) => m !== id.Fay);
    expect((await api(w.plugin, "PATCH", `/gifts/groups/${groupId.Cousins}`, { token: w.token, body: { expectedRevision: cousins.revision, memberIds: without } })).status).toBe(200);
    const review = await page(w, `/gifts/occasions/${occasionId}/sync`);
    expect(review).toContain("Leaving: Fay.");
    const token = /name="token" value="([^"]+)"/.exec(review)?.[1] ?? "";
    const decisions = [...review.matchAll(/name="(decision-[^"]+)" value="unassign"/g)].map((m): [string, string] => [m[1] ?? "", "unassign"]);
    expect(decisions.length).toBe(1);
    // A stale token is refused and the review shown again.
    const stale = await post(w, `/gifts/occasions/${occasionId}/sync`, [["token", "stale"], ...decisions]);
    expect(stale.status).not.toBe(303);
    expect(await stale.text()).toContain("Sync Christmas 2026");
    const applied = await post(w, `/gifts/occasions/${occasionId}/sync`, [["token", token], ...decisions]);
    expect(applied.status).toBe(303);
    expect(applied.headers.get("location")).toContain("done=synced");
    const after = await page(w, `/gifts?${new URL(applied.headers.get("location") ?? "", ORIGIN).searchParams}`);
    expect(after).toContain("The occasion now matches its groups.");
    expect(rowsShown(after)).not.toContain(id.Fay);
    expect(after).toMatch(/<td>Calendar<\/td><td>Ann, Bea, Cal, Dee, Eve<\/td><td class="rb-num">5<\/td>/);
  });
});

describe("the gift forms' refusals", () => {
  it("saves nothing of a gift whose allocation would be refused, and refuses buying a gift twice", async () => {
    const w = await setup();
    const { id, occasionId } = await family(w);
    const items = async () => ((await (await api(w.plugin, "GET", "/gifts/items", { token: w.token })).json()) as Json).records.length;
    const before = await items();
    const zero = await post(w, "/gifts/new/gift", [["title", "Orphan"], ["estimate", ""], ["occasion", occasionId], ["for", id.Kim ?? ""], ["quantity", "0"]]);
    expect(zero.status).toBe(400);
    expect(await zero.text()).toContain("How many each is a whole number");
    const stranger = await post(w, "/gifts/new/gift", [["title", "Orphan"], ["estimate", ""], ["occasion", occasionId], ["for", "gr999"], ["quantity", "1"]]);
    expect(stranger.status).toBe(400);
    expect(await items()).toBe(before);
    const allocations = ((await (await api(w.plugin, "GET", "/gifts/allocations", { token: w.token })).json()) as Json).records as Json[];
    const game = allocations.find((a) => a.shared);
    const twice = await post(w, "/gifts/new/purchase", [["gift", game.id], ["currency", "USD"], ["price", "40"]]);
    expect(twice.status).toBe(400);
    expect(await twice.text()).toContain("That gift is already bought.");
    const after = ((await (await api(w.plugin, "GET", `/gifts/allocations/${game.id}`, { token: w.token })).json()) as Json).record;
    expect(after.purchaseId).toBe(game.purchaseId);
  });

  it("gives a leaving person's gift to someone on the roster, and says an archived occasion is not synced", async () => {
    const w = await setup();
    const { id, groupId, occasionId } = await family(w);
    const cousins = ((await (await api(w.plugin, "GET", `/gifts/groups/${groupId.Cousins}`, { token: w.token })).json()) as Json).record;
    await api(w.plugin, "PATCH", `/gifts/groups/${groupId.Cousins}`, { token: w.token, body: { expectedRevision: cousins.revision, memberIds: cousins.memberIds.filter((m: string) => m !== id.Fay) } });
    const review = await page(w, `/gifts/occasions/${occasionId}/sync`);
    const token = /name="token" value="([^"]+)"/.exec(review)?.[1] ?? "";
    const field = /name="(decision-[^"]+)" value="reassign:/.exec(review)?.[1] ?? "";
    expect((await post(w, `/gifts/occasions/${occasionId}/sync`, [["token", token], [field, `reassign:${id.Kim}`]])).status).toBe(303);
    const after = await page(w, `/gifts?occasion=${occasionId}`);
    expect(after).toMatch(new RegExp(`data-recipient="${id.Kim}"><td>Kim</td><td>Planned</td>`));
    expect(after).toMatch(/<td>Calendar<\/td><td>Ann, Bea, Cal, Dee, Eve, Kim<\/td>/);
    const occasion = ((await (await api(w.plugin, "GET", `/gifts/occasions/${occasionId}`, { token: w.token })).json()) as Json).record;
    expect((await api(w.plugin, "PATCH", `/gifts/occasions/${occasionId}`, { token: w.token, body: { expectedRevision: occasion.revision, archived: true } })).status).toBe(200);
    const archived = await call(w.plugin, "GET", `/gifts/occasions/${occasionId}/sync`, { jar: w.jar });
    expect(archived.status).toBe(409);
    expect(await archived.text()).toContain("archived");
    const shown = await page(w, `/gifts?occasion=${occasionId}`);
    expect(shown).toContain(`<option value="${occasionId}" selected>Christmas 2026 (archived)</option>`);
  });
});

describe("parseMoney", () => {
  it("reads whole and two-place amounts, blank as none, anything else as not an amount", () => {
    const usd = (raw: string | null) => parseMoney(raw, "USD");
    expect([usd("12"), usd("12.5"), usd("12.50"), usd(" "), usd(null)]).toEqual([1200, 1250, 1250, null, null]);
    for (const bad of ["12.505", "-3", "1,000", "abc", "1e3", "12."]) expect(usd(bad)).toBeUndefined();
  });

  it("uses the currency's own minor units: none for JPY, three for KWD", () => {
    expect([parseMoney("1250", "JPY"), parseMoney("12.5", "JPY"), parseMoney("1.234", "KWD"), parseMoney("1.5", "KWD")]).toEqual([1250, undefined, 1234, 1500]);
  });
});
