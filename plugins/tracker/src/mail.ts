import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { User } from "@rackbops/docket-core";
import type { Listing } from "@rackbops/docket-types";
import type { TrackerDeps } from "./actions.js";
import { htmlText, MAX_HTML_CHARS, readEbayAlert, SEARCH_MARKS, sameSearch } from "./ebay-alert.js";
import { acceptListing } from "./inbox.js";
import type { MailMessage } from "./mime.js";
import { WANT_TYPES, type WatchConfig, watchSite } from "./want.js";

/**
 * The alert-email route (tracker 0.25.0; Rod's "build the email route", with the forwarding
 * address he chose on the card): eBay's saved-search alerts reach a person's eBay watches by mail.
 *
 * Each person has one alert address, `m-<24 hex>@<TRACKER_MAIL_DOMAIN>`, made the first time it is
 * shown to them (`/want source: ebay`, the web area's settings). Their mail forwards eBay's alerts
 * there; Cloudflare Email Routing hands every message for the domain to a small Email Worker
 * (`mail-worker/`), which posts it as it came to `POST /<plugin>/mail/inbound` with
 * `TRACKER_MAIL_KEY` as its bearer and the address it was sent to (web/mail-inbound.ts). Here:
 *
 * - **Gmail's forwarding confirmation** (from Google, `forwardingConfirmation`): its code, and its
 *   verify link on Gmail's own hosts, are DMed to the person, so they can finish turning
 *   forwarding on in Gmail. Nothing else from it goes on.
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
  // The manifest's format, `^[!-~]{32,}$` (#202): printable ASCII, no spaces.
  if (key.length < MIN_MAIL_KEY || !/^[!-~]+$/.test(key)) throw new Error(`${MAIL_KEY_KEY} must be at least ${MIN_MAIL_KEY} printable ASCII characters with no spaces`);
  return { domain, key };
}

/** The `mail_addresses` table (schema migration 10). */
export class MailAddresses {
  constructor(
    private readonly db: Database,
    readonly domain: string,
  ) {}

