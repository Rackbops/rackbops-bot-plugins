import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { Plugin } from "../../../../packages/api/contract.js";
import { TASK_BUSY } from "../locks.js";
import { MAX_CONTEXT_CHARS, MAX_LIVE_RESEARCH, MAX_QUESTION_CHARS, RESEARCH_OFF, SHORT_QUESTION } from "../research.js";
import { NOT_EDITABLE, NOT_FOUND_MESSAGE, refusal } from "./api-tasks.js";
import { researchInput } from "./form-input.js";
import { api, call, cleanup, csrfOf, CURLY, hidden, type Jar, LARRY, makeToken, ORIGIN, people, signIn, slash, world } from "./harness.js";

/**
 * A research request from the web editor and the JSON task API (rackbops-bot-plugins#82; plan 1.4's
 * web component, 5.10's task editor, item 67's API): made by `/research`'s own rules through the
 * editor's shared `makeTask`, offered only while research is available, and paused, resumed or
 * deleted like any task but never edited. Nothing here reaches city-hall: making a request only
 * queues its run, which the execute tick (research.test.ts) submits.
 */

afterEach(cleanup);

const CITY_HALL = {
  TRACKER_CITY_HALL_URL: "https://city-hall.example.com",
  TRACKER_CITY_HALL_KEY: "source-key-never-logged",
  TRACKER_CITY_HALL_CAPABILITY: "claude-cli:subscription",
};

async function setup(on = true) {
  const cityHallCalls: string[] = [];
  const cityHallFetch = (async (input: string | URL | Request) => {
    cityHallCalls.push(String(input));
    return Response.json({ error: "not expected" }, { status: 500 });
  }) as typeof fetch;
  const w = await world(on ? { env: CITY_HALL, cityHallFetch } : {});
  await people(w.plugin);
  const larry = await signIn(w.plugin, LARRY);
  const csrf = await csrfOf(w.plugin, larry);
  const token = await makeToken(w, larry);
  return { ...w, larry, csrf, token, cityHallCalls };
}

function post(plugin: Plugin, jar: Jar, csrf: string, path: string, form: Record<string, string> = {}) {
  return call(plugin, "POST", path, { jar, form: { csrf, ...form }, origin: ORIGIN });
}

interface Row {
  id: string;
  type: string;
  title: string;
  status: string;
  config: Record<string, unknown>;
  schedule: Record<string, unknown> | null;
}

function tasks(dbPath: string): Row[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.query("SELECT seq, type, title, status, config, schedule FROM tasks ORDER BY seq").all() as Record<string, unknown>[];
  db.close();
  return rows.map((r) => ({
    id: `t${String(r.seq)}`,
    type: String(r.type),
    title: String(r.title),
    status: String(r.status),
    config: JSON.parse(String(r.config)),
    schedule: JSON.parse(String(r.schedule)),
  }));
}

