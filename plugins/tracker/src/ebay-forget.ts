import type { Database } from "bun:sqlite";
import { clip } from "./actions.js";
import { ebaySearchUrl } from "./want.js";

/**
 * eBay API watches keep no eBay data (Rod, 2026-10-20, the account-deletion card): eBay's API
 * License wants shown listing data at most six hours old and seller names gone on eBay's notice,
 * and the keyset may opt out of those notices only when the app keeps no eBay data. docket-types
 * stores no findings for such a watch (`keepsFindings`) and its state holds only digests of the
 * listings told; what is left is each run's recorded DM (docket-core's `Occurrence.record`, kept
 * so an owed send can be retried). Six hours after a run of an `ebay` watch fired, a recorded DM
 * that lists listings keeps its first line (the watch's name and how many, no eBay data) and the
 * rest becomes a note with eBay's own search, so a send still owed never carries an old listing.
 * Other DMs of such a watch (a miss) hold no listing and are left as they are.
 *
 * Plain SQL over the tracker's own tables plus a JSON rewrite, run on the notify tick over the
 * runs that fired in the two days before the cutoff (`EBAY_SWEEP_MS`), and at activation over all
 * of them (`sweepAll`), so each tick's cost stays small however long the history grows.
 */

export const EBAY_KEEP_MS = 6 * 3600_000;
export const EBAY_SWEEP_MS = 48 * 3600_000;
const CLEARED = "eBay's listings are not kept here past 6 hours, so they are not repeated now.";

/** What a cleared DM says after its first line. */
export function ebayForgottenText(firstLine: string, words: string, max?: number): string {
  return clip(
    [
      firstLine,
      CLEARED,
      `eBay's own search: <${ebaySearchUrl(words, max)}>`,
      "Press Done once you have it, and I stop looking.",
    ].join("\n"),
  );
}

interface Row {
  seq: number;
  record: string;
  config: string;
}

/** Clears the listings from every `ebay` watch run's recorded DM fired at least `EBAY_KEEP_MS` before `now`; how many. */
export function forgetEbayMessages(db: Database, now: Date, sweepAll = false): number {
  const cutoff = new Date(now.getTime() - EBAY_KEEP_MS).toISOString();
  // A run starts before it fires, so `started_at` (a plain column, no JSON read) bounds the window;
  // the full sweep takes every run, one whose start was cleared (put back unstarted) included.
  const from = new Date(now.getTime() - EBAY_KEEP_MS - EBAY_SWEEP_MS).toISOString();
  const rows = db
    .query(
      `SELECT o.seq AS seq, o.record AS record, t.config AS config
         FROM occurrences o JOIN tasks t ON o.task_id = 't' || t.seq
         WHERE t.type IN ('wantlist', 'wantjudge') AND json_extract(t.config, '$.source') = 'ebay'
           AND o.record IS NOT NULL
           AND (? OR o.started_at > ?)
           AND json_extract(o.record, '$.firedAt') <= ?`,
    )
    .all(sweepAll ? 1 : 0, from, cutoff) as Row[];
  let changed = 0;
  for (const r of rows) {
    let record: { outcome?: { notify?: { text?: unknown } } };
    let config: { target?: unknown; maxPrice?: unknown };
    try {
      record = JSON.parse(r.record);
      config = JSON.parse(r.config);
    } catch {
      continue;
    }
    const text = record.outcome?.notify?.text;
    // Only a DM that lists listings: each listing line links its item as <https://...>.
    if (typeof text !== "string" || !text.includes("<https://") || text.includes(CLEARED)) continue;
    const words = typeof config.target === "string" ? config.target : "";
    const max = typeof config.maxPrice === "number" ? config.maxPrice : undefined;
    const first = text.split("\n", 1)[0] ?? "";
    (record.outcome as { notify: { text: string } }).notify.text = ebayForgottenText(first, words, max);
    db.query("UPDATE occurrences SET record = ? WHERE seq = ?").run(JSON.stringify(record), r.seq);
    changed++;
  }
  return changed;
}
