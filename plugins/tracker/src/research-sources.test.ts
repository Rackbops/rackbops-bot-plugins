import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { gatheredPages } from "@rackbops/docket-types";
import { admit } from "./people.js";
import { BROWSER_AT, BROWSER_OFF } from "./research.js";
import { MAX_SOURCES_PER_TASK, ResearchSources } from "./research-sources.js";
import { Roster } from "./roster.js";
import { migrate, MIGRATIONS, openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";
import { ANSWER, CITY_HALL, dmsTo, query, setup, success } from "./web/execute-harness.js";
import { api, cleanup, CURLY, LARRY, makeToken, people, signIn, slash, START, world } from "./web/harness.js";

/**
 * Research on pages the person's own browser gathered (tracker 0.28.0, docket-types 0.8.0's
 * `sources: "sent"`, rackbops-bot-plugins#125): `/research sources: browser`, the `research_sources`
 * table (schema migration 11), the task API's `sources` and `sources/ready` routes, the execute lane
 * reading the pages into the run's prompt, the request that never gets its pages, and the pages
 * going when the request ends or its owner is forgotten.
 */

afterEach(cleanup);

const AT = new Date(START);
const page = (n: number, text = `Page ${n} says the game has ${n} players.`) => ({ url: `https://example.com/p${n}`, title: `Page ${n}`, text });

// biome-ignore lint/suspicious/noExplicitAny: a test reads the API's JSON loosely.
async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("migration 11", () => {
  it("adds research_sources and its index and nothing else", () => {
    const db = new Database(":memory:");
    for (let v = 0; v < 10; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v] as string);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
    const schema = () => db.query("SELECT type, name, sql FROM sqlite_master WHERE name != 'sqlite_sequence' ORDER BY name").all() as { name: string }[];
    const before = schema();
    expect(migrate(db)).toBe(10);
    expect(MIGRATIONS).toHaveLength(11);
    expect(schema().filter((s) => !s.name.includes("research_sources"))).toEqual(before);
    expect(schema().filter((s) => s.name.includes("research_sources")).map((s) => s.name)).toEqual(["research_sources", "research_sources_task", "sqlite_autoindex_research_sources_1"]);
  });
});

describe("ResearchSources", () => {
  it("stores cleaned pages oldest first, replaces a page sent again in its place, and refuses an 11th", () => {
    const db = openDatabase(":memory:");
    const sources = new ResearchSources(db);
    expect(sources.add("t1", gatheredPages([page(1), page(2)]), AT)).toEqual({ ok: true, added: 2, replaced: 0, held: 2 });
    expect(sources.add("t1", gatheredPages([page(1, "Page 1, read again.")]), AT)).toEqual({ ok: true, added: 0, replaced: 1, held: 2 });
    expect(sources.read("t1")).toEqual([
      { url: "https://example.com/p1", title: "Page 1", text: "Page 1, read again." },
      { url: "https://example.com/p2", title: "Page 2", text: "Page 2 says the game has 2 players." },
    ]);
    const more = gatheredPages([3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => page(n)));
    expect(sources.add("t1", more, AT)).toEqual({ ok: false, held: 2 });
    expect(sources.count("t1")).toBe(2);
    expect(sources.add("t1", more.slice(0, MAX_SOURCES_PER_TASK - 2), AT)).toMatchObject({ ok: true, held: MAX_SOURCES_PER_TASK });
    expect(sources.read("t2")).toEqual([]);
  });

  it("purgeEnded drops the pages of requests no longer active or paused; forget-me drops their owner's", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteStore(db);
    const larry = await admit(store, "111111111111111111", AT);
    const curly = await admit(store, "222222222222222222", AT);
    const make = (ownerId: string) =>
      store.createTask({ ownerId, type: "research", title: "Q", config: { question: "Q?", sources: "sent" }, schedule: null, lane: "execute", capabilities: ["notify"], at: START });
    const live = await make(larry.id);
    const ended = await make(larry.id);
    const theirs = await make(curly.id);
    await store.updateTask(ended.id, { status: "done", at: START });
    const sources = new ResearchSources(db);
    for (const t of [live, ended, theirs]) sources.add(t.id, gatheredPages([page(1)]), AT);
    expect(sources.purgeEnded()).toBe(1);
    expect([sources.count(live.id), sources.count(ended.id), sources.count(theirs.id)]).toEqual([1, 0, 1]);
    const erased = new Roster(db).erase(larry.id);
    expect(erased.rows.research_sources).toBe(1);
    expect([sources.count(live.id), sources.count(theirs.id)]).toEqual([0, 1]);
  });
});