// biome-ignore lint/suspicious/noExplicitAny: a test reads the API's JSON loosely.
async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("research from the web editor", () => {
  it("while research is off: no link, the page says why instead of a form, and a post makes nothing", async () => {
    const w = await setup(false);
    const list = await (await call(w.plugin, "GET", "/", { jar: w.larry })).text();
    expect(list).toContain('href="/tracker/new/reminder"');
    expect(list).not.toContain("/new/research");

    const page = await call(w.plugin, "GET", "/new/research", { jar: w.larry });
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain("Research is not available on this bot yet");
    expect(text).not.toContain('action="/tracker/new/research"');

    const res = await post(w.plugin, w.larry, w.csrf, "/new/research", { question: "What is X?" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Research is not available on this bot yet");
    expect(tasks(w.dbPath)).toEqual([]);
  });

  it("new: the form, then a request made by /research's rules, landing on its page; city-hall is not called", async () => {
    const w = await setup();
    const list = await (await call(w.plugin, "GET", "/", { jar: w.larry })).text();
    expect(list).toContain('href="/tracker/new/research"');

    const form = await call(w.plugin, "GET", "/new/research", { jar: w.larry });
    expect(form.status).toBe(200);
    const page = await form.text();
    expect(page).toContain('action="/tracker/new/research"');
    expect(hidden(page, "csrf")).toBe(w.csrf);
    expect(page).toContain(`<textarea class="rb-textarea" id="question" name="question" rows="4" maxlength="${MAX_QUESTION_CHARS}" required>`);
    expect(page).toContain(`maxlength="${MAX_CONTEXT_CHARS}"`);

    const fields = { question: "What is X?", context: "larry-private-context", deadline: "tomorrow 17:00", at: "" };
    const res = await post(w.plugin, w.larry, w.csrf, "/new/research", fields);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/tracker/tasks/t1?done=created");
    const landed = await (await call(w.plugin, "GET", "/tasks/t1?done=created", { jar: w.larry })).text();
    expect(landed).toContain("Created.");
    expect(landed).toContain('action="/tracker/tasks/t1/pause"');
    expect(landed).toContain('action="/tracker/tasks/t1/delete"');
    // No edit, here or in Discord.
    expect(landed).not.toContain('href="/tracker/tasks/t1/edit"');
    expect((await call(w.plugin, "GET", "/tasks/t1/edit", { jar: w.larry })).status).toBe(404);

    // The same words through /research make the same request.
    await slash(w.plugin, "research", LARRY, { strings: { question: "What is X?", context: "larry-private-context", deadline: "tomorrow 17:00" } });
    const [web, discord] = tasks(w.dbPath);
    expect(web?.type).toBe("research");
    expect(web?.title).toBe(discord?.title ?? "");
    expect(web?.config).toEqual(discord?.config ?? {});
    expect(web?.config).toMatchObject({ question: "What is X?", context: "larry-private-context" });
    expect(typeof web?.config.deadline).toBe("string");
    expect(web?.schedule).toEqual(discord?.schedule ?? null);
    expect(w.cityHallCalls).toEqual([]);
  });

  it("new: a refusal re-renders the form with what was typed, escaped, and the reason; nothing is made", async () => {
    const w = await setup();
    for (const [form, reason] of [
      [{ question: "  " }, "Say what to look into."],
      [{ question: "0", context: "What is Q?" }, "Put the whole question in <code>question</code>: it needs at least 3 characters"],
      [{ question: `<b>"hi"</b>`, deadline: "blorp" }, "<code>deadline</code>:"],
      [{ question: `<b>"hi"</b>`, at: "tomorrow 9am", deadline: "tomorrow 8am" }, "The deadline has to be after the research starts."],
      [{ question: "x".repeat(MAX_QUESTION_CHARS + 1) }, `longer than ${MAX_QUESTION_CHARS} characters`],
      [{ question: "hello", context: "x".repeat(MAX_CONTEXT_CHARS + 1) }, `<code>context</code> is longer than ${MAX_CONTEXT_CHARS} characters.`],
    ] as const) {
      const res = await post(w.plugin, w.larry, w.csrf, "/new/research", form);
      expect(res.status).toBe(400);
      const page = await res.text();
      expect(page).toContain('role="alert"');
      expect(page).toContain(reason);
      expect(page).not.toContain("<b>");
      if (form.question.startsWith("<b>")) expect(page).toContain(">&lt;b&gt;&quot;hi&quot;&lt;/b&gt;</textarea>");
    }
    expect(tasks(w.dbPath)).toEqual([]);
  });

  it("the waiting cap is /research's, counted across Discord and the web; pause, resume and delete work", async () => {
    const w = await setup();
    for (let i = 0; i < MAX_LIVE_RESEARCH - 1; i++) await slash(w.plugin, "research", LARRY, { strings: { question: `Question ${i}` } });
    expect((await post(w.plugin, w.larry, w.csrf, "/new/research", { question: "one more" })).status).toBe(303);
    const over = await post(w.plugin, w.larry, w.csrf, "/new/research", { question: "too many" });
    expect(over.status).toBe(400);
    expect(await over.text()).toContain(`You already have ${MAX_LIVE_RESEARCH} research requests waiting`);
    expect(tasks(w.dbPath).length).toBe(MAX_LIVE_RESEARCH);

    const last = `t${MAX_LIVE_RESEARCH}`;
    expect((await post(w.plugin, w.larry, w.csrf, `/tasks/${last}/pause`)).status).toBe(303);
    expect(tasks(w.dbPath).at(-1)?.status).toBe("paused");
    expect((await post(w.plugin, w.larry, w.csrf, `/tasks/${last}/resume`)).status).toBe(303);
    expect((await post(w.plugin, w.larry, w.csrf, `/tasks/${last}/delete`, { confirm: "yes" })).status).toBe(303);
    expect(tasks(w.dbPath).at(-1)?.status).toBe("archived");
    // A deleted request frees its place.
    expect((await post(w.plugin, w.larry, w.csrf, "/new/research", { question: "now there is room" })).status).toBe(303);
  });
});

describe("research from the task API", () => {
  it("while research is off: GET /types leaves it out, and a create answers 503 in /research's words", async () => {
    const w = await setup(false);
    const types = await body(await api(w.plugin, "GET", "/types", { token: w.token }));
    expect(types.types.map((t: { type: string }) => t.type)).toEqual(["reminder", "renewal", "price"]);
    const res = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "research", question: "What is X?" } });
    expect(res.status).toBe(503);
    expect((await body(res)).error).toEqual({ code: "unavailable", message: RESEARCH_OFF });
    const bad = await body(await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "scout" } }));
    expect(bad.error.message).toBe("`type` is one of reminder, renewal, price.");
    expect(tasks(w.dbPath)).toEqual([]);
  });

  it("GET /types describes research's create fields, and says it takes no edit", async () => {
    const w = await setup();
    const types = await body(await api(w.plugin, "GET", "/types", { token: w.token }));
    expect(types.types.map((t: { type: string; editable: boolean }) => [t.type, t.editable])).toEqual([
      ["reminder", true],
      ["renewal", true],
      ["price", true],
      ["research", false],
    ]);
    const research = types.types[3];
    expect(research.create.map((f: { name: string; type: string; required: boolean }) => [f.name, f.type, f.required])).toEqual([
      ["question", "string", true],
      ["context", "string", false],
      ["deadline", "string", false],
      ["at", "string", false],
    ]);
    expect(research.create[0].maxLength).toBe(MAX_QUESTION_CHARS);
    expect(research.edit).toEqual([]);
    const bad = await body(await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "scout" } }));
    expect(bad.error.message).toBe("`type` is one of reminder, renewal, price, research.");
  });

  it("POST makes one by /research's rules; it reads back to its owner only, and a PATCH answers 409", async () => {
    const w = await setup();
    const res = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "research", question: "What is X?", context: "larry-private-context", deadline: "tomorrow 17:00" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe("/tracker/api/v1/tasks/t1");
    const made = await body(res);
    expect(made.message).toContain("Research `t1` queued");
    expect(made.task).toMatchObject({ id: "t1", type: "research", status: "active", title: "What is X?" });
    expect(made.task.settings).toMatchObject({ question: "What is X?", context: "larry-private-context" });
    expect(typeof made.task.settings.deadline).toBe("string");
    expect(typeof made.task.nextAt).toBe("string");

    const read = await body(await api(w.plugin, "GET", "/tasks/t1", { token: w.token }));
    expect(read.task.settings.context).toBe("larry-private-context");
    expect(read.findings).toEqual([]);

    // Curly's token: Larry's request is the unknown task, to a read and to an edit.
    const curly = await makeToken(w, await signIn(w.plugin, CURLY));
    const theirs = await api(w.plugin, "GET", "/tasks/t1", { token: curly });
    expect(theirs.status).toBe(404);
    expect(JSON.stringify(await body(theirs))).not.toContain("larry-private-context");
    const theirEdit = await api(w.plugin, "PATCH", "/tasks/t1", { token: curly, body: { question: "mine now" } });
    expect(theirEdit.status).toBe(404);
    expect((await body(theirEdit)).error.message).toBe(NOT_FOUND_MESSAGE);

    const edit = await api(w.plugin, "PATCH", "/tasks/t1", { token: w.token, body: { question: "Something else" } });
    expect(edit.status).toBe(409);
    expect((await body(edit)).error).toEqual({ code: "conflict", message: NOT_EDITABLE });
    expect(tasks(w.dbPath)[0]?.config.question).toBe("What is X?");

    expect((await api(w.plugin, "POST", "/tasks/t1/pause", { token: w.token, body: {} })).status).toBe(200);
    expect((await api(w.plugin, "DELETE", "/tasks/t1", { token: w.token })).status).toBe(200);
    expect(tasks(w.dbPath)[0]?.status).toBe("archived");
    expect(w.cityHallCalls).toEqual([]);
  });

  it("refusals: an unknown field by name, /research's own words as 400, and the waiting cap as 409", async () => {
    const w = await setup();
    const unknown = await body(await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "research", question: "What is Q?", model: "opus" } }));
    expect(unknown.error.code).toBe("unknown_field");
    const empty = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "research", question: " " } });
    expect(empty.status).toBe(400);
    expect((await body(empty)).error).toEqual({ code: "invalid", message: "Say what to look into." });
    const stray = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "research", question: "0", context: "What is Q?" } });
    expect(stray.status).toBe(400);
    expect((await body(stray)).error).toEqual({ code: "invalid", message: SHORT_QUESTION });
    const typed = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "research", question: 7 } });
    expect((await body(typed)).error.message).toBe("`question` must be a string.");

    for (let i = 0; i < MAX_LIVE_RESEARCH; i++) {
      expect((await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "research", question: `Question ${i}` } })).status).toBe(201);
    }
    const over = await api(w.plugin, "POST", "/tasks", { token: w.token, body: { type: "research", question: "too many" } });
    expect(over.status).toBe(409);
    expect((await body(over)).error.code).toBe("limit_reached");
  });

  it("a task the execute tick holds answers 409 busy, not 400", () => {
    expect(refusal(TASK_BUSY)).toEqual({ status: 409, body: { error: { code: "busy", message: TASK_BUSY } } });
  });
});

describe("researchInput", () => {
  it("keeps a typed line break one character, as the browser's maxlength counted it", () => {
    const form = new URLSearchParams({ question: "one\r\ntwo\rthree", context: "a\r\nb" });
    expect(researchInput(form)).toEqual({ question: "one\ntwo\nthree", context: "a\nb" });
  });
});
