import { afterEach, describe, expect, it } from "bun:test";
import { GiftLedger, GiftRevisionError, MemoryGiftStore, type User } from "@rackbops/docket-core";
import { capped, giftBought, giftIdea, today, toMinor } from "./gift-command.js";
import { api, cleanup, LARRY, makeToken, people, type Said, signIn, slash, STRANGER, world } from "./web/harness.js";

/**
 * `/gift` (rackbops-bot-plugins#385) through the plugin's own command handler, on a made-up family
 * written through the task API: the same ledger the web page and the API read.
 */

afterEach(cleanup);

// biome-ignore lint/suspicious/noExplicitAny: test reads of JSON answers
type Json = any;

async function setup() {
  const w = await world();
  await people(w.plugin);
  const token = await makeToken(w, await signIn(w.plugin, LARRY));
  w.sent.length = 0;
  return { ...w, token };
}
type W = Awaited<ReturnType<typeof setup>>;

async function create(w: W, collection: string, fields: unknown): Promise<Json> {
  const res = await api(w.plugin, "POST", `/gifts/${collection}`, { token: w.token, body: fields });
  const body = (await res.json()) as Json;
  if (res.status !== 201) throw new Error(`create ${collection}: ${res.status} ${JSON.stringify(body)}`);
  return body.record;
}
const list = async (w: W, collection: string): Promise<Json[]> => ((await (await api(w.plugin, "GET", `/gifts/${collection}`, { token: w.token })).json()) as Json).records;

const person = (displayName: string) => ({ displayName, kind: "person", memberIds: [], labels: [], interests: [], avoid: [], notes: null });

/** Ann, Bea, Cal and Dee on Christmas 2026 through the Aunts group; Bea has a scarf planned, Cal one bought. */
async function family(w: W) {
  const [ann, bea, cal, dee] = [await create(w, "recipients", person("Ann")), await create(w, "recipients", person("Bea")), await create(w, "recipients", person("Cal")), await create(w, "recipients", person("Dee"))];
  const aunts = await create(w, "groups", { name: "Aunts", memberIds: [ann.id, bea.id, cal.id, dee.id] });
  const xmas = await create(w, "occasions", { kind: "christmas", title: "Christmas 2026", date: "2026-12-25", timeZone: null, year: 2026, currency: "USD", budgetMinor: null, groupIds: [aunts.id], includeIds: [], excludeIds: [] });
  for (const r of [ann, bea, cal, dee]) await create(w, "occasion-recipients", { occasionId: xmas.id, recipientId: r.id, target: null, budgetMinor: null, decision: "planning", skipReason: null });
  return { ann, bea, cal, dee, xmas };
}

/** Runs `/gift <sub>` as Larry and answers what it said, checking every message was ephemeral and nothing was DMed or posted. */
async function gift(w: W, sub: string, strings: Record<string, string>, extra: { numbers?: Record<string, number>; booleans?: Record<string, boolean> } = {}, as = LARRY): Promise<string> {
  const said: Said[] = [];
  const answer = await slash(w.plugin, "gift", as, { sub, strings, said, ...extra });
  // slash() has already checked the deferral was ephemeral (flags 64): the edit is that reply; any follow-up carries the flag itself.
  for (const s of said) if (s.kind === "followUp") expect(Number(s.flags) & 64).toBe(64);
  expect(w.sent).toEqual([]);
  return answer;
}

