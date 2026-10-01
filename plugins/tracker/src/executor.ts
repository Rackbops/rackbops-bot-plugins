import type { Database } from "bun:sqlite";
import {
  type Executor,
  ExecutorUnavailableError,
  type FailureKind,
  JobPendingError,
  type JobResult,
  type JobSpec,
} from "@rackbops/docket-core";
import type { PluginLog } from "../../../packages/api/contract.js";

/**
 * docket's Executor port as a city-hall source (plan 5.12, E8; rackbops-bot-plugins#82): a model
 * Job goes to city-hall's execute lane and the runner (Rackbops/docket-runner) that carries the
 * configured capability tag claims it there. The tracker never calls a model and holds no Claude
 * credential; what it holds is a source key toward city-hall (plan item 50: the tracker's
 * credential toward city-hall arrives with E8).
 *
 * The wire is Lepid-Labs/city-hall#18's (proposed, not agreed by Nazu; decision 0002 calls the
 * source pair a stand-in for the source and responder contracts, so it may change):
 *
 * - `POST {url}/api/execute/jobs` with `{ key, capability, spec, responder }` and the source bearer
 *   key: `201 { job }` new, `200 { job }` for a key already used (the same job back);
 * - `GET {url}/api/execute/jobs/:id`: `{ job: { status, result, error, ... }, runs }`, `status`
 *   being `queued`, `running`, `done` or `failed`.
 *
 * docket's contract (`run(spec | null, occurrenceId, jobKey)`, core README "Adopting 0.5.0"):
 *
 * - a first ask (a spec) submits under `jobKey` and stores jobKey -> city-hall's job id in the
 *   tracker's own `executor_jobs` table **before** answering, so every later ask (no spec: docket
 *   never prepares a Job that is out again) finds the Job by key. A later ask with no stored id
 *   throws a plain Error: docket holds the run like a pending one and gives up after six hours;
 * - `queued` or `running`: `JobPendingError`; `done`: the result, read as a docket JobResult;
 *   `failed`: its result when it reads as one, else an `error` result carrying city-hall's error;
 * - city-hall unreachable, a timeout, a 5xx, a 429, or an answer that is not city-hall's (a
 *   redirect or page from the edge): `ExecutorUnavailableError`, so the run is asked again and never
 *   given up while city-hall is away. A 401 or 403 is the same, logged as a credential problem: it
 *   is not the Job's fault. Any other 4xx is a plain Error (a refused submit is an uncharged
 *   `error` result for the type; on a Job already out docket treats it like pending).
 *
 * Model output is data (plan 5.6): the result is passed to the type as a value, never acted on
 * here, and never logged above debug -- nor is the prompt or the key.
 */

/** Each request to city-hall gives up after this; a timeout is "unavailable", never the Job's failure. */
export const CITY_HALL_TIMEOUT_MS = 15_000;

/** A credential or edge problem is logged at most this often, not on every tick. */
export const CREDENTIAL_LOG_EVERY_MS = 60 * 60 * 1000;

/** city-hall's capability tag (city-hall#18 `isTag`): lowercase words joined by `:` or `-`. */
export const CAPABILITY_FORMAT = "^[a-z0-9]+([-:][a-z0-9]+)*$";
const CAPABILITY = new RegExp(CAPABILITY_FORMAT);
const MAX_CAPABILITY = 100;

/** An https origin, as `TRACKER_WEB_URL` takes it. */
export const CITY_HALL_URL_FORMAT = "^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$";

/** The key a Job is stored under at city-hall: the tracker's own prefix, then docket's Job key. */
export const KEY_PREFIX = "rackbops-tracker:";

/**
 * What the tracker asks city-hall to do with the result (plan item 70: the caller says what is done
 * with its task). city-hall stores it and does not act on it yet (city-hall#18): the tracker reads
 * the result back itself.
 */
export const RESPONDER = Object.freeze({ kind: "poll", by: "rackbops-tracker", note: "the tracker reads the result back with GET /api/execute/jobs/:id; deliver nothing" });

export interface CityHallConfig {
  /** The origin, no trailing slash. */
  url: string;
  /** The source bearer key (city-hall's `CITY_HALL_API_KEY`). */
  key: string;
  /** The tag only docket-runner carries (plan item 71). */
  capability: string;
  /** A Cloudflare Access service token for city-hall's edge, when it has one in front. */
  access: { clientId: string; clientSecret: string } | null;
}

export const ENV = {
  url: "TRACKER_CITY_HALL_URL",
  key: "TRACKER_CITY_HALL_KEY",
  capability: "TRACKER_CITY_HALL_CAPABILITY",
  accessId: "TRACKER_CITY_HALL_ACCESS_CLIENT_ID",
  accessSecret: "TRACKER_CITY_HALL_ACCESS_CLIENT_SECRET",
} as const;

export type CityHallSetting = { config: CityHallConfig } | { config: null; missing: string[] };

