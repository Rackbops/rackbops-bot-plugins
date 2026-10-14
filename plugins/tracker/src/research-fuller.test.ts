import { afterEach, describe, expect, it } from "bun:test";
import { DISPATCHER, SUBMITTED_EVENT } from "@rackbops/docket-core";
import { admit } from "./people.js";
import { MAX_LIVE_RESEARCH } from "./research.js";
import { awaitingPages, waitingForPages } from "./research-sources.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";
import { ANSWER, CITY_HALL, dmsTo, fakeCityHall, type FakeJob, query, setup, success } from "./web/execute-harness.js";
import { api, cleanup, LARRY, makeToken, people, signIn, slash, START, world } from "./web/harness.js";

/**
 * The fuller pass on pages a research run could not open (tracker 0.29.0, docket-types 0.9.0): a
 * web request whose first answer listed `blocked` pages DMs that reviewed answer and waits in phase
 * `awaiting-pages` on one queued follow-up at its expiry; the task API's sources routes take pages
 * for it, `ready` moves the once task to now and deletes the follow-up, and the second pass DMs an
 * "Update to" message.
 */

afterEach(cleanup);

const QUESTION = "How many players does Y take?";
const BLOCKED = [{ site: "BoardGameGeek", url: "https://boardgamegeek.com/boardgame/1/y", why: "403 to the runner" }];
const page = (n: number, text = `Page ${n} says Y takes ${n} to 4 players.`) => ({ url: `https://boardgamegeek.com/p${n}`, title: `Page ${n}`, text });

// biome-ignore lint/suspicious/noExplicitAny: a test reads the API's JSON loosely.
async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, unknown>;
}

type World = Awaited<ReturnType<typeof setup>>;

/** Answers the Job submitted last with `output`, then lets the lane collect it and queue what follows. */
async function answer(w: World, output: unknown, job: FakeJob | undefined = w.city.latest()) {
  if (job) Object.assign(job, { status: "done", result: success(output, 0.3) });
  await w.round();
  await w.round();
}

/** A web request whose first answer listed a blocked page, reviewed and DMed: it now waits for pages. */
async function awaiting(w: World, question = QUESTION) {
  await slash(w.plugin, "research", LARRY, { strings: { question } });
  await w.round();
  await answer(w, { ...ANSWER, blocked: BLOCKED });
  await answer(w, { verdict: "approve", problems: [], answer: ANSWER });
}

const followUps = (w: World) => query<{ status: string; due_at: string }>(w.dbPath, "SELECT status, due_at FROM occurrences WHERE dedupe_key LIKE 'followup:%' AND status = 'queued'");

async function ready(w: World) {
  const token = await makeToken({ plugin: w.plugin, sent: w.sent }, await signIn(w.plugin, LARRY));
  return { token, send: (pages: unknown, id = "t1") => api(w.plugin, "POST", `/tasks/${id}/sources`, { token, body: { pages } }), go: (id = "t1") => api(w.plugin, "POST", `/tasks/${id}/sources/ready`, { token, body: {} }) };
}