describe("/research sources: browser", () => {
  it("waits for pages: config sources sent, its run at 14 days out, `at` refused, the web reply unchanged", async () => {
    const w = await setup();
    const web = await slash(w.plugin, "research", LARRY, { strings: { question: "What is X?" } });
    expect(web).toBe(
      "Research `t1` queued: What is X?\nStarts within a minute or two. A second run checks the answer against its sources before I DM it to you, so it can take a while; " +
        "an answer that does not pass the check is not sent. Requests share a daily budget.",
    );
    const made = await slash(w.plugin, "research", LARRY, { strings: { question: "How many players does Y take?", sources: "browser" } });
    expect(made).toContain("Research `t2` is waiting for pages");
    expect(made).toContain("Claude in Chrome");
    expect(made).toContain("your own browser");
    expect(made).toContain("POST /api/v1/tasks/t2/sources");
    expect(made).toContain("nothing is run");
    const rows = query<{ config: string; schedule: string }>(w.dbPath, "SELECT config, schedule FROM tasks ORDER BY seq");
    expect(JSON.parse(rows[0]?.config ?? "")).toEqual({ question: "What is X?" });
    expect(JSON.parse(rows[1]?.config ?? "")).toEqual({ question: "How many players does Y take?", sources: "sent" });
    expect(JSON.parse(rows[1]?.schedule ?? "")).toEqual({ kind: "once", at: "2026-10-15T12:00:00.000Z" });

    // A deadline sooner than that is when it runs.
    await slash(w.plugin, "research", LARRY, { strings: { question: "What about Z?", sources: "browser", deadline: "tomorrow 17:00" } });
    const [third] = query<{ config: string; schedule: string }>(w.dbPath, "SELECT config, schedule FROM tasks WHERE seq = 3");
    expect(JSON.parse(third?.schedule ?? "").at).toBe(JSON.parse(third?.config ?? "").deadline);

    expect(await slash(w.plugin, "research", LARRY, { strings: { question: "What about W?", sources: "browser", at: "tomorrow 9am" } })).toBe(BROWSER_AT);
    expect(query(w.dbPath, "SELECT seq FROM tasks")).toHaveLength(3);

    // /tasks says it waits, and how many pages are in.
    expect(await slash(w.plugin, "tasks", LARRY)).toContain("(sources: browser, 0 pages in; waiting for pages)");
  });

  it("is refused without the web area, whose task API the pages arrive through", async () => {
    const off = await world({ webUrl: null, env: CITY_HALL });
    await people(off.plugin);
    expect(await slash(off.plugin, "research", LARRY, { strings: { question: "What is X?", sources: "browser" } })).toBe(BROWSER_OFF);
  });

  it("a request whose pages never come ends at its expiry with no model call", async () => {
    const w = await setup();
    await slash(w.plugin, "research", LARRY, { strings: { question: "How many players does Y take?", sources: "browser" } });
    await w.round();
    expect(w.city.jobs.size).toBe(0);
    w.clock.set("2026-10-15T12:01:00.000Z");
    await w.round();
    expect(w.city.jobs.size).toBe(0);
    expect(dmsTo(w.sent, LARRY).some((c) => c.includes("No pages were gathered, so nothing was run"))).toBe(true);
    expect(query(w.dbPath, "SELECT status FROM tasks")).toEqual([{ status: "done" }]);
  });
});

