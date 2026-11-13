import { afterEach, describe, expect, it } from "bun:test";
import { capped } from "./gift-command.js";
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
  it("notes an idea, plans it on an occasion, and records it bought, each answered only to the person", async () => {
    const w = await setup();
    const f = await family(w);
    expect(await gift(w, "idea", { person: "ann", title: "Board game" }, { numbers: { estimate: 30 } })).toBe("Give a currency with the estimate, or an occasion to take it from.");
    expect(await gift(w, "idea", { person: "ann", title: "Board game", currency: "usd" }, { numbers: { estimate: 30 } })).toContain("Saved Board game as an idea for Ann.");
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
    const bought = await gift(w, "bought", { gift: "scarf", merchant: "Corner Shop" }, { numbers: { price: 19.5 }, booleans: { arrived: true } });
    expect(bought).toContain("Recorded: bought Scarf for Bea (Christmas 2026), 1 at 19.5 USD each, arrived.");
    const [purchase] = await list(w, "purchases");
    expect(purchase).toMatchObject({ merchant: "Corner Shop", currency: "USD", unitPriceMinor: 1950, ordered: 1, received: 1 });
    expect((await list(w, "allocations"))[0].purchaseId).toBe(purchase.id);
    expect(await gift(w, "bought", { gift: "scarf" }, { numbers: { price: 19.5 } })).toContain("No planned gift called scarf is waiting to be bought.");
  });

  it("asks for the person when two planned gifts share a title, and names who is not on the list", async () => {
    const w = await setup();
    await family(w);
    await gift(w, "idea", { person: "Ann", title: "Calendar", occasion: "Christmas 2026" });
    await gift(w, "idea", { person: "Dee", title: "Calendar", occasion: "Christmas 2026" });
    const both = await gift(w, "bought", { gift: "Calendar" }, { numbers: { price: 10 } });
    expect(both).toContain("More than one planned gift matches; name the person too:");
    expect(both).toContain("- Calendar for Ann (Christmas 2026)");
    expect(both).toContain("- Calendar for Dee (Christmas 2026)");
    expect(await list(w, "purchases")).toEqual([]);
    expect(await gift(w, "bought", { gift: "Calendar", person: "Dee" }, { numbers: { price: 10 } })).toContain("Recorded: bought Calendar for Dee (Christmas 2026), 1 at 10 USD each, on its way.");
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

describe("capped", () => {
  it("keeps a long list of names to its length, saying how many more", () => {
    expect(capped(["Ann", "Bea"])).toBe("Ann, Bea");
    const many = Array.from({ length: 300 }, (_, i) => `Person ${i}`);
    const out = capped(many);
    expect(out.length).toBeLessThan(730);
    expect(out).toMatch(/, and \d+ more$/);
  });
});