describe("awaitingPages", () => {
  const AT = new Date(START);
  const AWAITING = { phase: "awaiting-pages", failures: 0, draft: null, pass: 1, blocked: BLOCKED, earlier: { summary: "S.", findings: ANSWER.findings, uncertain: [] } };

  async function made(state: unknown = AWAITING) {
    const store = new SqliteStore(openDatabase(":memory:"));
    const larry = await admit(store, "111111111111111111", AT);
    const task = await store.createTask({ ownerId: larry.id, type: "research", title: "Q", config: { question: "Q?" }, schedule: { kind: "once", at: START }, lane: "execute", capabilities: ["notify"], at: START });
    await store.updateTask(task.id, { state, at: START });
    const first = await store.createOccurrence({ taskId: task.id, lane: "execute", dueAt: START, dedupeKey: `sched:${task.id}:${START}`, at: START });
    if (first) await store.updateOccurrence(first.id, { status: "done", finishedAt: START });
    const follow = await store.createOccurrence({ taskId: task.id, lane: "execute", dueAt: "2026-10-15T12:00:00.000Z", dedupeKey: `followup:${first?.id}`, at: START });
    if (!follow) throw new Error("no follow-up");
    const current = async () => (await store.getTask(task.id)) ?? task;
    return { store, task: current, follow };
  }

  it("is true on the one queued, unstarted follow-up of a live request in phase awaiting-pages", async () => {
    const m = await made();
    expect(await awaitingPages(m.store, await m.task())).toBe(true);
    expect(await waitingForPages(m.store, await m.task())).toBe(true);
    await m.store.updateTask((await m.task()).id, { status: "paused", at: START });
    expect(await awaitingPages(m.store, await m.task())).toBe(true);
  });

  it("is false in another phase, once the request ended, or with no follow-up", async () => {
    const review = await made({ phase: "review", failures: 0, draft: ANSWER });
    expect(await awaitingPages(review.store, await review.task())).toBe(false);
    const done = await made();
    await done.store.updateTask((await done.task()).id, { status: "done", at: START });
    expect(await awaitingPages(done.store, await done.task())).toBe(false);
    const gone = await made();
    await gone.store.deleteOccurrence(gone.follow.id);
    expect(await awaitingPages(gone.store, await gone.task())).toBe(false);
  });

  it("is false once the follow-up started, has its Job out, fired, or another run is queued beside it", async () => {
    const started = await made();
    await started.store.addEvent({ occurrenceId: started.follow.id, agent: DISPATCHER, type: "status", text: "started", at: START });
    expect(await awaitingPages(started.store, await started.task())).toBe(false);

    const out = await made();
    await out.store.addEvent({ occurrenceId: out.follow.id, agent: DISPATCHER, type: "status", text: SUBMITTED_EVENT, at: START });
    expect(await awaitingPages(out.store, await out.task())).toBe(false);

    const running = await made();
    await running.store.updateOccurrence(running.follow.id, { status: "running", startedAt: START });
    expect(await awaitingPages(running.store, await running.task())).toBe(false);

    const beside = await made();
    await beside.store.createOccurrence({ taskId: (await beside.task()).id, lane: "execute", dueAt: START, dedupeKey: "sched:beside", at: START });
    expect(await awaitingPages(beside.store, await beside.task())).toBe(false);
  });
});

