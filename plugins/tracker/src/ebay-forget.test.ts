import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { EBAY_KEEP_MS, forgetEbayMessages } from "./ebay-forget.js";
import { openDatabase } from "./schema.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const LISTING_DM = "Oceania: a new listing.\n- Wingspan Oceania -- 29.99 USD -- sold by boardgame_bin <https://www.ebay.com/itm/123456789012> (via eBay)\nPress Done once you have it, and I stop looking.";
const opened: Database[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function db(): Database {
  const d = openDatabase(":memory:");
  opened.push(d);
  return d;
}

let seq = 0;
function task(d: Database, type: string, config: Record<string, unknown>): string {
  const at = NOW.toISOString();
  d.query(
    "INSERT INTO tasks (owner_id, type, title, config, state, schedule, lane, capabilities, status, created_at, updated_at) VALUES ('u1', ?, 'Oceania', ?, '{}', '{}', 'notify', '[]', 'active', ?, ?)",
  ).run(type, JSON.stringify(config), at, at);
  return `t${(d.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id}`;
}

function run(d: Database, taskId: string, ageMs: number, text: string | null, started = true): number {
  const fired = new Date(NOW.getTime() - ageMs).toISOString();
  const record = { firedAt: fired, outcome: text === null ? { summary: "nothing new" } : { notify: { text, actions: ["done"] }, summary: "1 new" } };
  d.query(
    "INSERT INTO occurrences (task_id, lane, due_at, started_at, finished_at, status, late, dedupe_key, created_at, record) VALUES (?, 'notify', ?, ?, ?, 'done', 0, ?, ?, ?)",
  ).run(taskId, fired, started ? fired : null, fired, `k${++seq}`, fired, JSON.stringify(record));
  return (d.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

const textOf = (d: Database, s: number) => (d.query("SELECT json_extract(record, '$.outcome.notify.text') AS t FROM occurrences WHERE seq = ?").get(s) as { t: string | null }).t;

describe("forgetEbayMessages", () => {
  it("clears an eBay API watch's listing DM at six hours, keeping its first line, and not a minute before", () => {
    const d = db();
    const t = task(d, "wantlist", { source: "ebay", target: "Wingspan Oceania", maxPrice: 35 });
    const young = run(d, t, EBAY_KEEP_MS - 60_000, LISTING_DM);
    const old = run(d, t, EBAY_KEEP_MS, LISTING_DM);
    expect(forgetEbayMessages(d, NOW)).toBe(1);
    expect(textOf(d, young)).toBe(LISTING_DM);
    const cleared = textOf(d, old) ?? "";
    expect(cleared.startsWith("Oceania: a new listing.\neBay's listings are not kept here past 6 hours")).toBe(true);
    expect(cleared).not.toContain("boardgame_bin");
    expect(cleared).toContain("<https://www.ebay.com/sch/i.html?");
    // Done once: the next tick rewrites nothing.
    expect(forgetEbayMessages(d, NOW)).toBe(0);
  });

  it("leaves every other watch and task, a DM with no listing, and a run with no DM alone", () => {
    const d = db();
    const others = [
      task(d, "wantlist", { source: "inbox", target: "ebay-0123456789abcdef01234567", search: "Oceania" }),
      task(d, "wantlist", { source: "shopify", target: "Oceania" }),
      task(d, "wantjudge", { source: "page", target: "https://shop.example/s" }),
      task(d, "reminder", { source: "ebay" }),
    ].map((t) => run(d, t, 3 * EBAY_KEEP_MS, LISTING_DM));
    const t = task(d, "wantjudge", { source: "ebay", target: "Oceania" });
    const miss = run(d, t, 3 * EBAY_KEEP_MS, "Oceania: I could read no listings from eBay's search just now (eBay is busy (HTTP 503)).");
    run(d, t, 3 * EBAY_KEEP_MS, null);
    expect(forgetEbayMessages(d, NOW, true)).toBe(0);
    for (const s of others) expect(textOf(d, s)).toBe(LISTING_DM);
    expect(textOf(d, miss)).toContain("eBay is busy");
  });

  it("takes the last two days on a tick, and every run, its start cleared too, on the full sweep", () => {
    const d = db();
    const t = task(d, "wantlist", { source: "ebay", target: "Oceania" });
    const ancient = run(d, t, 30 * 24 * 3600_000, LISTING_DM);
    const unstarted = run(d, t, EBAY_KEEP_MS + 60_000, LISTING_DM, false);
    expect(forgetEbayMessages(d, NOW)).toBe(0);
    expect(forgetEbayMessages(d, NOW, true)).toBe(2);
    expect(textOf(d, ancient)).not.toContain("boardgame_bin");
    expect(textOf(d, unstarted)).not.toContain("boardgame_bin");
  });
});
