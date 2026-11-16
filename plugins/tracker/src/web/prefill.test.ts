import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { call, cleanup, csrfOf, LARRY, ORIGIN, people, signIn, world } from "./harness.js";
import { fieldsFor } from "./editor-pages.js";
import { prefilled } from "./form-input.js";

/**
 * A new task's form filled in from its address (`/new/<type>?name=...`), so another app can link a
 * person to a want-list watch, or any new task, already filled in. The link only fills the form:
 * nothing is made until the person saves it, with the session's CSRF token, as any form post.
 */

afterEach(cleanup);

async function setup() {
  const w = await world();
  await people(w.plugin);
  const larry = await signIn(w.plugin, LARRY);
  return { ...w, larry };
}

function taskCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const n = (db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
  db.close();
  return n;
}

const q = (o: Record<string, string | string[]>): URLSearchParams => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) for (const one of [v].flat()) p.append(k, one);
  return p;
};

describe("prefilled", () => {
  it("takes the form's own fields and ignores anything else", () => {
    expect(prefilled("wantlist", q({ name: "Arkham Horror", max: "350", currency: "USD", exclude: "investigator", hours: "2", judge: "no", evil: "x", csrf: "y" }))).toEqual({
      name: "Arkham Horror",
      max: "350",
      currency: "USD",
      exclude: "investigator",
      hours: "2",
      judge: "no",
    });
  });

  it("ticks each place given, once each or separated by commas, and only real places", () => {
    expect(prefilled("wantlist", q({ source: ["ebay", "shopify"] })).source).toBe("ebay,shopify");
    expect(prefilled("wantlist", q({ source: "ebay, nobleknight,ebay,moon" })).source).toBe("ebay,nobleknight");
    expect(prefilled("wantlist", q({ source: "moon" })).source).toBeUndefined();
  });

  it("keeps a select only to one of its options", () => {
    expect(prefilled("wantlist", q({ judge: "maybe" })).judge).toBeUndefined();
    expect(prefilled("wantlist", q({ judge: "yes" })).judge).toBe("yes");
    expect(prefilled("reminder", q({ repeat: "hourly" })).repeat).toBeUndefined();
    expect(prefilled("reminder", q({ text: "call mum", repeat: "week" }))).toEqual({ text: "call mum", repeat: "week" });
  });

  it("puts the API's target in the one place's own box, unless that box is given", () => {
    expect(prefilled("wantlist", q({ source: "ebay", target: "arkham horror lcg" })).target_ebay).toBe("arkham horror lcg");
    expect(prefilled("wantlist", q({ source: "ebay", target: "a", target_ebay: "b" })).target_ebay).toBe("b");
    // With several places, or none, `target` names no one box and is left out.
    const several = prefilled("wantlist", q({ source: "ebay,shopify", target: "a" }));
    expect(several.target_ebay).toBeUndefined();
    expect(several.target_shopify).toBeUndefined();
    expect(prefilled("wantlist", q({ target: "a" }))).toEqual({});
  });

  it("takes nothing from an empty query", () => {
    expect(prefilled("wantlist", new URLSearchParams())).toEqual({});
  });
});

describe("GET /new/<type> with a query", () => {
  it("shows a want-list watch's form filled in, and makes nothing", async () => {
    const w = await setup();
    const res = await call(
      w.plugin,
      "GET",
      `/new/wantlist?${q({ name: "Arkham Horror: The Card Game", source: "ebay,nobleknight", target_ebay: "arkham horror card game", target_nobleknight: "https://www.nobleknight.com/P/2148112695", max: "350", currency: "USD", exclude: "investigator, sleeves", judge: "no", hours: "6" })}`,
      { jar: w.larry },
    );
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('name="name" type="text" value="Arkham Horror: The Card Game"');
    expect(page).toContain('name="source" value="ebay" checked>');
    expect(page).toContain('name="source" value="nobleknight" checked>');
    expect(page).not.toContain('name="source" value="page" checked>');
    expect(page).toContain('name="target_ebay" type="text" value="arkham horror card game"');
    expect(page).toContain('name="target_nobleknight" type="text" value="https://www.nobleknight.com/P/2148112695"');
    expect(page).toContain('name="max" type="text" value="350"');
    expect(page).toContain('name="currency" type="text" value="USD"');
    expect(page).toContain('name="exclude" type="text" value="investigator, sleeves"');
    expect(page).toContain('name="hours" type="number" value="6"');
    expect(page).toContain('<option value="no" selected>');
    expect(taskCount(w.dbPath)).toBe(0);
  });

  it("without a query shows the defaults, as before", async () => {
    const w = await setup();
    const page = await (await call(w.plugin, "GET", "/new/wantlist", { jar: w.larry })).text();
    expect(page).toContain('name="source" value="page" checked>');
    expect(page).toContain('name="name" type="text" value=""');
  });

  it("escapes what the address carries", async () => {
    const w = await setup();
    const page = await (await call(w.plugin, "GET", `/new/wantlist?${q({ name: '"><script>alert(1)</script>' })}`, { jar: w.larry })).text();
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("value=\"&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;\"");
  });

  it("fills the other new-task forms the same way", async () => {
    const w = await setup();
    const page = await (await call(w.plugin, "GET", `/new/renewal?${q({ name: "Domain", amount: "12", currency: "EUR", unit: "month" })}`, { jar: w.larry })).text();
    expect(page).toContain('name="name" type="text" value="Domain"');
    expect(page).toContain('name="currency" type="text" value="EUR"');
    expect(page).toContain('<option value="month" selected>');
    // A default the query does not name stays.
    expect(page).toContain('name="lead" type="number" value="7"');
  });

  it("a prefilled form saves only through the usual post with the session's token", async () => {
    const w = await setup();
    const csrf = await csrfOf(w.plugin, w.larry);
    // A cross-site post of the same fields, without the token, is refused as before.
    const forged = await call(w.plugin, "POST", "/new/reminder", { jar: w.larry, form: { text: "x", when: "tomorrow 9am" }, origin: ORIGIN });
    expect(forged.status).toBe(403);
    expect(taskCount(w.dbPath)).toBe(0);
    const made = await call(w.plugin, "POST", "/new/reminder", { jar: w.larry, form: { csrf, text: "x", when: "tomorrow 9am" }, origin: ORIGIN });
    expect(made.status).toBe(303);
    expect(taskCount(w.dbPath)).toBe(1);
  });

  it("asks a signed-out browser to sign in first", async () => {
    const w = await world();
    const res = await call(w.plugin, "GET", "/new/wantlist?name=x");
    expect(res.status).toBe(303);
  });
});

describe("the README's contract", () => {
  it("names exactly the want-list form's fields, and the API's target", async () => {
    const readme = await Bun.file(new URL("../../README.md", import.meta.url)).text();
    const start = readme.indexOf("A want-list watch (`/new/wantlist`):");
    expect(start).toBeGreaterThan(-1);
    const table = readme.slice(start, readme.indexOf("For example, an eBay", start));
    const named = [...table.matchAll(/^\| (`[^|]+`) \|/gm)].flatMap((m) => [...m[1]!.matchAll(/`([a-z_]+)`/g)].map((n) => n[1]!));
    const fields = fieldsFor("wantlist", "new").map((f) => f.name);
    expect(named.sort()).toEqual([...fields, "target"].sort());
  });
});
