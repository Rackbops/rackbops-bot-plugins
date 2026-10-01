import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { NO_SUCH_TASK } from "./actions.js";
import { KEY_PREFIX } from "./executor.js";
import { MAX_LIVE_RESEARCH, RESEARCH_OFF } from "./research.js";
import { ADMIN, api, call, cleanup, csrfOf, CURLY, LARRY, makeToken, ORIGIN, people, press, signIn, slash, world } from "./web/harness.js";

/**
 * The research request end to end (rackbops-bot-plugins#82): `/research`, the execute lane on its
 * own tick through a fake city-hall speaking city-hall#18's source pair, the reviewer's follow-up,
 * the DM, the findings on the task's page, in the API and in `/task history`, the budget, and what
 * a recipient sees.
 */

afterEach(cleanup);

const CITY_HALL = {
  TRACKER_CITY_HALL_URL: "https://city-hall.example.com",
  TRACKER_CITY_HALL_KEY: "source-key-never-logged",
  TRACKER_CITY_HALL_CAPABILITY: "claude-cli:subscription",
};

interface FakeJob {
  id: string;
  key: string;
  capability: string;
  spec: { prompt: string; jsonSchema?: unknown };
  responder: unknown;
  status: "queued" | "running" | "done" | "failed";
  result: unknown;
  error: string | null;
}

/** city-hall's source pair in memory: `jobs` by id, `posts` and `gets` counted, `auth` the bearer it checks. */
function fakeCityHall() {
  const jobs = new Map<string, FakeJob>();
  let accepted = CITY_HALL.TRACKER_CITY_HALL_KEY;
  const calls: { method: string; path: string; auth: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? null;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, auth });
    if (auth !== `Bearer ${accepted}`) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (init?.method === "POST" && url.pathname === "/api/execute/jobs") {
      const b = JSON.parse(String(init.body)) as { key: string; capability: string; spec: FakeJob["spec"]; responder: unknown };
      const known = [...jobs.values()].find((j) => j.key === b.key);
      if (known) return Response.json({ job: known }, { status: 200 });
      const job: FakeJob = { id: `j${jobs.size + 1}`, key: b.key, capability: b.capability, spec: b.spec, responder: b.responder, status: "queued", result: null, error: null };
      jobs.set(job.id, job);
      return Response.json({ job }, { status: 201 });
    }
    const m = /^\/api\/execute\/jobs\/([^/]+)$/.exec(url.pathname);
    const job = m ? jobs.get(decodeURIComponent(m[1] ?? "")) : undefined;
    if (!job) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ job, runs: [] });
  }) as typeof fetch;
  // The tracker's key is `rackbops-tracker:<database id>:<docket's Job key>` (executor.ts `jobKeyFor`).
  const byKey = (key: string) => [...jobs.values()].find((j) => new RegExp(`^${KEY_PREFIX}[0-9a-f]{32}:${key}$`).test(j.key));
  /** The job submitted last, and how many there are. */
  const latest = () => [...jobs.values()].at(-1);
  /** The source key city-hall takes from now on (the operator fixing the credential on its side). */
  const accept = (key: string) => (accepted = key);
  return { jobs, calls, fetchImpl, byKey, latest, accept };
}

const ANSWER = {
  summary: "X is a thing that does Y.",
  findings: [
    { claim: "X was released in 2024.", sources: ["https://example.com/x-release"] },
    { claim: "X <b>bold</b> runs on Z.", sources: ["https://example.org/x-z?a=1&b=2"] },
  ],
  uncertain: [],
};

function success(structuredOutput: unknown, cost = 0.3) {
  return { kind: "success", result: "ok", structuredOutput, totalCostUsd: cost, durationMs: 1000 };
}

async function setup(env: Record<string, string> = CITY_HALL) {
  const city = fakeCityHall();
  const work: Promise<void>[] = [];
  const logs: string[] = [];
  const w = await world({ env, cityHallFetch: city.fetchImpl, executeStarted: (p) => void work.push(p), logs });
  await people(w.plugin);
  /** One round of the host's ticks, waiting for the execute lane's background work; then a minute passes. */
  const round = async () => {
    for (const t of w.plugin.ticks ?? []) await t.run(new AbortController().signal);
    await Promise.all(work.splice(0));
    w.clock.advance(61_000);
  };
  return { ...w, city, round, logs };
}