function value(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const v = env[key]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

/**
 * The city-hall Executor's settings. All unset: off, quietly. Some but not all of URL, key and
 * capability: off, with `missing` naming what is not set, so the plugin can say why (there is no
 * default capability: a guessed tag could route the tracker's Jobs to another agent, item 71). A
 * value that is set but malformed throws, naming the variable and never echoing a secret, as
 * `TRACKER_WEB_URL` does. The Access pair is both or neither.
 */
export function parseCityHallConfig(env: Readonly<Record<string, string | undefined>>): CityHallSetting {
  const url = value(env, ENV.url);
  const key = value(env, ENV.key);
  const capability = value(env, ENV.capability);
  const accessId = value(env, ENV.accessId);
  const accessSecret = value(env, ENV.accessSecret);
  if ((accessId === undefined) !== (accessSecret === undefined)) {
    throw new Error(`${ENV.accessId} and ${ENV.accessSecret} are set together or not at all`);
  }
  let origin: string | undefined;
  if (url !== undefined) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!new RegExp(CITY_HALL_URL_FORMAT).test(url) || !parsed || parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
      throw new Error(`${ENV.url}: "${url}" is not an https origin such as https://city-hall.example.com (no path, query or credentials)`);
    }
    origin = parsed.origin;
  }
  if (capability !== undefined && (capability.length > MAX_CAPABILITY || !CAPABILITY.test(capability))) {
    throw new Error(`${ENV.capability}: "${capability}" is not a capability tag (lowercase words joined by ":" or "-", e.g. claude-cli:subscription)`);
  }
  if (key !== undefined && /\s/.test(key)) throw new Error(`${ENV.key} has whitespace in it`);
  const missing = [
    ...(origin === undefined ? [ENV.url] : []),
    ...(key === undefined ? [ENV.key] : []),
    ...(capability === undefined ? [ENV.capability] : []),
  ];
  if (origin === undefined || key === undefined || capability === undefined) return { config: null, missing: missing.length === 3 && accessId === undefined ? [] : missing };
  return {
    config: {
      url: origin,
      key,
      capability,
      access: accessId !== undefined && accessSecret !== undefined ? { clientId: accessId, clientSecret: accessSecret } : null,
    },
  };
}

/** The tracker's record of its Jobs at city-hall: docket's Job key -> city-hall's job id (`executor_jobs`, migration 6). */
export class JobRecords {
  constructor(private readonly db: Database) {}

  get(jobKey: string): string | null {
    const r = this.db.query("SELECT remote_id FROM executor_jobs WHERE job_key = ?").get(jobKey) as { remote_id: string } | null;
    return r ? r.remote_id : null;
  }

  /** Stores (or, for a key city-hall answered again, refreshes) the id. */
  put(jobKey: string, occurrenceId: string, remoteId: string, at: string): void {
    this.db
      .query(
        `INSERT INTO executor_jobs (job_key, occurrence_id, remote_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (job_key) DO UPDATE SET remote_id = excluded.remote_id`,
      )
      .run(jobKey, occurrenceId, remoteId, at);
  }
}

const FAILURE_KINDS: ReadonlySet<string> = new Set<FailureKind>(["auth_failed", "usage_limit", "turn_cap", "budget_cap", "schema_miss", "timeout", "error"]);

