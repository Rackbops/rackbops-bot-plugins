import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { Fetch, FetchResponse } from "@rackbops/docket-core";
import { SlashCommandBuilder } from "discord.js";
import type { Plugin } from "../../../../packages/api/contract.js";
import { NO_SUCH_TASK } from "../actions.js";
import { MAX_LIVE_TASKS, MAX_NEAR, MAX_REMINDER_TEXT, MAX_TITLE, MAX_URL, MAX_WHEN } from "../limits.js";
import { MAX_PRICE_TASKS, nearPattern } from "../price.js";
import { MAX_FORM_BYTES } from "./app.js";
import { READING } from "./editor.js";
import { ADMIN, call, cleanup, csrfOf, CURLY, hidden, type Jar, LARRY, ORIGIN, people, signIn, slash, world } from "./harness.js";

/**
 * The task editor (rackbops-bot-plugins#80, slice 2), through the plugin's own `http` handler with
 * a fake host: new, edit, pause, resume and delete for each type the commands make, with the
 * commands' rules; and the gates -- session, CSRF, Origin, method, body size -- and ownership: an id
 * in the path is only ever looked up, and anyone else's task answers the same 404 as an unknown one.
 */

afterEach(cleanup);

const SHOP = "https://shop.example/widget";

function shop() {
  const s = { price: 100 as number | null, reads: [] as string[] };
  const fetch: Fetch = {
    async get(url: string): Promise<FetchResponse> {
      s.reads.push(url);
      if (s.price === null) return { status: 200, body: "<html><body>Out of stock</body></html>", headers: {} };
      const ld = { "@type": "Product", offers: { "@type": "Offer", price: s.price.toFixed(2), priceCurrency: "USD" } };
      return { status: 200, body: `<script type="application/ld+json">${JSON.stringify(ld)}</script><p>(a+)+$ Price: ${s.price.toFixed(2)}</p>`, headers: {} };
    },
  };
  return { s, fetch };
}

async function setup() {
  const store = shop();
  const w = await world({ fetch: store.fetch });
  await people(w.plugin);
  const larry = await signIn(w.plugin, LARRY);
  const csrf = await csrfOf(w.plugin, larry);
  return { ...w, larry, csrf, shop: store.s };
}

/** A form post from this origin with the session's token. */
function post(plugin: Plugin, jar: Jar, csrf: string, path: string, form: Record<string, string> = {}) {
  return call(plugin, "POST", path, { jar, form: { csrf, ...form }, origin: ORIGIN });
}

interface Row {
  seq: number;
  type: string;
  title: string;
  status: string;
  config: Record<string, unknown>;
  state: Record<string, unknown> | null;
  schedule: Record<string, unknown> | null;
}

function tasks(dbPath: string): Row[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.query("SELECT seq, type, title, status, config, state, schedule FROM tasks ORDER BY seq").all() as Record<string, unknown>[];
  db.close();
  return rows.map((r) => ({
    seq: Number(r.seq),
    type: String(r.type),
    title: String(r.title),
    status: String(r.status),
    config: JSON.parse(String(r.config)),
    state: JSON.parse(String(r.state)),
    schedule: JSON.parse(String(r.schedule)),
  }));
}

function events(dbPath: string, taskId: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.query("SELECT kind, detail FROM task_events WHERE task_id = ? ORDER BY seq").all(taskId) as { kind: string; detail: string }[];
  db.close();
  // A creation says its type, a schedule change its JSON: only the kind of those.
  return rows.map((r) => (r.kind === "created" || r.kind === "schedule_changed" ? r.kind : `${r.kind}${r.detail ? `: ${r.detail}` : ""}`));
}

function queued(dbPath: string, taskId: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.query("SELECT due_at FROM occurrences WHERE task_id = ? AND status = 'queued' ORDER BY due_at").all(taskId) as { due_at: string }[];
  db.close();
  return rows.map((r) => r.due_at);
}

const notifyTick = (p: Plugin) => p.ticks!.find((t) => t.name === "notify")!.run(new AbortController().signal);