const dmsTo = (sent: { userId: string; message: unknown }[], id: string) => sent.filter((s) => s.userId === id).map((s) => String((s.message as { content: string }).content));

function query<T>(dbPath: string, sql: string): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

describe("/research while the city-hall Executor is not set up", () => {
  it("answers that research is not available, makes no task, and runs no execute tick", async () => {
    const w = await world();
    await people(w.plugin);
    expect(await slash(w.plugin, "research", LARRY, { strings: { question: "What is X?" } })).toBe(RESEARCH_OFF);
    expect(query(w.dbPath, "SELECT seq FROM tasks")).toEqual([]);
    expect((w.plugin.ticks ?? []).map((t) => t.name)).toEqual(["notify", "poll"]);
  });

  it("partly set up is off too, and says which settings are missing; malformed settings refuse to start", async () => {
    const logs: string[] = [];
    const w = await world({ env: { TRACKER_CITY_HALL_URL: CITY_HALL.TRACKER_CITY_HALL_URL, TRACKER_CITY_HALL_KEY: "k" }, logs });
    await people(w.plugin);
    expect(logs.some((l) => l.includes("execute lane is off") && l.includes("TRACKER_CITY_HALL_CAPABILITY"))).toBe(true);
    expect(logs.join("\n")).not.toContain("source-key");
    expect(await slash(w.plugin, "research", LARRY, { strings: { question: "What is X?" } })).toBe(RESEARCH_OFF);
    await expect(world({ env: { ...CITY_HALL, TRACKER_CITY_HALL_CAPABILITY: "Not A Tag" } })).rejects.toThrow("TRACKER_CITY_HALL_CAPABILITY");
  });
});

