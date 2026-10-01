import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { Plugin } from "../../../../packages/api/contract.js";
import { UNDELIVERED_DAYS, UNDELIVERED_LIMIT } from "../roster.js";
import { esc } from "./html.js";
import { ADMIN, call, cleanup, CURLY, LARRY, people, signIn, slash, world } from "./harness.js";

/**
 * The admin's Deliveries page (0.10.0): the DMs that settled failed, unconfirmed or deferred, through
 * the plugin's own `http` handler with a fake host -- shown to an admin, newest first and bounded,
 * every value escaped; to anyone else, the unknown page's 404.
 */

afterEach(cleanup);

async function setup() {
  const w = await world();
  await people(w.plugin);
  return { ...w, admin: await signIn(w.plugin, ADMIN), larry: await signIn(w.plugin, LARRY), curly: await signIn(w.plugin, CURLY) };
}

const tick = (p: Plugin) => p.ticks!.find((t) => t.name === "notify")!.run(new AbortController().signal);

/** Writes delivery rows straight into the store, as docket would have settled them. */
function insert(dbPath: string, rows: { occurrence: string; user: string; status: string; error: string | null; settledAt: string }[]): void {
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const q = db.query(
      `INSERT INTO deliveries (occurrence_id, user_id, status, error, attempts, deferrals, retry_at, created_at, settled_at)
       VALUES (?, ?, ?, ?, 1, 0, NULL, ?, ?)`,
    );
    db.transaction(() => {
      for (const r of rows) q.run(r.occurrence, r.user, r.status, r.error, r.settledAt, r.settledAt);
    })();
  } finally {
    db.close();
  }
}

/** The table rows of the Deliveries page's body. */
function bodyRows(page: string): string[] {
  const body = /<tbody>([\s\S]*)<\/tbody>/.exec(page)?.[1] ?? "";
  return body.split("<tr>").slice(1);
}

describe("the admin's Deliveries page", () => {
  it("an admin sees a DM that failed: task, owner, run due, recipient, status, attempts, deferrals, error, settled; a DM that arrived is not listed", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "pills", repeat: "day", when: "9am" } });
    w.delivery.unreachable.add(LARRY);
    w.clock.set("2026-10-01T13:00:00.000Z");
    await tick(w.plugin);
    w.delivery.unreachable.clear();
    w.clock.set("2026-10-02T13:00:00.000Z");
    await tick(w.plugin);

    const admin = await call(w.plugin, "GET", "/admin", { jar: w.admin });
    expect(await admin.text()).toContain('href="/tracker/admin/deliveries"');
    const res = await call(w.plugin, "GET", "/admin/deliveries", { jar: w.admin });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const page = await res.text();
    const rows = bodyRows(page);
    expect(rows).toHaveLength(1);
    const row = rows[0] ?? "";
    expect(row).toContain('href="/tracker/tasks/t1">pills</a>');
    expect(row).toContain("t1, owner Larry");
    expect(row).toContain('href="/tracker/admin/people/u2">Larry</a>');
    expect(row).toContain("<td>failed</td>");
    expect(row).toContain("<td>1</td>\n<td>0</td>");
    expect(row).toContain("<td>recipient cannot be messaged</td>");
    expect(page).toContain("1 in all.");
  });

  it("a non-admin, the failed DM's own recipient included, gets the unknown page's 404", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "pills", repeat: "day", when: "9am" } });
    w.delivery.unreachable.add(LARRY);
    w.clock.set("2026-10-01T13:00:00.000Z");
    await tick(w.plugin);
    const unknown = await (await call(w.plugin, "GET", "/no/such/page", { jar: w.larry })).text();
    for (const jar of [w.larry, w.curly]) {
      const res = await call(w.plugin, "GET", "/admin/deliveries", { jar });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(unknown);
      expect(await (await call(w.plugin, "GET", "/", { jar })).text()).not.toContain("/admin/deliveries");
    }
    const anon = await call(w.plugin, "GET", "/admin/deliveries");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/tracker/signin");
  });

  it("escapes the error text and every other value", async () => {
    const w = await setup();
    const evil = `<script>alert("x")</script> & 'q'`;
    insert(w.dbPath, [{ occurrence: "o99", user: "<u9>", status: "unconfirmed", error: evil, settledAt: "2026-10-01T11:00:00.000Z" }]);
    const page = await (await call(w.plugin, "GET", "/admin/deliveries", { jar: w.admin })).text();
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("<u9>");
    expect(page).toContain(esc(evil));
    expect(page).toContain("&lt;u9&gt;");
    expect(page).toContain("run o99 (task gone)");
    expect(page).toContain("unconfirmed (may have gone out; never resent)");
  });

  it(`lists at most ${UNDELIVERED_LIMIT} rows, newest first, from the last ${UNDELIVERED_DAYS} days only, and only failed, unconfirmed or deferred`, async () => {
    const w = await setup();
    const now = Date.parse("2026-10-01T12:00:00.000Z");
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const statuses = ["failed", "unconfirmed", "deferred"];
    const recent = Array.from({ length: UNDELIVERED_LIMIT + 5 }, (_, i) => ({
      occurrence: `o${1000 + i}`,
      user: "u2",
      status: statuses[i % 3] ?? "failed",
      error: `err-${String(i).padStart(3, "0")}.`,
      settledAt: at(i + 1),
    }));
    insert(w.dbPath, [
      ...recent,
      { occurrence: "o1", user: "u3", status: "failed", error: "too-old.", settledAt: at((UNDELIVERED_DAYS * 24 + 1) * 60) },
      { occurrence: "o2", user: "u3", status: "sent", error: null, settledAt: at(0) },
      { occurrence: "o3", user: "u3", status: "pending", error: "not-settled.", settledAt: at(0) },
    ]);
    const page = await (await call(w.plugin, "GET", "/admin/deliveries", { jar: w.admin })).text();
    const rows = bodyRows(page);
    expect(rows).toHaveLength(UNDELIVERED_LIMIT);
    expect(page).toContain(`Showing the newest ${UNDELIVERED_LIMIT} of ${UNDELIVERED_LIMIT + 5}.`);
    // Newest first: row k is err-k; the five oldest of the window, and the rest, are not shown.
    rows.forEach((r, k) => expect(r).toContain(`err-${String(k).padStart(3, "0")}.`));
    for (const missing of ["err-200.", "err-204.", "too-old.", "not-settled."]) expect(page).not.toContain(missing);
    expect(page).not.toContain("admin/people/u3");
  });

  it("says so when there is nothing to list", async () => {
    const w = await setup();
    const page = await (await call(w.plugin, "GET", "/admin/deliveries", { jar: w.admin })).text();
    expect(page).toContain("None in that time.");
    expect(page).not.toContain("<tbody>");
  });
});
