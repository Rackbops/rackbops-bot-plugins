import { describe, expect, it } from "bun:test";
import { ExecutorUnavailableError, JobPendingError, type JobSpec } from "@rackbops/docket-core";
import {
  createCityHallExecutor,
  DATABASE_ID_KEY,
  databaseId,
  EXECUTOR_JOBS_KEPT_MS,
  JobRecords,
  KEY_PREFIX,
  parseCityHallConfig,
  readJob,
  readJobResult,
  RESPONDER,
} from "./executor.js";
import { META_TABLE, openDatabase } from "./schema.js";

const KEY = "source-key-that-must-never-be-logged";
const PROMPT = "a prompt that must never be logged";
const SPEC: JobSpec = { prompt: PROMPT, maxTurns: 15 };
const URL_ = "https://city-hall.example.com";
const NOW = new Date("2026-10-01T12:00:00.000Z");

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake city-hall: `answer` decides each response; every request is recorded. */
function fakeCityHall(answer: (req: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Seen = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(req);
    // As the real fetch does: the request's signal (the adapter's timeout) aborts a slow answer.
    const signal = init?.signal;
    return Promise.race([
      Promise.resolve().then(() => answer(req)),
      new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
    ]);
  }) as typeof fetch;
  return { seen, fetchImpl };
}