describe("reminders", () => {
  it("new: the form, then a reminder made by /remind's rules, landing on its page", async () => {
    const w = await setup();
    const form = await call(w.plugin, "GET", "/new/reminder", { jar: w.larry });
    expect(form.status).toBe(200);
    const page = await form.text();
    expect(page).toContain('action="/tracker/new/reminder"');
    expect(hidden(page, "csrf")).toBe(w.csrf);
    expect(page).toContain('<option value="none" selected>once</option>');

    const res = await post(w.plugin, w.larry, w.csrf, "/new/reminder", { text: "water the plants", when: "tomorrow 9am", repeat: "week" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/tracker/tasks/t1?done=created");
    const landed = await (await call(w.plugin, "GET", "/tasks/t1?done=created", { jar: w.larry })).text();
    expect(landed).toContain("Created.");
    expect(landed).toContain('action="/tracker/tasks/t1/pause"');

    // The same words through /remind make the same task.
    await slash(w.plugin, "remind", LARRY, { strings: { text: "water the plants", when: "tomorrow 9am", repeat: "week" } });
    const [web, discord] = tasks(w.dbPath);
    expect(web?.schedule).toEqual(discord?.schedule ?? null);
    expect(web?.config).toEqual({ text: "water the plants" });
    expect(queued(w.dbPath, "t1")).toEqual(queued(w.dbPath, "t2"));
  });

  it("new: a refusal re-renders the form with what was typed, escaped, and the reason; nothing is made", async () => {
    const w = await setup();
    for (const [form, reason] of [
      [{ text: "  ", when: "", repeat: "none" }, "Say what to remind you of."],
      [{ text: `<b>"hi"</b>`, when: "", repeat: "none" }, "Say when"],
      [{ text: `<b>"hi"</b>`, when: "blorp", repeat: "none" }, ""],
      [{ text: "x".repeat(1501), when: "tomorrow", repeat: "none" }, "longer than 1500 characters"],
      [{ text: "hi", when: "", repeat: "hourly" }, "<code>repeat</code> is once, daily, weekly or monthly."],
    ] as const) {
      const res = await post(w.plugin, w.larry, w.csrf, "/new/reminder", form);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain('role="alert"');
      expect(body).toContain(reason);
      expect(body).not.toContain("<b>");
      if (form.text.startsWith("<b>")) expect(body).toContain('value="&lt;b&gt;&quot;hi&quot;&lt;/b&gt;"');
    }
    expect(tasks(w.dbPath)).toEqual([]);
  });

  it("edit: the form shows the task; a new text and time are saved, and a blank time keeps the schedule", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "stretch", when: "tomorrow 9am", repeat: "day" } });
    const form = await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar: w.larry })).text();
    expect(form).toContain('value="stretch"');
    expect(form).toContain('<option value="day" selected>daily</option>');
    expect(form).toContain("daily at 9:00");
    const before = tasks(w.dbPath)[0]?.schedule;

    // Only the text: the schedule is not touched.
    let res = await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { text: "stretch twice", when: "", repeat: "day" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/tracker/tasks/t1?done=saved");
    expect(tasks(w.dbPath)[0]).toMatchObject({ title: "stretch twice", config: { text: "stretch twice" }, schedule: before });
    expect(events(w.dbPath, "t1")).toEqual(["created", "edited: title, config"]);

    // A new time: rescheduled, as a zone move would.
    res = await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { text: "stretch twice", when: "tomorrow 7pm", repeat: "day" });
    expect(res.status).toBe(303);
    expect(tasks(w.dbPath)[0]?.schedule).toMatchObject({ kind: "calendar", unit: "day", hour: 19, minute: 0 });
    expect(queued(w.dbPath, "t1")).toEqual(["2026-10-02T23:00:00.000Z"]);
    expect(events(w.dbPath, "t1").at(-1)).toBe("schedule_changed");

    // Nothing changed: nothing written.
    await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { text: "stretch twice", when: "", repeat: "day" });
    expect(events(w.dbPath, "t1")).toHaveLength(3);

    // Once, with no time: refused as /remind refuses it, and the form keeps what was typed.
    res = await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { text: "stretch <3", when: "", repeat: "none" });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Say when");
    expect(body).toContain('value="stretch &lt;3"');
    expect(tasks(w.dbPath)[0]?.title).toBe("stretch twice");
  });

  it("a snooze survives an edit's reschedule", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "stretch", repeat: "day" } });
    const db = new Database(w.dbPath);
    db.query(
      "INSERT INTO occurrences (task_id, lane, due_at, status, late, dedupe_key, created_at) VALUES ('t1', 'notify', '2026-10-01T20:00:00.000Z', 'queued', 0, 'snooze:o99', ?)",
    ).run(new Date().toISOString());
    db.close();
    await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { text: "stretch", when: "5pm", repeat: "day" });
    expect(queued(w.dbPath, "t1")).toContain("2026-10-01T20:00:00.000Z");
  });
});