describe("/gift", () => {
  it("plans an idea that may repeat another gift for the person, and names the possible duplicate (docket#100)", async () => {
    const w = await setup();
    const f = await family(w);
    const birthday = await create(w, "occasions", { kind: "birthday", title: "Bea's birthday 2027", date: "2027-02-02", timeZone: null, year: 2027, currency: "USD", budgetMinor: null, groupIds: [], includeIds: [], excludeIds: [] });
    const first = await gift(w, "idea", { person: "Bea", title: "Scarf", occasion: "christmas 2026" });
    expect(first).toContain("Planned Scarf for Bea for Christmas 2026.");
    expect(first).not.toContain("Perhaps");
    const again = await gift(w, "idea", { person: "Bea", title: "scarf", occasion: birthday.title });
    expect(again).toContain("Planned scarf for Bea for Bea's birthday 2027. Perhaps the same as Scarf (Christmas 2026).");
    expect((await list(w, "allocations")).map((a) => a.occasionId)).toEqual([f.xmas.id, birthday.id]);
  });

  it("notes an idea, plans it on an occasion, and records it bought, each answered only to the person", async () => {
    const w = await setup();
    const f = await family(w);
    expect(await gift(w, "idea", { person: "ann", title: "Board game" }, { numbers: { estimate: 30 } })).toBe("Give a currency with the estimate, or an occasion to take it from.");
    expect(await gift(w, "idea", { person: "ann", title: "Board game", currency: "usd" }, { numbers: { estimate: 30 } })).toContain('Saved Board game as an idea, noted "For Ann".');
    const planned = await gift(w, "idea", { person: "Bea", title: "Scarf", occasion: "christmas 2026" }, { numbers: { estimate: 24.99 } });
    expect(planned).toContain("Planned Scarf for Bea for Christmas 2026.");
    expect(planned).toContain(`/tracker/gifts?occasion=${f.xmas.id}>`);
    const items = await list(w, "items");
    expect(items.map((i) => [i.title, i.planning, i.estimateMinor, i.currency])).toEqual([
      ["Board game", "idea", 3000, "USD"],
      ["Scarf", "selected", 2499, "USD"],
    ]);
    const [scarf] = await list(w, "allocations");
    expect(scarf).toMatchObject({ occasionId: f.xmas.id, recipientIds: [f.bea.id], quantity: 1, purchaseId: null });

    expect(await gift(w, "bought", { gift: "Mug" }, { numbers: { price: 5 } })).toContain("No planned gift called Mug is waiting to be bought.");
    // 02:00 UTC on the 2nd is still the 1st in Larry's zone (America/New_York).
    w.clock.set("2026-10-02T02:00:00.000Z");
    const bought = await gift(w, "bought", { gift: "scarf", merchant: "Corner Shop" }, { numbers: { price: 19.5 }, booleans: { arrived: true } });
    expect(bought).toContain("Recorded: bought Scarf for Bea (Christmas 2026), 1 at 19.50 USD each, arrived.");
    const [purchase] = await list(w, "purchases");
    // Bought on the clock's day in Larry's own zone (America/New_York), not UTC's.
    expect(purchase).toMatchObject({ merchant: "Corner Shop", currency: "USD", unitPriceMinor: 1950, ordered: 1, received: 1, purchasedOn: "2026-10-01" });
    expect((await list(w, "allocations"))[0].purchaseId).toBe(purchase.id);
    expect(await gift(w, "bought", { gift: "scarf" }, { numbers: { price: 19.5 } })).toContain("No planned gift called scarf is waiting to be bought.");
  });

  it("asks for the person when two planned gifts share a title, and names who is not on the list", async () => {
    const w = await setup();
    await family(w);
    await gift(w, "idea", { person: "Ann", title: "Calendar", occasion: "Christmas 2026" });
    await gift(w, "idea", { person: "Dee", title: "Calendar", occasion: "Christmas 2026" });
    const both = await gift(w, "bought", { gift: "Calendar" }, { numbers: { price: 10 } });
    expect(both).toContain("More than one planned gift matches; name the person or the occasion too:");
    expect(both).toContain("- Calendar for Ann (Christmas 2026)");
    expect(both).toContain("- Calendar for Dee (Christmas 2026)");
    expect(await list(w, "purchases")).toEqual([]);
    expect(await gift(w, "bought", { gift: "Calendar", occasion: "Christmas 2026", person: "Bea" }, { numbers: { price: 10 } })).toContain("No planned gift called Calendar for Bea on Christmas 2026 is waiting to be bought.");
    expect(await gift(w, "bought", { gift: "Calendar", person: "Dee" }, { numbers: { price: 10 } })).toContain("Recorded: bought Calendar for Dee (Christmas 2026), 1 at 10.00 USD each, on its way.");
    expect(await gift(w, "idea", { person: "Zed", title: "Book" })).toStartWith("No one called Zed is on your gift list.");
    expect(await gift(w, "idea", { person: "Ann", title: "Book", occasion: "Easter" })).toStartWith("No open occasion called Easter is on your gift list.");
    expect((await list(w, "items")).map((i) => i.title)).toEqual(["Calendar", "Calendar"]);
  });

  it("lists who still needs a gift exactly as the API's coverage says", async () => {
    const w = await setup();
    const f = await family(w);
    await gift(w, "idea", { person: "Bea", title: "Scarf", occasion: "Christmas 2026" });
    await gift(w, "idea", { person: "Cal", title: "Mug", occasion: "Christmas 2026" });
    await gift(w, "bought", { gift: "Mug" }, { numbers: { price: 8 } });
    const answer = await gift(w, "needs", {});
    const summary = (await (await api(w.plugin, "GET", `/gifts/occasions/${f.xmas.id}/summary`, { token: w.token })).json()) as Json;
    const names = new Map([f.ann, f.bea, f.cal, f.dee].map((r) => [r.id, r.displayName]));
    const byStatus = (s: string) => summary.coverage.filter((c: Json) => c.status === s).map((c: Json) => names.get(c.recipientId));
    expect(byStatus("needs-planning")).toEqual(["Ann", "Dee"]);
    expect(byStatus("planned")).toEqual(["Bea"]);
    expect(answer).toContain("Christmas 2026: 3 still need a gift.");
    expect(answer).toContain(`Needs planning: ${byStatus("needs-planning").join(", ")}`);
    expect(answer).toContain(`Planned: ${byStatus("planned").join(", ")}`);
    expect(answer).toContain("Needs planning 2 | Planned 1 | Purchased or awaiting 1 | Ready 0 | Given 0 | Skipped 0");
    expect(await gift(w, "needs", { occasion: "christmas 2026" })).toBe(answer);
  });

  it("answers someone not registered without touching any ledger, and someone with no occasions plainly", async () => {
    const w = await setup();
    const refused = await gift(w, "needs", {}, {}, STRANGER);
    expect(refused).not.toContain("still need");
    expect(await gift(w, "needs", {})).toStartWith("You have no open occasions on your gift list.");
  });
});

