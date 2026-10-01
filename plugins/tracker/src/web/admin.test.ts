import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { Plugin } from "../../../../packages/api/contract.js";
import { NOT_ADMIN, NOT_ADMITTED } from "../access.js";
import type { Fetch } from "@rackbops/docket-core";
import { NO_LONGER_LISTED } from "../actions.js";
import { CONFIGURED_ADMIN, CONFIGURED_SELF, LAST_ADMIN } from "../admin.js";
import { CANNOT_SHARE } from "../press.js";
import { PAUSE_AFTER } from "../delivery-health.js";
import { ERASED_TABLES, FORGOTTEN } from "../roster.js";
import { CONFIGURED_NOTE, CONFIRM_WORD } from "./admin-pages.js";
import { esc } from "./html.js";
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
  press,
  replyText,
  SESSION,
  signIn,
  slash,
  STRANGER,
  world,
} from "./harness.js";

/**
 * The admin view and forget-me (rackbops-bot-plugins#80, slice 3), through the plugin's own `http`
 * handler and slash commands with a fake host: every admin route refused to a non-admin exactly as
 * an unknown page is, an admin whose flag is revoked mid-session refused at once, each admin act
 * against the command path that does the same, and forget-me erasing every row that names the
 * person -- found by scanning every table -- and nothing of anyone else's.
 */

afterEach(cleanup);

/** Admin u1, Larry u2 and Curly u3, all registered. */
async function setup(opts: Parameters<typeof world>[0] = {}) {
  const w = await world(opts);
  await people(w.plugin);
  const admin = await signIn(w.plugin, ADMIN);
  const larry = await signIn(w.plugin, LARRY);
  return { ...w, admin, adminCsrf: await csrfOf(w.plugin, admin), larry, larryCsrf: await csrfOf(w.plugin, larry) };
}

function post(plugin: Plugin, jar: Jar, csrf: string, path: string, form: Record<string, string> = {}, origin: string | null = ORIGIN) {
  return call(plugin, "POST", path, { jar, form: { csrf, ...form }, origin });
}

function query<T>(dbPath: string, sql: string, ...params: (string | number)[]): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/** Every table's rows as JSON, for "nothing changed". */
function snapshot(dbPath: string): string {
  const tables = query<{ name: string }>(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  return JSON.stringify(tables.map((t) => [t.name, query(dbPath, `SELECT * FROM ${t.name} ORDER BY rowid`)]));
}

/**
 * Every value anywhere in the database that names the person: their tracker id as a word, their
 * Discord id, or any of `words`. Every table in the schema, whatever the erasure thinks it covers.
 */
function traces(dbPath: string, id: string, words: readonly string[]): string[] {
  const found: string[] = [];
  for (const { name } of query<{ name: string }>(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence'")) {
    for (const row of query<Record<string, unknown>>(dbPath, `SELECT * FROM ${name}`)) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== "string") continue;
        if (mentions(value, id) || words.some((w) => value.includes(w))) found.push(`${name}.${column}: ${value}`);
      }
    }
  }
  return found;
}

