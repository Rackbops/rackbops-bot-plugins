import type { Database } from "bun:sqlite";

/**
 * eBay API watches keep no eBay data (Rod, 2026-10-20, the account-deletion card): eBay's API
 * License wants shown listing data at most six hours old and seller names gone on eBay's notice,
 * and the keyset may opt out of those notices only when the app keeps no eBay data. docket-types
 * stores no findings for such a watch (`keepsFindings`) and its state holds only digests of the
 * listings told; what is left is each run's recorded DM (docket-core's `Occurrence.record`, kept
 * so an owed send can be retried). Six hours after a run of an `ebay` watch fired, its DM text is
 * replaced by `FORGOTTEN`, so `/task history` and any send still owed carry no listing.
 *
 * Plain SQL over the tracker's own tables, run on the notify tick: no store port carries it.
 */

export const EBAY_KEEP_MS = 6 * 3600_000;
export const FORGOTTEN = "(eBay listings are not kept here after 6 hours.)";

/** Forgets the DM text of every `ebay` watch run that finished at least `EBAY_KEEP_MS` before `now`; how many. */
export function forgetEbayMessages(db: Database, now: Date): number {
  const before = new Date(now.getTime() - EBAY_KEEP_MS).toISOString();
  return db
    .query(
      `UPDATE occurrences SET record = json_set(record, '$.outcome.notify.text', ?)
         WHERE record IS NOT NULL
           AND finished_at IS NOT NULL AND finished_at <= ?
           AND json_type(record, '$.outcome.notify.text') = 'text'
           AND json_extract(record, '$.outcome.notify.text') <> ?
           AND task_id IN (SELECT 't' || seq FROM tasks WHERE type IN ('wantlist', 'wantjudge') AND json_extract(config, '$.source') = 'ebay')`,
    )
    .run(FORGOTTEN, before, FORGOTTEN).changes;
}