describe("/gift's edges", () => {
  it("takes a price in the occasion's own digits, refuses extra decimals, and buys as many as the gift needs", async () => {
    const w = await setup();
    const f = await family(w);
    const yen = await create(w, "occasions", { kind: "birthday", title: "Ann in Tokyo", date: null, timeZone: null, year: null, currency: "JPY", budgetMinor: null, groupIds: [], includeIds: [f.ann.id], excludeIds: [] });
    await gift(w, "idea", { person: "Ann", title: "Tea", occasion: "Ann in Tokyo" });
    expect(await gift(w, "bought", { gift: "Tea" }, { numbers: { price: 12.5 } })).toBe("The price is not an amount in JPY.");
    expect(await gift(w, "bought", { gift: "Tea" }, { numbers: { price: 1250 } })).toContain("1 at 1250 JPY each");
    // One calendar each for two people: two units on one purchase, and 19.99 kept exactly.
    const item = await create(w, "items", { title: "Calendar", url: null, productKey: null, variant: null, notes: null, source: { kind: "manual", ref: null }, planning: "selected", estimateMinor: null, currency: null });
    await create(w, "allocations", { itemId: item.id, occasionId: f.xmas.id, recipientIds: [f.bea.id, f.cal.id], quantity: 1, shared: false, purchaseId: null, handoff: "none", givenOn: null });
    expect(await gift(w, "bought", { gift: "Calendar" }, { numbers: { price: 19.99 } })).toContain("Calendar for Bea, Cal (Christmas 2026), 2 at 19.99 USD each");
    const purchases = await list(w, "purchases");
    expect(purchases.map((p) => [p.currency, p.unitPriceMinor, p.ordered])).toEqual([
      ["JPY", 1250, 1],
      ["USD", 1999, 2],
    ]);
    expect(yen.currency).toBe("JPY");
    expect([today(new Date("2026-11-14T01:00:00Z"), "America/New_York"), today(new Date("2026-11-14T01:00:00Z"), "UTC")]).toEqual(["2026-11-13", "2026-11-14"]);
    expect([toMinor(19.99, "USD"), toMinor(0.1, "USD"), toMinor(1.234, "KWD"), toMinor(1.005, "USD"), toMinor(1e21, "USD")]).toEqual([1999, 10, 1234, null, null]);
  });

  it("tells an occasion apart by name, ignores archived occasions and people, and refuses a name two people share", async () => {
    const w = await setup();
    const f = await family(w);
    await create(w, "occasions", { kind: "birthday", title: "Ann's birthday", date: null, timeZone: null, year: null, currency: "USD", budgetMinor: null, groupIds: [], includeIds: [f.ann.id], excludeIds: [] });
    await gift(w, "idea", { person: "Ann", title: "Book", occasion: "Christmas 2026" });
    await gift(w, "idea", { person: "Ann", title: "Book", occasion: "Ann's birthday" });
    expect(await gift(w, "bought", { gift: "Book", person: "Ann" }, { numbers: { price: 12 } })).toContain("name the person or the occasion too");
    expect(await gift(w, "bought", { gift: "Book", occasion: "ann's birthday" }, { numbers: { price: 12 } })).toContain("Recorded: bought Book for Ann (Ann's birthday)");
    const xmas = (await (await api(w.plugin, "GET", `/gifts/occasions/${f.xmas.id}`, { token: w.token })).json()) as Json;
    await api(w.plugin, "PATCH", `/gifts/occasions/${f.xmas.id}`, { token: w.token, body: { expectedRevision: xmas.record.revision, archived: true } });
    expect(await gift(w, "bought", { gift: "Book" }, { numbers: { price: 12 } })).toContain("No planned gift called Book is waiting to be bought.");
    expect(await gift(w, "idea", { person: "Ann", title: "Pen", occasion: "Christmas 2026" })).toStartWith("No open occasion called Christmas 2026");
    const dee = (await (await api(w.plugin, "GET", `/gifts/recipients/${f.dee.id}`, { token: w.token })).json()) as Json;
    await api(w.plugin, "PATCH", `/gifts/recipients/${f.dee.id}`, { token: w.token, body: { expectedRevision: dee.record.revision, archived: true } });
    expect(await gift(w, "idea", { person: "Dee", title: "Pen" })).toStartWith("No one called Dee is on your gift list.");
    await create(w, "recipients", person("Ann"));
    expect(await gift(w, "idea", { person: "Ann", title: "Pen" })).toStartWith("More than one person on your gift list is called Ann.");
  });

  it("lists at most 10 matches, counting the rest", async () => {
    const w = await setup();
    const f = await family(w);
    for (let i = 0; i < 12; i++) await gift(w, "idea", { person: ["Ann", "Bea", "Cal", "Dee"][i % 4] ?? "Ann", title: "Gift card", occasion: "Christmas 2026" });
    const answer = await gift(w, "bought", { gift: "Gift card" }, { numbers: { price: 25 } });
    expect(answer.split("\n").filter((l) => l.startsWith("- Gift card for"))).toHaveLength(10);
    expect(answer).toContain("- and 2 more");
    expect(f.xmas.title).toBe("Christmas 2026");
  });

  it("says plainly when nobody is on an occasion, or nobody still needs a gift", async () => {
    const w = await setup();
    const f = await family(w);
    await create(w, "occasions", { kind: "custom", title: "Picnic", date: null, timeZone: null, year: null, currency: "USD", budgetMinor: null, groupIds: [], includeIds: [], excludeIds: [] });
    expect(await gift(w, "needs", { occasion: "Picnic" })).toStartWith("Picnic: nobody is on it yet.");
    for (const r of [f.ann, f.bea, f.cal, f.dee]) {
      const rows = ((await (await api(w.plugin, "GET", `/gifts/occasion-recipients?occasionId=${f.xmas.id}`, { token: w.token })).json()) as Json).records as Json[];
      const row = rows.find((x) => x.recipientId === r.id);
      await api(w.plugin, "PATCH", `/gifts/occasion-recipients/${row.id}`, { token: w.token, body: { expectedRevision: row.revision, decision: "skipped", skipReason: "not this year" } });
    }
    expect(await gift(w, "needs", {})).toStartWith("Christmas 2026: nobody still needs a gift.");
  });

  it("takes back the first write when the second is refused, so nothing is left half-saved", async () => {
    const real = new GiftLedger(new MemoryGiftStore());
    const user = { id: "u1", timeZone: "UTC" } as unknown as User;
    const at = { ownerId: "u1", actor: "u1", source: "api" as const, at: "2026-11-01T00:00:00.000Z" };
    const ann = await real.create("recipient", at, { displayName: "Ann", kind: "person", memberIds: [], labels: [], interests: [], avoid: [], notes: null });
    await real.create("occasion", at, { kind: "custom", title: "Fete", date: null, timeZone: null, year: null, currency: "USD", budgetMinor: null, groupIds: [], includeIds: [ann.id], excludeIds: [] });
    const failing = new Proxy(real, {
      get(target, key) {
        if (key === "create") return async (kind: string, ...rest: unknown[]) => {
          if (kind === "allocation") throw new GiftRevisionError("stale", 2);
          return (target.create as (...a: unknown[]) => unknown)(kind, ...rest);
        };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const d = { gifts: failing, clock: { now: () => new Date("2026-11-01T12:00:00Z") } } as never;
    expect(await giftIdea(d, user, { person: "Ann", title: "Kite", occasion: "Fete" }, null)).toBe("Not saved: it changed while this ran. Try again.");
    expect((await real.list("item", "u1")).map((i) => i.title)).toEqual([]);
    const item = await real.create("item", at, { title: "Kite", url: null, productKey: null, variant: null, notes: null, source: { kind: "manual", ref: null }, planning: "selected", estimateMinor: null, currency: null });
    const occasion = (await real.list("occasion", "u1"))[0];
    await real.create("allocation", at, { itemId: item.id, occasionId: occasion?.id ?? "", recipientIds: [ann.id], quantity: 1, shared: false, purchaseId: null, handoff: "none", givenOn: null });
    const refusing = new Proxy(real, {
      get(target, key) {
        if (key === "update") return async (kind: string, ...rest: unknown[]) => {
          if (kind === "allocation") throw new GiftRevisionError("stale", 2);
          return (target.update as (...a: unknown[]) => unknown)(kind, ...rest);
        };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const d2 = { gifts: refusing, clock: { now: () => new Date("2026-11-01T12:00:00Z") } } as never;
    expect(await giftBought(d2, user, { gift: "Kite", price: 5 }, null)).toBe("Not saved: it changed while this ran. Try again.");
    expect(await real.list("purchase", "u1")).toEqual([]);
  });
});

describe("capped", () => {
  it("keeps a long list of names to its length, saying how many more", () => {
    expect(capped(["Ann", "Bea"])).toBe("Ann, Bea");
    expect(capped(["A".repeat(20), "Bea"], 10)).toBe("2 people");
    const many = Array.from({ length: 300 }, (_, i) => `Person ${i}`);
    const out = capped(many);
    expect(out.length).toBeLessThan(730);
    expect(out).toMatch(/, and \d+ more$/);
  });
});