/** Whether `text` names `id` as a word of its own: the scan's broad test, wider than the erasure's. */
function mentions(text: string, id: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${id}(?![0-9A-Za-z_])`).test(text);
}

const tick = (p: Plugin) => p.ticks!.find((t) => t.name === "notify")!.run(new AbortController().signal);

/** Occurrence ids of `taskId` that have run, oldest first. */
function runs(dbPath: string, taskId: string): string[] {
  return query<{ id: string }>(dbPath, "SELECT 'o' || seq AS id FROM occurrences WHERE task_id = ? AND status != 'queued' ORDER BY seq", taskId).map((r) => r.id);
}

const ADMIN_ROUTES: readonly [string, string, Record<string, string>?][] = [
  ["GET", "/admin"],
  ["GET", "/admin/tasks"],
  ["GET", "/admin/deliveries"],
  ["GET", "/admin/people/u1"],
  ["GET", "/admin/people/u3"],
  ["GET", "/admin/people/u999"],
  ["POST", "/admin/allow", { discord_id: STRANGER }],
  ["POST", "/admin/people/u3/grant"],
  ["POST", "/admin/people/u1/revoke"],
  ["POST", "/admin/people/u3/resume-delivery"],
  ["POST", "/admin/people/u3/forget", { confirm: "yes", word: CONFIRM_WORD }],
  ["POST", "/admin/blocks/b1/lift"],
  ["POST", "/admin/tokens/k1/revoke"],
  // The wrong method, too: to a non-admin it is the unknown page, not a 405 that says the path exists.
  ["POST", "/admin"],
  ["GET", "/admin/allow"],
];

describe("who may use the admin view", () => {
  it("a non-admin gets the unknown page's 404 from every admin route, word for word, and nothing changes", async () => {
    const w = await setup();
    const unknown = await call(w.plugin, "GET", "/no/such/page", { jar: w.larry });
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.text();
    const before = snapshot(w.dbPath);
    for (const [method, path, form] of ADMIN_ROUTES) {
      const res = method === "GET" ? await call(w.plugin, "GET", path, { jar: w.larry }) : await post(w.plugin, w.larry, w.larryCsrf, path, form);
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 404`);
      expect(await res.text()).toBe(unknownBody);
    }
    expect(snapshot(w.dbPath)).toBe(before);
    // No Admin link for them either.
    expect(await (await call(w.plugin, "GET", "/", { jar: w.larry })).text()).not.toContain('href="/tracker/admin"');
  });

  it("an admin sees each page; the wrong method is a 405 for them; nobody signed in is sent to sign in", async () => {
    const w = await setup();
    for (const path of ["/admin", "/admin/tasks", "/admin/deliveries", "/admin/people/u2"]) expect((await call(w.plugin, "GET", path, { jar: w.admin })).status).toBe(200);
    expect((await call(w.plugin, "GET", "/admin/people/u999", { jar: w.admin })).status).toBe(404);
    expect((await call(w.plugin, "GET", "/admin/allow", { jar: w.admin })).status).toBe(405);
    expect((await post(w.plugin, w.admin, w.adminCsrf, "/admin")).status).toBe(405);
    expect(await (await call(w.plugin, "GET", "/", { jar: w.admin })).text()).toContain('href="/tracker/admin"');
    const anon = await call(w.plugin, "GET", "/admin");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/tracker/signin");
  });

  it("an admin whose flag is revoked mid-session loses the admin view on their very next request", async () => {
    const w = await setup();
    // Larry signed in before he was an admin: the flag is read on each request, not at sign-in.
    expect((await call(w.plugin, "GET", "/admin", { jar: w.larry })).status).toBe(404);
    const granted = await post(w.plugin, w.admin, w.adminCsrf, "/admin/people/u2/grant");
    expect(granted.status).toBe(200);
    expect(await granted.text()).toContain("Larry is now an admin.");
    expect((await call(w.plugin, "GET", "/admin", { jar: w.larry })).status).toBe(200);
    // The one admin definition: the same flag lets him /allow in Discord.
    expect(await slash(w.plugin, "allow", LARRY, { users: { user: STRANGER } })).toContain("Allowed");

    expect((await post(w.plugin, w.admin, w.adminCsrf, "/admin/people/u2/revoke")).status).toBe(200);
    expect((await call(w.plugin, "GET", "/admin", { jar: w.larry })).status).toBe(404);
    expect((await post(w.plugin, w.larry, w.larryCsrf, "/admin/people/u3/grant")).status).toBe(404);
    expect(query<{ admin: number }>(w.dbPath, "SELECT admin FROM users WHERE seq = 3")[0]?.admin).toBe(0);
    expect(await slash(w.plugin, "allow", LARRY, { users: { user: "555555555555555555" } })).toBe(NOT_ADMIN);
    // His session itself goes on: he is still a registered person.
    expect((await call(w.plugin, "GET", "/", { jar: w.larry })).status).toBe(200);
  });

  it("an admin revoking their own flag lands on My tasks; the last admin can be neither revoked nor forgotten", async () => {
    const w = await setup();
    const last = await post(w.plugin, w.admin, w.adminCsrf, "/admin/people/u1/revoke");
    expect(last.status).toBe(400);
    expect(await last.text()).toContain(esc(LAST_ADMIN));
    const forget = await post(w.plugin, w.admin, w.adminCsrf, "/forget", { confirm: "yes", word: CONFIRM_WORD });
    expect(forget.status).toBe(400);
    expect(await forget.text()).toContain(esc(LAST_ADMIN));
    const removeSelf = await post(w.plugin, w.admin, w.adminCsrf, "/admin/people/u1/forget", { confirm: "yes", word: CONFIRM_WORD });
    expect(removeSelf.status).toBe(400);
    expect(query(w.dbPath, "SELECT seq FROM users WHERE seq = 1")).toHaveLength(1);

    // Larry, made an admin here (not by the configuration), revokes himself.
    await post(w.plugin, w.admin, w.adminCsrf, "/admin/people/u2/grant");
    const self = await post(w.plugin, w.larry, w.larryCsrf, "/admin/people/u2/revoke");
    expect(self.status).toBe(303);
    expect(self.headers.get("location")).toBe("/tracker/");
    expect((await call(w.plugin, "GET", "/admin", { jar: w.larry })).status).toBe(404);
  });

  it("every admin post needs the session's CSRF token and this origin", async () => {
    const w = await setup();
    const before = snapshot(w.dbPath);
    expect((await post(w.plugin, w.admin, "not-the-token", "/admin/people/u2/grant")).status).toBe(403);
    expect((await post(w.plugin, w.admin, w.adminCsrf, "/admin/people/u2/grant", {}, "https://evil.example.net")).status).toBe(403);
    expect((await post(w.plugin, w.admin, w.adminCsrf, "/admin/people/u3/forget", { confirm: "yes", word: CONFIRM_WORD }, "https://evil.example.net")).status).toBe(403);
    expect((await post(w.plugin, w.admin, "", "/admin/allow", { discord_id: STRANGER })).status).toBe(403);
    expect(snapshot(w.dbPath)).toBe(before);
  });
});

