import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { makeFakeHost } from "../../../../packages/testkit/index.js";
import pkg from "../../package.json" with { type: "json" };
import { type Membership, NOT_ADMITTED } from "../access.js";
import { createPlugin } from "../index.js";
import { lookupMembership } from "../discord-common.js";
import { LEFT_SERVER, lookupWithin, MEMBER_GRACE_MS, MEMBER_RECHECK_MS, MEMBER_RETRY_MS, RECHECK_FAILED } from "./app.js";
import { WEB_NOT_CONFIGURED } from "./command.js";
import { parseWebUrl, WEB_URL_FORMAT } from "./config.js";
import { esc, html } from "./html.js";
import { sha256 } from "./secrets.js";
import { STYLESHEET_PATH } from "./theme.js";

/**
 * The web area's first slice (rackbops-bot-plugins#80), through the plugin's own `http` handler and
 * slash commands with a fake host: sign-in by one-time link, sessions, CSRF and Origin checks, the
 * pages, and escaping. No server: each request is a `Request` handed to `plugin.http`.
 */

import {
  ADMIN,
  api,
  call,
  cleanup,
  csrfOf,
  CURLY,
  GUILD,
  GUILD_B,
  hidden,
  type Jar,
  LARRY,
  LOGIN,
  makeToken,
  openLink,
  ORIGIN,
  people,
  SESSION,
  signIn,
  slash,
  STRANGER,
  tokenOf,
  type WebLookup,
  world,
} from "./harness.js";

afterEach(cleanup);

describe("TRACKER_WEB_URL", () => {
  it("takes a bare https origin and nothing else, and matches the manifest's format", () => {
    expect(parseWebUrl(undefined)).toBeNull();
    expect(parseWebUrl(" ")).toBeNull();
    expect(parseWebUrl("https://clerk.example.com")).toBe("https://clerk.example.com");
    expect(parseWebUrl("https://clerk.example.com/")).toBe("https://clerk.example.com");
    expect(parseWebUrl("https://clerk.example.com:8443")).toBe("https://clerk.example.com:8443");
    for (const bad of ["http://clerk.example.com", "https://clerk.example.com/tracker", "https://clerk.example.com/?a=1", "https://u:p@clerk.example.com", "clerk.example.com"]) {
      expect(() => parseWebUrl(bad)).toThrow("TRACKER_WEB_URL");
    }
    const declared = pkg.botPlugin.env.find((e) => e.key === "TRACKER_WEB_URL");
    expect(declared?.format).toBe(WEB_URL_FORMAT);
    expect(declared?.secret).toBe(false);
    expect(() => createPlugin(makeFakeHost({ name: "tracker", env: { TRACKER_WEB_URL: "http://clerk.example.com" } }))).toThrow("TRACKER_WEB_URL");
  });

  it("unset: /web says the web area is not set up, and every page is 404", async () => {
    const { plugin } = await world({ webUrl: null });
    await people(plugin);
    expect(await slash(plugin, "web", LARRY)).toBe(WEB_NOT_CONFIGURED);
    expect((await call(plugin, "GET", "/")).status).toBe(404);
    expect((await call(plugin, "GET", "/login?t=x")).status).toBe(404);
    expect((await call(plugin, "GET", "/healthz")).status).toBe(200);
  });
});