describe("renewals", () => {
  const NETFLIX = { name: "Netflix", amount: "15.49", currency: "usd", renews: "2026-12-01", unit: "month", every: "1", lead: "3", note: "cancel at netflix.com" };

  it("new: made by /renewal's rules, with its defaults on the form", async () => {
    const w = await setup();
    const form = await (await call(w.plugin, "GET", "/new/renewal", { jar: w.larry })).text();
    expect(form).toContain('<option value="year" selected>yearly</option>');
    expect(form).toContain('name="lead" type="number" value="7"');
    const res = await post(w.plugin, w.larry, w.csrf, "/new/renewal", NETFLIX);
    expect(res.status).toBe(303);
    await slash(w.plugin, "renewal", LARRY, {
      strings: { name: "Netflix", currency: "usd", renews: "2026-12-01", unit: "month", note: "cancel at netflix.com" },
      numbers: { amount: 15.49 },
      ints: { every: 1, lead: 3 },
    });
    const [web, discord] = tasks(w.dbPath);
    expect(web).toMatchObject({ type: "renewal", title: "Netflix", config: { amount: 15.49, currency: "USD", note: "cancel at netflix.com" } });
    expect(web?.schedule).toEqual(discord?.schedule ?? null);
    expect(queued(w.dbPath, "t1")).toEqual(queued(w.dbPath, "t2"));
  });

  it("new: a first ask already due comes at once, as /renewal's does", async () => {
    const w = await setup();
    await post(w.plugin, w.larry, w.csrf, "/new/renewal", { ...NETFLIX, renews: "2026-10-03", lead: "7" });
    expect(queued(w.dbPath, "t1")[0]! <= "2026-10-01T12:00:00.000Z").toBe(true);
  });

  it("edit: a changed lead does not ask again about a date already asked about", async () => {
    const w = await setup();
    await post(w.plugin, w.larry, w.csrf, "/new/renewal", { ...NETFLIX, unit: "year", renews: "2026-10-05", lead: "3" });
    expect(queued(w.dbPath, "t1")).toEqual(["2026-10-02T13:00:00.000Z"]);
    w.clock.set("2026-10-02T14:00:00.000Z");
    await notifyTick(w.plugin);
    expect(w.sent).toHaveLength(1);
    const res = await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { ...NETFLIX, unit: "year", renews: "2026-10-05", lead: "5" });
    expect(res.status).toBe(303);
    expect(queued(w.dbPath, "t1")).toEqual(["2027-09-30T13:00:00.000Z"]);
    await notifyTick(w.plugin);
    expect(w.sent).toHaveLength(1);
  });

  it("new: every rule refuses as the command does", async () => {
    const w = await setup();
    for (const [change, reason] of [
      [{ name: "" }, "Say what renews"],
      [{ amount: "abc" }, "The amount has to be zero or more."],
      [{ amount: "" }, "The amount has to be zero or more."],
      [{ amount: "-5" }, "The amount has to be zero or more."],
      [{ amount: "1e3" }, "The amount has to be zero or more."],
      [{ currency: "US" }, "three-letter code"],
      [{ renews: "2026-09-30" }, "That date has passed"],
      [{ renews: "12/01/2026" }, "YYYY-MM-DD"],
      [{ unit: "hour" }, "<code>unit</code> is yearly, monthly, weekly or daily."],
      [{ every: "0" }, "<code>every</code> is a whole number from 1 to 100."],
      [{ every: "1.5" }, "<code>every</code> is a whole number from 1 to 100."],
      [{ lead: "366" }, "<code>lead</code> is a whole number of days from 0 to 365."],
      [{ note: "n".repeat(301) }, "The note is longer than 300 characters."],
    ] as const) {
      const res = await post(w.plugin, w.larry, w.csrf, "/new/renewal", { ...NETFLIX, ...change });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(reason);
    }
    expect(tasks(w.dbPath)).toEqual([]);
  });

  it("edit: the form shows the amount now carried; a new amount, note and schedule are saved", async () => {
    const w = await setup();
    await post(w.plugin, w.larry, w.csrf, "/new/renewal", NETFLIX);
    // A decision recorded a new amount: that is the one the next ask quotes, and the form shows.
    const db = new Database(w.dbPath);
    db.query(`UPDATE tasks SET state = '{"amount":17.99,"decision":"keep","decidedAt":null,"periodDate":null}' WHERE seq = 1`).run();
    db.close();
    const form = await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar: w.larry })).text();
    expect(form).toContain('name="amount" type="text" value="17.99"');
    expect(form).toContain('value="2026-12-01"');
    expect(form).toContain('<option value="month" selected>monthly</option>');

    // Only the note: the amount as first entered stays, and nothing is rescheduled.
    await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { ...NETFLIX, amount: "17.99", note: "" });
    expect(tasks(w.dbPath)[0]).toMatchObject({ config: { amount: 15.49, currency: "USD" }, state: { amount: 17.99 } });
    expect(tasks(w.dbPath)[0]?.config.note).toBeUndefined();
    expect(events(w.dbPath, "t1")).toEqual(["created", "edited: config"]);

    const res = await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { ...NETFLIX, amount: "19.99", unit: "year", renews: "2027-01-15", lead: "10" });
    expect(res.status).toBe(303);
    const row = tasks(w.dbPath)[0];
    expect(row).toMatchObject({ config: { amount: 19.99 }, state: { amount: 19.99 } });
    expect(row?.schedule).toEqual({ kind: "period", every: 1, unit: "year", anchor: "2027-01-15", leadDays: 10 });
    expect(queued(w.dbPath, "t1")).toEqual(["2027-01-05T14:00:00.000Z"]);

    const bad = await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { ...NETFLIX, currency: "dollars" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('value="dollars"');
    expect(tasks(w.dbPath)[0]?.config.currency).toBe("USD");
  });
});