describe("what an admin sees", () => {
  it("people with their status, zone, hour, delivery and task counts; every task with its owner; any task read-only", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "water the plants", when: "tomorrow 9am" } });
    await slash(w.plugin, "allow", ADMIN, { users: { user: STRANGER } });
    const page = await (await call(w.plugin, "GET", "/admin", { jar: w.admin })).text();
    expect(page).toContain("Larry");
    expect(page).toContain("admitted, not registered");
    expect(page).toContain("America/New_York, 09:00");
    expect(page).toContain("1 active, 0 paused, 0 done, 0 deleted; receives 0");
    const tasks = await (await call(w.plugin, "GET", "/admin/tasks", { jar: w.admin })).text();
    expect(tasks).toContain('href="/tracker/tasks/t1"');
    expect(tasks).toContain("water the plants");
    const one = await call(w.plugin, "GET", "/tasks/t1", { jar: w.admin });
    expect(one.status).toBe(200);
    const body = await one.text();
    expect(body).toContain("Owned by Larry; you can see it, not change it.");
    expect(body).not.toContain("/tasks/t1/edit");
    expect(body).not.toContain("/tasks/t1/pause");
    // Admins do not change other people's tasks: the owner's acts answer them 404.
    for (const action of ["pause", "delete", "edit"]) {
      expect((await post(w.plugin, w.admin, w.adminCsrf, `/tasks/t1/${action}`, { confirm: "yes" })).status).toBe(404);
    }
    const person = await (await call(w.plugin, "GET", "/admin/people/u2", { jar: w.admin })).text();
    expect(person).toContain(`Discord id: ${LARRY}`);
    expect(person).toContain("water the plants");
  });

  it("escapes what people typed and chose to be called", async () => {
    const w = await setup();
    const db = new Database(w.dbPath);
    db.query("UPDATE users SET display_name = ? WHERE seq = 3").run('<script>alert("x")</script>');
    db.close();
    await slash(w.plugin, "remind", CURLY, { strings: { text: "<img src=x onerror=alert(1)>", when: "tomorrow 9am" } });
    for (const path of ["/admin", "/admin/people/u3", "/admin/tasks", "/tasks/t1"]) {
      const body = await (await call(w.plugin, "GET", path, { jar: w.admin })).text();
      expect(body).not.toContain("<script>alert");
      expect(body).not.toContain("<img src=x");
    }
    expect(await (await call(w.plugin, "GET", "/admin", { jar: w.admin })).text()).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });
});

describe("admin acts, against the command path", () => {
  it("allow by Discord id is /allow: the same row and admission, then /register works", async () => {
    const w = await setup();
    const OTHER = "555555555555555555";
    await slash(w.plugin, "allow", ADMIN, { users: { user: OTHER } });
    const res = await post(w.plugin, w.admin, w.adminCsrf, "/admin/allow", { discord_id: ` ${STRANGER} ` });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`Allowed ${STRANGER}: they can now use <code>/register</code>.`);
    const rows = query<Record<string, unknown>>(
      w.dbPath,
      `SELECT u.time_zone, u.preferred_hour, u.admin, a.admitted_by, a.registered_at FROM users u JOIN admissions a ON a.user_id = 'u' || u.seq
       WHERE u.discord_id IN (?, ?) ORDER BY u.seq`,
      OTHER,
      STRANGER,
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(rows[0] as Record<string, unknown>);
    expect(rows[0]).toMatchObject({ admitted_by: "u1", registered_at: null, admin: 0 });
    expect(await slash(w.plugin, "register", STRANGER)).toContain("You are registered.");
    const again = await post(w.plugin, w.admin, w.adminCsrf, "/admin/allow", { discord_id: STRANGER });
    expect(await again.text()).toContain(`${STRANGER} is already on the list.`);
    const bad = await post(w.plugin, w.admin, w.adminCsrf, "/admin/allow", { discord_id: "<b>12</b>" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("&lt;b&gt;12&lt;/b&gt;");
  });

  it("allow checks server membership as /allow does, and refuses when it cannot", async () => {
    let answer: "member" | "not-member" | null = "not-member";
    const w = await setup({ guild: true, webMembership: async () => answer });
    const before = snapshot(w.dbPath);
    expect(await (await post(w.plugin, w.admin, w.adminCsrf, "/admin/allow", { discord_id: STRANGER })).text()).toContain(
      `${STRANGER} is not a member of this tracker&#39;s server.`,
    );
    answer = null; // no Discord client yet
    expect(await (await post(w.plugin, w.admin, w.adminCsrf, "/admin/allow", { discord_id: STRANGER })).text()).toContain("I could not check");
    expect(snapshot(w.dbPath)).toBe(before);
    answer = "member";
    expect(await (await post(w.plugin, w.admin, w.adminCsrf, "/admin/allow", { discord_id: STRANGER })).text()).toContain(`Allowed ${STRANGER}`);
  });

  it("lifting a decline block lets the owner invite again, recorded as the admin's lift", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "bins out", when: "9am", repeat: "week" } });
    await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } });
    await press(w.plugin, "tracker:x.t.t1", CURLY);
    const share = () => slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } });
    expect(await share()).toContain("declined an earlier invitation from you");
    const page = await (await call(w.plugin, "GET", "/admin", { jar: w.admin })).text();
    expect(page).toContain("Larry may not invite user333 until");
    expect(page).toContain('action="/tracker/admin/blocks/b1/lift"');
    const lifted = await post(w.plugin, w.admin, w.adminCsrf, "/admin/blocks/b1/lift");
    expect(lifted.status).toBe(200);
    expect(await lifted.text()).toContain("Lifted: Larry may invite user333 again.");
    expect(query(w.dbPath, "SELECT lifted_by FROM invite_blocks WHERE seq = 1")).toEqual([{ lifted_by: "u1" }]);
    expect((await post(w.plugin, w.admin, w.adminCsrf, "/admin/blocks/b1/lift")).status).toBe(400); // nothing left to lift
    expect((await post(w.plugin, w.admin, w.adminCsrf, "/admin/blocks/b99/lift")).status).toBe(400);
    expect(await share()).toContain("Invited");
  });

  it("resuming a person's delivery is what their own next command does", async () => {
    async function pausedLarry() {
      const w = await setup();
      await slash(w.plugin, "remind", LARRY, { strings: { text: "pills", repeat: "day", when: "9am" } });
      w.delivery.unreachable.add(LARRY);
      for (const day of ["01", "02", "03"]) {
        w.clock.set(`2026-10-${day}T13:00:00.000Z`);
        await tick(w.plugin);
      }
      w.delivery.unreachable.clear();
      expect(query(w.dbPath, "SELECT status FROM tasks")).toEqual([{ status: "paused" }]);
      return w;
    }
    const byAdmin = await pausedLarry();
    const page = await (await call(byAdmin.plugin, "GET", "/admin/people/u2", { jar: byAdmin.admin })).text();
    expect(page).toContain("Delivery: paused since");
    const resumed = await post(byAdmin.plugin, byAdmin.admin, byAdmin.adminCsrf, "/admin/people/u2/resume-delivery");
    expect(resumed.status).toBe(200);
    expect(await resumed.text()).toContain("Delivery to Larry resumed; 1 task(s) back on.");
    expect((await post(byAdmin.plugin, byAdmin.admin, byAdmin.adminCsrf, "/admin/people/u2/resume-delivery")).status).toBe(400);

    const byCommand = await pausedLarry();
    expect(await slash(byCommand.plugin, "tasks", LARRY)).toContain(`I could not DM you ${PAUSE_AFTER} times in a row`);

    const state = (dbPath: string) => ({
      health: query(dbPath, "SELECT failures, paused_at FROM delivery_health"),
      pauses: query(dbPath, "SELECT * FROM delivery_pauses"),
      tasks: query(dbPath, "SELECT status FROM tasks"),
      events: query(dbPath, "SELECT kind, detail, actor_id FROM task_events ORDER BY seq"),
      queued: query(dbPath, "SELECT due_at, status FROM occurrences ORDER BY seq"),
    });
    expect(state(byAdmin.dbPath)).toEqual(state(byCommand.dbPath));
  });
});