describe("sign-in by one-time link", () => {
  it("/web passes the gates and answers a link on TRACKER_WEB_URL, never the request's host", async () => {
    const { plugin, dbPath } = await world();
    await people(plugin);
    expect(await slash(plugin, "web", STRANGER)).toBe(NOT_ADMITTED);
    const answer = await slash(plugin, "web", LARRY);
    expect(answer).toContain("works once, within 10 minutes");
    const token = tokenOf(answer);
    // Only the hash is stored.
    const db = new Database(dbPath, { readonly: true });
    const rows = db.query("SELECT token_hash FROM web_login_tokens").all() as { token_hash: string }[];
    expect(rows.map((r) => r.token_hash)).toEqual([sha256(token)]);
    db.close();
  });

  it("opening the link does not use it; the Sign in post does, once, and sets the session cookie", async () => {
    const { plugin } = await world();
    await people(plugin);
    const token = tokenOf(await slash(plugin, "web", LARRY));
    const jar: Jar = new Map();
    // A preview, a prefetch, the person: three opens, nothing used up.
    await openLink(plugin, token, new Map());
    await openLink(plugin, token, new Map());
    const opened = await openLink(plugin, token, jar);
    expect(opened.res.status).toBe(200);
    expect(opened.res.headers.get("referrer-policy")).toBe("same-origin");
    expect(opened.res.headers.get("cache-control")).toBe("no-store");
    expect(opened.body).toContain(`action="/tracker/login"`);
    expect(opened.body).not.toContain("evil.example.net");
    // Never no-referrer: a browser would then send a form post's Origin as "null", which is refused.
    expect(opened.body).toContain('<meta name="referrer" content="same-origin">');
    expect(opened.res.headers.getSetCookie()[0]).toMatch(new RegExp(`^${LOGIN}=[^;]+; Path=/tracker/; Max-Age=600; HttpOnly; Secure; SameSite=Strict$`));

    const res = await call(plugin, "POST", "/login", { jar, form: opened.form ?? {}, origin: ORIGIN });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/tracker/");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const cookies = res.headers.getSetCookie();
    expect(cookies[0]).toMatch(new RegExp(`^${SESSION}=[A-Za-z0-9_-]{43}; Path=/tracker/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$`));
    expect(cookies[1]).toContain(`${LOGIN}=; Path=/tracker/; Max-Age=0`);

    const home = await call(plugin, "GET", "/", { jar });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("My tasks");

    // Used: the page says so, and posting it again (with a fresh page cookie) fails.
    const again = await openLink(plugin, token, new Map());
    expect(again.form).toBeNull();
    expect(again.body).toContain("expired or was already used");
    const jar2: Jar = new Map([[LOGIN, "x".repeat(43)]]);
    const replay = await call(plugin, "POST", "/login", { jar: jar2, form: { t: token, csrf: "x".repeat(43) }, origin: ORIGIN });
    expect(replay.status).toBe(400);
    expect(jar2.has(SESSION)).toBe(false);
  });

  it("a link expires after ten minutes, opened or not", async () => {
    const { plugin, clock } = await world();
    await people(plugin);
    const token = tokenOf(await slash(plugin, "web", LARRY));
    const jar: Jar = new Map();
    const { form } = await openLink(plugin, token, jar);
    clock.advance(10 * 60 * 1000);
    expect((await openLink(plugin, token, new Map())).form).toBeNull();
    const res = await call(plugin, "POST", "/login", { jar, form: form ?? {}, origin: ORIGIN });
    expect(res.status).toBe(400);
    expect(jar.has(SESSION)).toBe(false);
  });

  it("the sign-in post needs the page's own cookie (no login CSRF) and a matching Origin", async () => {
    const { plugin } = await world();
    await people(plugin);
    const token = tokenOf(await slash(plugin, "web", LARRY));
    const jar: Jar = new Map();
    const { form } = await openLink(plugin, token, jar);
    // A cross-site page posting a token, without the victim's SameSite=Strict cookie.
    expect((await call(plugin, "POST", "/login", { form: form ?? {} })).status).toBe(403);
    expect((await call(plugin, "POST", "/login", { jar, form: { ...form, csrf: "y".repeat(43) } as Record<string, string> })).status).toBe(403);
    expect((await call(plugin, "POST", "/login", { jar, form: form ?? {}, origin: "https://evil.example.net" })).status).toBe(403);
    expect((await call(plugin, "POST", "/login", { jar, form: form ?? {}, origin: "null" })).status).toBe(403);
    // None of that used the link up.
    expect((await call(plugin, "POST", "/login", { jar, form: form ?? {}, origin: ORIGIN })).status).toBe(303);
  });

  it("a person no longer registered cannot use a link issued before", async () => {
    const { plugin, dbPath } = await world();
    await people(plugin);
    const token = tokenOf(await slash(plugin, "web", LARRY));
    const jar: Jar = new Map();
    const { form } = await openLink(plugin, token, jar);
    const db = new Database(dbPath);
    db.query("DELETE FROM admissions WHERE user_id = 'u2'").run();
    db.close();
    expect((await call(plugin, "POST", "/login", { jar, form: form ?? {}, origin: ORIGIN })).status).toBe(400);
    expect(jar.has(SESSION)).toBe(false);
  });
});

