import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { Plugin } from "../../../packages/api/contract.js";
import worker from "../mail-worker/worker.js";
import { readEbayAlert, sameSearch } from "./ebay-alert.js";
import { forwardingCode, ignoredWhy, MailAddresses, parseMailConfig } from "./mail.js";
import { decodeWords, parseMail } from "./mime.js";
import { MIGRATIONS, migrate } from "./schema.js";
import { query } from "./web/execute-harness.js";
import { CURLY, call, cleanup, csrfOf, LARRY, ORIGIN, people, signIn, slash, world } from "./web/harness.js";
import { MAX_MAIL_BYTES } from "./web/mail-inbound.js";

/**
 * The alert-email route (tracker 0.25.0): eBay's saved-search alerts, forwarded to a person's alert
 * address, reach their eBay watches. The fixture is the first real alert (2026-10-13) with its
 * tracking parameters and account names taken out.
 */

afterEach(cleanup);

const FIXTURE = readFileSync(new URL("./fixtures/ebay-saved-search-alert.eml", import.meta.url));
const DOMAIN = "alerts.example.com";
const KEY = "k".repeat(40);
const MAIL_ENV = { TRACKER_MAIL_DOMAIN: DOMAIN, TRACKER_MAIL_KEY: KEY };
const ADDRESS = /\b(m-[0-9a-f]{24}@alerts\.example\.com)\b/;
const pollTick = (p: Plugin) => p.ticks!.find((t) => t.name === "poll")!.run(new AbortController().signal);
type Sent = { userId: string; message: unknown }[];
const contents = (sent: Sent) => sent.map((s) => String((s.message as { content?: unknown }).content ?? ""));

const enc = (s: string) => new TextEncoder().encode(s);

function inbound(plugin: Plugin, to: string, body: Uint8Array | string, key = KEY): Promise<Response> {
  const request = new Request("https://evil.example.net/tracker/mail/inbound", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "message/rfc822", "x-envelope-to": to },
    body: typeof body === "string" ? body : new Uint8Array(body),
  });
  return plugin.http!(request, { path: "/mail/inbound", clientIp: "unknown" });
}

function gmailConfirmation(to: string): string {
  return [
    "From: Gmail Team <forwarding-noreply@google.com>",
    `To: ${to}`,
    "Subject: (#123456789) Gmail Forwarding Confirmation - Receive Mail from someone@gmail.com",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "someone@gmail.com has requested to automatically forward mail to your email address.",
    "Confirmation code: 123456789",
    "",
  ].join("\r\n");
}

describe("parseMail", () => {
  it("reads the real alert: its sender, its subject and its quoted-printable HTML", () => {
    const m = parseMail(FIXTURE);
    expect(m.from).toBe("ebay@ebay.com");
    expect(m.subject).toBe("wingspan oceania expansion: Only 1 match");
    expect(m.html).toContain("Wingspan Board Game Wooden Component Up\u2026");
    expect(m.html).not.toContain("=3D");
    expect(m.text).toBeNull();
  });

  it("finds both bodies in nested multipart, decodes base64 and encoded words, and skips attachments", () => {
    const html = Buffer.from("<p>caf\u00e9 \u2013 html</p>").toString("base64");
    const raw = [
      "From: =?UTF-8?Q?eBay_Caf=C3=A9?= <Alerts@Ebay.CO.UK>",
      "Subject: =?UTF-8?B?Y2Fmw6k=?=",
      "  =?UTF-8?Q?_alert?=",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "preamble",
      "--outer",
      'Content-Type: multipart/alternative; boundary="inner"',
      "",
      "--inner",
      "Content-Type: text/plain; charset=iso-8859-1",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "caf=E9 =",
      "text",
      "--inner",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      html,
      "--inner--",
      "--outer",
      "Content-Type: text/html",
      "Content-Disposition: attachment; filename=x.html",
      "",
      "<p>attached</p>",
      "--outer--",
      "",
    ].join("\r\n");
    const m = parseMail(enc(raw));
    expect(m.from).toBe("alerts@ebay.co.uk");
    expect(m.subject).toBe("caf\u00e9 alert");
    expect(m.text).toBe("caf\u00e9 text");
    expect(m.html).toBe("<p>caf\u00e9 \u2013 html</p>");
  });

  it("gives less, never a throw, for what is not a message", () => {
    expect(parseMail(enc(""))).toEqual({ from: null, subject: "", html: null, text: "" });
    expect(parseMail(enc("Content-Type: multipart/mixed\r\n\r\nno boundary")).html).toBeNull();
    expect(decodeWords("=?nonsense?Q?x?=")).toBe("x");
    const quotedBoundary = 'Content-Type: multipart/alternative; boundary="a;b"\r\n\r\n--a;b\r\nContent-Type: text/html\r\n\r\n<p>x</p>\r\n--a;b--\r\n';
    expect(parseMail(enc(quotedBoundary)).html).toBe("<p>x</p>");
  });
});

