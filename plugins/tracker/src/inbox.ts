import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { type Listing, type Submitted, submittedListing } from "@rackbops/docket-types";

/**
 * Want-list inboxes (docket-types 0.7.0's `inbox` source; tracker 0.19.0): the listings sent in for
 * a watch rather than read by the tracker. Rod's rule for eBay and BoardGameGeek (2026-10-05) is
 * that Clerk never opens either site itself; listings reach a watch only when someone sends them
 * in -- today the owner's own browser (Claude in Chrome searching eBay or BGG for them) through the
 * task API's `POST /tasks/<id>/listings` (web/api-listings.ts), later eBay's saved-search alert
 * emails. This is the host's half of the source: the `want_inbox` table (schema migration 8), one
 * inbox per watch, found by the watch's inbox key (its config's `target`).
 *
 * What is stored is never what was sent: each listing goes through docket-types' own
 * `submittedListing` first (a title, an absolute http(s) address, every field cleaned, capped and
 * typed), and only its six fields are kept, so a row holds nothing a caller made up beyond them and
 * nothing longer than docket's own caps. The source cleans each one again when it reads, which
 * costs nothing and keeps the source honest whatever a host stores.
 *
 * An inbox is a window, not an archive: `MAX_INBOX_ROWS` rows per key, the oldest going as new ones
 * come in. The watch's own state (docket's `reported`) is what keeps a listing from being DMed
 * twice, so a row that goes after it was read loses nothing; one that goes before it was read --
 * more than `MAX_INBOX_ROWS` sent between two runs -- is lost, which is why an inbox watch polls
 * hourly by default (want.ts's `DEFAULT_INBOX_HOURS`).
 */

/** Rows kept per inbox key, newest first; docket's source reads at most 100 of them a run. */
export const MAX_INBOX_ROWS = 200;
/** Listings one `POST /tasks/<id>/listings` may carry. */
export const MAX_LISTINGS_PER_POST = 40;

/** The sites an inbox watch is for, by its key's prefix. */
export const INBOX_SITES = ["ebay", "bgg"] as const;
export type InboxSite = (typeof INBOX_SITES)[number];

const KEY = /^(ebay|bgg)-[0-9a-f]{24}$/;

/** A new inbox key for `site`: the site, a dash and 24 random hex digits (96 bits), so no key is guessed or reused. */
export function newInboxKey(site: InboxSite): string {
  return `${site}-${randomBytes(12).toString("hex")}`;
}

/** The site an inbox key is for, or null for anything that is not one of ours. */
export function inboxSite(key: string): InboxSite | null {
  const m = KEY.exec(key);
  return m ? (m[1] as InboxSite) : null;
}

/** A listing as stored: only `Submitted`'s six fields, from docket's cleaned `Listing`. */
function stored(l: Listing): Submitted {
  return {
    title: l.title,
    url: l.url,
    ...(l.price !== undefined ? { price: l.price } : {}),
    ...(l.currency !== undefined ? { currency: l.currency } : {}),
    ...(l.condition !== undefined ? { condition: l.condition } : {}),
    ...(l.seller !== undefined ? { seller: l.seller } : {}),
  };
}

/** One sent-in listing, cleaned, or null when docket-types refuses it (no title, no usable address, not an object). */
export function acceptListing(raw: unknown): Listing | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return submittedListing(raw as Submitted);
}

/** The `want_inbox` table (schema migration 8). */
export class WantInbox {
  constructor(private readonly db: Database) {}

  /**
   * Stores `listings` (already accepted: `acceptListing`) for the watch `taskId` under `key`, in the
   * order given, then keeps only the newest `MAX_INBOX_ROWS` for the key, in one transaction.
   * Returns how many were stored.
   */
  add(taskId: string, key: string, listings: readonly Listing[], now: Date): number {
    const at = now.toISOString();
    const insert = this.db.query("INSERT INTO want_inbox (task_id, key, listing, at) VALUES (?, ?, ?, ?)");
    return this.db.transaction(() => {
      for (const l of listings) insert.run(taskId, key, JSON.stringify(stored(l)), at);
      this.db
        .query("DELETE FROM want_inbox WHERE key = ? AND seq NOT IN (SELECT seq FROM want_inbox WHERE key = ? ORDER BY seq DESC LIMIT ?)")
        .run(key, key, MAX_INBOX_ROWS);
      return listings.length;
    })();
  }

  /** docket's `ReadInbox`: what has arrived under `key`, oldest first; a row that does not parse is skipped. */
  read(key: string): Submitted[] {
    const rows = this.db.query("SELECT listing FROM want_inbox WHERE key = ? ORDER BY seq").all(key) as { listing: string }[];
    const out: Submitted[] = [];
    for (const r of rows) {
      try {
        const v = JSON.parse(r.listing) as unknown;
        if (typeof v === "object" && v !== null && !Array.isArray(v)) out.push(v as Submitted);
      } catch {
        // A row this module did not write; nothing to hand on.
      }
    }
    return out;
  }

  /** How many rows a key holds (tests, and the API's answer). */
  count(key: string): number {
    return Number((this.db.query("SELECT COUNT(*) AS n FROM want_inbox WHERE key = ?").get(key) as { n: number }).n);
  }
}