describe("price trackers", () => {
  it("new: the page is read once, then made by /price's rules", async () => {
    const w = await setup();
    const res = await post(w.plugin, w.larry, w.csrf, "/new/price", { url: SHOP, name: "", hours: "6", drop: "15", baseline: "peak", near: "" });
    expect(res.status).toBe(303);
    expect(w.shop.reads).toEqual([SHOP]);
    expect(tasks(w.dbPath)[0]).toMatchObject({
      type: "price",
      title: "shop.example/widget",
      config: { url: SHOP, dropPercent: 15, baseline: "peak" },
      schedule: { kind: "poll", every: 6, unit: "hour" },
    });
  });

  it("new: no price on the page, a bad URL, a bad number: refused, nothing made", async () => {
    const w = await setup();
    w.shop.price = null;
    let res = await post(w.plugin, w.larry, w.csrf, "/new/price", { url: SHOP });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("I found no price on that page.");
    w.shop.price = 100;
    for (const [form, reason] of [
      [{ url: "ftp://shop.example/x" }, "http"],
      [{ url: SHOP, hours: "169" }, "<code>hours</code> is a whole number from 1 to 168."],
      [{ url: SHOP, hours: "0x10" }, "<code>hours</code> is a whole number from 1 to 168."],
      [{ url: SHOP, drop: "95" }, "<code>drop</code> is a percentage from 1 to 90."],
      [{ url: SHOP, baseline: "lowest" }, "<code>baseline</code> is first, last or peak."],
      [{ url: SHOP, near: "p".repeat(101) }, "<code>near</code> is longer than 100 characters."],
    ] as const) {
      res = await post(w.plugin, w.larry, w.csrf, "/new/price", form);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(reason);
    }
    expect(tasks(w.dbPath)).toEqual([]);
  });

  it("new: `near` becomes the same bounded pattern /price builds, never a pattern of the person's", async () => {
    const w = await setup();
    const near = "(a+)+$ Price:";
    expect((await post(w.plugin, w.larry, w.csrf, "/new/price", { url: SHOP, near })).status).toBe(303);
    await slash(w.plugin, "price", LARRY, { strings: { url: SHOP, near } });
    const [web, discord] = tasks(w.dbPath);
    expect(web?.config.pattern).toBe(nearPattern(near));
    expect(web?.config).toEqual(discord?.config ?? {});
  });

  it(`new: at most ${MAX_PRICE_TASKS} per person, counting the ones made in Discord; a delete frees one`, async () => {
    const w = await setup();
    for (let i = 0; i < MAX_PRICE_TASKS; i++) await slash(w.plugin, "price", LARRY, { strings: { url: `${SHOP}${i}` } });
    const res = await post(w.plugin, w.larry, w.csrf, "/new/price", { url: SHOP });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(`You already track ${MAX_PRICE_TASKS} prices`);
    await post(w.plugin, w.larry, w.csrf, "/tasks/t1/delete", { confirm: "yes" });
    expect((await post(w.plugin, w.larry, w.csrf, "/new/price", { url: SHOP })).status).toBe(303);
  });

  it("new: one page read at a time per person", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reads: string[] = [];
    const fetch: Fetch = {
      async get(url: string): Promise<FetchResponse> {
        reads.push(url);
        await gate;
        return { status: 200, body: `<p>Price: 10.00</p>`, headers: {} };
      },
    };
    const w = await world({ fetch });
    await people(w.plugin);
    const larry = await signIn(w.plugin, LARRY);
    const csrf = await csrfOf(w.plugin, larry);
    const first = post(w.plugin, larry, csrf, "/new/price", { url: SHOP, near: "Price:" });
    // Wait on the read itself, not a fixed time: a busy machine is slow to get there.
    const until = async (n: number) => {
      for (let i = 0; i < 500 && reads.length < n; i++) await Bun.sleep(2);
    };
    await until(1);
    const second = await post(w.plugin, larry, csrf, "/new/price", { url: `${SHOP}2`, near: "Price:" });
    expect(second.status).toBe(400);
    expect(await second.text()).toContain(READING);
    // Someone else is not held up by it.
    const curly = await signIn(w.plugin, CURLY);
    const other = post(w.plugin, curly, await csrfOf(w.plugin, curly), "/new/price", { url: `${SHOP}3`, near: "Price:" });
    await until(2);
    expect(reads).toEqual([SHOP, `${SHOP}3`]);
    release();
    expect((await first).status).toBe(303);
    expect((await other).status).toBe(303);
    expect((await post(w.plugin, larry, csrf, "/new/price", { url: `${SHOP}2`, near: "Price:" })).status).toBe(303);
  });

  it("edit: the name, interval, drop and baseline; never the page", async () => {
    const w = await setup();
    await post(w.plugin, w.larry, w.csrf, "/new/price", { url: SHOP, hours: "12" });
    const start = tasks(w.dbPath)[0]?.schedule?.start;
    const form = await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar: w.larry })).text();
    expect(form).toContain(`Page: ${SHOP}`);
    expect(form).not.toContain('name="url"');
    const res = await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { url: "https://elsewhere.example/", name: "Widget", hours: "24", drop: "20", baseline: "first" });
    expect(res.status).toBe(303);
    expect(tasks(w.dbPath)[0]).toMatchObject({
      title: "Widget",
      config: { url: SHOP, dropPercent: 20, baseline: "first" },
      schedule: { kind: "poll", every: 24, unit: "hour", start },
    });
    // An empty name goes back to the page's address.
    await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { name: "", hours: "24", drop: "20", baseline: "first" });
    expect(tasks(w.dbPath)[0]?.title).toBe("shop.example/widget");
    expect((await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { hours: "200" })).status).toBe(400);
    expect(w.shop.reads).toHaveLength(1);
  });
});