describe("readEbayAlert", () => {
  it("takes the one match and its search from the real alert, and none of eBay's suggestions", () => {
    expect(readEbayAlert(parseMail(FIXTURE))).toEqual({
      search: "wingspan oceania expansion",
      listings: [{ title: "Wingspan Board Game Wooden Component Up\u2026", url: "https://www.ebay.com/itm/407286422177", price: "$39.00", currency: "USD" }],
    });
  });

  it("is null for mail not from eBay, and for an eBay mail with no match in it", () => {
    const m = parseMail(FIXTURE);
    expect(readEbayAlert({ ...m, from: "ebay@ebay.com.evil.example" })).toBeNull();
    expect(readEbayAlert({ ...m, from: "seller@example.com" })).toBeNull();
    expect(readEbayAlert({ ...m, html: "<p>Your order shipped</p>" })).toBeNull();
    // Only suggestions (the part from "You might also like" on): nothing is a match.
    const suggestions = (m.html ?? "").slice((m.html ?? "").search(/you might also like/i));
    expect(readEbayAlert({ ...m, html: suggestions })).toBeNull();
  });

  it("falls back to the subject's words, and takes several matches each once", () => {
    const item = (n: string, title: string, price: string) =>
      `<a href="https://www.ebay.co.uk/itm/${n}?mkevt=1&amp;recoId=${n}"><span><h3>${title}</h3></span></a><p class="price fs16">${price}</p>`;
    const html = `${item("123456789", "Oceania &amp; more", "\u00a312.50")}${item("123456789", "again", "\u00a31")}${item("223456789", "Asia", "")}<a href="https://www.ebay.co.uk/itm/323456789?_trkparms=x"><h3>Tracked</h3></a>`;
    const alert = readEbayAlert({ from: "ebay@ebay.co.uk", subject: "Wingspan: 2 new matches", html, text: null });
    expect(alert).toEqual({
      search: "Wingspan",
      listings: [
        { title: "Oceania & more", url: "https://www.ebay.co.uk/itm/123456789", price: "\u00a312.50", currency: "GBP" },
        { title: "Asia", url: "https://www.ebay.co.uk/itm/223456789" },
      ],
    });
  });

  it("takes only eBay's own domains, for the sender and for each item", () => {
    const item = (host: string) => `<a href="https://${host}/itm/123456789"><h3>Oceania</h3></a><p class="price">$30.00</p>`;
    const at = (from: string, host: string) => readEbayAlert({ from, subject: "oceania: 1 match", html: item(host), text: null });
    expect(at("ebay@ebay.com", "www.ebay.com")?.listings).toHaveLength(1);
    expect(at("ebay@reply.ebay.de", "www.ebay.de")?.listings[0]?.url).toBe("https://www.ebay.de/itm/123456789");
    for (const lookalike of ["ebay.com.de", "ebay.in.ua", "www.ebay.com.ai", "ebay.xyz", "ebay.co", "notebay.com"]) {
      expect(at(`ebay@${lookalike}`, "www.ebay.com")).toBeNull();
      expect(at("ebay@ebay.com", lookalike)).toBeNull();
    }
  });

  it("keeps a price's whole text and its currency, and the low end of a range", () => {
    const one = (price: string, host = "www.ebay.de") =>
      readEbayAlert({ from: "ebay@ebay.de", subject: "x: 1 match", html: `<a href="https://${host}/itm/123456789"><h3>T</h3></a><p class="price">${price}</p>`, text: null })?.listings[0];
    expect(one("EUR 1.234,56")).toMatchObject({ price: "EUR 1.234,56", currency: "EUR" });
    expect(one("1.234,56 \u20ac")).toMatchObject({ price: "1.234,56 \u20ac", currency: "EUR" });
    expect(one("C $12.00 to C $15.00", "www.ebay.ca")).toMatchObject({ price: "C $12.00", currency: "CAD" });
    expect(one("$39.00 to $44.00", "www.ebay.com")).toMatchObject({ price: "$39.00", currency: "USD" });
    expect(one("$39.00", "www.ebay.com.au")?.currency).toBeUndefined();
  });

  it("reads a title with inline tags and an item address with a slug", () => {
    const html = `<a href="https://www.ebay.com/itm/wingspan-oceania/123456789?x=1"><h3><b>New</b> Wingspan &amp; more</h3></a><p class="price">$30.00</p>`;
    expect(readEbayAlert({ from: "ebay@ebay.com", subject: "w: 1", html, text: null })?.listings).toEqual([
      { title: "New Wingspan & more", url: "https://www.ebay.com/itm/123456789", price: "$30.00", currency: "USD" },
    ]);
  });

  it("strips a forward's prefix from the subject's words", () => {
    const html = `<a href="https://www.ebay.com/itm/123456789"><h3>T</h3></a>`;
    expect(readEbayAlert({ from: "ebay@ebay.com", subject: "Fwd: Re: wingspan: 2 new matches", html, text: null })?.search).toBe("wingspan");
  });

  it("reads hostile HTML in bounded time", () => {
    const from = "ebay@ebay.com";
    const started = performance.now();
    expect(readEbayAlert({ from, subject: "x: 1", html: "<a ".repeat(80_000), text: null })).toBeNull();
    expect(readEbayAlert({ from, subject: "x: 1", html: '<a href="https://www.ebay.com/itm/1234567"><h3>'.repeat(8_000), text: null })).toBeNull();
    expect(readEbayAlert({ from, subject: "x: 1", html: `<a href="https://www.ebay.com/itm/1234567"${" x".repeat(200_000)}`, text: null })).toBeNull();
    expect(readEbayAlert({ from, subject: "x: 1", html: `<a href="https://${"<".repeat(1990)}">`.repeat(250), text: null })).toBeNull();
    // A title of nothing but `<`: read (it is text), once, and quickly.
    expect(readEbayAlert({ from, subject: "x: 1", html: `<a href="https://www.ebay.com/itm/1234567"><h3>${"<".repeat(1990)}</h3>`.repeat(200), text: null })?.listings).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("compares searches as eBay would", () => {
    expect(sameSearch(" Wingspan  Oceania Expansion", "wingspan oceania expansion")).toBe(true);
    expect(sameSearch("wingspan oceania", "wingspan oceania expansion")).toBe(false);
    expect(sameSearch("7 wonders (2nd edition)", "7 wonders 2nd edition")).toBe(true);
  });
});

describe("Gmail's forwarding confirmation", () => {
  it("gives its code only when it is from Gmail's forwarding address", () => {
    const m = parseMail(enc(gmailConfirmation("m-x@alerts.example.com")));
    expect(forwardingCode(m)).toBe("123456789");
    expect(forwardingCode({ ...m, from: "forwarding-noreply@google.com.evil.example" })).toBeNull();
    expect(forwardingCode({ ...m, subject: "Gmail Forwarding Confirmation" })).toBe("123456789");
  });

  it("reads it loosely: another Google sender, an HTML-only body, a code without brackets", () => {
    const html = "<p>roshne@gmail.com has requested to automatically forward mail to your address.</p><p>Confirmation code: <b>987654321</b></p>";
    expect(forwardingCode({ from: "noreply@accounts.google.com", subject: "Gmail Forwarding Confirmation", html, text: null })).toBe("987654321");
    expect(forwardingCode({ from: "forwarding-noreply@google.com", subject: "#123456789 Gmail Forwarding Confirmation", html: null, text: null })).toBe("123456789");
    expect(forwardingCode({ from: "forwarding-noreply@google.com", subject: "Your receipt", html: null, text: "Order 123456789" })).toBeNull();
    expect(forwardingCode({ from: "someone@example.com", subject: "(#123456789) Gmail Forwarding Confirmation", html: null, text: null })).toBeNull();
    // Gmail in another language: its subject still starts with the code.
    expect(forwardingCode({ from: "forwarding-noreply@google.com", subject: "(#123456789) Gmail-Weiterleitungsbest\u00e4tigung", html: null, text: "x" })).toBe("123456789");
    // An empty plain part does not hide the HTML.
    expect(forwardingCode({ from: "forwarding-noreply@google.com", subject: "Gmail Forwarding Confirmation", html: "<p>Confirmation code: 123456789</p>", text: "" })).toBe("123456789");
    // A quoted-printable soft break with white space before its line end.
    const qp = "From: forwarding-noreply@google.com\r\nSubject: Gmail Forwarding Confirmation\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nConfirmation code: 1234= \r\n56789\r\n";
    expect(forwardingCode(parseMail(enc(qp)))).toBe("123456789");
  });

  it("says why a message did nothing, without its words or a stranger's name", () => {
    expect(ignoredWhy({ from: "someone@example.com", subject: "Gmail forwarding? hello", html: null, text: "hi" })).toBe("from example.com, text, subject names forwarding");
    expect(ignoredWhy({ from: "forwarding-noreply@google.com", subject: "x", html: "<p>x</p>", text: null })).toBe("from forwarding-noreply@google.com, html, subject does not name forwarding");
    expect(ignoredWhy({ from: null, subject: "", html: null, text: null })).toBe("from none, no body, subject does not name forwarding");
    expect(ignoredWhy({ from: "jane.doe@google.com", subject: "x", html: null, text: "x" })).toBe("from google.com, text, subject does not name forwarding");
    expect(ignoredWhy({ from: "a@john_smith+secret", subject: "x", html: null, text: "x" })).toBe("from john?smith?secret, text, subject does not name forwarding");
  });
});

describe("parseMailConfig", () => {
  it("takes both or neither, and refuses a half-set, short or malformed one without echoing it", () => {
    expect(parseMailConfig({})).toBeNull();
    expect(parseMailConfig({ TRACKER_MAIL_DOMAIN: " ", TRACKER_MAIL_KEY: "" })).toBeNull();
    expect(parseMailConfig(MAIL_ENV)).toEqual({ domain: DOMAIN, key: KEY });
    expect(() => parseMailConfig({ TRACKER_MAIL_DOMAIN: DOMAIN })).toThrow("go together");
    expect(() => parseMailConfig({ TRACKER_MAIL_KEY: KEY })).toThrow("go together");
    expect(() => parseMailConfig({ ...MAIL_ENV, TRACKER_MAIL_KEY: "short-secret" })).toThrow("at least 32");
    expect(() => parseMailConfig({ ...MAIL_ENV, TRACKER_MAIL_DOMAIN: "Alerts.Example.com" })).not.toThrow("Alerts");
    expect(() => parseMailConfig({ ...MAIL_ENV, TRACKER_MAIL_DOMAIN: "localhost" })).toThrow("TRACKER_MAIL_DOMAIN");
  });
});

describe("migration 10", () => {
  it("adds mail_addresses and nothing else; one address per person, never shared", () => {
    const db = new Database(":memory:");
    for (let v = 0; v < 9; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v] as string);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
    const schema = () => db.query("SELECT type, name, sql FROM sqlite_master WHERE name != 'sqlite_sequence' ORDER BY name").all() as { name: string }[];
    const before = schema();
    expect(migrate(db)).toBe(9);
    expect(MIGRATIONS).toHaveLength(10);
    expect(schema().filter((s) => !s.name.includes("mail_addresses"))).toEqual(before);
    for (const id of ["1", "2"]) db.exec(`INSERT INTO users (discord_id, display_name, time_zone, preferred_hour, admin, created_at) VALUES ('${id}', 'x', 'UTC', 9, 0, 'now')`);
    const mail = new MailAddresses(db, DOMAIN);
    const at = new Date("2026-10-13T12:00:00.000Z");
    const a = mail.addressFor("u1", at) ?? "";
    expect(a).toMatch(ADDRESS);
    expect(mail.addressFor("u1", at)).toBe(a);
    expect(mail.addressFor("u2", at)).not.toBe(a);
    expect(mail.addressFor("u3", at)).toBeNull();
    expect(mail.addressFor("someone", at)).toBeNull();
    expect(mail.userOf(a)).toBe("u1");
    expect(mail.userOf(a.toUpperCase())).toBe("u1");
    expect(mail.userOf(a.replace(DOMAIN, "other.example.com"))).toBeNull();
    expect(mail.userOf("m-000000000000000000000000@alerts.example.com")).toBeNull();
    expect(mail.userOf("nonsense")).toBeNull();
  });
});

async function setup() {
  const w = await world({ env: MAIL_ENV });
  await people(w.plugin);
  return w;
}

/** Larry's eBay watch for the alert's words, and his alert address from the reply. */
async function watching(w: Awaited<ReturnType<typeof setup>>) {
  const made = await slash(w.plugin, "want", LARRY, { strings: { name: "Wingspan Oceania", source: "ebay", target: "Wingspan Oceania Expansion" } });
  const address = ADDRESS.exec(made)?.[1];
  if (!address) throw new Error(`no address in: ${made}`);
  return { made, address };
}

describe("POST /mail/inbound", () => {
  it("puts the alert's listings in the matching eBay watch's inbox, and the next look DMs them", async () => {
    const w = await setup();
    const { made, address } = await watching(w);
    expect(made).toContain("from eBay's saved-search alert emails");
    expect(made).toContain(`forward eBay's alerts to ${address}`);
    // The same address every time, and on the settings page.
    const again = await slash(w.plugin, "want", LARRY, { strings: { name: "Other", source: "ebay" } });
    expect(again).toContain(address);
    const page = await (await call(w.plugin, "GET", "/settings", { jar: await signIn(w.plugin, LARRY) })).text();
    expect(page).toContain(address);

    await pollTick(w.plugin);
    const before = w.sent.length;
    const res = await inbound(w.plugin, address, FIXTURE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "stored", watches: 1, listings: 1 });
    const rows = query<{ task_id: string; listing: string }>(w.dbPath, "SELECT task_id, listing FROM want_inbox");
    expect(rows.map((r) => r.task_id)).toEqual(["t1"]);
    expect(JSON.parse(rows[0]?.listing ?? "{}")).toEqual({ title: "Wingspan Board Game Wooden Component Up\u2026", url: "https://www.ebay.com/itm/407286422177", price: 39, currency: "USD" });
    expect(w.sent.length).toBe(before);

    w.clock.advance(3600_000);
    await pollTick(w.plugin);
    const dms = contents(w.sent.slice(before));
    expect(dms.some((c) => c.includes("Wingspan Board Game Wooden Component Up") && c.includes("https://www.ebay.com/itm/407286422177"))).toBe(true);
  });

  it("DMs Gmail's confirmation code, and says so when no watch has the alert's words", async () => {
    const w = await setup();
    const made = await slash(w.plugin, "want", CURLY, { strings: { name: "Root", source: "ebay" } });
    const address = ADDRESS.exec(made)?.[1] ?? "";
    const before = w.sent.length;
    expect(await (await inbound(w.plugin, address, gmailConfirmation(address))).json()).toEqual({ result: "confirmation" });
    expect(await (await inbound(w.plugin, address, FIXTURE)).json()).toEqual({ result: "unmatched" });
    const dms = contents(w.sent.slice(before));
    expect(dms[0]).toContain("The confirmation code is 123456789");
    expect(dms[1]).toContain('An eBay alert for "wingspan oceania expansion" reached me');
    expect(dms[1]).toContain("`/want name: wingspan oceania expansion source: ebay target: wingspan oceania expansion`");
    expect(query(w.dbPath, "SELECT * FROM want_inbox")).toEqual([]);
    // Anything else: nothing said, nothing kept.
    const other = "From: someone@example.com\r\nSubject: hello\r\n\r\nhi";
    expect(await (await inbound(w.plugin, address, other)).json()).toEqual({ result: "ignored" });
    expect(w.sent.length).toBe(before + 2);
  });

  it("feeds every live eBay watch with the words, paused ones too, and never a BGG or page watch", async () => {
    const w = await setup();
    const { address } = await watching(w);
    await slash(w.plugin, "want", LARRY, { strings: { name: "Again", source: "ebay", target: "wingspan  OCEANIA expansion" } });
    await slash(w.plugin, "want", LARRY, { strings: { name: "BGG", source: "bgg", target: "wingspan oceania expansion" } });
    await slash(w.plugin, "want", LARRY, { strings: { name: "Other words", source: "ebay", target: "wingspan asia" } });
    const jar = await signIn(w.plugin, LARRY);
    const csrf = await csrfOf(w.plugin, jar);
    expect((await call(w.plugin, "POST", "/tasks/t2/pause", { jar, form: { csrf }, origin: ORIGIN })).status).toBe(303);
    expect(await (await inbound(w.plugin, address, FIXTURE)).json()).toEqual({ result: "stored", watches: 2, listings: 1 });
    expect(query<{ task_id: string }>(w.dbPath, "SELECT task_id FROM want_inbox ORDER BY seq").map((r) => r.task_id).sort()).toEqual(["t1", "t2"]);
  });

  it("keeps the address on the settings page when a change is refused", async () => {
    const w = await setup();
    const { address } = await watching(w);
    const jar = await signIn(w.plugin, LARRY);
    const csrf = await csrfOf(w.plugin, jar);
    const bad = await call(w.plugin, "POST", "/settings", { jar, form: { csrf, hour: "25", zone: "UTC" }, origin: ORIGIN });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain(address);
  });

  it("refuses a wrong key, an unknown address and a message too big; is off without the settings", async () => {
    const w = await setup();
    const { address } = await watching(w);
    expect((await inbound(w.plugin, address, FIXTURE, "x".repeat(40))).status).toBe(401);
    expect((await inbound(w.plugin, address, FIXTURE, "")).status).toBe(401);
    expect((await inbound(w.plugin, "m-000000000000000000000000@alerts.example.com", FIXTURE)).status).toBe(404);
    expect((await inbound(w.plugin, address.replace("alerts.example.com", "elsewhere.example.com"), FIXTURE)).status).toBe(404);
    expect((await inbound(w.plugin, address, new Uint8Array(MAX_MAIL_BYTES + 1))).status).toBe(413);
    const get = await w.plugin.http!(new Request("https://x.example/tracker/mail/inbound"), { path: "/mail/inbound", clientIp: "unknown" });
    expect(get.status).toBe(405);
    expect(query(w.dbPath, "SELECT * FROM want_inbox")).toEqual([]);

    const off = await world();
    await people(off.plugin);
    const made = await slash(off.plugin, "want", LARRY, { strings: { name: "Wingspan Oceania", source: "ebay" } });
    expect(made).not.toMatch(ADDRESS);
    expect((await inbound(off.plugin, address, FIXTURE)).status).toBe(404);
  });

  it("forget-me deletes the address: mail to it then finds no one", async () => {
    const w = await setup();
    const { address } = await watching(w);
    const jar = await signIn(w.plugin, LARRY);
    const csrf = await csrfOf(w.plugin, jar);
    const done = await call(w.plugin, "POST", "/forget", { jar, form: { csrf, confirm: "yes", word: "forget" }, origin: ORIGIN });
    expect(done.status).toBe(303);
    expect(query(w.dbPath, "SELECT * FROM mail_addresses WHERE user_id = 'u2'")).toEqual([]);
    expect((await inbound(w.plugin, address, FIXTURE)).status).toBe(404);
  });
});