describe("sessions", () => {
  it("a request not signed in, to any page, is sent to the page that says to run /web", async () => {
    const { plugin } = await world();
    for (const path of ["/", "/settings", "/tasks/t1"]) {
      const res = await call(plugin, "GET", path);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/tracker/signin");
    }
    const help = await call(plugin, "GET", "/signin");
    expect(help.status).toBe(200);
    expect(await help.text()).toContain("<code>/web</code>");
    // A made-up session cookie is dropped.
    const jar: Jar = new Map([[SESSION, "z".repeat(43)]]);
    await call(plugin, "GET", "/", { jar });
    expect(jar.has(SESSION)).toBe(false);
  });

  it("a person taken off the tracker is signed out on their next request, every session", async () => {
    const { plugin, dbPath } = await world();
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    const other = await signIn(plugin, LARRY);
    expect((await call(plugin, "GET", "/", { jar })).status).toBe(200);
    const db = new Database(dbPath);
    db.query("DELETE FROM users WHERE seq = 2").run();
    const res = await call(plugin, "GET", "/", { jar });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/tracker/signin");
    expect(jar.has(SESSION)).toBe(false);
    expect((db.query("SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = 'u2'").get() as { n: number }).n).toBe(0);
    expect((await call(plugin, "GET", "/", { jar: other })).status).toBe(303);
    db.close();
  });

  it("a session lasts seven days", async () => {
    const { plugin, clock } = await world();
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    clock.advance(7 * 24 * 60 * 60 * 1000 - 1);
    expect((await call(plugin, "GET", "/", { jar })).status).toBe(200);
    clock.advance(1);
    expect((await call(plugin, "GET", "/", { jar })).status).toBe(303);
  });

  it("sign out is a POST with the CSRF token; it ends that session", async () => {
    const { plugin } = await world();
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    const csrf = await csrfOf(plugin, jar);
    expect((await call(plugin, "GET", "/logout", { jar })).status).toBe(405);
    expect((await call(plugin, "POST", "/logout", { jar: new Map(jar), form: { csrf: "" }, origin: ORIGIN })).status).toBe(403);
    const kept = new Map(jar);
    const res = await call(plugin, "POST", "/logout", { jar, form: { csrf }, origin: ORIGIN });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/tracker/signin?out=1");
    expect(jar.has(SESSION)).toBe(false);
    expect((await call(plugin, "GET", "/", { jar: kept })).status).toBe(303);
  });
});