describe("pause, resume, delete", () => {
  it("pause holds the reminder; resume lets it go (late); each once, with the reason when refused", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "tea", when: "in 5 minutes" } });
    let res = await post(w.plugin, w.larry, w.csrf, "/tasks/t1/pause");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/tracker/tasks/t1?done=paused");
    expect(tasks(w.dbPath)[0]?.status).toBe("paused");
    const page = await (await call(w.plugin, "GET", "/tasks/t1?done=paused", { jar: w.larry })).text();
    expect(page).toContain("Paused: nothing is sent until you resume it.");
    expect(page).toContain('action="/tracker/tasks/t1/resume"');
    expect(page).not.toContain('action="/tracker/tasks/t1/pause"');

    res = await post(w.plugin, w.larry, w.csrf, "/tasks/t1/pause");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("That task is paused, not active.");

    w.clock.advance(10 * 60 * 1000);
    await notifyTick(w.plugin);
    expect(w.sent).toHaveLength(0);

    res = await post(w.plugin, w.larry, w.csrf, "/tasks/t1/resume");
    expect(res.headers.get("location")).toBe("/tracker/tasks/t1?done=resumed");
    await notifyTick(w.plugin);
    expect(w.sent).toHaveLength(1);
    expect(events(w.dbPath, "t1")).toEqual(["created", "paused: paused by the owner", "resumed: resumed by the owner"]);
    expect((await post(w.plugin, w.larry, w.csrf, "/tasks/t1/resume")).status).toBe(400);
  });

  it("/task resume in Discord resumes a task paused on the web: one rule", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "tea", repeat: "day" } });
    await post(w.plugin, w.larry, w.csrf, "/tasks/t1/pause");
    expect(await slash(w.plugin, "task", LARRY, { sub: "resume", strings: { task: "t1" } })).toBe("Resumed `t1`.");
    expect(tasks(w.dbPath)[0]?.status).toBe("active");
  });

  it("delete asks first, then archives: gone from the lists, nothing more sent, the history kept", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "<i>bins</i>", when: "in 5 minutes" } });
    const ask = await post(w.plugin, w.larry, w.csrf, "/tasks/t1/delete");
    expect(ask.status).toBe(200);
    const confirm = await ask.text();
    expect(confirm).toContain("Delete &lt;i&gt;bins&lt;/i&gt;?");
    expect(confirm).toContain('name="confirm" value="yes"');
    expect(hidden(confirm, "csrf")).toBe(w.csrf);
    expect(tasks(w.dbPath)[0]?.status).toBe("active");
    // A GET never deletes.
    expect((await call(w.plugin, "GET", "/tasks/t1/delete?confirm=yes", { jar: w.larry })).status).toBe(405);

    const res = await post(w.plugin, w.larry, w.csrf, "/tasks/t1/delete", { confirm: "yes" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/tracker/?done=deleted");
    expect(tasks(w.dbPath)[0]?.status).toBe("archived");
    expect(queued(w.dbPath, "t1")).toEqual([]);
    const home = await (await call(w.plugin, "GET", "/?done=deleted", { jar: w.larry })).text();
    expect(home).toContain("Deleted. Its history is kept.");
    expect(home).not.toContain("bins");
    expect(await slash(w.plugin, "tasks", LARRY)).toBe("You have no active tasks.");
    w.clock.advance(10 * 60 * 1000);
    await notifyTick(w.plugin);
    expect(w.sent).toHaveLength(0);

    // Its page stays, with no controls; every act on it is the unknown-id 404.
    const page = await (await call(w.plugin, "GET", "/tasks/t1", { jar: w.larry })).text();
    expect(page).toContain("reminder, deleted");
    expect(page).not.toContain("/tasks/t1/edit");
    expect((await call(w.plugin, "GET", "/tasks/t1/edit", { jar: w.larry })).status).toBe(404);
    for (const act of ["edit", "pause", "resume", "delete"]) {
      expect((await post(w.plugin, w.larry, w.csrf, `/tasks/t1/${act}`, { confirm: "yes", text: "x", repeat: "none" })).status).toBe(404);
    }
    expect(await slash(w.plugin, "task", LARRY, { sub: "resume", strings: { task: "t1" } })).toBe(NO_SUCH_TASK);
  });

  it("a finished task cannot be edited, only deleted", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "tea", when: "in 5 minutes" } });
    const db = new Database(w.dbPath);
    db.query("UPDATE tasks SET status = 'done' WHERE seq = 1").run();
    db.close();
    const get = await call(w.plugin, "GET", "/tasks/t1/edit", { jar: w.larry });
    expect(get.status).toBe(303);
    expect(get.headers.get("location")).toBe("/tracker/tasks/t1");
    const res = await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { text: "coffee", when: "tomorrow", repeat: "none" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("That task has finished");
    expect(tasks(w.dbPath)[0]?.title).toBe("tea");
    expect((await post(w.plugin, w.larry, w.csrf, "/tasks/t1/pause")).status).toBe(400);
    expect((await post(w.plugin, w.larry, w.csrf, "/tasks/t1/delete", { confirm: "yes" })).status).toBe(303);
  });
});