  /**
   * The person's alert address, made now when they have none; null when they are no longer in the
   * store (forgotten while the request waited), so forget-me's erasure is never undone.
   */
  addressFor(userId: string, now: Date): string | null {
    const seq = /^u([1-9][0-9]*)$/.exec(userId)?.[1];
    if (seq === undefined || this.db.query("SELECT 1 FROM users WHERE seq = ?").get(Number(seq)) === null) return null;
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

/** Whether `address` is at google.com or one of its subdomains. */
function fromGoogle(address: string | null): boolean {
  const host = address?.slice(address.lastIndexOf("@") + 1) ?? "";
  return host === "google.com" || host.endsWith(".google.com");
}

export interface ForwardingConfirmation {
  code: string | null;
  link: string | null;
}

// Only URL-safe ASCII in the path: nothing that reorders text or is Discord markdown.
const GMAIL_LINK = /https:\/\/(?:[a-z0-9-]{1,63}\.){0,4}(?:mail|mail-settings)\.google\.com\/[A-Za-z0-9\-._~%/?#&=+:@!$,;]{1,1000}/gi;

function decodedHtmlLinks(html: string): string {
  // `&amp;` (or its numeric forms) in an href is `&` in the address.
  return html.slice(0, MAX_HTML_CHARS).replace(/&(?:amp|#0*38|#x0*26);/gi, "&");
}

/** `s` without a sentence's closing marks at its end. */
function trimClosingMarks(s: string): string {
  let end = s.length;
  while (end > 0 && ".,;:!?".includes(s.charAt(end - 1))) end--;
  return s.slice(0, end);
}

/** Gmail's verify (`/mail/vf-`) link in `s`, or null: never its cancel link or any other. */
function gmailLink(s: string): string | null {
  for (const l of s.match(GMAIL_LINK) ?? []) {
    const link = trimClosingMarks(l);
    if (/^https:\/\/[^/]+\/mail\/vf-/i.test(link)) return link;
  }
  return null;
}

/** `s` with every word holding an `@` (an address) taken out, in linear time. */
function withoutAddresses(s: string): string {
  return s.split(/\s+/).filter((w) => !w.includes("@")).join(" ");
}

/** The body as the reader sees it: plain text, else the HTML's text. */
function bodyText(mail: MailMessage): string {
  return mail.text || (mail.html !== null ? htmlText(mail.html.slice(0, MAX_HTML_CHARS)) : "");
}

/**
 * Gmail's forwarding confirmation in `mail`: its code, its confirmation link, both, or null when it
 * is not one. Read loosely, since the first two real ones (2026-10-13) went unread by stricter
 * readers (0.25.0, 0.26.0), which wanted the code as `#<digits>` or after "confirmation code":
 *
 * - from Google, naming forwarding in its subject or body (or, in any language, a subject that
 *   starts `(#<digits>)` as Gmail's has);
 * - the code: that leading `(#<digits>)`, else a run of 6 to 12 digits standing alone in the
 *   subject, else one within a few characters after the word "code" in the body (plain text, else
 *   the HTML's text); never digits inside an address;
 * - the link: Gmail's verify link, an https `/mail/vf-` address on Gmail's own hosts
 *   (`mail.google.com`, `mail-settings.google.com`, or a subdomain of either), found in the plain
 *   text, else anywhere in the HTML's markup, without a sentence's closing mark. Never its cancel
 *   (`/mail/uf-`) link or any other.
 *
 * Anyone can forge a From line, but what is read only goes to the address's own owner, who asked
 * Gmail for it.
 */
export function forwardingConfirmation(mail: MailMessage): ForwardingConfirmation | null {
  if (!fromGoogle(mail.from)) return null;
  const leading = /^\(#(\d{6,12})\)/.exec(mail.subject)?.[1] ?? null;
  const body = bodyText(mail);
  if (!leading && !/forwarding/i.test(mail.subject) && !/forward/i.test(body)) return null;
  // An address (the requester's, or the alert address) may hold digits that are not the code.
  const subject = withoutAddresses(mail.subject.slice(0, 500));
  const code =
    leading ??
    /(?:^|[\s#(])(\d{6,12})(?=$|[\s).,:;])/.exec(subject)?.[1] ??
    /\bcode\b\D{0,40}?(?<![\w.@/=%?&#:-])(\d{6,12})(?!\d)/i.exec(withoutAddresses(body))?.[1] ??
    null;
  const link = gmailLink(mail.text ?? "") ?? (mail.html !== null ? gmailLink(decodedHtmlLinks(mail.html)) : null);
  return code || link ? { code, link } : null;
}

/** The code alone, as 0.25.0 and 0.26.0 read it (kept for the tests). */
export function forwardingCode(mail: MailMessage): string | null {
  return forwardingConfirmation(mail)?.code ?? null;
}

/** A string's shape for the log: letters `a`, digits `9`, everything else kept, capped. */
function shape(s: string): string {
  return s.replace(/\p{L}/gu, "a").replace(/\p{N}/gu, "9").replace(/[^\x20-\x7e]/g, "?").slice(0, 160);
}

/** A subject's shape, with each address in it only `<addr>`: no address's length reaches the log. */
function subjectShape(subject: string): string {
  return subject.slice(0, 500).split(/\s+/).map((w) => (w.includes("@") ? "<addr>" : shape(w))).join(" ").slice(0, 160);
}

/** What a message that did nothing was, for the log: never its words or its sender's name. */
export function ignoredWhy(mail: MailMessage): string {
  // Google's no-reply system senders (the confirmation's own, when it goes unread) are named whole;
  // anyone else only by their domain, so no person's name reaches the log.
  const system = mail.from !== null && fromGoogle(mail.from) && /^[a-z-]*no-?reply$/.test(mail.from.slice(0, mail.from.lastIndexOf("@")));
  const domain = mail.from ? (system ? mail.from : mail.from.slice(mail.from.lastIndexOf("@") + 1)) : "none";
  const parts = [mail.html !== null ? "html" : "", mail.text !== null ? "text" : ""].filter(Boolean).join("+") || "no body";
  const base = `from ${domain.replace(/[^a-z0-9.@-]/g, "?").slice(0, 100)}, ${parts}, subject ${/forwarding/i.test(mail.subject) ? "names" : "does not name"} forwarding`;
  if (!system) return base;
  // From Google's own system senders only: the subject's shape (no letters or digits survive) and
  // counts from the body as the reader sees it, so the next unread confirmation says what it was.
  const body = bodyText(mail);
  const runs = (body.match(/\d{6,12}/g) ?? []).length;
  const links = (body.match(/https:\/\/[a-z0-9.-]{1,253}/gi) ?? []).length;
  return `${base}, subject shape "${subjectShape(mail.subject)}", body ${body.length} chars, ${runs} digit run(s), ${links} https link(s), says code: ${/code/i.test(body) ? "yes" : "no"}`;
}

/**
 * Words from a stranger's mail made safe for a DM: no markdown, mentions or links, one line,
 * capped. The marks taken out are the ones `sameSearch` ignores, so a watch made with these words
 * matches the alert they came from.
 */
function quoted(words: string): string {
  // With `:` and `/` gone no address survives for Discord to link.
  return words.replace(SEARCH_MARKS, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

export type MailOutcome =
  | { kind: "confirmation" }
  | { kind: "stored"; watches: number; listings: number }
  | { kind: "unmatched" }
  | { kind: "ignored"; why: string };

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
  if (!user || !d.admissions.isRegistered(user.id) || !d.inbox) return { kind: "ignored", why: "the owner is not registered" };
  const confirm = forwardingConfirmation(mail);
  if (confirm) {
    const how = [
      confirm.code ? `The confirmation code is ${confirm.code}: enter it in Gmail's Settings, under Forwarding and POP/IMAP.` : "",
      confirm.link ? `${confirm.code ? "Or open" : "Open"} Gmail's confirmation link: <${confirm.link}>` : "",
    ].filter(Boolean).join(" ");
    await tell(d, user.id, `Gmail asks to confirm forwarding to your alert address. ${how} If you did not ask for this, ignore it.`);
    return { kind: "confirmation" };
  }
  const alert = readEbayAlert(mail);
  if (!alert) return { kind: "ignored", why: ignoredWhy(mail) };
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
