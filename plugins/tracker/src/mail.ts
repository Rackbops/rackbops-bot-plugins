import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { User } from "@rackbops/docket-core";
import type { Listing } from "@rackbops/docket-types";
import type { TrackerDeps } from "./actions.js";
import { readEbayAlert, sameSearch } from "./ebay-alert.js";
import { acceptListing } from "./inbox.js";
import type { MailMessage } from "./mime.js";
import { WANT_TYPES, type WatchConfig, watchSite } from "./want.js";

/**
 * The alert-email route (tracker 0.24.0; Rod's "build the email route", with the forwarding
 * address he chose on the card): eBay's saved-search alerts reach a person's eBay watches by mail.
 *
 * Each person has one alert address, `m-<24 hex>@<TRACKER_MAIL_DOMAIN>`, made the first time it is
 * shown to them (`/want source: ebay`, the web area's settings). Their mail forwards eBay's alerts
 * there; Cloudflare Email Routing hands every message for the domain to a small Email Worker
 * (`mail-worker/`), which posts it as it came to `POST /<plugin>/mail/inbound` with
 * `TRACKER_MAIL_KEY` as its bearer and the address it was sent to (web/mail-inbound.ts). Here:
 *
 * - **Gmail's forwarding confirmation** (from `forwarding-noreply@google.com`): its code is DMed to
 *   the person, so they can finish turning forwarding on in Gmail. Only the digits go on.
 * - **An eBay alert** (ebay-alert.ts): its listings go into the inbox of each of the person's live
 *   eBay watches whose words are the alert's (case and spacing aside), exactly as if Claude in
 *   Chrome had posted them, and the watch's next look DMs the new ones. An alert no watch searches
 *   for gets one DM saying so, with the words to make one.
 * - **Anything else** is dropped unread past its sender and subject.
 *
 * The address is the only thing that ties a message to a person, so it is never guessable (96
 * random bits), never shown to anyone else, and goes with forget-me. A message is never stored:
 * only the listings read from it are, in the watch's inbox.
 */

export const MAIL_DOMAIN_KEY = "TRACKER_MAIL_DOMAIN";
export const MAIL_KEY_KEY = "TRACKER_MAIL_KEY";
/** The manifest's `format` for the domain: a lower-case host name with at least one dot. */
export const MAIL_DOMAIN_FORMAT = "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$";
/** The shortest key taken: the Worker's bearer guards every person's watches at once. */
export const MIN_MAIL_KEY = 32;
export const GMAIL_FORWARDING = "forwarding-noreply@google.com";

const LOCAL = /^m-[0-9a-f]{24}$/;

export interface MailConfig {
  domain: string;
  key: string;
}

/** `TRACKER_MAIL_DOMAIN` and `TRACKER_MAIL_KEY`: both, or neither (the route is off); throws, naming the problem, on anything else. Values are never echoed. */
export function parseMailConfig(env: Readonly<Record<string, string | undefined>>): MailConfig | null {
  const domain = (env[MAIL_DOMAIN_KEY] ?? "").trim();
  const key = (env[MAIL_KEY_KEY] ?? "").trim();
  if (domain === "" && key === "") return null;
  if (domain === "" || key === "") throw new Error(`${MAIL_DOMAIN_KEY} and ${MAIL_KEY_KEY} go together: set both for the alert-email route, or neither`);
  if (!new RegExp(MAIL_DOMAIN_FORMAT).test(domain)) throw new Error(`${MAIL_DOMAIN_KEY} is not a lower-case domain such as alerts.example.com`);
  if (key.length < MIN_MAIL_KEY || /\s/.test(key)) throw new Error(`${MAIL_KEY_KEY} must be at least ${MIN_MAIL_KEY} characters with no spaces`);
  return { domain, key };
}

/** The `mail_addresses` table (schema migration 10). */
export class MailAddresses {
  constructor(
    private readonly db: Database,
    readonly domain: string,
  ) {}

  /** The person's alert address, made now when they have none. */
  addressFor(userId: string, now: Date): string {
    const row = this.db.query("SELECT local FROM mail_addresses WHERE user_id = ?").get(userId) as { local: string } | null;
    if (row) return `${row.local}@${this.domain}`;
    const local = `m-${randomBytes(12).toString("hex")}`;
    this.db.query("INSERT INTO mail_addresses (user_id, local, created_at) VALUES (?, ?, ?)").run(userId, local, now.toISOString());
    return `${local}@${this.domain}`;
  }