describe("only the owner", () => {
  it("anyone else's task -- another person's, or one an admin can see -- is the unknown id's 404, and is untouched", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "Larry's", when: "tomorrow", repeat: "day" } });
    for (const who of [CURLY, ADMIN]) {
      const jar = await signIn(w.plugin, who);
      const csrf = await csrfOf(w.plugin, jar);
      const unknown = await (await call(w.plugin, "GET", "/tasks/t999/edit", { jar })).text();
      const edit = await call(w.plugin, "GET", "/tasks/t1/edit", { jar });
      expect(edit.status).toBe(404);
      expect(await edit.text()).toBe(unknown);
      for (const act of ["edit", "pause", "resume", "delete"]) {
        const res = await post(w.plugin, jar, csrf, `/tasks/t1/${act}`, { confirm: "yes", text: "mine now", when: "", repeat: "day" });
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("Larry");
      }
    }
    // The admin sees the history, with no owner's controls on it.
    const admin = await signIn(w.plugin, ADMIN);
    const page = await (await call(w.plugin, "GET", "/tasks/t1", { jar: admin })).text();
    expect(page).toContain("Larry&#39;s");
    expect(page).not.toContain("/tasks/t1/pause");
    expect(tasks(w.dbPath)[0]).toMatchObject({ title: "Larry's", status: "active" });
    expect(events(w.dbPath, "t1")).toEqual(["created"]);
  });

  it("an id that is encoded, padded or made up is only ever looked up", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "tea", repeat: "day" } });
    expect((await call(w.plugin, "GET", "/tasks/%74%31/edit", { jar: w.larry })).status).toBe(200);
    expect((await call(w.plugin, "GET", "/tasks/%E0%A4%A/edit", { jar: w.larry })).status).toBe(404);
    expect((await post(w.plugin, w.larry, w.csrf, "/tasks/..%2Ft1/pause")).status).toBe(404);
    expect((await post(w.plugin, w.larry, w.csrf, "/tasks/t1%2Fpause/pause")).status).toBe(404);
    expect(tasks(w.dbPath)[0]?.status).toBe("active");
  });
});

describe("the gates", () => {
  it("every editor post needs the session's CSRF token and this Origin; nothing changes without them", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "tea", repeat: "day" } });
    const curly = await csrfOf(w.plugin, await signIn(w.plugin, CURLY));
    const forms: [string, Record<string, string>][] = [
      ["/new/reminder", { text: "x", when: "tomorrow", repeat: "none" }],
      ["/tasks/t1/edit", { text: "x", when: "", repeat: "day" }],
      ["/tasks/t1/pause", {}],
      ["/tasks/t1/delete", { confirm: "yes" }],
    ];
    for (const [path, form] of forms) {
      expect((await call(w.plugin, "POST", path, { jar: w.larry, form, origin: ORIGIN })).status).toBe(403);
      expect((await call(w.plugin, "POST", path, { jar: w.larry, form: { ...form, csrf: "" }, origin: ORIGIN })).status).toBe(403);
      expect((await call(w.plugin, "POST", path, { jar: w.larry, form: { ...form, csrf: curly }, origin: ORIGIN })).status).toBe(403);
      expect((await call(w.plugin, "POST", path, { jar: w.larry, form: { ...form, csrf: w.csrf }, origin: "https://evil.example.net" })).status).toBe(403);
      expect((await call(w.plugin, "POST", path, { jar: w.larry, form: { ...form, csrf: w.csrf }, origin: "null" })).status).toBe(403);
      // Not signed in: sent to sign in, before the form is read.
      const anon = await call(w.plugin, "POST", path, { form: { ...form, csrf: w.csrf }, origin: ORIGIN });
      expect(anon.status).toBe(303);
      expect(anon.headers.get("location")).toBe("/tracker/signin");
    }
    expect(tasks(w.dbPath)).toHaveLength(1);
    expect(tasks(w.dbPath)[0]).toMatchObject({ title: "tea", status: "active" });
  });

  it("methods: forms are GET and POST, acts POST only; an unknown type or act is 404", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "tea", repeat: "day" } });
    for (const act of ["pause", "resume", "delete"]) {
      const res = await call(w.plugin, "GET", `/tasks/t1/${act}`, { jar: w.larry });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
    const put = await call(w.plugin, "PUT", "/new/reminder", { jar: w.larry });
    expect(put.status).toBe(405);
    expect((await call(w.plugin, "POST", "/tasks/t1", { jar: w.larry, form: { csrf: w.csrf }, origin: ORIGIN })).headers.get("allow")).toBe("GET");
    expect((await call(w.plugin, "GET", "/new/chore", { jar: w.larry })).status).toBe(404);
    expect((await call(w.plugin, "GET", "/new/", { jar: w.larry })).status).toBe(404);
    expect((await post(w.plugin, w.larry, w.csrf, "/tasks/t1/archive")).status).toBe(404);
    expect(tasks(w.dbPath)[0]?.status).toBe("active");
  });

  it("a body over the cap, declared or not, or not a form, is refused before it is read", async () => {
    const w = await setup();
    const big = { csrf: w.csrf, text: "x".repeat(MAX_FORM_BYTES), when: "tomorrow", repeat: "none" };
    expect((await call(w.plugin, "POST", "/new/reminder", { jar: w.larry, form: big, origin: ORIGIN })).status).toBe(400);
    const lying = await call(w.plugin, "POST", "/new/reminder", {
      jar: w.larry,
      form: { csrf: w.csrf, text: "tea", when: "tomorrow", repeat: "none" },
      origin: ORIGIN,
      headers: { "content-length": String(MAX_FORM_BYTES + 1) },
    });
    expect(lying.status).toBe(400);
    const json = await call(w.plugin, "POST", "/new/reminder", {
      jar: w.larry,
      origin: ORIGIN,
      headers: { "content-type": "application/json" },
    });
    expect(json.status).toBe(400);
    // The longest reminder, in a script that percent-encodes to nine bytes a character, fits.
    const long = { text: "\u3042".repeat(1500), when: "tomorrow", repeat: "none" };
    expect((await post(w.plugin, w.larry, w.csrf, "/new/reminder", long)).status).toBe(303);
    expect(tasks(w.dbPath)).toHaveLength(1);
  });

  it("the page names only fixed notices: nothing from the address is echoed", async () => {
    const w = await setup();
    const body = await (await call(w.plugin, "GET", "/?done=%3Cscript%3Ealert(1)%3C/script%3E", { jar: w.larry })).text();
    expect(body).not.toContain("alert(1)");
    expect(await (await call(w.plugin, "GET", "/?done=constructor", { jar: w.larry })).text()).not.toContain('role="status"');
    const home = await (await call(w.plugin, "GET", "/", { jar: w.larry })).text();
    expect(home).toContain('href="/tracker/new/reminder"');
    expect(home).toContain('href="/tracker/new/price"');
  });
});