describe("/research through city-hall", () => {
  it("submits, waits, reviews, DMs the checked answer, and keeps its findings for the page, the API and /task history", async () => {
    const w = await setup();
    expect(w.logs).toContain("execute lane on: city-hall https://city-hall.example.com, capability claude-cli:subscription");
    const made = await slash(w.plugin, "research", LARRY, { strings: { question: "What is X?", context: "larry-private-context" } });
    expect(made).toContain("Research `t1` queued: What is X?");
    const [task] = query<{ schedule: string; config: string; capabilities: string; lane: string }>(w.dbPath, "SELECT schedule, config, capabilities, lane FROM tasks");
    expect(JSON.parse(task?.schedule ?? "")).toEqual({ kind: "once", at: "2026-10-01T12:00:00.000Z" });
    expect(JSON.parse(task?.config ?? "")).toEqual({ question: "What is X?", context: "larry-private-context" });
    expect(JSON.parse(task?.capabilities ?? "")).toEqual(["notify"]);
    expect(task?.lane).toBe("execute");

    // The first round submits the research Job and keeps city-hall's id; it is queued there.
    await w.round();
    const research = w.city.byKey("o1");
    expect(research?.capability).toBe("claude-cli:subscription");
    expect(research?.spec.prompt).toContain("What is X?");
    expect(research?.responder).toMatchObject({ kind: "poll" });
    expect(query(w.dbPath, "SELECT job_key, occurrence_id, remote_id FROM executor_jobs")).toEqual([{ job_key: "o1", occurrence_id: "o1", remote_id: "j1" }]);

    // Still running: asked again by id, nothing new submitted, nobody DMed.
    if (research) research.status = "running";
    const before = w.sent.length;
    await w.round();
    expect(w.city.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(w.city.calls.at(-1)).toMatchObject({ method: "GET", path: "/api/execute/jobs/j1" });
    expect(w.sent.length).toBe(before);

    // Done: collected; the reviewer's follow-up is submitted on a later round.
    if (research) Object.assign(research, { status: "done", result: success(ANSWER, 0.4) });
    await w.round();
    await w.round();
    expect(w.city.jobs.size).toBe(2);
    const review = w.city.latest();
    // The follow-up is its own run, keyed by its own occurrence (`followup:o1` its dedupe key).
    const [followUp] = query<{ id: string }>(w.dbPath, "SELECT 'o' || seq AS id FROM occurrences WHERE dedupe_key = 'followup:o1'");
    const [dbId] = query<{ value: string }>(w.dbPath, "SELECT value FROM tracker_meta WHERE key = 'database_id'");
    expect(review?.key).toBe(`${KEY_PREFIX}${dbId?.value}:${followUp?.id}`);
    expect(review?.spec.prompt).toContain("X was released in 2024.");
    if (review) Object.assign(review, { status: "done", result: success({ verdict: "approve", problems: [], answer: ANSWER }, 0.2) });
    await w.round();
    await w.round();

    const dm = dmsTo(w.sent, LARRY).find((c) => c.startsWith("Research: What is X?"));
    expect(dm).toContain("X was released in 2024. <https://example.com/x-release>");
    expect(dm).toContain("Checked by a reviewer run.");
    expect(query(w.dbPath, "SELECT status FROM tasks")).toEqual([{ status: "done" }]);
    // Charged once per Job, keyed by it.
    expect(query(w.dbPath, "SELECT key, cost_usd FROM usage ORDER BY seq")).toEqual([
      { key: "o1", cost_usd: 0.4 },
      { key: followUp?.id, cost_usd: 0.2 },
    ]);
    const stored = query<{ key: string; text: string; source: string; owner_id: string }>(w.dbPath, "SELECT key, text, source, owner_id FROM findings ORDER BY seq");
    expect(stored.map((f) => [f.key, f.source, f.owner_id])).toEqual([
      [`${followUp?.id}:0`, "https://example.com/x-release", "u2"],
      [`${followUp?.id}:1`, "https://example.org/x-z?a=1&b=2", "u2"],
    ]);
    expect(stored[0]?.text).toBe("X was released in 2024.");
    // Model text is cleaned by docket before it is stored (no markup survives as such).
    expect(stored[1]?.text).toContain("X <b>bold");

    // The task's page lists them, escaped, each source a link that does not reach back.
    const larry = await signIn(w.plugin, LARRY);
    const page = await (await call(w.plugin, "GET", "/tasks/t1", { jar: larry })).text();
    expect(page).toContain("<h2>Findings</h2>");
    expect(page).toContain("X &lt;b&gt;bold");
    expect(page).not.toContain("<b>bold");
    expect(page).toContain('<a class="rb-link" href="https://example.org/x-z?a=1&amp;b=2" rel="noopener noreferrer nofollow">');

    // The API's task read carries them (additive), the history with them.
    const token = await makeToken({ plugin: w.plugin, sent: w.sent }, larry);
    const res = await api(w.plugin, "GET", "/tasks/t1", { token });
    const body = (await res.json()) as { findings: { claim: string; source: string | null; at: string }[]; history: unknown };
    expect(res.status).toBe(200);
    expect(body.findings.map((f) => f.claim)).toEqual(stored.map((f) => f.text));
    expect(body.findings[0]?.source).toBe("https://example.com/x-release");
    expect(body.history).toBeDefined();

    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" } });
    expect(history).toContain("Findings: 2");
    expect(history).toContain("- X was released in 2024. <https://example.com/x-release>");

    // Logs never carry the key, the prompt or the result.
    const all = w.logs.join("\n");
    expect(all).not.toContain("source-key-never-logged");
    expect(all).not.toContain("What is X?");
    expect(all).not.toContain("X was released");
  });

  it("a recipient gets the answer and sees the findings, never the owner's config or state; before accepting, nothing", async () => {
    const w = await setup();
    await slash(w.plugin, "research", LARRY, { strings: { question: "What is X?", context: "larry-private-context" } });
    expect(await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } })).toContain("Invited");
    // Invited but not yet accepted: nothing to see.
    expect(await slash(w.plugin, "task", CURLY, { sub: "history", strings: { task: "t1" } })).toBe(NO_SUCH_TASK);
    await press(w.plugin, "tracker:a.t.t1", CURLY);
    await w.round();
    const research = w.city.byKey("o1");
    if (research) Object.assign(research, { status: "done", result: success(ANSWER) });
    await w.round();
    await w.round();
    const review = w.city.latest();
    expect(review?.key).not.toBe(research?.key);
    // Under review, the draft is the task's state: the owner's, never shown to a recipient.
    const [held] = query<{ state: string }>(w.dbPath, "SELECT state FROM tasks WHERE seq = 1");
    expect(JSON.parse(held?.state ?? "null")?.draft?.summary).toBe(ANSWER.summary);
    const curlyEarly = await signIn(w.plugin, CURLY);
    const seen = [
      await (await call(w.plugin, "GET", "/tasks/t1", { jar: curlyEarly })).text(),
      await (await call(w.plugin, "GET", "/", { jar: curlyEarly })).text(),
      await slash(w.plugin, "task", CURLY, { sub: "history", strings: { task: "t1" } }),
      await slash(w.plugin, "tasks", CURLY),
    ];
    for (const text of seen) {
      expect(text).not.toContain(ANSWER.summary);
      expect(text).not.toContain("X was released in 2024.");
    }
    if (review) Object.assign(review, { status: "done", result: success({ verdict: "approve", problems: [], answer: ANSWER }) });
    await w.round();
    await w.round();
    expect(dmsTo(w.sent, CURLY).some((c) => c.startsWith("Research: What is X?"))).toBe(true);

    const curly = await signIn(w.plugin, CURLY);
    const page = await (await call(w.plugin, "GET", "/tasks/t1", { jar: curly })).text();
    expect(page).toContain("X was released in 2024.");
    expect(page).toContain("Owned by Larry");
    expect(page).not.toContain("larry-private-context");
    const list = await (await call(w.plugin, "GET", "/", { jar: curly })).text();
    expect(list).not.toContain("larry-private-context");
    const history = await slash(w.plugin, "task", CURLY, { sub: "history", strings: { task: "t1" } });
    expect(history).toContain("Findings: 2");
    expect(history).not.toContain("larry-private-context");
    expect(await slash(w.plugin, "tasks", CURLY)).not.toContain("larry-private-context");
    // The admin sees it too; nobody else.
    expect(await slash(w.plugin, "task", ADMIN, { sub: "history", strings: { task: "t1" } })).toContain("Findings: 2");
  });

  it("a usage ceiling holds the next run, tells the person and the admins once, and lets it run after midnight Eastern", async () => {
    const w = await setup();
    await slash(w.plugin, "research", LARRY, { strings: { question: "What is X?" } });
    await w.round();
    const research = w.city.byKey("o1");
    // One expensive run spends past the 2 USD a day.
    if (research) Object.assign(research, { status: "done", result: success(ANSWER, 2.5) });
    await w.round();
    await w.round();
    await w.round();
    expect(w.city.jobs.size).toBe(1);
    expect(dmsTo(w.sent, LARRY).filter((c) => c.includes("You have reached today's limit"))).toHaveLength(1);
    expect(dmsTo(w.sent, ADMIN).filter((c) => c.includes("has reached today's limit"))).toHaveLength(1);
    // After midnight Eastern the review goes out.
    w.clock.set("2026-10-02T05:00:00.000Z");
    await w.round();
    expect(w.city.jobs.size).toBe(2);
  });

  it("an admin's raise from the web lets a held run go the same day, through docket's own budget check (plan 5.7)", async () => {
    const w = await setup();
    await slash(w.plugin, "research", LARRY, { strings: { question: "What is X?" } });
    await w.round();
    const research = w.city.byKey("o1");
    if (research) Object.assign(research, { status: "done", result: success(ANSWER, 2.5) });
    await w.round();
    await w.round();
    expect(w.city.jobs.size).toBe(1); // held at the default 2 USD
    const admin = await signIn(w.plugin, ADMIN);
    const csrf = await csrfOf(w.plugin, admin);
    const raised = await call(w.plugin, "POST", "/admin/people/u2/ceiling", { jar: admin, form: { csrf, usd: "5", calls: "40" }, origin: ORIGIN });
    expect(raised.status).toBe(200);
    await w.round();
    expect(w.city.jobs.size).toBe(2); // the review went out the same day
    expect(dmsTo(w.sent, LARRY).filter((c) => c.includes("You have reached today's limit"))).toHaveLength(1);
  });

  it("a runner paused past six hours is collected when it resumes: one Job, one charge, no second key (review of #110, round 2)", async () => {
    const w = await setup();
    await slash(w.plugin, "research", LARRY, { strings: { question: "What is X?" } });
    await w.round();
    const research = w.city.byKey("o1");
    expect(research).toBeDefined();
    // The runner hits its usage limit: city-hall requeues the job, hour after hour, for seven hours.
    if (research) Object.assign(research, { status: "queued", attempts: 1, lastOutcome: "usage_limit" });
    for (let h = 0; h < 7; h++) {
      await w.round();
      w.clock.advance(60 * 60 * 1000);
    }
    // It resumes: running, then done.
    if (research) Object.assign(research, { status: "running", attempts: 2 });
    await w.round();
    expect(w.city.jobs.size).toBe(1);
    expect(query(w.dbPath, "SELECT status FROM occurrences WHERE seq = 1")).toEqual([{ status: "queued" }]);
    if (research) Object.assign(research, { status: "done", result: success(ANSWER) });
    await w.round();
    expect(query(w.dbPath, "SELECT status FROM occurrences WHERE seq = 1")).toEqual([{ status: "done" }]);
    expect(query(w.dbPath, "SELECT calls FROM usage WHERE occurrence_id = 'o1'")).toEqual([{ calls: 1 }]);
    const events = query<{ text: string }>(w.dbPath, "SELECT text FROM events WHERE occurrence_id = 'o1'").map((e) => e.text);
    expect(events.some((t) => t.includes("gave up"))).toBe(false);
    // The only other Job is the reviewer's follow-up, never a second research key.
    const keys = [...w.city.jobs.values()].map((j) => j.key);
    expect(keys.filter((k) => /:o1(:|$)/.test(k))).toEqual([research?.key ?? "missing"]);
    expect(w.logs.filter((l) => l.includes("runner is paused"))).toHaveLength(7);
    expect(dmsTo(w.sent, ADMIN).filter((c) => c.includes("runner is paused"))).toHaveLength(1);
  });

  it("refuses a deadline before the start, a sixth waiting request, and a question too long", async () => {
    const w = await setup();
    expect(await slash(w.plugin, "research", LARRY, { strings: { question: "Q", at: "tomorrow 9am", deadline: "in 2 hours" } })).toBe(
      "The deadline has to be after the research starts.",
    );
    expect(await slash(w.plugin, "research", LARRY, { strings: { question: "x".repeat(1001) } })).toContain("longer than 1000 characters");
    for (let i = 0; i < MAX_LIVE_RESEARCH; i++) expect(await slash(w.plugin, "research", LARRY, { strings: { question: `Q${i}`, at: "tomorrow 9am" } })).toContain("queued");
    expect(await slash(w.plugin, "research", LARRY, { strings: { question: "one more" } })).toContain(`already have ${MAX_LIVE_RESEARCH} research requests`);
    const [later] = query<{ schedule: string }>(w.dbPath, "SELECT schedule FROM tasks ORDER BY seq LIMIT 1");
    expect(JSON.parse(later?.schedule ?? "").at).toBe("2026-10-02T13:00:00.000Z"); // 9am New York
  });

  it("a deadline goes into the config as an instant; a run that would start past it makes no call and tells the owner", async () => {
    const w = await setup();
    expect(await slash(w.plugin, "research", LARRY, { strings: { question: "Q", deadline: "in 1 hour" } })).toContain("nothing is run");
    const [t] = query<{ config: string }>(w.dbPath, "SELECT config FROM tasks");
    expect(JSON.parse(t?.config ?? "").deadline).toBe("2026-10-01T13:00:00.000Z");
    w.clock.set("2026-10-01T14:00:00.000Z");
    await w.round();
    await w.round();
    expect(w.city.calls).toEqual([]);
    expect(dmsTo(w.sent, LARRY).some((c) => c.includes("passed before the research could start"))).toBe(true);
  });

  it("city-hall refusing the credential holds the run without failing it, and the run goes once the key is right", async () => {
    const w = await setup({ ...CITY_HALL, TRACKER_CITY_HALL_KEY: "wrong-key" });
    await slash(w.plugin, "research", LARRY, { strings: { question: "Q" } });
    await w.round();
    await w.round();
    expect(w.city.jobs.size).toBe(0);
    expect(query(w.dbPath, "SELECT status FROM occurrences")).toEqual([{ status: "queued" }]);
    expect(w.logs.filter((l) => l.includes("refused the tracker's credential"))).toHaveLength(1);
    expect(w.logs.join("\n")).not.toContain("wrong-key");
    // The admins are told once for the Job, not every minute.
    const told = () => dmsTo(w.sent, ADMIN).filter((c) => c.includes("refused the tracker's credential"));
    expect(told()).toHaveLength(1);
    expect(told()[0]).not.toContain("wrong-key");

    // The key is right again: the same run is submitted, answered, and finishes.
    w.city.accept("wrong-key");
    await w.round();
    expect(w.city.jobs.size).toBe(1);
    expect(w.city.byKey("o1")).toBeDefined();
    const research = w.city.byKey("o1");
    if (research) Object.assign(research, { status: "done", result: success(ANSWER) });
    await w.round();
    expect(query<{ status: string }>(w.dbPath, "SELECT status FROM occurrences WHERE seq = 1")).toEqual([{ status: "done" }]);
    expect(told()).toHaveLength(1);
  });
});