describe("forget-me", () => {
  /** Larry in every table: tasks of his (one deleted), one shared both ways, a reply each way, a decline, a snooze, failed DMs, sign-ins. */
  async function busyLarry() {
    const w = await setup();
    await signIn(w.plugin, CURLY);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "larry-bins", when: "9am", repeat: "week" } }); // t1
    await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } });
    await press(w.plugin, "tracker:a.t.t1", CURLY);
    await slash(w.plugin, "remind", CURLY, { strings: { text: "curly-plants", when: "9am", repeat: "day" } }); // t2
    await slash(w.plugin, "task", CURLY, { sub: "share", strings: { task: "t2" }, users: { user: LARRY } });
    await press(w.plugin, "tracker:a.t.t2", LARRY);
    await slash(w.plugin, "remind", CURLY, { strings: { text: "curly-second", when: "9am", repeat: "day" } }); // t3
    await slash(w.plugin, "task", CURLY, { sub: "share", strings: { task: "t3" }, users: { user: LARRY } });
    await press(w.plugin, "tracker:x.t.t3", LARRY); // a block: Curly may not invite Larry
    await slash(w.plugin, "remind", LARRY, { strings: { text: "larry-old", when: "in 2 hours" } }); // t4
    await post(w.plugin, w.larry, w.larryCsrf, "/tasks/t4/delete", { confirm: "yes" });
    w.clock.set("2026-10-01T13:00:00.000Z");
    await tick(w.plugin);
    const [t1run] = runs(w.dbPath, "t1");
    const [t2run] = runs(w.dbPath, "t2");
    expect(await replyText(w.plugin, t2run as string, LARRY, "larry-said-done")).toContain("Reply kept");
    expect(await replyText(w.plugin, t1run as string, CURLY, "curly-said-ok")).toContain("Reply kept");
    expect(await slash(w.plugin, "task", LARRY, { sub: "snooze", strings: { task: "t1" } })).toContain("Snoozed");
    // A day of failed DMs to Larry: the snooze's run and Curly's shared one.
    w.delivery.unreachable.add(LARRY);
    w.clock.set("2026-10-02T13:00:00.000Z");
    await tick(w.plugin);
    w.delivery.unreachable.clear();
    await slash(w.plugin, "web", LARRY); // an unused sign-in link
    const token = await makeToken(w, w.larry, "larry-agent"); // an API token
    expect((await api(w.plugin, "GET", "/me", { token })).status).toBe(200);
    const where = new Set(traces(w.dbPath, "u2", [LARRY, "Larry", "larry-"]).map((t) => t.split(".")[0]));
    // Everywhere a person can be, but a price's series and a pause (their own tests' business), and
    // the execute lane's charges, budget notices, findings and Job records, which no tick here writes
    // (roster.test.ts).
    const elsewhere = new Set(["series", "delivery_pauses", "usage", "notices", "findings", "executor_jobs"]);
    expect([...where].sort()).toEqual([...ERASED_TABLES].filter((t) => !elsewhere.has(t)).sort());
    // His copies of runs are in docket's deliveries, and so are the copies of his runs to Curly.
    expect(query(w.dbPath, "SELECT DISTINCT user_id FROM deliveries ORDER BY user_id")).toEqual([{ user_id: "u2" }, { user_id: "u3" }]);
    return { ...w, token };
  }

  it("two steps and a typed word; then every row that names them is gone, from every table, and they are signed out", async () => {
    const w = await busyLarry();
    const curly = await signIn(w.plugin, CURLY);
    const oldCookie: Jar = new Map(w.larry);
    const before = snapshot(w.dbPath);

    const page = await call(w.plugin, "GET", "/forget", { jar: w.larry });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('action="/tracker/forget"');
    const ask = await post(w.plugin, w.larry, w.larryCsrf, "/forget");
    expect(ask.status).toBe(200);
    expect(await ask.text()).toContain(`Type ${CONFIRM_WORD} to confirm`);
    const wrong = await post(w.plugin, w.larry, w.larryCsrf, "/forget", { confirm: "yes", word: "yes" });
    expect(wrong.status).toBe(400);
    expect((await post(w.plugin, w.larry, "stale", "/forget", { confirm: "yes", word: CONFIRM_WORD })).status).toBe(403);
    expect((await post(w.plugin, w.larry, w.larryCsrf, "/forget", { confirm: "yes", word: CONFIRM_WORD }, "https://evil.example.net")).status).toBe(403);
    expect(snapshot(w.dbPath)).toBe(before);

    const curlyRows = (dbPath: string) => ({
      user: query(dbPath, "SELECT * FROM users WHERE seq = 3"),
      admission: query(dbPath, "SELECT * FROM admissions WHERE user_id = 'u3'"),
      tasks: query(dbPath, "SELECT seq, owner_id, title, status FROM tasks WHERE owner_id = 'u3' ORDER BY seq"),
      runs: query(dbPath, "SELECT seq, task_id, due_at, dedupe_key FROM occurrences WHERE task_id IN ('t2', 't3') ORDER BY seq"),
    });
    const curlyBefore = curlyRows(w.dbPath);

    const done = await post(w.plugin, w.larry, w.larryCsrf, "/forget", { confirm: "yes", word: ` ${CONFIRM_WORD.toUpperCase()} ` });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/tracker/signin?forgotten=1");
    expect(done.headers.get("set-cookie")).toContain(`${SESSION}=; Path=/tracker/; Max-Age=0`);
    expect(w.larry.has(SESSION)).toBe(false);
    expect(await (await call(w.plugin, "GET", "/signin?forgotten=1")).text()).toContain("Everything the tracker held about you is deleted");

    // Nothing anywhere names him: his id as a word, his Discord id, his name, his tasks' words.
    expect(traces(w.dbPath, "u2", [LARRY, "Larry", "larry-"])).toEqual([]);
    expect(query(w.dbPath, "SELECT seq FROM users WHERE seq = 2")).toEqual([]);
    // Curly's own tasks and their runs are all still there, and so is Curly.
    expect(curlyRows(w.dbPath)).toEqual(curlyBefore);
    expect((await call(w.plugin, "GET", "/", { jar: curly })).status).toBe(200);
    expect(await slash(w.plugin, "task", CURLY, { sub: "history", strings: { task: "t2" } })).toContain("curly-plants");
    // His API token is gone with him.
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(401);
    // Larry's old cookie signs no one in.
    const stale = await call(w.plugin, "GET", "/", { jar: oldCookie });
    expect(stale.status).toBe(303);
    expect(stale.headers.get("location")).toBe("/tracker/signin");
    // He is not on the list; allowed again, he is a new person with a new id.
    expect(await slash(w.plugin, "register", LARRY)).toBe(NOT_ADMITTED);
    expect(await slash(w.plugin, "allow", ADMIN, { users: { user: LARRY } })).toContain("Allowed");
    expect(query(w.dbPath, "SELECT 'u' || seq AS id FROM users WHERE discord_id = ?", LARRY)).toEqual([{ id: "u4" }]);
    expect(await slash(w.plugin, "tasks", LARRY)).toContain("Run `/register` first");
  });

  it("the erasure covers every table in the schema", async () => {
    const w = await setup();
    // Every table but SQLite's own counter and tracker_meta, which holds housekeeping, no person.
    const tables = query<{ name: string }>(w.dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sqlite_sequence', 'tracker_meta')").map((t) => t.name);
    expect([...ERASED_TABLES].map(String).sort()).toEqual(tables.sort());
  });

  it("an admin removes a person the same way, with the same confirmation; their session ends at once", async () => {
    const w = await busyLarry();
    const before = snapshot(w.dbPath);
    const ask = await post(w.plugin, w.admin, w.adminCsrf, "/admin/people/u2/forget");
    expect(ask.status).toBe(200);
    expect(await ask.text()).toContain("Remove Larry from the tracker?");
    expect((await post(w.plugin, w.admin, w.adminCsrf, "/admin/people/u2/forget", { confirm: "yes", word: "remove" })).status).toBe(400);
    expect(snapshot(w.dbPath)).toBe(before);
    const done = await post(w.plugin, w.admin, w.adminCsrf, "/admin/people/u2/forget", { confirm: "yes", word: CONFIRM_WORD });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Larry is removed from the tracker.");
    expect(traces(w.dbPath, "u2", [LARRY, "Larry", "larry-"])).toEqual([]);
    expect((await call(w.plugin, "GET", "/", { jar: w.larry })).status).toBe(303);
    expect((await api(w.plugin, "GET", "/me", { token: w.token })).status).toBe(401);
    expect((await post(w.plugin, w.admin, w.adminCsrf, "/admin/people/u2/forget", { confirm: "yes", word: CONFIRM_WORD })).status).toBe(404);
  });

  it("a forgotten admin's audit marks on other people's rows say only that an admin did it", async () => {
    const w = await setup();
    await post(w.plugin, w.admin, w.adminCsrf, "/admin/people/u2/grant");
    await slash(w.plugin, "allow", LARRY, { users: { user: STRANGER } });
    await slash(w.plugin, "remind", CURLY, { strings: { text: "bins", when: "9am", repeat: "week" } });
    await slash(w.plugin, "task", CURLY, { sub: "share", strings: { task: "t1" }, users: { user: ADMIN } });
    await press(w.plugin, "tracker:x.t.t1", ADMIN); // Curly may not invite the admin
    await slash(w.plugin, "remind", ADMIN, { strings: { text: "admin-task", when: "9am", repeat: "week" } });
    await slash(w.plugin, "task", ADMIN, { sub: "share", strings: { task: "t2" }, users: { user: CURLY } });
    await press(w.plugin, "tracker:x.t.t2", CURLY); // the admin may not invite Curly
    const larryAdmin = await signIn(w.plugin, LARRY);
    await post(w.plugin, larryAdmin, await csrfOf(w.plugin, larryAdmin), "/admin/blocks/b2/lift");
    expect(query(w.dbPath, "SELECT lifted_by FROM invite_blocks WHERE seq = 2")).toEqual([{ lifted_by: "u2" }]);

    await post(w.plugin, w.larry, w.larryCsrf, "/forget", { confirm: "yes", word: CONFIRM_WORD });
    expect(traces(w.dbPath, "u2", [LARRY, "Larry"])).toEqual([]);
    expect(query(w.dbPath, "SELECT admitted_by FROM admissions WHERE user_id = 'u4'")).toEqual([{ admitted_by: FORGOTTEN }]);
    expect(query(w.dbPath, "SELECT lifted_by, lifted_at IS NOT NULL AS lifted FROM invite_blocks WHERE seq = 2")).toEqual([{ lifted_by: FORGOTTEN, lifted: 1 }]);
    expect(await (await call(w.plugin, "GET", "/admin", { jar: w.admin })).text()).toContain("an admin since forgotten");
  });

  it("waits for a tick with a DM to them in flight, so nothing about them is written after", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", CURLY, { strings: { text: "curly-plants", when: "9am", repeat: "day" } });
    await slash(w.plugin, "task", CURLY, { sub: "share", strings: { task: "t1" }, users: { user: LARRY } });
    await press(w.plugin, "tracker:a.t.t1", LARRY);
    let release = () => {};
    w.delivery.hold = new Promise<void>((r) => (release = r));
    w.clock.set("2026-10-01T13:00:00.000Z");
    const ticking = tick(w.plugin);
    const forgetting = post(w.plugin, w.larry, w.larryCsrf, "/forget", { confirm: "yes", word: CONFIRM_WORD });
    await new Promise((r) => setTimeout(r, 20));
    // Still waiting on the tick: nothing is erased yet.
    expect(query(w.dbPath, "SELECT seq FROM users WHERE seq = 2")).toHaveLength(1);
    w.delivery.hold = null;
    release();
    await ticking;
    expect((await forgetting).status).toBe(303);
    expect(traces(w.dbPath, "u2", [LARRY, "Larry"])).toEqual([]);
    expect(query(w.dbPath, "SELECT status FROM occurrences WHERE task_id = 't1' ORDER BY seq LIMIT 1")).toEqual([{ status: "done" }]);
  });

  it("another owner's task paused only for them goes back on", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", CURLY, { strings: { text: "curly-plants", when: "9am", repeat: "day" } });
    await slash(w.plugin, "task", CURLY, { sub: "share", strings: { task: "t1" }, users: { user: LARRY } });
    await press(w.plugin, "tracker:a.t.t1", LARRY);
    w.delivery.unreachable.add(LARRY);
    for (const day of ["01", "02", "03"]) {
      w.clock.set(`2026-10-${day}T13:00:00.000Z`);
      await tick(w.plugin);
    }
    expect(query(w.dbPath, "SELECT status FROM tasks")).toEqual([{ status: "paused" }]);
    expect(query(w.dbPath, "SELECT user_id FROM delivery_pauses")).toEqual([{ user_id: "u2" }]);

    await post(w.plugin, w.larry, w.larryCsrf, "/forget", { confirm: "yes", word: CONFIRM_WORD });
    expect(query(w.dbPath, "SELECT status FROM tasks")).toEqual([{ status: "active" }]);
    expect(query(w.dbPath, "SELECT * FROM delivery_pauses")).toEqual([]);
    expect(await slash(w.plugin, "task", CURLY, { sub: "history", strings: { task: "t1" } })).toContain("Next: Sun Oct 4, 9:00");
    expect(traces(w.dbPath, "u2", [LARRY, "Larry"])).toEqual([]);
  });
});

