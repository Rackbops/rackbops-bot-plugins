import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { NOT_ENFORCED } from "../ceilings.js";
import { UNLIMITED_BANNER, UNLIMITED_IDLE_LOG, UNLIMITED_LOG } from "../usage.js";
import { ADMIN, call, cleanup, csrfOf, LARRY, ORIGIN, people, signIn, world } from "./harness.js";
import { esc } from "./html.js";

/**
 * `/admin/usage` and the budgets-off banner (roshne, 2026-10-02: "evaluate usage during alpha";
 * rackbops-bot-plugins#82, plan 5.7), through the plugin's own `http` handler. Who may reach the
 * route at all is admin.test.ts's ADMIN_ROUTES too.
 */

afterEach(cleanup);

/** Charges written straight into the usage table, as docket's execute lane would. */
function charge(dbPath: string, rows: [userId: string, at: string, calls: number, usd: number][]): void {
  const db = new Database(dbPath);
  try {
    for (const [userId, at, calls, usd] of rows) {
      db.query("INSERT INTO usage (user_id, task_id, occurrence_id, source, calls, cost_usd, at) VALUES (?, 't1', NULL, 'run', ?, ?, ?)").run(userId, calls, usd, at);
    }
  } finally {
    db.close();
  }
}

async function setup(env: Record<string, string> = {}) {
  const logs: string[] = [];
  const w = await world({ env, logs });
  await people(w.plugin);
  const admin = await signIn(w.plugin, ADMIN);
  return { ...w, logs, admin };
}

const banner = esc(UNLIMITED_BANNER);

describe("/admin/usage", () => {
  it("shows each day's spend in all and per person, and what the default ceilings would have held", async () => {
    const w = await setup();
    // START is 2026-10-01 12:00Z: 08:00 in New York, the budget day 2026-10-01.
    charge(w.dbPath, [
      ...Array.from({ length: 22 }, (): [string, string, number, number] => ["u2", "2026-10-01T12:00:00.000Z", 1, 0.05]),
      ["u1", "2026-10-01T11:00:00.000Z", 1, 0.3],
      ["u2", "2026-09-30T15:00:00.000Z", 1, 2.5],
    ]);
    const res = await call(w.plugin, "GET", "/admin/usage", { jar: w.admin });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Model usage");
    expect(page).toContain("The last 14 days, newest first: 3.90 USD and 24 model call(s) in all.");
    // Today: everyone 1.40 USD / 23 calls (under the global 10 USD / 100); Larry past 20 calls, 2 after it.
    expect(page).toContain("<td>2026-10-01</td>\n<td><strong>Everyone</strong></td>\n<td>1.40</td>\n<td>23</td>");
    expect(page).toContain('href="/tracker/admin/people/u2">Larry</a></td>\n<td>1.10</td>\n<td>22</td>\n<td><span class="rb-badge">would have hit the 20 call limit</span>; 2 call(s) after it</td>');
    // Yesterday: one 2.50 USD run reached the dollar ceiling, nothing after it.
    expect(page).toContain('<td>2.50</td>\n<td>1</td>\n<td><span class="rb-badge">would have hit the 2.00 USD limit</span></td>');
    expect(page).toContain("<td>2026-09-29</td><td colspan=\"4\" class=\"rb-muted\">No model use.</td>");
    expect(page).toContain("2.00 USD and 20 model calls a day a person, 10.00 USD and 100 model calls a day for everyone together");
    expect(page).not.toContain(banner);
    // Every admin page links to it.
    expect(await (await call(w.plugin, "GET", "/admin", { jar: w.admin })).text()).toContain('href="/tracker/admin/usage"');
  });

  it("is admin only: a signed-in non-admin gets the unknown page's 404, and it is read-only (GET)", async () => {
    const w = await setup();
    const larry = await signIn(w.plugin, LARRY);
    const res = await call(w.plugin, "GET", "/admin/usage", { jar: larry });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(await (await call(w.plugin, "GET", "/no/such/page", { jar: larry })).text());
    const csrf = await csrfOf(w.plugin, w.admin);
    expect((await call(w.plugin, "POST", "/admin/usage", { jar: w.admin, form: { csrf }, origin: ORIGIN })).status).toBe(405);
    const anon = await call(w.plugin, "GET", "/admin/usage");
    expect(anon.status).toBe(303);
  });
});

describe("TRACKER_BUDGET_UNLIMITED on", () => {
  it("with the execute lane configured, logs the budgets-off line once at start", async () => {
    const w = await setup({
      TRACKER_BUDGET_UNLIMITED: "true",
      TRACKER_CITY_HALL_URL: "https://city-hall.example.com",
      TRACKER_CITY_HALL_KEY: "k",
      TRACKER_CITY_HALL_CAPABILITY: "claude-cli:subscription",
    });
    expect(w.logs.filter((l) => l === UNLIMITED_LOG)).toHaveLength(1);
    expect(w.logs).not.toContain(UNLIMITED_IDLE_LOG);
  });

  it("with the execute lane off, logs one line that no model work runs (not the budgets-off line); the people, usage and person pages say budgets are off; the ceiling form still works", async () => {
    const w = await setup({ TRACKER_BUDGET_UNLIMITED: "true" });
    expect(w.logs.filter((l) => l === UNLIMITED_IDLE_LOG)).toHaveLength(1);
    expect(w.logs).not.toContain(UNLIMITED_LOG);
    expect(await (await call(w.plugin, "GET", "/admin", { jar: w.admin })).text()).toContain(banner);
    const usage = await (await call(w.plugin, "GET", "/admin/usage", { jar: w.admin })).text();
    expect(usage).toContain(banner);
    expect(usage).toContain("While budgets are off, nothing is held.");
    const person = await (await call(w.plugin, "GET", "/admin/people/u2", { jar: w.admin })).text();
    expect(person).toContain(esc(NOT_ENFORCED));
    expect(person).toContain("(the default) -- not enforced.");
    const csrf = await csrfOf(w.plugin, w.admin);
    const raised = await call(w.plugin, "POST", "/admin/people/u2/ceiling", { jar: w.admin, form: { csrf, usd: "4", calls: "40" }, origin: ORIGIN });
    expect(raised.status).toBe(200);
    const body = await raised.text();
    expect(body).toContain("ceiling is now 4.00 USD and 40 model calls a day, until an admin changes it.");
    expect(body).toContain('<span class="rb-badge">raised</span> -- not enforced.');
  });

  it("off by default: no log line, no banner, no note", async () => {
    const w = await setup();
    expect(w.logs.some((l) => l.includes("budgets off"))).toBe(false);
    expect(await (await call(w.plugin, "GET", "/admin", { jar: w.admin })).text()).not.toContain(banner);
    expect(await (await call(w.plugin, "GET", "/admin/people/u2", { jar: w.admin })).text()).not.toContain(esc(NOT_ENFORCED));
  });
});
