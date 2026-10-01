import { describe, expect, it } from "bun:test";
import { ExecutorUnavailableError, JobPendingError, type JobSpec } from "@rackbops/docket-core";
import { createCityHallExecutor, JobRecords, KEY_PREFIX, parseCityHallConfig, readJobResult, RESPONDER } from "./executor.js";
import { openDatabase } from "./schema.js";

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

function setup(answer: (req: Seen) => Response | Promise<Response>, access = false) {
  const { seen, fetchImpl } = fakeCityHall(answer);
  const records = new JobRecords(openDatabase(":memory:"));
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(`info ${m}`), warn: (m: string) => logs.push(`warn ${m}`), error: (m: string) => logs.push(`error ${m}`) };
  let now = NOW;
  const executor = createCityHallExecutor({
    config: { url: URL_, key: KEY, capability: "claude-cli:subscription", access: access ? { clientId: "cf-id", clientSecret: "cf-secret" } : null },
    records,
    log,
    now: () => now,
    fetchImpl,
    timeoutMs: 50,
  });
  return { seen, records, logs, executor, later: (ms: number) => (now = new Date(now.getTime() + ms)) };
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
    expect(req?.body).toEqual({ key: `${KEY_PREFIX}o7`, capability: "claude-cli:subscription", spec: SPEC, responder: RESPONDER });
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
