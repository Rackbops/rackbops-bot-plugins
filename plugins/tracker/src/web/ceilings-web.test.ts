import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { Plugin } from "../../../../packages/api/contract.js";
import { ADMIN, call, cleanup, csrfOf, type Jar, LARRY, ORIGIN, people, signIn, world } from "./harness.js";

/**
 * Raising a person's ceiling from the admin view (plan 5.7, 5.10; rackbops-bot-plugins#82), through
 * the plugin's own `http` handler: the person page's section, a raise and a reset, a refused value,
 * the session and CSRF checks every admin act has, and the log line. Who may reach the route at all
 * is admin.test.ts's ADMIN_ROUTES.
 */

afterEach(cleanup);

function post(plugin: Plugin, jar: Jar, csrf: string, path: string, form: Record<string, string> = {}, origin: string | null = ORIGIN) {
  return call(plugin, "POST", path, { jar, form: { csrf, ...form }, origin });
}

function rows(dbPath: string): unknown[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query("SELECT user_id, usd, calls, set_by FROM ceiling_changes ORDER BY seq").all();
  } finally {
    db.close();
  }
}

async function setup() {
  const logs: string[] = [];
  const w = await world({ logs });
  await people(w.plugin);
  const admin = await signIn(w.plugin, ADMIN);
  return { ...w, logs, admin, csrf: await csrfOf(w.plugin, admin) };
}

describe("an admin raises a person's ceiling", () => {
  it("the person page shows today's spend and the default; a raise stands and is listed; a reset goes back", async () => {
    const w = await setup();
    const page = await (await call(w.plugin, "GET", "/admin/people/u2", { jar: w.admin })).text();
    expect(page).toContain("Daily model budget");
    expect(page).toContain("Today: 0.00 USD and 0 model call(s). Ceiling: 2.00 USD and 20 model calls a day (the default).");
    expect(page).toContain('action="/tracker/admin/people/u2/ceiling"');
    expect(page).toContain("No admin has changed their ceiling.");
    expect(page).not.toContain("Back to the default");

    const raised = await post(w.plugin, w.admin, w.csrf, "/admin/people/u2/ceiling", { usd: "4.50", calls: "40" });
    expect(raised.status).toBe(200);
    const body = await raised.text();
    expect(body).toContain("Larry&#39;s ceiling is now 4.50 USD and 40 model calls a day, until an admin changes it.");
    expect(body).toContain('<span class="rb-badge">raised</span>');
    expect(body).toContain("raised to 4.50 USD and 40 model calls a day, by user111");
    expect(body).toContain("Back to the default");
    expect(rows(w.dbPath)).toEqual([{ user_id: "u2", usd: 4.5, calls: 40, set_by: "u1" }]);
    expect(w.logs).toContain("u1 set u2's daily ceiling to 4.5 USD / 40 calls (c1)");

    // It stands: a day later the page still shows it.
    w.clock.set("2026-10-03T12:00:00.000Z");
    expect(await (await call(w.plugin, "GET", "/admin/people/u2", { jar: w.admin })).text()).toContain("Ceiling: 4.50 USD and 40 model calls a day");

    const reset = await post(w.plugin, w.admin, w.csrf, "/admin/people/u2/ceiling", { reset: "yes" });
    expect(reset.status).toBe(200);
    const after = await reset.text();
    expect(after).toContain("Larry is back on the default ceiling: 2.00 USD and 20 model calls a day.");
    expect(after).toContain("back to the default, by user111");
    expect(rows(w.dbPath)).toEqual([
      { user_id: "u2", usd: 4.5, calls: 40, set_by: "u1" },
      { user_id: "u2", usd: null, calls: null, set_by: "u1" },
    ]);
  });

  it("the form sent with exactly the default is a reset: nothing written on the default, back to it from a raise", async () => {
    const w = await setup();
    const same = await post(w.plugin, w.admin, w.csrf, "/admin/people/u2/ceiling", { usd: "2.00", calls: "20" });
    expect(same.status).toBe(200);
    expect(await same.text()).toContain("Larry is already on the default ceiling.");
    expect(rows(w.dbPath)).toEqual([]);
    await post(w.plugin, w.admin, w.csrf, "/admin/people/u2/ceiling", { usd: "4", calls: "40" });
    const back = await (await post(w.plugin, w.admin, w.csrf, "/admin/people/u2/ceiling", { usd: "2", calls: "20" })).text();
    expect(back).toContain("Larry is back on the default ceiling: 2.00 USD and 20 model calls a day.");
    expect(back).not.toContain('<span class="rb-badge">raised</span>');
    expect(back).toContain("The latest 20 at most, newest first.");
    expect(rows(w.dbPath)).toEqual([
      { user_id: "u2", usd: 4, calls: 40, set_by: "u1" },
      { user_id: "u2", usd: null, calls: null, set_by: "u1" },
    ]);
  });

  it("a value out of bounds is refused with the reason and writes nothing; an unknown person is the 404", async () => {
    const w = await setup();
    const res = await post(w.plugin, w.admin, w.csrf, "/admin/people/u2/ceiling", { usd: "50", calls: "40" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("The dollars cannot go above the global ceiling, 10.00 USD a day.");
    expect((await post(w.plugin, w.admin, w.csrf, "/admin/people/u2/ceiling", { usd: "4", calls: "" })).status).toBe(400);
    expect((await post(w.plugin, w.admin, w.csrf, "/admin/people/u99/ceiling", { usd: "4", calls: "40" })).status).toBe(404);
    expect(rows(w.dbPath)).toEqual([]);
  });

  it("a stale CSRF token, another origin, a GET, or no session changes nothing", async () => {
    const w = await setup();
    const form = { usd: "4", calls: "40" };
    expect((await post(w.plugin, w.admin, "stale", "/admin/people/u2/ceiling", form)).status).toBe(403);
    expect((await post(w.plugin, w.admin, w.csrf, "/admin/people/u2/ceiling", form, "https://evil.example.net")).status).toBe(403);
    expect((await call(w.plugin, "GET", "/admin/people/u2/ceiling", { jar: w.admin })).status).toBe(405);
    const anon = await call(w.plugin, "POST", "/admin/people/u2/ceiling", { form: { csrf: w.csrf, ...form }, origin: ORIGIN });
    expect(anon.status).toBe(303);
    expect(rows(w.dbPath)).toEqual([]);
  });

  it("an admin whose flag was revoked mid-session is refused at once", async () => {
    const w = await setup();
    const larry = await signIn(w.plugin, LARRY);
    expect((await post(w.plugin, w.admin, w.csrf, "/admin/people/u2/grant")).status).toBe(200);
    const larryCsrf = await csrfOf(w.plugin, larry);
    expect((await post(w.plugin, w.admin, w.csrf, "/admin/people/u2/revoke")).status).toBe(200);
    expect((await post(w.plugin, larry, larryCsrf, "/admin/people/u2/ceiling", { usd: "4", calls: "40" })).status).toBe(404);
    expect(rows(w.dbPath)).toEqual([]);
  });
});