describe("review fixes (slice 3)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Waits (a few seconds at most) until `ready`, instead of guessing a delay. */
  async function until(ready: () => boolean) {
    for (let i = 0; i < 400 && !ready(); i++) await sleep(5);
    expect(ready()).toBe(true);
  }
  const PAGE = "https://shop.example/u2/widget";

  it("a /price whose page is read while its person is forgotten makes nothing for the gone id", async () => {
    let open = () => {};
    let reading = false;
    const gate = new Promise<void>((r) => (open = r));
    const ld = { "@type": "Product", offers: { "@type": "Offer", price: "10.00", priceCurrency: "USD" } };
    const fetch: Fetch = {
      async get() {
        reading = true;
        await gate;
        return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(ld)}</script>`, headers: {} };
      },
    };
    const w = await setup({ fetch });
    const answer = slash(w.plugin, "price", LARRY, { strings: { url: PAGE } });
    await until(() => reading); // its first turn is done; the page read waits outside the queue
    expect((await post(w.plugin, w.larry, w.larryCsrf, "/forget", { confirm: "yes", word: CONFIRM_WORD })).status).toBe(303);
    open();
    expect(await answer).toBe(NO_LONGER_LISTED);
    expect(query(w.dbPath, "SELECT * FROM tasks")).toEqual([]);
    expect(traces(w.dbPath, "u2", [LARRY, "Larry"])).toEqual([]);
  });

  it("an invitation DM that fails after its invitee is forgotten writes nothing about them", async () => {
    const w = await setup();
    const curly = await signIn(w.plugin, CURLY);
    const curlyCsrf = await csrfOf(w.plugin, curly);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "bins out", when: "9am", repeat: "week" } });
    let release = () => {};
    w.delivery.hold = new Promise<void>((r) => (release = r));
    w.delivery.unreachable.add(CURLY);
    const sharing = slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } });
    await until(() => w.delivery.held > 0); // the invitation is recorded; its DM waits outside the queue
    expect((await post(w.plugin, curly, curlyCsrf, "/forget", { confirm: "yes", word: CONFIRM_WORD })).status).toBe(303);
    w.delivery.hold = null;
    release();
    expect(await sharing).toBe(`<@${CURLY}> ${CANNOT_SHARE}`);
    expect(query(w.dbPath, "SELECT * FROM delivery_health")).toEqual([]);
    expect(traces(w.dbPath, "u3", [CURLY, "user333"])).toEqual([]);
  });

  it("forget-me waits for a running tick outside the write queue: everyone else's commands go on meanwhile", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", CURLY, { strings: { text: "curly-plants", when: "9am", repeat: "day" } });
    let release = () => {};
    w.delivery.hold = new Promise<void>((r) => (release = r));
    w.clock.set("2026-10-01T13:00:00.000Z");
    const ticking = tick(w.plugin);
    await until(() => w.delivery.held > 0);
    const forgetting = post(w.plugin, w.larry, w.larryCsrf, "/forget", { confirm: "yes", word: CONFIRM_WORD });
    await sleep(20);
    const other = await Promise.race([slash(w.plugin, "tasks", CURLY), sleep(1000).then(() => "stalled")]);
    expect(other).toContain("curly-plants");
    w.delivery.hold = null;
    release();
    await ticking;
    expect((await forgetting).status).toBe(303);
  });

  it("a pause for a recipient names them by id, shown by the name they have when read", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", CURLY, { strings: { text: "curly-plants", when: "9am", repeat: "day" } });
    await slash(w.plugin, "task", CURLY, { sub: "share", strings: { task: "t1" }, users: { user: LARRY } });
    await press(w.plugin, "tracker:a.t.t1", LARRY);
    w.delivery.unreachable.add(LARRY);
    for (const day of ["01", "02", "03"]) {
      w.clock.set(`2026-10-${day}T13:00:00.000Z`);
      await tick(w.plugin);
    }
    expect(query<{ detail: string }>(w.dbPath, "SELECT detail FROM task_events WHERE kind = 'paused'")[0]?.detail).toStartWith("delivery to {u2} paused:");
    expect(await slash(w.plugin, "task", CURLY, { sub: "history", strings: { task: "t1" } })).toContain("paused: delivery to Larry paused:");
    const db = new Database(w.dbPath);
    db.query("UPDATE users SET display_name = 'Lawrence' WHERE seq = 2").run();
    db.close();
    expect(await slash(w.plugin, "task", CURLY, { sub: "history", strings: { task: "t1" } })).toContain("paused: delivery to Lawrence paused:");
  });

  it("forget-me erases pause rows by id, and an old row by name only where no other recipient has that name", async () => {
    const w = await setup();
    for (const text of ["shared-both", "shared-larry"]) await slash(w.plugin, "remind", ADMIN, { strings: { text, when: "9am", repeat: "week" } });
    for (const [task, who] of [["t1", LARRY], ["t1", CURLY], ["t2", LARRY]] as const) {
      await slash(w.plugin, "task", ADMIN, { sub: "share", strings: { task }, users: { user: who } });
      await press(w.plugin, `tracker:a.t.${task}`, who);
    }
    const db = new Database(w.dbPath);
    db.query("UPDATE users SET display_name = 'Larry' WHERE seq = 3").run(); // Curly now goes by Larry too
    const add = db.query("INSERT INTO task_events (task_id, actor_id, kind, detail, at) VALUES (?, NULL, 'paused', ?, '2026-10-01T12:00:00.000Z')");
    const legacy = "delivery to Larry paused: 3 DMs in a row could not be delivered";
    add.run("t1", legacy); // could be either Larry: kept
    add.run("t2", legacy); // only u2 is on t2: theirs
    add.run("t1", "delivery to {u3} paused: 3 DMs in a row could not be delivered"); // the other Larry's, by id: kept
    add.run("t1", "delivery to {u2} paused: 3 DMs in a row could not be delivered"); // u2's, by id
    db.close();
    await post(w.plugin, w.larry, w.larryCsrf, "/forget", { confirm: "yes", word: CONFIRM_WORD });
    expect(query(w.dbPath, "SELECT task_id, detail FROM task_events WHERE kind = 'paused' ORDER BY seq")).toEqual([
      { task_id: "t1", detail: legacy },
      { task_id: "t1", detail: "delivery to {u3} paused: 3 DMs in a row could not be delivered" },
    ]);
  });

  it("an id-like word in someone else's text is not them: only the forms the code writes are erased or redacted", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", CURLY, { strings: { text: "curly-plants", when: "9am", repeat: "day" } });
    const db = new Database(w.dbPath);
    const at = "2026-10-01T12:00:00.000Z";
    db.query("INSERT INTO occurrences (task_id, lane, due_at, status, late, dedupe_key, error, created_at) VALUES ('t1', 'notify', ?, 'failed', 0, 'x1', ?, ?)").run(at, `could not read ${PAGE}`, at);
    db.query("INSERT INTO occurrences (task_id, lane, due_at, status, late, dedupe_key, error, created_at) VALUES ('t1', 'notify', ?, 'failed', 0, 'x2', ?, ?)").run(at, "recipient u2 cannot be messaged (DMs closed, or the bot is blocked)", at);
    const o = (db.query("SELECT 'o' || seq AS id FROM occurrences WHERE dedupe_key = 'x1'").get() as { id: string }).id;
    db.query("INSERT INTO events (occurrence_id, agent, type, text, at) VALUES (?, 'docket', 'error', ?, ?)").run(o, `could not read ${PAGE}`, at);
    db.query("INSERT INTO task_events (task_id, actor_id, kind, detail, at) VALUES ('t1', 'u3', 'edited', ?, ?)").run(`note: ${PAGE}`, at);
    db.close();
    await post(w.plugin, w.larry, w.larryCsrf, "/forget", { confirm: "yes", word: CONFIRM_WORD });
    expect(query(w.dbPath, "SELECT dedupe_key, error FROM occurrences WHERE dedupe_key LIKE 'x%' ORDER BY seq")).toEqual([
      { dedupe_key: "x1", error: `could not read ${PAGE}` },
      { dedupe_key: "x2", error: "recipient (forgotten) cannot be messaged (DMs closed, or the bot is blocked)" },
    ]);
    expect(query(w.dbPath, "SELECT text FROM events WHERE type = 'error'")).toEqual([{ text: `could not read ${PAGE}` }]);
    expect(query(w.dbPath, "SELECT detail FROM task_events WHERE kind = 'edited'")).toEqual([{ detail: `note: ${PAGE}` }]);
  });

  it("a configured admin cannot be revoked or removed by another admin; forgetting themselves is allowed, and a start makes them again", async () => {
    const w = await setup();
    await post(w.plugin, w.admin, w.adminCsrf, "/admin/people/u2/grant");
    const revoke = await post(w.plugin, w.larry, w.larryCsrf, "/admin/people/u1/revoke");
    expect(revoke.status).toBe(400);
    expect(await revoke.text()).toContain(esc(CONFIGURED_ADMIN));
    const remove = await post(w.plugin, w.larry, w.larryCsrf, "/admin/people/u1/forget", { confirm: "yes", word: CONFIRM_WORD });
    expect(remove.status).toBe(400);
    expect(await remove.text()).toContain(esc(CONFIGURED_ADMIN));
    const page = await (await call(w.plugin, "GET", "/admin/people/u1", { jar: w.larry })).text();
    expect(page).toContain(esc(CONFIGURED_NOTE));
    expect(page).not.toContain("/admin/people/u1/revoke");
    expect(page).not.toContain("/admin/people/u1/forget");
    expect(await (await call(w.plugin, "GET", "/forget", { jar: w.admin })).text()).toContain(esc(CONFIGURED_SELF));
    expect(await (await post(w.plugin, w.admin, w.adminCsrf, "/forget")).text()).toContain(esc(CONFIGURED_SELF));

    expect((await post(w.plugin, w.admin, w.adminCsrf, "/forget", { confirm: "yes", word: CONFIRM_WORD })).status).toBe(303);
    expect(query(w.dbPath, "SELECT seq FROM users WHERE discord_id = ?", ADMIN)).toEqual([]);
    await w.plugin.dispose!();
    await w.plugin.activate!();
    expect(query(w.dbPath, "SELECT 'u' || seq AS id, admin FROM users WHERE discord_id = ?", ADMIN)).toEqual([{ id: "u4", admin: 1 }]);
  });

  it("the write-ahead log checkpoint says when a reader kept it busy", async () => {
    const w = await setup();
    const reader = new Database(w.dbPath, { readonly: true });
    reader.exec("BEGIN");
    reader.query("SELECT * FROM users").all();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "x", when: "tomorrow 9am" } }); // a write the reader has not seen
    const { Roster } = await import("../roster.js");
    const { openDatabase } = await import("../schema.js");
    const db = openDatabase(w.dbPath);
    expect(new Roster(db).checkpoint()).toBe(false);
    reader.exec("COMMIT");
    reader.close();
    expect(new Roster(db).checkpoint()).toBe(true);
    db.close();
  });
});