describe("membership re-check (TRACKER_GUILD_ID set)", () => {
  /** A web lookup that answers `answer()` and counts its calls. */
  function lookup(answer: () => Promise<Membership | null>) {
    const calls: string[] = [];
    const fn: WebLookup = (id) => {
      calls.push(id);
      return answer();
    };
    return { fn, calls };
  }

  it("sign-in carries /web's confirmation: no lookup for 15 minutes", async () => {
    const l = lookup(async () => "member");
    const { plugin, clock } = await world({ guild: true, webMembership: l.fn });
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    clock.advance(MEMBER_RECHECK_MS - 1);
    expect((await call(plugin, "GET", "/", { jar })).status).toBe(200);
    expect(l.calls).toEqual([]);
  });

  it("a member is re-confirmed after 15 minutes, and not asked again for another 15", async () => {
    const l = lookup(async () => "member");
    const { plugin, clock } = await world({ guild: true, webMembership: l.fn });
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    clock.advance(MEMBER_RECHECK_MS);
    expect((await call(plugin, "GET", "/", { jar })).status).toBe(200);
    expect(l.calls).toEqual([LARRY]);
    clock.advance(MEMBER_RECHECK_MS - 1);
    expect((await call(plugin, "GET", "/", { jar })).status).toBe(200);
    expect(l.calls).toHaveLength(1);
  });

  it("someone who left the server is signed out of every session, on a page that says why", async () => {
    let answer: Membership = "member";
    const l = lookup(async () => answer);
    const { plugin, clock } = await world({ guild: true, webMembership: l.fn });
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    const other = await signIn(plugin, LARRY);
    clock.advance(MEMBER_RECHECK_MS);
    answer = "not-member";
    const res = await call(plugin, "GET", "/", { jar });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(LEFT_SERVER.replaceAll("'", "&#39;"));
    expect(jar.has(SESSION)).toBe(false);
    answer = "member";
    expect((await call(plugin, "GET", "/", { jar: other })).status).toBe(303);
    // A POST is refused the same way, before its form is read.
    const third = await signIn(plugin, LARRY);
    const csrf = await csrfOf(plugin, third);
    clock.advance(MEMBER_RECHECK_MS);
    answer = "not-member";
    expect((await call(plugin, "POST", "/settings", { jar: third, form: { hour: "5", zone: "UTC", csrf }, origin: ORIGIN })).status).toBe(403);
    expect(await slash(plugin, "tasks", LARRY)).toBe("You have no active tasks.");
  });

  it("a failed lookup, or no Discord client yet, lets them on for 24 hours from the last confirmation, then signs them out", async () => {
    let answer: () => Promise<Membership | null> = async () => null;
    const l = lookup(() => answer());
    const { plugin, clock } = await world({ guild: true, webMembership: l.fn });
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    clock.advance(MEMBER_RECHECK_MS);
    expect((await call(plugin, "GET", "/", { jar })).status).toBe(200); // no client yet
    answer = async () => "unknown";
    clock.advance(MEMBER_RETRY_MS);
    expect((await call(plugin, "GET", "/", { jar })).status).toBe(200); // not confirmed, so asked again
    answer = async () => {
      throw new Error("discord is down");
    };
    clock.advance(MEMBER_RETRY_MS);
    expect((await call(plugin, "GET", "/", { jar })).status).toBe(200);
    expect(l.calls).toHaveLength(3);
    clock.advance(MEMBER_GRACE_MS - MEMBER_RECHECK_MS - 2 * MEMBER_RETRY_MS);
    const res = await call(plugin, "GET", "/", { jar });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(RECHECK_FAILED.replaceAll("'", "&#39;"));
    expect(jar.has(SESSION)).toBe(false);
  });

  it("after a failed lookup, that person is not looked up again for a minute (served under the grace rule)", async () => {
    const l = lookup(async () => "unknown");
    const { plugin, clock } = await world({ guild: true, webMembership: l.fn });
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    clock.advance(MEMBER_RECHECK_MS);
    for (let i = 0; i < 5; i++) expect((await call(plugin, "GET", "/", { jar })).status).toBe(200);
    expect(l.calls).toHaveLength(1);
    clock.advance(MEMBER_RETRY_MS - 1);
    await call(plugin, "GET", "/", { jar });
    expect(l.calls).toHaveLength(1);
    clock.advance(1);
    await call(plugin, "GET", "/", { jar });
    expect(l.calls).toHaveLength(2);
  });

  it("concurrent requests share one lookup", async () => {
    let release: (m: Membership) => void = () => {};
    const l = lookup(() => new Promise<Membership>((resolve) => (release = resolve)));
    const { plugin, clock } = await world({ guild: true, webMembership: l.fn });
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    clock.advance(MEMBER_RECHECK_MS);
    const pending = [call(plugin, "GET", "/", { jar }), call(plugin, "GET", "/settings", { jar }), call(plugin, "GET", "/", { jar })];
    await Bun.sleep(5);
    expect(l.calls).toHaveLength(1);
    release("member");
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([200, 200, 200]);
  });

  it("a session deleted while its lookup waited is not acted on", async () => {
    let release: (m: Membership) => void = () => {};
    const l = lookup(() => new Promise<Membership>((resolve) => (release = resolve)));
    const { plugin, clock, dbPath } = await world({ guild: true, webMembership: l.fn });
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    const csrf = await csrfOf(plugin, jar);
    clock.advance(MEMBER_RECHECK_MS);
    const pending = call(plugin, "POST", "/settings", { jar, form: { hour: "5", zone: "UTC", csrf }, origin: ORIGIN });
    await Bun.sleep(5);
    const db = new Database(dbPath);
    db.query("DELETE FROM web_sessions").run();
    release("member");
    const res = await pending;
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/tracker/signin");
    expect(db.query("SELECT preferred_hour AS h, time_zone AS z FROM users WHERE seq = 2").get()).toEqual({ h: 9, z: "America/New_York" });
    db.close();
  });

  it("a confirmation time in the future (clock set back) is re-checked, not trusted", async () => {
    const l = lookup(async () => "unknown");
    const { plugin, clock } = await world({ guild: true, webMembership: l.fn });
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    clock.advance(-60 * 60 * 1000);
    const res = await call(plugin, "GET", "/", { jar });
    expect(l.calls).toEqual([LARRY]);
    // Not a fresh confirmation, so not within the grace either: signed out.
    expect(res.status).toBe(403);
  });

  it("the member lookup asks Discord, never discord.js's cache: a cached member who left is not a member", async () => {
    const cached = new Set([LARRY]);
    const client = {
      guilds: {
        fetch: async () => ({
          members: {
            fetch: async (o: { user: string; force?: boolean }) => {
              if (!o.force && cached.has(o.user)) return { id: o.user };
              throw Object.assign(new Error("Unknown Member"), { code: 10007 });
            },
          },
        }),
      },
    };
    const log = { info() {}, warn() {}, error() {} };
    expect(await lookupMembership({ guildId: null, user: { id: LARRY }, client }, [GUILD], LARRY, log)).toBe("not-member");
  });

  it("a lookup that hangs counts as unknown after the timeout", async () => {
    expect(await lookupWithin(() => new Promise(() => {}), 20)).toBe("unknown");
    expect(await lookupWithin(async () => "member", 20)).toBe("member");
    expect(await lookupWithin(async () => null, 20)).toBeNull();
  });

  it("by default it asks through the Discord client of an interaction the plugin handled", async () => {
    const { plugin, clock } = await world({ guild: true });
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    const asked: string[] = [];
    const client = {
      guilds: {
        fetch: async (id: string) => ({
          members: {
            fetch: async (o: { user: string }) => {
              asked.push(`${id}/${o.user}`);
              throw Object.assign(new Error("Unknown Member"), { code: 10007 });
            },
          },
        }),
      },
    };
    await slash(plugin, "tasks", CURLY, { client });
    clock.advance(MEMBER_RECHECK_MS);
    expect((await call(plugin, "GET", "/", { jar })).status).toBe(403);
    expect(asked).toEqual([`${GUILD}/${LARRY}`]);
  });

  it("with two servers: a member of only one keeps the session; leaving both signs out and deletes API tokens", async () => {
    const { plugin, clock, dbPath, sent } = await world({ guild: `${GUILD},${GUILD_B}` });
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    const token = await makeToken({ plugin, sent }, jar);
    const members: Record<string, Set<string>> = { [GUILD]: new Set(), [GUILD_B]: new Set([LARRY]) };
    const asked: string[] = [];
    const client = {
      guilds: {
        fetch: async (id: string) => ({
          members: {
            fetch: async (o: { user: string; force?: boolean }) => {
              asked.push(`${id}/${o.user}/${o.force === true}`);
              if (members[id]?.has(o.user)) return { id: o.user };
              throw Object.assign(new Error("Unknown Member"), { code: 10007 });
            },
          },
        }),
      },
    };
    await slash(plugin, "tasks", CURLY, { client });
    clock.advance(MEMBER_RECHECK_MS);
    expect((await call(plugin, "GET", "/", { jar })).status).toBe(200);
    expect(asked.sort()).toEqual([`${GUILD_B}/${LARRY}/true`, `${GUILD}/${LARRY}/true`]);
    members[GUILD_B]?.delete(LARRY);
    clock.advance(MEMBER_RECHECK_MS);
    expect((await call(plugin, "GET", "/", { jar })).status).toBe(403);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query("SELECT seq FROM api_tokens").all()).toEqual([]);
      expect(db.query("SELECT id_hash FROM web_sessions").all()).toEqual([]);
    } finally {
      db.close();
    }
    expect((await api(plugin, "GET", "/me", { token })).status).toBe(401);
  });

  it("with no gate, nothing is looked up, however old the session", async () => {
    const l = lookup(async () => "not-member");
    const { plugin, clock } = await world({ webMembership: l.fn });
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    clock.advance(7 * 24 * 60 * 60 * 1000 - 1);
    expect((await call(plugin, "GET", "/", { jar })).status).toBe(200);
    expect(l.calls).toEqual([]);
  });
});

