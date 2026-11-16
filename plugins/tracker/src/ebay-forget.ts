import type { Database } from "bun:sqlite";
import { MAX_WANT_DM_CHARS } from "@rackbops/docket-types";
import { clip } from "./actions.js";
import { ebaySearchUrl } from "./want.js";

/**
 * eBay API watches keep no eBay data (Rod, 2026-10-20, the account-deletion card): eBay's API
 * License wants shown listing data at most six hours old and seller names gone on eBay's notice,
 * and the keyset may opt out of those notices only when the app keeps no eBay data. docket-types
 * stores no findings for such a watch (`keepsFindings`); its state holds digests of the listings
 * told and, for a judged one, the item numbers it holds for its next look (docket 0.22.0), and
 * city-hall erases its judge Job (`ebayJobForgetSeconds`); what is left is each run's recorded DM (docket-core's `Occurrence.record`, kept
 * so an owed send can be retried). Six hours after a run of an `ebay` watch fired, a recorded DM
 * that lists listings keeps its first line (the watch's name and how many, no eBay data) and the
 * rest becomes a note with eBay's own search, so a send still owed never carries an old listing.
 * Other DMs of such a watch (a miss) hold no listing and are left as they are. A watch of several
 * places with eBay among them (0.61.0) loses only its eBay lines (`ebayLinesForgotten`).
 *
 * Plain SQL over the tracker's own tables plus a JSON rewrite, run on the notify tick over the
 * runs that fired in the two days before the cutoff (`EBAY_SWEEP_MS`), and at activation over all
 * of them (`sweepAll`), so each tick's cost stays small however long the history grows.
 */

export const EBAY_KEEP_MS = 6 * 3600_000;
export const EBAY_SWEEP_MS = 48 * 3600_000;
const DONE_LINE = "Press Done once you have it, and I stop looking.";
const CLEARED = "eBay's listings are not kept here past 6 hours, so they are not repeated now.";

/** What a cleared DM says after its first line. */
export function ebayForgottenText(firstLine: string, words: string, max?: number): string {
  return clip(
    [
      firstLine,
      CLEARED,
      `eBay's own search: <${ebaySearchUrl(words, max)}>`,
      DONE_LINE,
    ].join("\n"),
  );
}

/** A DM line that lists an eBay listing: `- ...` linking an item on an eBay site as `<https://...>`. */
const EBAY_LINE = /^- .*<https?:\/\/(?:[^/>]*\.)?ebay\.[a-z.]+[/>]/i;

/**
 * A DM of a watch of several places (0.61.0) with its eBay listings taken out: the other places'
 * lines stay, and the eBay ones become the same note and eBay's own search, before its last line.
 * Null when it lists no eBay listing, so nothing is rewritten.
 */
export function ebayLinesForgotten(text: string, words: string, max?: number): string | null {
  const lines = text.split("\n");
  // A DM cut at docket's want-DM length (`wantDm`'s `clip`, "...") lost its closing line, and its last line
  // may be an eBay listing cut before its link and its "(via eBay)", which nothing can tell from
  // another place's: that line goes too, so a cut DM of a watch with an eBay place is always rewritten.
  const cut = text.endsWith("...") && !text.endsWith(DONE_LINE) ? lines.pop() : undefined;
  // A judged DM follows each listing with an indented note line ("  looks right: ... Seller: ..."),
  // which goes with its eBay listing: it may name the seller.
  const kept = lines.filter((l, i) => !EBAY_LINE.test(l) && !(l.startsWith("  ") && EBAY_LINE.test(lines[i - 1] ?? "")));
  if (kept.length === lines.length && cut === undefined) return null;
  const last = cut !== undefined ? DONE_LINE : (kept.pop() ?? "");
  const tail = [CLEARED, `eBay's own search: <${ebaySearchUrl(words, max)}>`, last];
  // The note must survive whole, or the sweep would not know the DM as cleared: a DM near
  // docket's want-DM length (from docket 0.30.0, tracker 0.62.0: up to MAX_WANT_DM_CHARS, sent as
  // several Discord messages) gives up its last listings, never its first line, to make room for it.
  while (kept.length > 1 && [...kept, ...tail].join("\n").length > MAX_WANT_DM_CHARS) kept.pop();
  return clip([...kept, ...tail].join("\n"), MAX_WANT_DM_CHARS);
}

/**
 * How long city-hall may keep a judged eBay watch's Job, in seconds: its prompt carries the
 * listings for the model to check, so city-hall erases it once it ends and never past eBay's six
 * hours (Rod, 2026-11-08: "Queue wipes eBay jobs"; Rackbops/city-hall#6 `forgetAfterSeconds`).
 */
export const EBAY_JOB_FORGET_SECONDS = EBAY_KEEP_MS / 1000;

/**
 * `EBAY_JOB_FORGET_SECONDS` when occurrence `occurrenceId` (`o<seq>`) is a run of a judged eBay
 * watch, else undefined. A plain watch sends no Job. An inbox eBay watch (no eBay keys) is stored
 * as `source: "inbox"`, so its Jobs are kept as before: its listings come from its owner's own
 * browser or alert emails, not eBay's API, and are kept as findings.
 */
export function ebayJobForgetSeconds(db: Database, occurrenceId: string): number | undefined {
  const m = /^o(\d+)$/.exec(occurrenceId);
  if (!m) return undefined;
  const row = db
    .query(
      `SELECT 1 AS one FROM occurrences o JOIN tasks t ON o.task_id = 't' || t.seq
         WHERE o.seq = ? AND t.type = 'wantjudge' AND json_extract(t.config, '$.source') = 'ebay'`,
    )
    .get(Number(m[1])) as { one: number } | null;
  return row ? EBAY_JOB_FORGET_SECONDS : undefined;
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
         WHERE t.type IN ('wantlist', 'wantjudge')
           AND (json_extract(t.config, '$.source') = 'ebay'
             OR EXISTS (SELECT 1 FROM json_each(t.config, '$.also') a WHERE json_extract(a.value, '$.source') = 'ebay'))
           AND o.record IS NOT NULL
           AND (? OR o.started_at > ?)
           AND json_extract(o.record, '$.firedAt') <= ?`,
    )
    .all(sweepAll ? 1 : 0, from, cutoff) as Row[];
  let changed = 0;
  for (const r of rows) {
    let record: { outcome?: { notify?: { text?: unknown } } };
    let config: { source?: unknown; target?: unknown; maxPrice?: unknown; also?: unknown };
    try {
      record = JSON.parse(r.record);
      config = JSON.parse(r.config);
    } catch {
      continue;
    }
    const text = record.outcome?.notify?.text;
    // Only a DM that lists listings: each listing line links its item as <https://...>.
    if (typeof text !== "string" || !text.includes("<https://") || text.includes(CLEARED)) continue;
    const also = Array.isArray(config.also) ? (config.also as { source?: unknown; target?: unknown }[]) : [];
    const ebay = config.source === "ebay" ? config : also.find((p) => p !== null && typeof p === "object" && p.source === "ebay");
    const words = typeof ebay?.target === "string" ? ebay.target : "";
    const max = typeof config.maxPrice === "number" ? config.maxPrice : undefined;
    const first = text.split("\n", 1)[0] ?? "";
    const cleared = also.length > 0 ? ebayLinesForgotten(text, words, max) : ebayForgottenText(first, words, max);
    if (cleared === null) continue;
    (record.outcome as { notify: { text: string } }).notify.text = cleared;
    db.query("UPDATE occurrences SET record = ? WHERE seq = ?").run(JSON.stringify(record), r.seq);
    changed++;
  }
  return changed;
}