describe("the task API's sources routes", () => {
  async function ready() {
    const w = await setup();
    await slash(w.plugin, "research", LARRY, { strings: { question: "How many players does Y take?", sources: "browser" } });
    await slash(w.plugin, "research", LARRY, { strings: { question: "What is X?" } });
    const larry = await signIn(w.plugin, LARRY);
    const token = await makeToken({ plugin: w.plugin, sent: w.sent }, larry);
    const curlyToken = await makeToken({ plugin: w.plugin, sent: w.sent }, await signIn(w.plugin, CURLY), "curly-agent");
    return { ...w, token, curlyToken };
  }

  it("takes cleaned pages, dedupes and replaces by address, caps them, and refuses others' and web requests", async () => {
    const w = await ready();
    const send = (pages: unknown, token = w.token, id = "t1") => api(w.plugin, "POST", `/tasks/${id}/sources`, { token, body: { pages } });

    const first = await send([page(1), page(1), { url: "javascript:alert(1)", text: "x" }]);
    expect(first.status).toBe(200);
    expect(await body(first)).toMatchObject({ accepted: 1, rejected: 2, pages: 1 });
    const again = await body(await send([page(1, "Page 1, read again: 4 players.")]));
    expect(again).toMatchObject({ accepted: 1, rejected: 0, pages: 1 });
    expect(again.message).toContain("1 replaced");
    expect(query(w.dbPath, "SELECT task_id, url, text FROM research_sources")).toEqual([{ task_id: "t1", url: "https://example.com/p1", text: "Page 1, read again: 4 players." }]);

    // Eleven in one request, or more than ten in all.
    expect(await body(await send([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => page(n))))).toMatchObject({ error: { code: "too_many" } });
    const over = await send([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => page(n)));
    expect(over.status).toBe(409);
    expect((await body(over)).error.message).toContain("this one holds 1");

    // Someone else's, unknown: the same 404. A web request: 409. Junk: 400.
    expect((await send([page(2)], w.curlyToken)).status).toBe(404);
    expect((await send([page(2)], w.token, "t99")).status).toBe(404);
    expect((await send([page(2)], w.token, "t2")).status).toBe(409);
    expect((await send("nope")).status).toBe(400);
    expect((await api(w.plugin, "POST", "/tasks/t1/sources", { token: w.token, body: { pages: [page(2)], more: 1 } })).status).toBe(400);
    expect((await api(w.plugin, "GET", "/tasks/t1/sources", { token: w.token })).status).toBe(405);

    // Its JSON says where its pages come from, how many are in, and that it waits.
    const read = await body(await api(w.plugin, "GET", "/tasks/t1", { token: w.token }));
    expect(read.task).toMatchObject({ sources: "sent", pages: 1, waitingForPages: true });
    expect(read.task.settings.sources).toBe("browser");
    const web = await body(await api(w.plugin, "GET", "/tasks/t2", { token: w.token }));
    expect(web.task.sources).toBeUndefined();
    expect(web.task.settings.sources).toBe("web");
  });

  it("ready needs a page, then moves the run to now; the run's prompt carries the pages, and they go once it ends", async () => {
    const w = await ready();
    const readyOf = (id = "t1", token = w.token) => api(w.plugin, "POST", `/tasks/${id}/sources/ready`, { token, body: {} });
    const none = await readyOf();
    expect(none.status).toBe(409);
    expect((await body(none)).error.message).toContain("Send pages first");
    expect((await readyOf("t2")).status).toBe(409);
    expect((await readyOf("t1", w.curlyToken)).status).toBe(404);
    expect((await api(w.plugin, "POST", "/tasks/t1/sources/ready", { token: w.token, body: { now: true } })).status).toBe(400);

    await api(w.plugin, "POST", "/tasks/t1/sources", { token: w.token, body: { pages: [page(1, "BGG says Y takes 2 to 4 players."), page(2)] } });
    const go = await readyOf();
    expect(go.status).toBe(200);
    expect((await body(go)).pages).toBe(2);
    expect(JSON.parse(query<{ schedule: string }>(w.dbPath, "SELECT schedule FROM tasks WHERE seq = 1")[0]?.schedule ?? "")).toEqual({ kind: "once", at: START });
    // No longer waiting: no more pages, no second ready.
    expect((await api(w.plugin, "POST", "/tasks/t1/sources", { token: w.token, body: { pages: [page(3)] } })).status).toBe(409);
    expect((await readyOf()).status).toBe(409);
    expect((await body(await api(w.plugin, "GET", "/tasks/t1", { token: w.token }))).task.waitingForPages).toBe(false);

    // The web request t2 goes, so the lane has only t1 to run.
    expect((await api(w.plugin, "DELETE", "/tasks/t2", { token: w.token })).status).toBe(200);
    await w.round();
    const job = [...w.city.jobs.values()].find((j) => j.spec.prompt.includes("How many players does Y take?"));
    expect(job?.spec.prompt).toContain("BGG says Y takes 2 to 4 players.");
    expect(job?.spec.prompt).toContain("https://example.com/p2");
    if (job) Object.assign(job, { status: "done", result: success(ANSWER, 0.4) });
    await w.round();
    await w.round();
    const review = [...w.city.jobs.values()].find((j) => j !== job && j.spec.prompt.includes("How many players does Y take?"));
    expect(review?.spec.prompt).toContain("BGG says Y takes 2 to 4 players.");
    if (review) Object.assign(review, { status: "done", result: success({ verdict: "approve", problems: [], answer: ANSWER }, 0.2) });
    await w.round();
    await w.round();
    expect(dmsTo(w.sent, LARRY).some((c) => c.startsWith("Research: How many players does Y take?"))).toBe(true);
    expect(query(w.dbPath, "SELECT status FROM tasks WHERE seq = 1")).toEqual([{ status: "done" }]);
    // Ended: its pages are gone at the execute tick's housekeeping.
    expect(query(w.dbPath, "SELECT * FROM research_sources")).toEqual([]);
  });
});