describe("the Email Worker", () => {
  const env = { CLERK_URL: "https://clerk.example.com/", CLERK_MAIL_KEY: KEY, ACCESS_CLIENT_ID: "id.access", ACCESS_CLIENT_SECRET: "secret" };
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function message(bytes: Uint8Array, size = bytes.byteLength) {
    const rejected: string[] = [];
    return {
      rejected,
      to: "m-abc@alerts.example.com",
      raw: new Response(new Uint8Array(bytes)).body as ReadableStream<Uint8Array>,
      rawSize: size,
      setReject: (reason: string) => void rejected.push(reason),
    };
  }

  it("posts the message as it came, with its bearer, Access's service token and the address", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const m = message(FIXTURE);
    await worker.email(m, env);
    expect(m.rejected).toEqual([]);
    expect(seen[0]?.url).toBe("https://clerk.example.com/tracker/mail/inbound");
    expect(seen[0]?.init.headers).toMatchObject({
      Authorization: `Bearer ${KEY}`,
      "CF-Access-Client-Id": "id.access",
      "CF-Access-Client-Secret": "secret",
      "X-Envelope-To": "m-abc@alerts.example.com",
    });
    expect(Buffer.from(seen[0]?.init.body as ArrayBuffer).equals(FIXTURE)).toBe(true);
  });

  it("refuses what the tracker does not take, a message too big, and an unreachable tracker", async () => {
    expect(worker.MAX_MAIL_BYTES).toBe(MAX_MAIL_BYTES);
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const m = message(FIXTURE);
    await worker.email(m, env);
    expect(m.rejected).toEqual(["No such address"]);
    // Access sending a browser to sign in (no service token) is a refusal too.
    globalThis.fetch = (async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
    const r = message(FIXTURE);
    await worker.email(r, env);
    expect(r.rejected).toEqual(["Clerk could not take this message (status 302)"]);
    expect(worker.refusal(503)).toBe("Clerk could not take this message (status 503)");
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("down");
    }) as unknown as typeof fetch;
    const big = message(enc("x"), MAX_MAIL_BYTES + 1);
    await worker.email(big, env);
    expect(big.rejected).toEqual(["Message too large"]);
    expect(called).toBe(false);
    const down = message(FIXTURE);
    await worker.email(down, env);
    expect(down.rejected).toEqual(["Clerk could not be reached"]);
  });
});
