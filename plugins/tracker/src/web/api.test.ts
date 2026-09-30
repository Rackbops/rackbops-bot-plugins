import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { Fetch, FetchResponse } from "@rackbops/docket-core";
import type { Plugin } from "../../../../packages/api/contract.js";
import type { Membership } from "../access.js";
import { MAX_PRICE_TASKS } from "../price.js";
import { FAILED_BURST, MAX_API_BYTES, RATE_BURST } from "./api.js";
import { MAX_TOKENS_PER_PERSON } from "./api-tokens.js";
import { NOT_FOUND_MESSAGE } from "./api-tasks.js";
import { MEMBER_GRACE_MS, MEMBER_RECHECK_MS } from "./app.js";
import { sha256 } from "./secrets.js";
import { MAX_CREATIONS_PER_HOUR, TOKEN_NOT_SENT, TOO_MANY_CREATED } from "./tokens.js";
import {
  ADMIN,
  api,
  call,
  cleanup,
  csrfOf,
  CURLY,
  type Jar,
  LARRY,
  makeToken,
  ORIGIN,
  people,
  SESSION,
  signIn,
  slash,
  type WebLookup,
  world,
} from "./harness.js";

/**
 * The JSON task API and its tokens (rackbops-bot-plugins#80, slice 4), through the plugin's own
 * `http` handler with a fake host: bearer tokens only (never the cookie), made and revoked on the
 * web, revoked by an admin, erased with their owner; each endpoint against the web editor or the
 * command that does the same; ownership (anyone else's task is the unknown task's 404); the caps;
 * and the gates on the request itself -- Origin, Content-Type, body size, method, rate.
 */

afterEach(cleanup);

const SHOP = "https://shop.example/widget";