describe("a web request waiting for pages for a fuller pass", () => {
  it("DMs its first answer once, then days of ticks send no DM and submit no Job", async () => {
    const w = await setup();
    await awaiting(w);
    const dms = dmsTo(w.sent, LARRY);
    expect(dms.filter((c) => c.startsWith("Research: How many players does Y take?"))).toHaveLength(1);
    expect(dms.at(-1)).toContain("Couldn't open:");
    expect(dms.at(-1)).toContain("t1");
    const jobs = w.city.jobs.size;
    expect(followUps(w)).toHaveLength(1);
    expect(query(w.dbPath, "SELECT status FROM tasks")).toEqual([{ status: "active" }]);
    for (let day = 0; day < 13; day++) {
      w.clock.advance(24 * 3_600_000);
      await w.round();
    }
    expect(dmsTo(w.sent, LARRY)).toEqual(dms);
    expect(w.city.jobs.size).toBe(jobs);
    expect(followUps(w)).toHaveLength(1);
  });

  it("the task JSON and /tasks say it waits, with what was blocked; settings.sources stays web", async () => {
    const w = await setup();
    await awaiting(w);
    const { token } = await ready(w);
    const read = await body(await api(w.plugin, "GET", "/tasks/t1", { token }));
    expect(read.task).toMatchObject({ sources: "web", pages: 0, waitingForPages: true, blocked: BLOCKED });
    expect(read.task.settings.sources).toBe("web");
    const listed = await body(await api(w.plugin, "GET", "/tasks", { token }));
    expect(listed.tasks.filter((t: { waitingForPages?: boolean }) => t.waitingForPages).map((t: { id: string }) => t.id)).toEqual(["t1"]);
    expect(await slash(w.plugin, "tasks", LARRY)).toContain("(0 pages in; waiting for pages for a fuller pass)");
  });

  it("takes pages; ready moves it to now and deletes the follow-up; the next tick runs the second pass on the pages, and the update is DMed", async () => {
    const w = await setup();
    await awaiting(w);
    const r = await ready(w);
    expect((await r.go()).status).toBe(409); // no page yet
    const took = await r.send([page(1, "BGG says Y takes 2 to 4 players, 5 with the expansion.")]);
    expect(took.status).toBe(200);
    expect(await body(took)).toMatchObject({ accepted: 1, pages: 1 });
    const go = await r.go();
    expect(go.status).toBe(200);
    expect((await body(go)).message).toContain("fuller pass");
    expect(followUps(w)).toEqual([]);
    expect(JSON.parse(query<{ schedule: string }>(w.dbPath, "SELECT schedule FROM tasks")[0]?.schedule ?? "")).toEqual({ kind: "once", at: w.clock.now().toISOString() });
    // No longer waiting: neither route takes it.
    expect((await r.send([page(2)])).status).toBe(409);
    expect((await r.go()).status).toBe(409);
    expect((await body(await api(w.plugin, "GET", "/tasks/t1", { token: r.token }))).task.waitingForPages).toBe(false);

    const jobs = w.city.jobs.size;
    await w.round();
    expect(w.city.jobs.size).toBe(jobs + 1);
    const pass2 = w.city.latest();
    expect(pass2?.spec.prompt).toContain("BGG says Y takes 2 to 4 players, 5 with the expansion.");
    // Its run started: still no pages, no ready.
    expect((await r.send([page(2)])).status).toBe(409);
    expect((await r.go()).status).toBe(409);
    const update = { summary: "Y takes 5 with its expansion.", findings: [{ claim: "Y takes 5 players with the expansion.", sources: ["https://boardgamegeek.com/p1"] }], uncertain: [] };
    await answer(w, update, pass2);
    expect(w.city.latest()?.spec.prompt).toContain("BGG says Y takes 2 to 4 players");
    await answer(w, { verdict: "approve", problems: [], answer: update });
    expect(dmsTo(w.sent, LARRY).some((c) => c.startsWith("Update to"))).toBe(true);
    expect(query(w.dbPath, "SELECT status FROM tasks")).toEqual([{ status: "done" }]);
    expect(query(w.dbPath, "SELECT * FROM research_sources")).toEqual([]);
  });

  it("ready is refused, changing nothing, while the follow-up's own Job is out at its expiry", async () => {
    const w = await setup();
    await awaiting(w);
    const r = await ready(w);
    await r.send([page(1)]);
    const [follow] = followUps(w);
    w.clock.set(follow?.due_at ?? "");
    const jobs = w.city.jobs.size;
    await w.round();
    // The follow-up ran at its expiry on the page in, and its Job is out (back to queued, pending).
    expect(w.city.jobs.size).toBe(jobs + 1);
    const refused = await r.go();
    expect(refused.status).toBe(409);
    expect((await body(refused)).error.message).toContain("fuller pass has already started");
    const more = await r.send([page(2)]);
    expect(more.status).toBe(409);
    const said = (await body(more)).error.message;
    expect(said).toContain("no longer waiting for pages");
    expect(said).not.toContain("searches the web itself");
    expect(query(w.dbPath, "SELECT dedupe_key FROM occurrences WHERE status IN ('queued', 'running') AND dedupe_key NOT LIKE 'followup:%'")).toEqual([]);
    expect(query<{ n: number }>(w.dbPath, "SELECT COUNT(*) AS n FROM occurrences WHERE dedupe_key LIKE 'followup:%' AND status IN ('queued', 'running')")[0]?.n).toBe(1);
    expect(w.city.latest()?.spec.prompt).not.toContain("https://boardgamegeek.com/p2");
  });

  it("a second-pass try that fails retryably is its retry, not a wait: no pages, no ready, waitingForPages false", async () => {
    const w = await setup();
    await awaiting(w);
    const r = await ready(w);
    expect((await r.send([page(1)])).status).toBe(200);
    expect((await r.go()).status).toBe(200);
    await w.round();
    const pass2 = w.city.latest();
    expect(pass2?.spec.prompt).toContain("Page 1 says");
    if (pass2) Object.assign(pass2, { status: "done", result: { kind: "auth_failed", detail: "signed out" } });
    await w.round();
    // docket-types keeps the phase, counts the failure, and queues a fresh follow-up after the auth backoff.
    const state = JSON.parse(query<{ state: string }>(w.dbPath, "SELECT state FROM tasks")[0]?.state ?? "{}");
    expect(state).toMatchObject({ phase: "awaiting-pages", failures: 1 });
    expect(followUps(w)).toHaveLength(1);
    const [retry] = followUps(w);
    const sent = await r.send([page(2)]);
    expect(sent.status).toBe(409);
    expect((await body(sent)).error.message).toContain("fuller pass has already started");
    expect((await r.go()).status).toBe(409);
    expect(followUps(w)).toEqual([retry]);
    expect((await body(await api(w.plugin, "GET", "/tasks/t1", { token: r.token }))).task.waitingForPages).toBe(false);
  });

  it("ready that cannot delete the follow-up, or queues no run, is a 409 that leaves the follow-up and no new run", async () => {
    const original = { del: SqliteStore.prototype.deleteOccurrence, create: SqliteStore.prototype.createOccurrence };
    try {
      const w = await setup();
      await awaiting(w);
      const r = await ready(w);
      expect((await r.send([page(1)])).status).toBe(200);
      const followId = `o${query<{ seq: number }>(w.dbPath, "SELECT seq FROM occurrences WHERE dedupe_key LIKE 'followup:%' AND status = 'queued'")[0]?.seq}`;
      SqliteStore.prototype.deleteOccurrence = async function (this: SqliteStore, id: string) {
        return id === followId ? false : original.del.call(this, id);
      };
      const lost = await r.go();
      expect(lost.status).toBe(409);
      expect((await body(lost)).error.message).toContain("has started");
      expect(followUps(w)).toHaveLength(1);
      expect(query(w.dbPath, "SELECT seq FROM occurrences WHERE status IN ('queued', 'running') AND dedupe_key NOT LIKE 'followup:%'")).toEqual([]);
      SqliteStore.prototype.deleteOccurrence = original.del;

      SqliteStore.prototype.createOccurrence = async () => null;
      const none = await r.go();
      expect(none.status).toBe(409);
      expect((await body(none)).error.message).toContain("could not be started");
      expect(followUps(w)).toHaveLength(1);
      expect(query(w.dbPath, "SELECT seq FROM occurrences WHERE status IN ('queued', 'running') AND dedupe_key NOT LIKE 'followup:%'")).toEqual([]);
      SqliteStore.prototype.createOccurrence = original.create;
      // Still waiting: a later ready goes through.
      expect((await r.go()).status).toBe(200);
      expect(followUps(w)).toEqual([]);
    } finally {
      SqliteStore.prototype.deleteOccurrence = original.del;
      SqliteStore.prototype.createOccurrence = original.create;
    }
  });

  it("ready on a paused one is a 409; it still takes pages", async () => {
    const w = await setup();
    await awaiting(w);
    const r = await ready(w);
    expect((await api(w.plugin, "POST", "/tasks/t1/pause", { token: r.token, body: {} })).status).toBe(200);
    expect((await r.send([page(1)])).status).toBe(200);
    const paused = await r.go();
    expect(paused.status).toBe(409);
    expect((await body(paused)).error.message).toContain("paused");
    expect(followUps(w)).toHaveLength(1);
  });

  it("does not count against the live-request cap", async () => {
    const w = await setup();
    await awaiting(w);
    for (let i = 0; i < MAX_LIVE_RESEARCH; i++) expect(await slash(w.plugin, "research", LARRY, { strings: { question: `Question ${i}`, at: "tomorrow 9am" } })).toContain("queued");
    expect(await slash(w.plugin, "research", LARRY, { strings: { question: "one more" } })).toContain(`already have ${MAX_LIVE_RESEARCH} research requests`);
  });

  it("without the web area, a blocked first answer is sent and the request ends: no wait for pages nobody could send", async () => {
    const city = fakeCityHall();
    const work: Promise<void>[] = [];
    const w = await world({ webUrl: null, env: CITY_HALL, cityHallFetch: city.fetchImpl, executeStarted: (p) => void work.push(p) });
    await people(w.plugin);
    const round = async () => {
      for (const t of w.plugin.ticks ?? []) await t.run(new AbortController().signal);
      await Promise.all(work.splice(0));
      w.clock.advance(61_000);
    };
    await slash(w.plugin, "research", LARRY, { strings: { question: QUESTION } });
    await round();
    for (const output of [{ ...ANSWER, blocked: BLOCKED }, { verdict: "approve", problems: [], answer: ANSWER }]) {
      const job = city.latest();
      if (job) Object.assign(job, { status: "done", result: success(output, 0.3) });
      await round();
      await round();
    }
    const dms = dmsTo(w.sent, LARRY);
    expect(dms.some((c) => c.startsWith("Research: How many players does Y take?"))).toBe(true);
    expect(dms.some((c) => c.includes("Couldn't open:"))).toBe(false);
    expect(query(w.dbPath, "SELECT status FROM tasks")).toEqual([{ status: "done" }]);
  });
});