function job(status: string, extra: Record<string, unknown> = {}) {
  return { id: "j-1", key: "k", capability: "claude-cli:subscription", spec: SPEC, responder: null, status, runner: null, attempts: 0, result: null, error: null, createdAt: "x", updatedAt: "x", ...extra };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DB_ID = "0123456789abcdef0123456789abcdef";

function setup(answer: (req: Seen) => Response | Promise<Response>, access = false, records = new JobRecords(openDatabase(":memory:"))) {
  const { seen, fetchImpl } = fakeCityHall(answer);
  // noticeOnce's contract: one send per key, ever.
  const notices: { key: string; text: string }[] = [];
  const notice = async (key: string, text: string) => {
    if (!notices.some((n) => n.key === key)) notices.push({ key, text });
  };
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(`info ${m}`), warn: (m: string) => logs.push(`warn ${m}`), error: (m: string) => logs.push(`error ${m}`) };
  let now = NOW;
  const executor = createCityHallExecutor({
    config: { url: URL_, key: KEY, capability: "claude-cli:subscription", access: access ? { clientId: "cf-id", clientSecret: "cf-secret" } : null },
    records,
    databaseId: DB_ID,
    log,
    now: () => now,
    notice,
    fetchImpl,
    timeoutMs: 50,
  });
  return { seen, records, logs, notices, executor, later: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

describe("the city-hall Executor's settings", () => {
  it("is off and quiet with nothing set; off naming what is missing when partly set; never guesses a capability", () => {
    expect(parseCityHallConfig({})).toEqual({ config: null, missing: [] });
    expect(parseCityHallConfig({ TRACKER_CITY_HALL_URL: URL_, TRACKER_CITY_HALL_KEY: KEY })).toEqual({ config: null, missing: ["TRACKER_CITY_HALL_CAPABILITY"] });
    expect(parseCityHallConfig({ TRACKER_CITY_HALL_CAPABILITY: "claude-cli:subscription" })).toEqual({ config: null, missing: ["TRACKER_CITY_HALL_URL", "TRACKER_CITY_HALL_KEY"] });
  });

  it("is on with URL, key and capability, the Access pair optional but both or neither", () => {
    const base = { TRACKER_CITY_HALL_URL: `${URL_}/`, TRACKER_CITY_HALL_KEY: KEY, TRACKER_CITY_HALL_CAPABILITY: "claude-cli:subscription" };
    expect(parseCityHallConfig(base)).toEqual({ config: { url: URL_, key: KEY, capability: "claude-cli:subscription", access: null } });
    expect(parseCityHallConfig({ ...base, TRACKER_CITY_HALL_ACCESS_CLIENT_ID: "id", TRACKER_CITY_HALL_ACCESS_CLIENT_SECRET: "s" }).config?.access).toEqual({ clientId: "id", clientSecret: "s" });
    expect(() => parseCityHallConfig({ ...base, TRACKER_CITY_HALL_ACCESS_CLIENT_ID: "id" })).toThrow(/set together or not at all/);
  });

  it("refuses a URL that is not an https origin and a capability that is not a tag, never echoing the key", () => {
    const base = { TRACKER_CITY_HALL_KEY: KEY, TRACKER_CITY_HALL_CAPABILITY: "claude-cli:subscription" };
    for (const url of ["http://city-hall.example.com", "https://city-hall.example.com/api", "https://user:pw@city-hall.example.com", "city-hall"]) {
      expect(() => parseCityHallConfig({ ...base, TRACKER_CITY_HALL_URL: url })).toThrow(/TRACKER_CITY_HALL_URL/);
    }
    for (const tag of ["Claude", "claude cli", "claude-cli:", "a/b"]) {
      expect(() => parseCityHallConfig({ ...base, TRACKER_CITY_HALL_URL: URL_, TRACKER_CITY_HALL_CAPABILITY: tag })).toThrow(/not a capability tag/);
    }
    let message = "";
    try {
      parseCityHallConfig({ TRACKER_CITY_HALL_URL: URL_, TRACKER_CITY_HALL_KEY: "has space", TRACKER_CITY_HALL_CAPABILITY: "x" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("TRACKER_CITY_HALL_KEY");
    expect(message).not.toContain("has space");
  });

  it("refuses a URL with credentials in it without echoing it", () => {
    const base = { TRACKER_CITY_HALL_KEY: KEY, TRACKER_CITY_HALL_CAPABILITY: "claude-cli:subscription" };
    for (const url of ["https://user:hunter2@city-hall.example.com", "https://hunter2@city-hall.example.com/"]) {
      let message = "";
      try {
        parseCityHallConfig({ ...base, TRACKER_CITY_HALL_URL: url });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("must not contain credentials");
      expect(message).not.toContain("hunter2");
    }
    let other = "";
    try {
      parseCityHallConfig({ ...base, TRACKER_CITY_HALL_URL: "http://plain.example.com/path" });
    } catch (err) {
      other = (err as Error).message;
    }
    expect(other).not.toContain("plain.example.com");
  });
});

describe("the city-hall Executor (docket's Executor port, city-hall#18's source pair)", () => {
  it("a first ask submits under the Job key with the capability, spec and responder, keeps the job id, then answers pending", async () => {
    const w = setup(() => json(201, { job: job("queued") }), true);
    const err = await thrown(w.executor.run(SPEC, "o7", "o7"));
    expect(err).toBeInstanceOf(JobPendingError);
    expect(w.seen).toHaveLength(1);
    const [req] = w.seen;
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe(`${URL_}/api/execute/jobs`);
    expect(req?.body).toEqual({ key: `${KEY_PREFIX}${DB_ID}:o7`, capability: "claude-cli:subscription", spec: SPEC, responder: RESPONDER });
    expect(req?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(req?.headers["CF-Access-Client-Id"]).toBe("cf-id");
    expect(req?.headers["CF-Access-Client-Secret"]).toBe("cf-secret");
    expect(w.records.get("o7")).toBe("j-1");
  });

  it("a later ask (no spec) reads the job back by its stored id and answers by its status", async () => {
    let status = "running";
    let extra: Record<string, unknown> = {};
    const w = setup((req) => (req.method === "POST" ? json(201, { job: job("queued", { id: "j/9" }) }) : json(200, { job: job(status, { id: "j/9", ...extra }), runs: [] })));
    expect(await thrown(w.executor.run(SPEC, "o7", "o7:1"))).toBeInstanceOf(JobPendingError);
    expect(await thrown(w.executor.run(null, "o7", "o7:1"))).toBeInstanceOf(JobPendingError);
    expect(w.seen[1]?.method).toBe("GET");
    expect(w.seen[1]?.url).toBe(`${URL_}/api/execute/jobs/j%2F9`);
    expect(w.seen[1]?.headers["CF-Access-Client-Id"]).toBeUndefined();

    status = "done";
    extra = { result: { kind: "success", result: "text", structuredOutput: { summary: "s" }, totalCostUsd: 0.4, durationMs: 1200, unknown: "dropped" } };
    expect(await w.executor.run(null, "o7", "o7:1")).toEqual({ kind: "success", result: "text", structuredOutput: { summary: "s" }, totalCostUsd: 0.4, durationMs: 1200 });

    status = "failed";
    extra = { result: { kind: "turn_cap", detail: "hit the cap", durationMs: 5 } };
    expect(await w.executor.run(null, "o7", "o7:1")).toEqual({ kind: "turn_cap", detail: "hit the cap", durationMs: 5 });
    extra = { result: null, error: "lease expired 3 times" };
    expect(await w.executor.run(null, "o7", "o7:1")).toEqual({ kind: "error", detail: "city-hall: lease expired 3 times", durationMs: 0 });

    status = "done";
    extra = { result: { kind: "success" } };
    expect(await w.executor.run(null, "o7", "o7:1")).toEqual({ kind: "error", detail: "city-hall returned a result the tracker could not read", durationMs: 0 });
  });

  it("a key city-hall already knows (200) answers that job's result at once", async () => {
    const w = setup(() => json(200, { job: job("done", { result: { kind: "success", result: "r", durationMs: 1 } }) }));
    expect(await w.executor.run(SPEC, "o7", "o7")).toEqual({ kind: "success", result: "r", durationMs: 1 });
    expect(w.records.get("o7")).toBe("j-1");
  });

  it("a later ask with no stored id throws a plain error, which docket holds like pending and gives up after six hours", async () => {
    const w = setup(() => json(500, {}));
    const err = await thrown(w.executor.run(null, "o7", "o7"));
    expect(err).not.toBeInstanceOf(ExecutorUnavailableError);
    expect(err).not.toBeInstanceOf(JobPendingError);
    expect((err as Error).message).toContain("no city-hall job is on record");
    expect(w.seen).toHaveLength(0);
  });

  it("unreachable, timed out, 5xx, 429, a redirect or an answer that is not a job: unavailable, so the run is asked again", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Promise<Response>(() => {}), // never answers: the timeout
      () => json(502, {}),
      () => json(429, {}),
      () => new Response(null, { status: 302, headers: { location: "https://login.example.com" } }),
      () => new Response("<html>not city-hall</html>", { status: 200 }),
    ];
    for (const answer of answers) {
      const w = setup(answer);
      const err = await thrown(w.executor.run(SPEC, "o7", "o7"));
      expect(err).toBeInstanceOf(ExecutorUnavailableError);
      expect(w.records.get("o7")).toBeNull();
    }
  });

  it("a refused credential is unavailable, not the Job's fault, logged once an hour, never with the key", async () => {
    const w = setup(() => json(401, { error: "unauthorized" }));
    expect(await thrown(w.executor.run(SPEC, "o7", "o7"))).toBeInstanceOf(ExecutorUnavailableError);
    expect(await thrown(w.executor.run(SPEC, "o7", "o7"))).toBeInstanceOf(ExecutorUnavailableError);
    expect(w.logs.filter((l) => l.startsWith("error"))).toHaveLength(1);
    expect(w.logs[0]).toContain("refused the tracker's credential (HTTP 401)");
    w.later(61 * 60 * 1000);
    expect(await thrown(w.executor.run(SPEC, "o7", "o7"))).toBeInstanceOf(ExecutorUnavailableError);
    expect(w.logs.filter((l) => l.startsWith("error"))).toHaveLength(2);
    const w403 = setup(() => json(403, {}));
    expect(await thrown(w403.executor.run(null, "o7", "o7").catch(() => w403.executor.run(SPEC, "o7", "o7")))).toBeInstanceOf(ExecutorUnavailableError);
    for (const line of [...w.logs, ...w403.logs]) {
      expect(line).not.toContain(KEY);
      expect(line).not.toContain(PROMPT);
    }
  });

  it("a refused submit or an unknown job id is a plain error (an uncharged error result on a first ask)", async () => {
    const w = setup((req) => (req.method === "POST" ? json(400, { error: "spec.prompt must be a non-empty string" }) : json(404, { error: "not found" })));
    const refused = await thrown(w.executor.run(SPEC, "o7", "o7"));
    expect(refused).not.toBeInstanceOf(ExecutorUnavailableError);
    expect((refused as Error).message).toContain("HTTP 400");
    w.records.put("o8", "o8", "gone", NOW.toISOString());
    const unknown = await thrown(w.executor.run(null, "o8", "o8"));
    expect(unknown).not.toBeInstanceOf(ExecutorUnavailableError);
    expect((unknown as Error).message).toContain("HTTP 404 to GET /api/execute/jobs/:id");
  });

  it("logs a submission by its key and city-hall's id only: never the prompt, the key or the result", async () => {
    const w = setup(() => json(201, { job: job("done", { result: { kind: "success", result: "SECRET RESULT", durationMs: 1 } }) }));
    await w.executor.run(SPEC, "o7", "o7");
    expect(w.logs).toEqual(["info execute: o7 submitted to city-hall as j-1 (done)"]);
  });
});

describe("readJobResult", () => {
  it("keeps docket's fields, caps a failure's detail, refuses an unknown kind", () => {
    expect(readJobResult({ kind: "schema_miss", detail: `line\nbreak${"x".repeat(600)}` })?.kind).toBe("schema_miss");
    expect((readJobResult({ kind: "error", detail: "x".repeat(600) }) as { detail: string }).detail).toHaveLength(500);
    expect(readJobResult({ kind: "exploded" })).toBeNull();
    expect(readJobResult({ kind: "usage_limit", detail: "d", resetsAt: "2026-10-01T15:00:00Z", durationMs: 3 })).toEqual({ kind: "usage_limit", detail: "d", resetsAt: "2026-10-01T15:00:00Z", durationMs: 3 });
    expect(readJobResult(null)).toBeNull();
  });
});

describe("the tracker's keys at city-hall (review of #110: no collision across databases)", () => {
  it("a database's id is random, made once, and kept in tracker_meta", () => {
    const a = openDatabase(":memory:");
    const b = openDatabase(":memory:");
    const idA = databaseId(a);
    expect(idA).toMatch(/^[0-9a-f]{32}$/);
    expect(databaseId(a)).toBe(idA);
    expect((a.query(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get(DATABASE_ID_KEY) as { value: string }).value).toBe(idA);
    expect(databaseId(b)).not.toBe(idA);
  });

  it("two databases submit the same docket Job key under different city-hall keys", async () => {
    const keys: unknown[] = [];
    for (const db of [openDatabase(":memory:"), openDatabase(":memory:")]) {
      const { seen, fetchImpl } = fakeCityHall(() => json(201, { job: job("queued") }));
      const ex = createCityHallExecutor({
        config: { url: URL_, key: KEY, capability: "claude-cli:subscription", access: null },
        records: new JobRecords(db),
        databaseId: databaseId(db),
        log: { info: () => {}, warn: () => {}, error: () => {} },
        now: () => NOW,
        fetchImpl,
      });
      await thrown(ex.run(SPEC, "o1", "o1"));
      keys.push((seen[0]?.body as { key: string }).key);
    }
    expect(keys[0]).not.toBe(keys[1]);
    for (const k of keys) expect(String(k)).toMatch(/^rackbops-tracker:[0-9a-f]{32}:o1$/);
  });

  it("a 200 whose job holds another prompt is refused with a plain error and logged, and not recorded", async () => {
    const w = setup(() => json(200, { job: job("done", { spec: { prompt: "someone else's prompt" }, result: { kind: "success", result: "theirs", durationMs: 1 } }) }));
    const err = await thrown(w.executor.run(SPEC, "o7", "o7"));
    expect(err).not.toBeInstanceOf(ExecutorUnavailableError);
    expect(err).not.toBeInstanceOf(JobPendingError);
    expect((err as Error).message).toContain("not this Job");
    expect(w.records.get("o7")).toBeNull();
    expect(w.logs.some((l) => l.startsWith("error") && l.includes("whose prompt is not this one"))).toBe(true);
    for (const line of w.logs) expect(line).not.toContain("someone else's prompt");
    // A 201 is a new job: nothing to compare.
    const fresh = setup(() => json(201, { job: job("queued", { spec: { prompt: "echoed differently" } }) }));
    expect(await thrown(fresh.executor.run(SPEC, "o7", "o7"))).toBeInstanceOf(JobPendingError);
  });
});

describe("a failed record after a successful submit (review of #110)", () => {
  it("is unavailable, so docket asks again under the same key and city-hall hands back the same job", async () => {
    const db = openDatabase(":memory:");
    const records = new JobRecords(db);
    let failPut = true;
    const realPut = records.put.bind(records);
    records.put = (...args: Parameters<JobRecords["put"]>) => {
      if (failPut) throw new Error("database is locked");
      realPut(...args);
    };
    let posts = 0;
    const w = setup(() => json(posts++ === 0 ? 201 : 200, { job: job("queued") }), false, records);
    expect(await thrown(w.executor.run(SPEC, "o7", "o7"))).toBeInstanceOf(ExecutorUnavailableError);
    expect(w.records.get("o7")).toBeNull();
    failPut = false;
    expect(await thrown(w.executor.run(SPEC, "o7", "o7"))).toBeInstanceOf(JobPendingError);
    expect((w.seen[0]?.body as { key: string }).key).toBe((w.seen[1]?.body as { key: string }).key);
    expect(w.records.get("o7")).toBe("j-1");
  });
});

describe("a job city-hall requeued after its runner stopped (review of #110, city-hall#18)", () => {
  const requeued = (outcome: string, how: "field" | "runs") =>
    how === "field"
      ? { job: job("queued", { attempts: 1, lastOutcome: outcome }), runs: [{ attempt: 1, runner: "r", claimedAt: "x", endedAt: "y", outcome }] }
      : { job: job("queued", { attempts: 2 }), runs: [{ attempt: 1, runner: "r", claimedAt: "x", endedAt: "y", outcome: "lease_expired" }, { attempt: 2, runner: "r", claimedAt: "x", endedAt: "y", outcome }] };

  for (const how of ["field", "runs"] as const) {
    it(`is unavailable, not pending, for usage_limit, auth_failed and lease_expired (read from ${how === "field" ? "job.lastOutcome" : "the last of runs"})`, async () => {
      for (const outcome of ["usage_limit", "auth_failed", "lease_expired"]) {
        const w = setup(() => json(200, requeued(outcome, how)));
        w.records.put("o7", "o7", "j-1", NOW.toISOString());
        const err = await thrown(w.executor.run(null, "o7", "o7"));
        expect(err).toBeInstanceOf(ExecutorUnavailableError);
        expect((err as Error).message).toContain(outcome);
        expect(w.logs.filter((l) => l.startsWith("warn") && l.includes("runner is paused") && l.includes(outcome))).toHaveLength(1);
        expect(w.notices).toHaveLength(1);
        expect(w.notices[0]?.text).toContain(outcome);
      }
    });
  }

  it("logs once an hour per Job and tells the admins once per Job and outcome", async () => {
    const w = setup(() => json(200, requeued("usage_limit", "field")));
    w.records.put("o7", "o7", "j-1", NOW.toISOString());
    w.records.put("o9", "o9", "j-1", NOW.toISOString());
    await thrown(w.executor.run(null, "o7", "o7"));
    await thrown(w.executor.run(null, "o7", "o7"));
    expect(w.logs.filter((l) => l.includes("runner is paused"))).toHaveLength(1);
    w.later(61 * 60 * 1000);
    await thrown(w.executor.run(null, "o7", "o7"));
    expect(w.logs.filter((l) => l.includes("runner is paused"))).toHaveLength(2);
    expect(w.notices).toHaveLength(1);
    await thrown(w.executor.run(null, "o9", "o9"));
    expect(w.logs.filter((l) => l.includes("runner is paused"))).toHaveLength(3);
    expect(w.notices).toHaveLength(2);
  });

  it("a queued job never claimed, or one whose last claim ended otherwise, is still pending; lastOutcome wins over runs", async () => {
    const answers = [
      { job: job("queued", { attempts: 0, lastOutcome: null }), runs: [] },
      { job: job("queued", { attempts: 0 }), runs: [] },
      // The field says null (no claim ended): it wins over a runs list that says otherwise.
      { job: job("queued", { attempts: 1, lastOutcome: null }), runs: [{ attempt: 1, runner: "r", claimedAt: "x", endedAt: null, outcome: "usage_limit" }] },
      { job: job("running", { attempts: 1, lastOutcome: "usage_limit" }), runs: [] },
      { job: job("queued", { attempts: 1, lastOutcome: "error" }), runs: [] },
    ];
    for (const body of answers) {
      const w = setup(() => json(200, body));
      w.records.put("o7", "o7", "j-1", NOW.toISOString());
      expect(await thrown(w.executor.run(null, "o7", "o7"))).toBeInstanceOf(JobPendingError);
      expect(w.notices).toHaveLength(0);
    }
    expect(readJob(requeued("auth_failed", "runs"))?.lastOutcome).toBe("auth_failed");
  });
});

describe("the admins are told once per Job when city-hall refuses the credential (review of #110)", () => {
  it("a 401, a 403 or a redirect sends one notice per Job", async () => {
    for (const answer of [() => json(401, {}), () => json(403, {}), () => new Response(null, { status: 302, headers: { location: "https://login.example.com" } })]) {
      const w = setup(answer);
      await thrown(w.executor.run(SPEC, "o7", "o7"));
      await thrown(w.executor.run(SPEC, "o7", "o7"));
      expect(w.notices).toHaveLength(1);
      await thrown(w.executor.run(SPEC, "o8", "o8"));
      expect(w.notices).toHaveLength(2);
      for (const n of w.notices) expect(n.text).not.toContain(KEY);
    }
  });
});

describe("JobRecords.prune (review of #110)", () => {
  it("drops a Job's record once its run is gone, or finished over a month ago; keeps a run still out", () => {
    const db = openDatabase(":memory:");
    const records = new JobRecords(db);
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    const run = (status: string) =>
      Number(
        db
          .query("INSERT INTO occurrences (task_id, lane, due_at, status, late, dedupe_key, created_at) VALUES ('t1', 'execute', ?, ?, 0, ?, ?)")
          .run(at(0), status, crypto.randomUUID(), at(0)).lastInsertRowid,
      );
    const old = EXECUTOR_JOBS_KEPT_MS + 60_000;
    const oldDone = run("done");
    const newDone = run("done");
    const oldQueued = run("queued");
    records.put("a", `o${oldDone}`, "j-a", at(old));
    records.put("b", `o${newDone}`, "j-b", at(60_000));
    records.put("c", `o${oldQueued}`, "j-c", at(old));
    records.put("d", "o999", "j-d", at(60_000)); // its run is gone
    expect(records.prune(NOW)).toBe(2);
    expect(records.get("a")).toBeNull();
    expect(records.get("b")).toBe("j-b");
    expect(records.get("c")).toBe("j-c");
    expect(records.get("d")).toBeNull();
  });
});