function shop() {
  const s = { price: 100 as number | null };
  const fetch: Fetch = {
    async get(): Promise<FetchResponse> {
      if (s.price === null) return { status: 200, body: "<html><body>Out of stock</body></html>", headers: {} };
      const ld = { "@type": "Product", offers: { "@type": "Offer", price: s.price.toFixed(2), priceCurrency: "USD" } };
      return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(ld)}</script>`, headers: {} };
    },
  };
  return { s, fetch };
}

async function setup(opts: Parameters<typeof world>[0] = {}) {
  const store = shop();
  const w = await world({ fetch: store.fetch, ...opts });
  await people(w.plugin);
  const larry = await signIn(w.plugin, LARRY);
  const token = await makeToken(w, larry);
  return { ...w, larry, token, shop: store.s };
}

function form(plugin: Plugin, jar: Jar, csrf: string, path: string, fields: Record<string, string> = {}) {
  return call(plugin, "POST", path, { jar, form: { csrf, ...fields }, origin: ORIGIN });
}

function query<T>(dbPath: string, sql: string, ...params: (string | number)[]): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function snapshot(dbPath: string): string {
  const tables = query<{ name: string }>(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'api_tokens' ORDER BY name");
  return JSON.stringify(tables.map((t) => [t.name, query(dbPath, `SELECT * FROM ${t.name} ORDER BY rowid`)]));
}

/** A task row without its id, times or owner: what two ways of making the same task agree on. */
function shape(dbPath: string, seq: number) {
  const [row] = query<Record<string, unknown>>(dbPath, "SELECT type, title, config, state, schedule, status FROM tasks WHERE seq = ?", seq);
  const runs = query<{ due_at: string; status: string }>(dbPath, "SELECT due_at, status FROM occurrences WHERE task_id = ? ORDER BY seq", `t${seq}`);
  const events = query<{ kind: string; detail: string }>(dbPath, "SELECT kind, detail FROM task_events WHERE task_id = ? ORDER BY seq", `t${seq}`).map((e) =>
    e.kind === "schedule_changed" || e.kind === "created" ? e.kind : `${e.kind}: ${e.detail}`,
  );
  return { row, runs, events };
}

/** The refusal a web form page shows, as text: its alert's message, tags dropped, entities read. */
function alertText(page: string): string {
  const m = /role="alert"><p class="rb-alert__title">[^<]*<\/p><p>([\s\S]*?)<\/p><\/div>/.exec(page);
  if (!m?.[1]) throw new Error("no alert on the page");
  return m[1]
    .replace(/<[^>]+>/g, "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

describe("authentication", () => {
  it("no token, a wrong one, a malformed one, another scheme: 401 with a Bearer challenge; nothing is read or changed", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "bins", when: "9am" } });
    const before = snapshot(w.dbPath);
    const none = await api(w.plugin, "GET", "/tasks");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe('Bearer realm="tracker"');
    expect((await body(none)).error.code).toBe("unauthorized");
    const forged = `trk_${"A".repeat(43)}`;
    for (const headers of [{ authorization: `Bearer ${forged}` }, { authorization: "Bearer nonsense" }, { authorization: `Basic ${w.token}` }, { authorization: `Bearer ${w.token}x` }]) {
      const res = await api(w.plugin, "GET", "/tasks", { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
      expect(await body(res)).toEqual({ error: { code: "invalid_token", message: "That token is unknown, revoked or expired." } });
    }
    expect(snapshot(w.dbPath)).toBe(before);
    expect((await api(w.plugin, "GET", "/tasks", { token: w.token })).status).toBe(200);
  });

  it("the session cookie alone is not accepted, and does not help a wrong token", async () => {
    const w = await setup();
    expect(w.larry.has(SESSION)).toBe(true);
    const cookieOnly = await api(w.plugin, "GET", "/tasks", { jar: w.larry });
    expect(cookieOnly.status).toBe(401);
    expect((await body(cookieOnly)).error.code).toBe("unauthorized");
    expect((await api(w.plugin, "POST", "/tasks", { jar: w.larry, body: { type: "reminder", text: "x", when: "9am" } })).status).toBe(401);
    expect((await api(w.plugin, "GET", "/tasks", { jar: w.larry, token: `trk_${"B".repeat(43)}` })).status).toBe(401);
    expect(query(w.dbPath, "SELECT seq FROM tasks")).toEqual([]);
  });

  it("the store keeps only the token's SHA-256; the page shows it once", async () => {
    const w = await setup();
    const rows = query<Record<string, unknown>>(w.dbPath, "SELECT * FROM api_tokens");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(sha256(w.token));
    expect(JSON.stringify(rows)).not.toContain(w.token);
    const page = await (await call(w.plugin, "GET", "/tokens", { jar: w.larry })).text();
    expect(page).toContain("agent");
    expect(page).not.toContain(w.token);
  });

  it("a new token's secret goes by DM, never in the page; a failed DM deletes it and says so", async () => {
    const w = await setup();
    const csrf = await csrfOf(w.plugin, w.larry);
    const before = w.sent.length;
    const res = await form(w.plugin, w.larry, csrf, "/tokens", { name: "script", expiry: "30" });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Your new token is in your Discord DMs");
    expect(page).not.toMatch(/trk_[A-Za-z0-9_-]{43}/);
    const dms = w.sent.slice(before);
    expect(dms.map((m) => m.userId)).toEqual([LARRY]);
    const secret = /`(trk_[A-Za-z0-9_-]{43})`/.exec(String((dms[0]?.message as { content: string }).content))?.[1] as string;
    expect((await api(w.plugin, "GET", "/me", { token: secret })).status).toBe(200);
    // DMs closed: nothing is kept, nothing is shown, and the page says why.
    w.delivery.unreachable.add(LARRY);
    const count = query(w.dbPath, "SELECT seq FROM api_tokens").length;
    const failed = await form(w.plugin, w.larry, csrf, "/tokens", { name: "closed", expiry: "30" });
    expect(failed.status).toBe(400);
    const failedPage = await failed.text();
    expect(failedPage).toContain(TOKEN_NOT_SENT.replaceAll("'", "&#39;"));
    expect(failedPage).not.toMatch(/trk_[A-Za-z0-9_-]{43}/);
    expect(query(w.dbPath, "SELECT seq FROM api_tokens")).toHaveLength(count);
  });

  it("a revoked token is refused at once; revoking someone else's token is the unknown one's 404", async () => {
    const w = await setup();
    const curly = await signIn(w.plugin, CURLY);
    const curlyToken = await makeToken(w, curly, "curly-agent");
    const csrf = await csrfOf(w.plugin, w.larry);
    // Larry cannot revoke Curly's (k2); the answer is the unknown id's.
    const other = await form(w.plugin, w.larry, csrf, "/tokens/k2/revoke");
    const unknown = await form(w.plugin, w.larry, csrf, "/tokens/k99/revoke");
    expect(other.status).toBe(404);
    expect(await other.text()).toBe(await unknown.text());
    expect((await api(w.plugin, "GET", "/me", { token: curlyToken })).status).toBe(200);
    // CSRF and Origin guard the revoke, as every form.
    expect((await form(w.plugin, w.larry, "stale", "/tokens/k1/revoke")).status).toBe(403);
    expect((await call(w.plugin, "POST", "/tokens/k1/revoke", { jar: w.larry, form: { csrf }, origin: "https://evil.example.net" })).status).toBe(403);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(200);
    const done = await form(w.plugin, w.larry, csrf, "/tokens/k1/revoke");
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Revoked");
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(401);
  });

  it("an expired token is refused; every token expires, a year at most", async () => {
    const w = await setup(); // 90 days
    const year = await makeToken(w, w.larry, "year", "365");
    const month = await makeToken(w, w.larry, "month", "30");
    w.clock.advance(30 * 24 * 60 * 60 * 1000 - 1000);
    expect((await api(w.plugin, "GET", "/me", { token: month })).status).toBe(200);
    w.clock.advance(1000);
    expect((await api(w.plugin, "GET", "/me", { token: month })).status).toBe(401);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(200);
    w.clock.advance(60 * 24 * 60 * 60 * 1000);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(401);
    expect((await api(w.plugin, "GET", "/me", { token: year })).status).toBe(200);
    w.clock.advance(275 * 24 * 60 * 60 * 1000);
    expect((await api(w.plugin, "GET", "/me", { token: year })).status).toBe(401);
    expect(query(w.dbPath, "SELECT seq FROM api_tokens WHERE expires_at IS NULL")).toEqual([]);
  });

  it("last used is recorded at most once a minute", async () => {
    const w = await setup();
    const lastUsed = () => query<{ last_used_at: string | null }>(w.dbPath, "SELECT last_used_at FROM api_tokens WHERE seq = 1")[0]?.last_used_at;
    expect(lastUsed()).toBeNull();
    await api(w.plugin, "GET", "/me", { token: w.token });
    expect(lastUsed()).toBe("2026-10-01T12:00:00.000Z");
    w.clock.advance(59_000);
    await api(w.plugin, "GET", "/me", { token: w.token });
    expect(lastUsed()).toBe("2026-10-01T12:00:00.000Z");
    w.clock.advance(1000);
    await api(w.plugin, "GET", "/me", { token: w.token });
    expect(lastUsed()).toBe("2026-10-01T12:01:00.000Z");
  });

  it("/me says whose token it is; a token of an owner no longer registered is refused", async () => {
    const w = await setup();
    const me = await api(w.plugin, "GET", "/me", { token: w.token });
    expect(await body(me)).toEqual({
      user: { id: "u2", name: "Larry", timeZone: "America/New_York", preferredHour: 9 },
      token: { id: "k1", name: "agent", createdAt: "2026-10-01T12:00:00.000Z", expiresAt: "2026-12-30T12:00:00.000Z" },
    });
    const db = new Database(w.dbPath);
    db.query("UPDATE admissions SET registered_at = NULL WHERE user_id = 'u2'").run();
    db.close();
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(401);
    // Their tokens go, as their sessions do on the web.
    expect(query(w.dbPath, "SELECT seq FROM api_tokens")).toEqual([]);
  });

  it("a request carrying Origin -- any browser's -- is refused, same origin or not; no answer carries a CORS header", async () => {
    const w = await setup();
    const before = snapshot(w.dbPath);
    for (const origin of [ORIGIN, "https://evil.example.net", "null"]) {
      const res = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "reminder", text: "x", when: "9am" }, headers: { origin } });
      expect(res.status).toBe(403);
      expect((await body(res)).error.code).toBe("origin_refused");
    }
    const preflight = await api(w.plugin, "OPTIONS", "/tasks", { headers: { origin: "https://evil.example.net", "access-control-request-method": "POST" } });
    expect(preflight.status).toBe(403);
    expect(snapshot(w.dbPath)).toBe(before);
    const answers = [
      preflight,
      await api(w.plugin, "GET", "/tasks", { token: w.token }),
      await api(w.plugin, "GET", "/tasks"),
      await api(w.plugin, "OPTIONS", "/tasks", { token: w.token }),
    ];
    for (const res of answers) {
      for (const [k] of res.headers) expect(k.toLowerCase().startsWith("access-control-")).toBe(false);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(answers[3]?.status).toBe(405);
  });

  it("the log names a token by id, never by its secret", async () => {
    const logs: string[] = [];
    const w = await setup({ logs });
    await api(w.plugin, "GET", "/me", { token: w.token });
    await api(w.plugin, "GET", "/me", { token: `${w.token.slice(0, -1)}A` });
    const csrf = await csrfOf(w.plugin, w.larry);
    await form(w.plugin, w.larry, csrf, "/tokens/k1/revoke");
    expect(logs).toContain("u2 made API token k1");
    expect(logs).toContain("u2 revoked their API token k1");
    expect(logs.join("\n")).not.toContain(w.token.slice(4));
  });

  it("no web area, no API", async () => {
    const w = await world({ webUrl: null });
    expect((await api(w.plugin, "GET", "/me", { token: `trk_${"A".repeat(43)}` })).status).toBe(404);
  });

  it("rate limit: a burst per token, then 429 with Retry-After until it refills; another token is unaffected", async () => {
    const w = await setup();
    const second = await makeToken(w, w.larry, "second");
    for (let i = 0; i < RATE_BURST; i++) expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(200);
    const limited = await api(w.plugin, "GET", "/me", { token: w.token });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    expect((await body(limited)).error.code).toBe("rate_limited");
    // A limited request changes nothing, and makes nothing.
    expect((await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "reminder", text: "x", when: "9am" } })).status).toBe(429);
    expect(query(w.dbPath, "SELECT seq FROM tasks")).toEqual([]);
    expect((await api(w.plugin, "GET", "/me", { token: second })).status).toBe(200);
    w.clock.advance(1000);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(200);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(429);
  });
});

describe("failed lookups", () => {
  it("share one small global bucket: past it, 429; a valid token is unaffected", async () => {
    const w = await setup();
    const bad = (i: number) => `trk_${String(i).padStart(43, "A")}`;
    for (let i = 0; i < FAILED_BURST; i++) expect((await api(w.plugin, "GET", "/me", { token: bad(i) })).status).toBe(401);
    const limited = await api(w.plugin, "GET", "/me", { token: bad(99) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("2");
    expect((await api(w.plugin, "GET", "/me", { headers: { authorization: "Bearer junk" } })).status).toBe(429);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(200);
    w.clock.advance(2000);
    expect((await api(w.plugin, "GET", "/me", { token: bad(100) })).status).toBe(401);
  });
});

describe("membership (TRACKER_GUILD_ID set)", () => {
  function lookup() {
    const l = { answer: "member" as Membership | null, calls: 0 };
    const fn: WebLookup = async () => {
      l.calls++;
      return l.answer;
    };
    return { l, fn };
  }

  it("re-checked on the web's schedule; one who left loses every token and session", async () => {
    const { l, fn } = lookup();
    const w = await setup({ guild: true, webMembership: fn });
    w.clock.advance(MEMBER_RECHECK_MS - 1);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(200);
    expect(l.calls).toBe(0);
    w.clock.advance(1);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(200);
    expect(l.calls).toBe(1);
    w.clock.advance(MEMBER_RECHECK_MS);
    l.answer = "not-member";
    const left = await api(w.plugin, "GET", "/tasks", { token: w.token });
    expect(left.status).toBe(403);
    expect((await body(left)).error.code).toBe("not_member");
    l.answer = "member";
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(401);
    expect(query(w.dbPath, "SELECT seq FROM api_tokens")).toEqual([]);
    expect(query(w.dbPath, "SELECT id_hash FROM web_sessions")).toEqual([]);
  });

  it("the web finding someone gone deletes their API tokens too", async () => {
    const { l, fn } = lookup();
    const w = await setup({ guild: true, webMembership: fn });
    w.clock.advance(MEMBER_RECHECK_MS);
    l.answer = "not-member";
    expect((await call(w.plugin, "GET", "/", { jar: w.larry })).status).toBe(403);
    expect(query(w.dbPath, "SELECT seq FROM api_tokens")).toEqual([]);
    l.answer = "member";
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(401);
  });

  it("a lookup that keeps failing is let on for 24 hours from the last confirmation, then 503; the token is kept", async () => {
    const { l, fn } = lookup();
    const w = await setup({ guild: true, webMembership: fn });
    l.answer = "unknown";
    w.clock.advance(MEMBER_GRACE_MS - 1000);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(200);
    w.clock.advance(1000);
    const res = await api(w.plugin, "GET", "/me", { token: w.token });
    expect(res.status).toBe(503);
    expect((await body(res)).error.code).toBe("membership_unknown");
    l.answer = "member";
    w.clock.advance(60_000);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(200);
  });
});

describe("tokens on the web", () => {
  it("a name and an expiry from the offered ones; at most ten; the make form is a form like any other", async () => {
    const w = await setup();
    const csrf = await csrfOf(w.plugin, w.larry);
    const refused = async (fields: Record<string, string>, reason: string) => {
      const res = await form(w.plugin, w.larry, csrf, "/tokens", fields);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(reason);
    };
    await refused({ name: "  ", expiry: "90" }, "Give the token a name");
    await refused({ name: "x".repeat(51), expiry: "90" }, "longer than 50");
    await refused({ name: "ok", expiry: "7" }, "Choose when the token expires");
    await refused({ name: "ok", expiry: "never" }, "Choose when the token expires");
    expect((await form(w.plugin, w.larry, "stale", "/tokens", { name: "x", expiry: "90" })).status).toBe(403);
    for (let i = 1; i < MAX_TOKENS_PER_PERSON; i++) await makeToken(w, w.larry, `t${i}`);
    w.clock.advance(60 * 60 * 1000); // past the hourly limit on making them, which has its own test
    await refused({ name: "eleventh", expiry: "90" }, `You already have ${MAX_TOKENS_PER_PERSON} API tokens`);
    expect(query(w.dbPath, "SELECT seq FROM api_tokens")).toHaveLength(MAX_TOKENS_PER_PERSON);
    // Expired ones do not count.
    w.clock.advance(91 * 24 * 60 * 60 * 1000);
    await makeToken(w, await signIn(w.plugin, LARRY), "after");
  });

  it("at most ten tokens made per person per rolling hour, revoked ones counted; the eleventh sends no DM; it resets", async () => {
    const w = await setup(); // made one at START
    const csrf = await csrfOf(w.plugin, w.larry);
    w.clock.advance(30 * 60 * 1000);
    for (let i = 1; i < MAX_CREATIONS_PER_HOUR; i++) {
      await makeToken(w, w.larry, `t${i}`);
      expect((await form(w.plugin, w.larry, csrf, `/tokens/k${i + 1}/revoke`)).status).toBe(200);
    }
    expect(query(w.dbPath, "SELECT seq FROM api_tokens")).toHaveLength(1);
    const dms = w.sent.length;
    const eleventh = await form(w.plugin, w.larry, csrf, "/tokens", { name: "eleventh", expiry: "30" });
    expect(eleventh.status).toBe(400);
    expect(await eleventh.text()).toContain(TOO_MANY_CREATED);
    expect(w.sent.length).toBe(dms);
    expect(query(w.dbPath, "SELECT seq FROM api_tokens")).toHaveLength(1);
    // Someone else is unaffected.
    await makeToken(w, await signIn(w.plugin, CURLY), "curly");
    // An hour after the first, its slot is free again; the rest free up an hour after they were made.
    w.clock.advance(30 * 60 * 1000);
    await makeToken(w, w.larry, "again");
    expect((await form(w.plugin, w.larry, csrf, "/tokens", { name: "more", expiry: "30" })).status).toBe(400);
    w.clock.advance(30 * 60 * 1000);
    await makeToken(w, w.larry, "later");
  });

  it("an admin sees a person's tokens and revokes one; a non-admin cannot", async () => {
    const w = await setup();
    const admin = await signIn(w.plugin, ADMIN);
    const adminCsrf = await csrfOf(w.plugin, admin);
    const page = await (await call(w.plugin, "GET", "/admin/people/u2", { jar: admin })).text();
    expect(page).toContain("Their API tokens");
    expect(page).toContain('action="/tracker/admin/tokens/k1/revoke"');
    expect(page).not.toContain(w.token);
    const larryCsrf = await csrfOf(w.plugin, w.larry);
    const notAdmin = await form(w.plugin, w.larry, larryCsrf, "/admin/tokens/k1/revoke");
    expect(notAdmin.status).toBe(404);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(200);
    const done = await form(w.plugin, admin, adminCsrf, "/admin/tokens/k1/revoke");
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Revoked");
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(401);
    expect((await form(w.plugin, admin, adminCsrf, "/admin/tokens/k1/revoke")).status).toBe(404);
  });
});

describe("tasks", () => {
  it("POST /tasks makes a reminder by /remind's rules: the same task, runs and history", async () => {
    const w = await setup();
    const res = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "reminder", text: "water the plants", when: "tomorrow 9am", repeat: "week" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe("/tracker/api/v1/tasks/t1");
    const made = await body(res);
    expect(made.message).toContain("Reminder `t1` set: water the plants");
    expect(made.task).toMatchObject({ id: "t1", type: "reminder", title: "water the plants", status: "active", settings: { text: "water the plants", repeat: "week" } });
    expect(made.task.nextAt).toBe("2026-10-02T13:00:00.000Z");
    await slash(w.plugin, "remind", LARRY, { strings: { text: "water the plants", when: "tomorrow 9am", repeat: "week" } });
    expect(shape(w.dbPath, 1)).toEqual(shape(w.dbPath, 2));
  });

  it("POST /tasks makes a renewal and a price by the web editor's rules", async () => {
    const w = await setup();
    const csrf = await csrfOf(w.plugin, w.larry);
    const renewal = { name: "Domain", amount: 12.5, currency: "usd", renews: "2026-12-01", unit: "year", every: 1, lead: 14, note: "registrar" };
    expect((await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "renewal", ...renewal } })).status).toBe(201);
    const typedIn = Object.fromEntries(Object.entries(renewal).map(([k, v]) => [k, String(v)]));
    expect((await form(w.plugin, w.larry, csrf, "/new/renewal", typedIn)).status).toBe(303);
    expect(shape(w.dbPath, 1)).toEqual(shape(w.dbPath, 2));

    const price = { url: SHOP, name: "Widget", hours: 6, drop: 15, baseline: "peak" };
    const made = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "price", ...price } });
    expect(made.status).toBe(201);
    const madeTask = (await body(made)).task;
    expect(madeTask.settings).toEqual({ name: "Widget", hours: 6, drop: 15, baseline: "peak" });
    expect(madeTask.url).toBe(SHOP);
    expect((await form(w.plugin, w.larry, csrf, "/new/price", Object.fromEntries(Object.entries(price).map(([k, v]) => [k, String(v)])))).status).toBe(303);
    const a = shape(w.dbPath, 3);
    const b = shape(w.dbPath, 4);
    // A price's poll starts now, whenever each was made: the same moment here.
    expect(a).toEqual(b);
  });

  it("a refusal is the rule's own words, as the web editor shows them; nothing is made", async () => {
    const w = await setup();
    const csrf = await csrfOf(w.plugin, w.larry);
    const cases: [Record<string, unknown>, string][] = [
      [{ type: "reminder", text: "", when: "9am" }, "Say what to remind you of."],
      [{ type: "reminder", text: "x" }, 'Say when: for example "in 20 minutes", "tomorrow 9am" or "friday at 17:30".'],
      [{ type: "renewal", name: "Domain", amount: 5, currency: "US", renews: "2026-12-01" }, "The currency is a three-letter code, such as USD or EUR."],
      [{ type: "renewal", name: "Domain", amount: 5, currency: "USD", renews: "2026-12-01", every: 1.5 }, "`every` is a whole number from 1 to 100."],
      [{ type: "price", url: SHOP, hours: 500 }, "`hours` is a whole number from 1 to 168."],
    ];
    for (const [input, reason] of cases) {
      const res = await api(w.plugin, "POST", "/tasks", { token: w.token, body: input });
      expect(res.status).toBe(400);
      const e = (await body(res)).error;
      expect(e.code).toBe("invalid");
      expect(e.message).toBe(reason);
      const { type, ...fields } = input;
      const web = await form(w.plugin, w.larry, csrf, `/new/${String(type)}`, Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])));
      expect(web.status).toBe(400);
      expect(alertText(await web.text())).toBe(reason.replaceAll("`", ""));
    }
    w.shop.price = null;
    const noPrice = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "price", url: SHOP } });
    expect(noPrice.status).toBe(400);
    expect((await body(noPrice)).error.message).toContain("I found no price on that page.");
    expect(query(w.dbPath, "SELECT seq FROM tasks")).toEqual([]);
  });

  it("the body is checked: its type, its fields and their JSON types, by name", async () => {
    const w = await setup();
    const cases: [unknown, string, string][] = [
      [{ text: "x", when: "9am" }, "invalid", "`type` is one of reminder, renewal, price."],
      [{ type: "chore", text: "x" }, "invalid", "`type` is one of"],
      [{ type: "reminder", text: "x", when: "9am", colour: "red" }, "unknown_field", "`colour` is not a field of a reminder."],
      [{ type: "reminder", text: 5, when: "9am" }, "invalid", "`text` must be a string."],
      [{ type: "price", url: SHOP, hours: "12" }, "invalid", "`hours` must be a number."],
      [{ type: "reminder", text: "x", when: null }, "invalid", "`when` must be a string."],
      // A body shaped like an answer is still just a body.
      [{ status: 201, body: { task: {} } }, "invalid", "`type` is one of"],
    ];
    for (const [input, code, message] of cases) {
      const res = await api(w.plugin, "POST", "/tasks", { token: w.token, body: input });
      expect(res.status).toBe(400);
      const e = (await body(res)).error;
      expect(e.code).toBe(code);
      expect(e.message).toContain(message);
    }
    expect(query(w.dbPath, "SELECT seq FROM tasks")).toEqual([]);
  });

  it("Content-Type must be application/json; the body is capped; it must be one JSON object", async () => {
    const w = await setup();
    const reminder = JSON.stringify({ type: "reminder", text: "x", when: "9am" });
    const bad: [Record<string, string>, string, number, string][] = [
      [{}, reminder, 415, "unsupported_media_type"],
      [{ "content-type": "text/plain" }, reminder, 415, "unsupported_media_type"],
      [{ "content-type": "application/x-www-form-urlencoded" }, "type=reminder&text=x&when=9am", 415, "unsupported_media_type"],
      [{ "content-type": "application/json" }, "{not json", 400, "invalid_json"],
      [{ "content-type": "application/json" }, "[]", 400, "invalid_json"],
      [{ "content-type": "application/json" }, "null", 400, "invalid_json"],
      [{ "content-type": "application/json" }, JSON.stringify({ type: "reminder", text: "x".repeat(MAX_API_BYTES), when: "9am" }), 413, "too_large"],
    ];
    for (const [headers, raw, status, code] of bad) {
      const res = await api(w.plugin, "POST", "/tasks", { token: w.token, raw, headers });
      expect(`${status} ${code}`).toBe(`${res.status} ${(await body(res)).error.code}`);
    }
    // A declared length over the cap is refused unread.
    const declared = await api(w.plugin, "POST", "/tasks", { token: w.token, raw: "{}", headers: { "content-type": "application/json", "content-length": String(MAX_API_BYTES + 1) } });
    expect(declared.status).toBe(413);
    expect(query(w.dbPath, "SELECT seq FROM tasks")).toEqual([]);
    const ok = await api(w.plugin, "POST", "/tasks", { token: w.token, raw: reminder, headers: { "content-type": "Application/JSON; charset=utf-8" } });
    expect(ok.status).toBe(201);
  });

  it("GET /tasks lists the owner's own tasks only, deleted ones left out; GET /tasks/<id> adds the history", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "larry-one", when: "9am", repeat: "day" } }); // t1
    await slash(w.plugin, "remind", CURLY, { strings: { text: "curly-one", when: "9am", repeat: "day" } }); // t2
    await slash(w.plugin, "task", CURLY, { sub: "share", strings: { task: "t2" }, users: { user: LARRY } });
    await slash(w.plugin, "remind", LARRY, { strings: { text: "larry-gone", when: "in 2 hours" } }); // t3
    await api(w.plugin, "DELETE", "/tasks/t3", { token: w.token });
    const list = await body(await api(w.plugin, "GET", "/tasks", { token: w.token }));
    expect(list.tasks.map((t: { id: string }) => t.id)).toEqual(["t1"]);
    expect(list.tasks[0]).toMatchObject({ title: "larry-one", cadence: "daily at 9:00", nextAt: "2026-10-01T13:00:00.000Z" });
    const one = await body(await api(w.plugin, "GET", "/tasks/t1", { token: w.token }));
    expect(one.task.id).toBe("t1");
    expect(one.history.changes.map((c: { kind: string }) => c.kind)).toContain("created");
    // A deleted task's page stays for its owner, as on the web.
    expect((await body(await api(w.plugin, "GET", "/tasks/t3", { token: w.token }))).task.status).toBe("deleted");
  });

  it("anyone else's task -- one shared with them, and to an admin's token too -- is the unknown task's 404, on every endpoint", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", CURLY, { strings: { text: "curly-one", when: "9am", repeat: "day" } }); // t1
    await slash(w.plugin, "task", CURLY, { sub: "share", strings: { task: "t1" }, users: { user: LARRY } });
    const admin = await makeToken(w, await signIn(w.plugin, ADMIN), "admin-agent");
    const before = snapshot(w.dbPath);
    const tries: [string, string, unknown?][] = [
      ["GET", "/tasks/t1"],
      ["PATCH", "/tasks/t1", { text: "mine now" }],
      ["POST", "/tasks/t1/pause", {}],
      ["POST", "/tasks/t1/resume", {}],
      ["DELETE", "/tasks/t1"],
    ];
    for (const token of [w.token, admin]) {
      for (const [method, path, input] of tries) {
        const theirs = await api(w.plugin, method, path, { token, ...(input !== undefined ? { body: input } : {}) });
        const unknown = await api(w.plugin, method, path.replace("t1", "t999"), { token, ...(input !== undefined ? { body: input } : {}) });
        expect(`${method} ${path} ${theirs.status}`).toBe(`${method} ${path} 404`);
        const a = await theirs.text();
        expect(a).toBe(await unknown.text());
        expect(JSON.parse(a)).toEqual({ error: { code: "not_found", message: NOT_FOUND_MESSAGE } });
      }
    }
    expect(snapshot(w.dbPath)).toBe(before);
  });

  it("PATCH edits by the web editor's rules: the same fields make the same change", async () => {
    const w = await setup();
    const csrf = await csrfOf(w.plugin, w.larry);
    for (let i = 0; i < 2; i++) await slash(w.plugin, "remind", LARRY, { strings: { text: "bins", when: "9am", repeat: "week" } });
    const res = await api(w.plugin, "PATCH", "/tasks/t1", { token: w.token, body: { text: "recycling", repeat: "day" } });
    expect(res.status).toBe(200);
    const saved = await body(res);
    expect(saved.message).toContain("Saved `t1` (reminder)");
    expect(saved.task.settings).toEqual({ text: "recycling", repeat: "day" });
    expect((await form(w.plugin, w.larry, csrf, "/tasks/t2/edit", { text: "recycling", repeat: "day" })).status).toBe(303);
    const [a, b] = [shape(w.dbPath, 1), shape(w.dbPath, 2)];
    expect({ ...a.row, title: "" }).toEqual({ ...b.row, title: "" });
    expect(a.runs).toEqual(b.runs);
    expect(a.events).toEqual(b.events);

    // A renewal: an empty note clears it, a field left out keeps what it has.
    await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "renewal", name: "Domain", amount: 12, currency: "USD", renews: "2026-12-01", note: "registrar" } });
    const renewal = await body(await api(w.plugin, "PATCH", "/tasks/t3", { token: w.token, body: { amount: 15, note: "" } }));
    expect(renewal.task.settings).toMatchObject({ name: "Domain", amount: 15, currency: "USD", note: "" });
    // A price's page is not a field of its edit.
    await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "price", url: SHOP } });
    const page = await api(w.plugin, "PATCH", "/tasks/t4", { token: w.token, body: { url: "https://shop.example/other" } });
    expect(page.status).toBe(400);
    expect((await body(page)).error.code).toBe("unknown_field");
    const refused = await api(w.plugin, "PATCH", "/tasks/t4", { token: w.token, body: { drop: 95 } });
    expect(refused.status).toBe(400);
    expect((await body(refused)).error.message).toBe("`drop` is a percentage from 1 to 90.");
  });

  it("pause, resume and DELETE by the web's own acts; a second pause is a 409", async () => {
    const w = await setup();
    const csrf = await csrfOf(w.plugin, w.larry);
    for (let i = 0; i < 2; i++) await slash(w.plugin, "remind", LARRY, { strings: { text: "bins", when: "9am", repeat: "week" } });
    const paused = await api(w.plugin, "POST", "/tasks/t1/pause", { token: w.token, body: {} });
    expect(paused.status).toBe(200);
    expect((await body(paused)).task.status).toBe("paused");
    expect((await form(w.plugin, w.larry, csrf, "/tasks/t2/pause")).status).toBe(303);
    expect(shape(w.dbPath, 1)).toEqual(shape(w.dbPath, 2));
    const again = await api(w.plugin, "POST", "/tasks/t1/pause", { token: w.token, body: {} });
    expect(again.status).toBe(409);
    expect(await body(again)).toEqual({ error: { code: "conflict", message: "That task is paused, not active." } });
    expect((await api(w.plugin, "POST", "/tasks/t1/pause", { token: w.token, body: { now: true } })).status).toBe(400);
    w.clock.advance(3 * 24 * 60 * 60 * 1000);
    expect((await api(w.plugin, "POST", "/tasks/t1/resume", { token: w.token, body: {} })).status).toBe(200);
    expect((await form(w.plugin, w.larry, csrf, "/tasks/t2/resume")).status).toBe(303);
    expect(shape(w.dbPath, 1)).toEqual(shape(w.dbPath, 2));
    const gone = await api(w.plugin, "DELETE", "/tasks/t1", { token: w.token });
    expect(gone.status).toBe(200);
    expect((await body(gone)).task.status).toBe("deleted");
    expect((await form(w.plugin, w.larry, csrf, "/tasks/t2/delete", { confirm: "yes" })).status).toBe(303);
    expect(shape(w.dbPath, 1)).toEqual(shape(w.dbPath, 2));
    expect((await api(w.plugin, "DELETE", "/tasks/t1", { token: w.token })).status).toBe(404);
  });

  it("the caps are the commands': 20 price trackers, counted wherever they were made", async () => {
    const w = await setup();
    for (let i = 0; i < MAX_PRICE_TASKS; i++) await slash(w.plugin, "price", LARRY, { strings: { url: `${SHOP}/${i}` } });
    const res = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "price", url: SHOP } });
    expect(res.status).toBe(409);
    const e = (await body(res)).error;
    expect(e.code).toBe("limit_reached");
    expect(e.message).toBe(`You already track ${MAX_PRICE_TASKS} prices, the most one person may. Stop one with \`/task done\`, or delete one on the web, first.`);
    expect(await slash(w.plugin, "price", LARRY, { strings: { url: SHOP } })).toBe(e.message);
  });

  it("methods and paths: 405 with Allow, 404 for an unknown endpoint, GET /types lists every field", async () => {
    const w = await setup();
    const put = await api(w.plugin, "PUT", "/tasks", { token: w.token, body: {} });
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET, POST");
    expect((await api(w.plugin, "POST", "/tasks/t1", { token: w.token, body: {} })).headers.get("allow")).toBe("GET, PATCH, DELETE");
    expect((await api(w.plugin, "GET", "/nothing", { token: w.token })).status).toBe(404);
    const types = await body(await api(w.plugin, "GET", "/types", { token: w.token }));
    expect(types.types.map((t: { type: string }) => t.type)).toEqual(["reminder", "renewal", "price"]);
    const price = types.types[2];
    expect(price.create.map((f: { name: string }) => f.name)).toEqual(["url", "name", "hours", "drop", "baseline", "near"]);
    expect(price.edit.map((f: { name: string }) => f.name)).not.toContain("url");
    expect(price.create.find((f: { name: string }) => f.name === "hours")).toMatchObject({ type: "integer", minimum: 1, maximum: 168 });
    expect(price.create.find((f: { name: string }) => f.name === "baseline")).toMatchObject({ type: "string", enum: ["last", "first", "peak"] });
    // An edit keeps whatever it is not sent: none of its fields is required, though a create's are.
    for (const t of types.types) expect(t.edit.filter((f: { required: boolean }) => f.required)).toEqual([]);
    expect(types.types[1].create.filter((f: { required: boolean }) => f.required).map((f: { name: string }) => f.name)).toEqual(["name", "amount", "currency", "renews"]);
  });
});