const MAX_DETAIL = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clipDetail(text: string): string {
  // ASCII control characters out; the type cleans anything it shows a person again.
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length <= MAX_DETAIL ? flat : `${flat.slice(0, MAX_DETAIL - 3)}...`;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * A runner's result as docket's JobResult, or null when it is not one: `kind` is `success` with a
 * string `result`, or a known failure kind. Only the fields docket names are kept; unknown ones
 * are dropped, and a missing `durationMs` reads as 0.
 */
export function readJobResult(v: unknown): JobResult | null {
  if (!isRecord(v) || typeof v.kind !== "string") return null;
  const durationMs = num(v.durationMs) ?? 0;
  const cost = num(v.totalCostUsd);
  const session = typeof v.sessionId === "string" ? v.sessionId : undefined;
  if (v.kind === "success") {
    if (typeof v.result !== "string") return null;
    return {
      kind: "success",
      result: v.result,
      durationMs,
      ...("structuredOutput" in v ? { structuredOutput: v.structuredOutput } : {}),
      ...(session !== undefined ? { sessionId: session } : {}),
      ...(cost !== undefined ? { totalCostUsd: cost } : {}),
      ...("usage" in v ? { usage: v.usage } : {}),
      ...(num(v.numTurns) !== undefined ? { numTurns: num(v.numTurns) as number } : {}),
    };
  }
  if (!FAILURE_KINDS.has(v.kind)) return null;
  return {
    kind: v.kind as FailureKind,
    detail: typeof v.detail === "string" ? clipDetail(v.detail) : v.kind,
    durationMs,
    ...(typeof v.resetsAt === "string" ? { resetsAt: v.resetsAt } : {}),
    ...(num(v.apiErrorStatus) !== undefined ? { apiErrorStatus: num(v.apiErrorStatus) as number } : {}),
    ...(session !== undefined ? { sessionId: session } : {}),
    ...(cost !== undefined ? { totalCostUsd: cost } : {}),
  };
}

/** A city-hall job as the source reads it back; only what the adapter uses. */
interface RemoteJob {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  result: unknown;
  error: string | null;
}

function readJob(body: unknown): RemoteJob | null {
  if (!isRecord(body) || !isRecord(body.job)) return null;
  const j = body.job;
  if (typeof j.id !== "string" || j.id === "") return null;
  if (j.status !== "queued" && j.status !== "running" && j.status !== "done" && j.status !== "failed") return null;
  return { id: j.id, status: j.status, result: j.result ?? null, error: typeof j.error === "string" ? j.error : null };
}

/** What a finished (or not yet finished) job answers docket. */
export function answerFor(job: RemoteJob): JobResult {
  if (job.status === "queued" || job.status === "running") throw new JobPendingError(`city-hall job is ${job.status}`);
  const result = readJobResult(job.result);
  if (job.status === "done") {
    return result ?? { kind: "error", detail: "city-hall returned a result the tracker could not read", durationMs: 0 };
  }
  if (result && result.kind !== "success") return result;
  return { kind: "error", detail: clipDetail(`city-hall: ${job.error ?? "the job failed"}`), durationMs: 0 };
}

export interface CityHallExecutorOptions {
  config: CityHallConfig;
  records: JobRecords;
  log: PluginLog;
  now: () => Date;
  /** Test seam; the global `fetch` otherwise. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createCityHallExecutor(o: CityHallExecutorOptions): Executor {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? CITY_HALL_TIMEOUT_MS;
  const lastLogged = new Map<string, number>();

  /** A credential or edge problem, logged once an hour per reason. */
  function warnOnce(reason: string, text: string) {
    const at = o.now().getTime();
    const last = lastLogged.get(reason);
    if (last !== undefined && at - last < CREDENTIAL_LOG_EVERY_MS) return;
    lastLogged.set(reason, at);
    o.log.error(text);
  }

  function headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${o.config.key}`,
      Accept: "application/json",
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(o.config.access ? { "CF-Access-Client-Id": o.config.access.clientId, "CF-Access-Client-Secret": o.config.access.clientSecret } : {}),
    };
  }

  /** One call; the job it answers, or the right docket error. Never logs a body, a prompt or the key. */
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<RemoteJob> {
    let res: Response;
    try {
      res = await fetchImpl(`${o.config.url}${path}`, {
        method,
        headers: headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const why = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timed out" : "could not be reached";
      throw new ExecutorUnavailableError(`city-hall ${why}`);
    }
    const status = res.status;
    if (status === 401 || status === 403) {
      warnOnce("credential", `city-hall refused the tracker's credential (HTTP ${status}): check ${ENV.key} and the Access service token; research runs wait until it is fixed`);
      throw new ExecutorUnavailableError(`city-hall refused the tracker's credential (HTTP ${status})`);
    }
    if (status >= 300 && status < 400) {
      warnOnce("redirect", `city-hall answered with a redirect (HTTP ${status}), as an edge login does: check the Access service token (${ENV.accessId})`);
      throw new ExecutorUnavailableError(`city-hall answered with a redirect (HTTP ${status})`);
    }
    if (status >= 500 || status === 429 || status === 408) throw new ExecutorUnavailableError(`city-hall answered HTTP ${status}`);
    if (status < 200 || status >= 300) throw new Error(`city-hall answered HTTP ${status} to ${method} ${path.replace(/\/[^/]+$/, "/:id")}`);
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    const job = readJob(parsed);
    if (!job) {
      warnOnce("shape", `city-hall answered ${method} with HTTP ${status} but no job the tracker could read: is ${ENV.url} city-hall?`);
      throw new ExecutorUnavailableError("city-hall's answer was not a job");
    }
    return job;
  }

  return {
    async run(spec: JobSpec | null, occurrenceId: string, jobKey: string): Promise<JobResult> {
      if (spec !== null) {
        const job = await call("POST", "/api/execute/jobs", { key: `${KEY_PREFIX}${jobKey}`, capability: o.config.capability, spec, responder: RESPONDER });
        // Kept before answering: every later ask passes no spec and finds the Job only by this.
        o.records.put(jobKey, occurrenceId, job.id, o.now().toISOString());
        o.log.info(`execute: ${jobKey} submitted to city-hall as ${job.id} (${job.status})`);
        return answerFor(job);
      }
      const id = o.records.get(jobKey);
      if (id === null) throw new Error(`no city-hall job is on record for ${jobKey}`);
      return answerFor(await call("GET", `/api/execute/jobs/${encodeURIComponent(id)}`));
    },
  };
}