describe("pages", () => {
  it("my tasks: owned and received, next run in the viewer's zone, each linking to its history; text escaped", async () => {
    const { plugin } = await world();
    await people(plugin);
    await slash(plugin, "remind", LARRY, { strings: { text: `<script>alert("x")</script> & water`, when: "tomorrow 9am" } });
    const jar = await signIn(plugin, LARRY);
    const res = await call(plugin, "GET", "/", { jar });
    const body = await res.text();
    expect(body).toContain(`<a class="rb-link" href="/tracker/tasks/t1">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; water</a>`);
    expect(body).not.toContain("<script>");
    expect(body).toContain("Fri Oct 2, 9:00");
    expect(body).toContain("America/New_York");
    expect(body).toContain("An admin of this tracker can see every task");
    expect(body).toContain('data-rb-style="rackbops-noir"');
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'self'; img-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("history: the owner and an admin see it; anyone else, and an unknown id, get the same 404", async () => {
    const { plugin } = await world();
    await people(plugin);
    await slash(plugin, "remind", LARRY, { strings: { text: "<b>feed</b> the cat", when: "in 20 minutes" } });
    const larry = await signIn(plugin, LARRY);
    const owned = await call(plugin, "GET", "/tasks/t1", { jar: larry });
    expect(owned.status).toBe(200);
    const body = await owned.text();
    expect(body).toContain("<h1>&lt;b&gt;feed&lt;/b&gt; the cat</h1>");
    expect(body).toContain("created");
    expect((await call(plugin, "GET", "/tasks/t1", { jar: await signIn(plugin, ADMIN) })).status).toBe(200);

    const curly = await signIn(plugin, CURLY);
    const stranger = await call(plugin, "GET", "/tasks/t1", { jar: curly });
    const unknown = await call(plugin, "GET", "/tasks/t999", { jar: curly });
    const junk = await call(plugin, "GET", "/tasks/%E0%A4%A", { jar: curly });
    expect(stranger.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(junk.status).toBe(404);
    expect(await stranger.text()).toBe(await unknown.text());
  });

  it("settings: shows the hour and zone, saves a valid change, refuses a bad one with the reason", async () => {
    const { plugin } = await world();
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    const page = await (await call(plugin, "GET", "/settings", { jar })).text();
    expect(page).toContain('<option value="9" selected>09:00</option>');
    expect(page).toContain('value="America/New_York"');
    const csrf = hidden(page, "csrf");

    for (const [form, reason] of [
      [{ hour: "24", zone: "Europe/London" }, "whole hour from 0 to 23"],
      [{ hour: "7.5", zone: "Europe/London" }, "whole hour from 0 to 23"],
      [{ hour: "7", zone: "Mars/Olympus" }, "is not a time zone"],
      [{ hour: "7", zone: "" }, "Give a time zone"],
    ] as const) {
      const res = await call(plugin, "POST", "/settings", { jar, form: { ...form, csrf }, origin: ORIGIN });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(reason);
    }
    const saved = await call(plugin, "POST", "/settings", { jar, form: { hour: "7", zone: "Europe/London", csrf }, origin: ORIGIN });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/tracker/settings?saved=1");
    const after = await (await call(plugin, "GET", "/settings?saved=1", { jar })).text();
    expect(after).toContain("Saved.");
    expect(after).toContain('<option value="7" selected>07:00</option>');
    expect(after).toContain('value="Europe/London"');
    expect(await slash(plugin, "tasks", LARRY)).toBe("You have no active tasks.");
  });

  it("a state change needs the session's CSRF token and, when an Origin is sent, this one", async () => {
    const { plugin } = await world();
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    const csrf = await csrfOf(plugin, jar);
    const form = { hour: "6", zone: "America/New_York" };
    expect((await call(plugin, "POST", "/settings", { jar, form, origin: ORIGIN })).status).toBe(403);
    expect((await call(plugin, "POST", "/settings", { jar, form: { ...form, csrf: `${csrf.slice(0, -1)}${csrf.endsWith("A") ? "B" : "A"}` }, origin: ORIGIN })).status).toBe(403);
    // Another person's token is not this session's.
    const curlyCsrf = await csrfOf(plugin, await signIn(plugin, CURLY));
    expect((await call(plugin, "POST", "/settings", { jar, form: { ...form, csrf: curlyCsrf }, origin: ORIGIN })).status).toBe(403);
    expect((await call(plugin, "POST", "/settings", { jar, form: { ...form, csrf }, origin: "https://evil.example.net" })).status).toBe(403);
    expect((await call(plugin, "POST", "/settings", { jar, form: { ...form, csrf }, origin: "https://clerk.example.com.evil.example.net" })).status).toBe(403);
    // No Origin at all (an older browser) falls back to the token alone.
    expect((await call(plugin, "POST", "/settings", { jar, form: { ...form, csrf } })).status).toBe(303);
  });

  it("the stylesheet is the rackbops-noir theme at a hashed path, cached for a year", async () => {
    const { plugin } = await world();
    expect(STYLESHEET_PATH).toMatch(/^\/assets\/theme\.[0-9a-f]{16}\.css$/);
    const res = await call(plugin, "GET", STYLESHEET_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const css = await res.text();
    expect(css).toContain('[data-rb-style="rackbops-noir"]');
    expect(css).toContain(".rb-btn");
    expect((await call(plugin, "GET", "/signin")).headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await (await call(plugin, "GET", "/signin")).text()).toContain(`href="/tracker${STYLESHEET_PATH}"`);
    expect((await call(plugin, "GET", "/assets/theme.0000000000000000.css")).status).toBe(404);
  });

  it("an unknown path is 404; a method other than GET or POST is 405, and so is the wrong one of those", async () => {
    const { plugin } = await world();
    await people(plugin);
    const jar = await signIn(plugin, LARRY);
    expect((await call(plugin, "GET", "/nope", { jar })).status).toBe(404);
    expect((await call(plugin, "GET", "/tasks/t1/edit", { jar })).status).toBe(404);
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const res = await call(plugin, method, "/", { jar });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, POST");
    }
    expect((await call(plugin, "POST", "/", { jar, form: {}, origin: ORIGIN })).status).toBe(405);
    expect((await call(plugin, "POST", STYLESHEET_PATH, { form: {}, origin: ORIGIN })).status).toBe(405);
  });
});

describe("escaping", () => {
  it("escapes every interpolated value, and only once", () => {
    expect(esc(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
    const inner = html`<b>${"<i>"}</b>`;
    expect(html`<p>${inner}${["<", 1]}${null}${false}</p>`.value).toBe("<p><b>&lt;i&gt;</b>&lt;1</p>");
  });
});