  /** Whose address `to` is: null for another domain, a malformed one, or one no one has. */
  userOf(to: string): string | null {
    const at = to.trim().toLowerCase().lastIndexOf("@");
    if (at <= 0) return null;
    const local = to.trim().toLowerCase().slice(0, at);
    const domain = to.trim().toLowerCase().slice(at + 1);
    if (domain !== this.domain || !LOCAL.test(local)) return null;
    const row = this.db.query("SELECT user_id FROM mail_addresses WHERE local = ?").get(local) as { user_id: string } | null;
    return row?.user_id ?? null;
  }
}

/** Gmail's forwarding confirmation code in `mail`, or null when it is not one. */
export function forwardingCode(mail: MailMessage): string | null {
  if (mail.from !== GMAIL_FORWARDING || !/forwarding confirmation/i.test(mail.subject)) return null;
  const inSubject = /\(#(\d{6,12})\)/.exec(mail.subject)?.[1];
  if (inSubject) return inSubject;
  return /confirmation code:\s*(\d{6,12})/i.exec(mail.text ?? mail.html ?? "")?.[1] ?? null;
}

/** Words from a stranger's mail made safe for a DM: no markdown, mentions or links, one line, capped. */
function quoted(words: string): string {
  return words.replace(/[`*_~|<>@#[\]()\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

export type MailOutcome =
  | { kind: "confirmation" }
  | { kind: "stored"; watches: number; listings: number }
  | { kind: "unmatched" }
  | { kind: "ignored" };

/** The person's live eBay inbox watches searching for `search`. */
async function watchesFor(d: TrackerDeps, user: User, search: string) {
  const out = [];
  for (const type of WANT_TYPES) {
    for (const status of ["active", "paused"] as const) {
      for (const task of await d.store.listTasks({ ownerId: user.id, status, type })) {
        const c = task.config as WatchConfig;
        if (watchSite(c) === "ebay" && sameSearch(c.search ?? task.title, search)) out.push({ task, key: c.target });
      }
    }
  }
  return out;
}

/** DMs `text`, logging a failure rather than failing the mail: eBay mails again tomorrow. */
async function tell(d: TrackerDeps, userId: string, text: string): Promise<void> {
  try {
    await d.notifier.sendDm(userId, { text });
  } catch (err) {
    d.log.warn(`mail: a DM about an alert email did not go out (${err instanceof Error ? err.name : "error"})`);
  }
}

/**
 * What a message to `userId`'s alert address does (see above). Run in the surface's one queue: the
 * watches are read and their inboxes written as the store has them then.
 */
export async function deliverMail(d: TrackerDeps, userId: string, mail: MailMessage): Promise<MailOutcome> {
  const user = await d.store.getUser(userId);
  if (!user || !d.admissions.isRegistered(user.id) || !d.inbox) return { kind: "ignored" };
  const code = forwardingCode(mail);
  if (code) {
    await tell(d, user.id, `Gmail asks to confirm forwarding to your alert address. The confirmation code is ${code}: enter it in Gmail's Settings, under Forwarding and POP/IMAP. If you did not ask for this, ignore it.`);
    return { kind: "confirmation" };
  }
  const alert = readEbayAlert(mail);
  if (!alert) return { kind: "ignored" };
  const listings: Listing[] = [];
  for (const raw of alert.listings) {
    const l = acceptListing(raw);
    if (l) listings.push(l);
  }
  const watches = await watchesFor(d, user, alert.search);
  if (watches.length === 0 || listings.length === 0) {
    const words = quoted(alert.search);
    if (watches.length === 0 && words) {
      await tell(d, user.id, `An eBay alert for "${words}" reached me, but none of your eBay watches searches for those words, so I left it. To watch it: \`/want name: ${words} source: ebay target: ${words}\`.`);
    }
    return { kind: "unmatched" };
  }
  const now = d.clock.now();
  for (const w of watches) d.inbox.add(w.task.id, w.key, listings, now);
  return { kind: "stored", watches: watches.length, listings: listings.length };
}