function field(body: string, name: string): string {
  const m = new RegExp(`name="${name}" type="[a-z]+" value="([^"]*)"`).exec(body);
  if (!m) throw new Error(`no field ${name}`);
  return m[1] ?? "";
}

function deliveryPausedAt(dbPath: string, userId: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query("SELECT paused_at FROM delivery_health WHERE user_id = ?").get(userId) as { paused_at: string | null } | null;
  db.close();
  return row?.paused_at ?? null;
}

describe("review fixes", () => {
  it("a person's delivery pausing and resuming leaves a task they paused themselves paused", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "mine, paused", repeat: "day" } });
    await post(w.plugin, w.larry, w.csrf, "/tasks/t1/pause");
    for (const text of ["a", "b", "c"]) await slash(w.plugin, "remind", LARRY, { strings: { text, when: "in 5 minutes" } });
    w.delivery.refuse = true;
    w.clock.advance(10 * 60 * 1000);
    await notifyTick(w.plugin);
    expect(deliveryPausedAt(w.dbPath, "u2")).not.toBeNull();
    expect(events(w.dbPath, "t1")).toEqual(["created", "paused: paused by the owner"]);
    // Using a command resumes the person's delivery; their own pause stays.
    w.delivery.refuse = false;
    expect(await slash(w.plugin, "tasks", LARRY)).toContain("I could not DM you 3 times in a row");
    expect(deliveryPausedAt(w.dbPath, "u2")).toBeNull();
    expect(tasks(w.dbPath)[0]?.status).toBe("paused");
  });

  it("a renewal saved unchanged after its anchor passed keeps its schedule: the 31st stays the 31st", async () => {
    const w = await setup();
    await post(w.plugin, w.larry, w.csrf, "/new/renewal", { name: "Gym", amount: "30", currency: "USD", renews: "2026-10-31", unit: "month", every: "1", lead: "3" });
    const stored = tasks(w.dbPath)[0]?.schedule;
    w.clock.set("2026-10-28T14:00:00.000Z");
    await notifyTick(w.plugin);
    w.clock.set("2026-11-02T14:00:00.000Z");
    const before = queued(w.dbPath, "t1");
    // A month on, the first session has expired: sign in again.
    const jar = await signIn(w.plugin, LARRY);
    const csrf = await csrfOf(w.plugin, jar);
    const form = await (await call(w.plugin, "GET", "/tasks/t1/edit", { jar })).text();
    expect(field(form, "renews")).toBe("2026-11-30");
    const values = { name: "Gym", amount: field(form, "amount"), currency: "USD", renews: field(form, "renews"), unit: "month", every: "1", lead: "3" };
    expect((await post(w.plugin, jar, csrf, "/tasks/t1/edit", values)).status).toBe(303);
    expect(tasks(w.dbPath)[0]?.schedule).toEqual(stored ?? null);
    expect(queued(w.dbPath, "t1")).toEqual(before);
    expect(events(w.dbPath, "t1")).toEqual(["created"]);
    // A date that is not one of its period dates re-anchors.
    await post(w.plugin, jar, csrf, "/tasks/t1/edit", { ...values, renews: "2026-11-15" });
    expect(tasks(w.dbPath)[0]?.schedule).toMatchObject({ anchor: "2026-11-15" });
  });

  it("a zone or hour change moves a paused task's queued run too, so resume does not fire it at the old time", async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "stretch", repeat: "day" } });
    expect(queued(w.dbPath, "t1")).toEqual(["2026-10-01T13:00:00.000Z"]);
    await post(w.plugin, w.larry, w.csrf, "/tasks/t1/pause");
    await post(w.plugin, w.larry, w.csrf, "/settings", { hour: "9", zone: "Europe/London" });
    expect(queued(w.dbPath, "t1")).toEqual([]);
    await post(w.plugin, w.larry, w.csrf, "/tasks/t1/resume");
    expect(queued(w.dbPath, "t1")).toEqual(["2026-10-02T08:00:00.000Z"]);
  });

  it("an edit's empty or missing field keeps what the task has; an empty note clears it", async () => {
    const w = await setup();
    await post(w.plugin, w.larry, w.csrf, "/new/renewal", { name: "Domain", amount: "12", currency: "USD", renews: "2026-12-01", unit: "month", every: "2", lead: "10", note: "registrar" });
    await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { name: "", amount: "", currency: "", renews: "", every: "", lead: "" });
    expect(tasks(w.dbPath)[0]).toMatchObject({
      title: "Domain",
      config: { amount: 12, currency: "USD", note: "registrar" },
      schedule: { every: 2, unit: "month", anchor: "2026-12-01", leadDays: 10 },
    });
    expect(events(w.dbPath, "t1")).toEqual(["created"]);
    await post(w.plugin, w.larry, w.csrf, "/tasks/t1/edit", { note: "" });
    expect(tasks(w.dbPath)[0]?.config.note).toBeUndefined();

    await post(w.plugin, w.larry, w.csrf, "/new/price", { url: SHOP, name: "Widget", hours: "6", drop: "15", baseline: "peak" });
    await post(w.plugin, w.larry, w.csrf, "/tasks/t2/edit", { hours: "", drop: "" });
    expect(tasks(w.dbPath)[1]).toMatchObject({ title: "Widget", config: { dropPercent: 15, baseline: "peak" }, schedule: { every: 6 } });
    expect(events(w.dbPath, "t2")).toEqual(["created"]);

    await slash(w.plugin, "remind", LARRY, { strings: { text: "tea", repeat: "week" } });
    await post(w.plugin, w.larry, w.csrf, "/tasks/t3/edit", { text: " " });
    expect(tasks(w.dbPath)[2]).toMatchObject({ title: "tea", schedule: { unit: "week" } });
    expect(events(w.dbPath, "t3")).toEqual(["created"]);
  });

  it("the length limits hold on the server, and are one set of numbers for Discord, the forms and the checks", async () => {
    const w = await setup();
    let res = await post(w.plugin, w.larry, w.csrf, "/new/price", { url: `${SHOP}?${"q".repeat(MAX_URL)}` });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(`longer than ${MAX_URL} characters`);
    expect(w.shop.reads).toEqual([]);
    res = await post(w.plugin, w.larry, w.csrf, "/new/reminder", { text: "tea", when: `tomorrow${" ".repeat(MAX_WHEN)}9am`, repeat: "none" });
    expect(await res.text()).toContain(`longer than ${MAX_WHEN} characters`);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "tea", when: "in 5 minutes" } });
    expect(await slash(w.plugin, "task", LARRY, { sub: "snooze", strings: { task: "t1", until: "x".repeat(MAX_WHEN + 1) } })).toContain(`longer than ${MAX_WHEN}`);
    for (const [field, limit] of [["text", MAX_REMINDER_TEXT], ["when", MAX_WHEN]] as const) {
      expect(await (await call(w.plugin, "GET", "/new/reminder", { jar: w.larry })).text()).toContain(`name="${field}" type="text" value="" maxlength="${limit}"`);
    }
    const priceForm = await (await call(w.plugin, "GET", "/new/price", { jar: w.larry })).text();
    expect(priceForm).toContain(`name="url" type="url" value="" maxlength="${MAX_URL}"`);
    expect(priceForm).toContain(`name="near" type="text" value="" maxlength="${MAX_NEAR}"`);
    const price = w.plugin.commands!.find((c) => c.name === "price")!;
    const json = (price.build(new SlashCommandBuilder().setName("price")) as SlashCommandBuilder).toJSON();
    const max = Object.fromEntries((json.options ?? []).map((o) => [o.name, (o as { max_length?: number }).max_length]));
    expect(max).toMatchObject({ url: MAX_URL, name: MAX_TITLE, near: MAX_NEAR });
  });

  it(`at most ${MAX_LIVE_TASKS} active or paused tasks per person, of every type, in Discord and on the web alike`, async () => {
    const w = await setup();
    await slash(w.plugin, "remind", LARRY, { strings: { text: "tea", repeat: "day" } });
    const db = new Database(w.dbPath);
    const copy = db.query(
      "INSERT INTO tasks (owner_id, type, title, config, state, schedule, lane, capabilities, status, created_at, updated_at) SELECT owner_id, type, title, config, state, schedule, lane, capabilities, status, created_at, updated_at FROM tasks WHERE seq = 1",
    );
    for (let i = 1; i < MAX_LIVE_TASKS; i++) copy.run();
    db.close();
    const web = await post(w.plugin, w.larry, w.csrf, "/new/renewal", { name: "Gym", amount: "30", currency: "USD", renews: "2026-12-01" });
    expect(web.status).toBe(400);
    expect(await web.text()).toContain(`You already have ${MAX_LIVE_TASKS} active or paused tasks`);
    expect(await slash(w.plugin, "remind", LARRY, { strings: { text: "more", when: "tomorrow" } })).toBe(
      `You already have ${MAX_LIVE_TASKS} active or paused tasks, the most one person may. Finish one or delete one on the web first.`,
    );
    expect((await post(w.plugin, w.larry, w.csrf, "/new/price", { url: SHOP })).status).toBe(400);
    expect(w.shop.reads).toEqual([]);
    await post(w.plugin, w.larry, w.csrf, "/tasks/t1/delete", { confirm: "yes" });
    expect((await post(w.plugin, w.larry, w.csrf, "/new/reminder", { text: "more", when: "tomorrow", repeat: "none" })).status).toBe(303);
  });

  it("the cap messages mention the web only when there is one", async () => {
    const { s, fetch } = shop();
    s.price = 5;
    const w = await world({ webUrl: null, fetch });
    await people(w.plugin);
    for (let i = 0; i < MAX_PRICE_TASKS; i++) await slash(w.plugin, "price", LARRY, { strings: { url: `${SHOP}${i}` } });
    const answer = await slash(w.plugin, "price", LARRY, { strings: { url: SHOP } });
    expect(answer).toBe(`You already track ${MAX_PRICE_TASKS} prices, the most one person may. Stop one with \`/task done\` first.`);
  });
});
