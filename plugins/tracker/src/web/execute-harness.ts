import { Database } from "bun:sqlite";
import { KEY_PREFIX } from "../executor.js";
import { people, world } from "./harness.js";

/**
 * The execute lane's test harness (rackbops-bot-plugins#82, #83), shared by research.test.ts and
 * scout.test.ts: a fake city-hall speaking city-hall#18's source pair (the wire Rackbops/job-queue
 * serves), a plugin wired to it, one round of the host's ticks, and reads of the data file.
 */

export const CITY_HALL = {
  TRACKER_CITY_HALL_URL: "https://city-hall.example.com",
  TRACKER_CITY_HALL_KEY: "source-key-never-logged",
  TRACKER_CITY_HALL_CAPABILITY: "claude-cli:subscription",
};

export interface FakeJob {
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
export function fakeCityHall() {
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

export const ANSWER = {
  summary: "X is a thing that does Y.",
  findings: [
    { claim: "X was released in 2024.", sources: ["https://example.com/x-release"] },
    { claim: "X <b>bold</b> runs on Z.", sources: ["https://example.org/x-z?a=1&b=2"] },
  ],
  uncertain: [],
};

export function success(structuredOutput: unknown, cost = 0.3) {
  return { kind: "success", result: "ok", structuredOutput, totalCostUsd: cost, durationMs: 1000 };
}

export async function setup(env: Record<string, string> = CITY_HALL) {
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

export const dmsTo = (sent: { userId: string; message: unknown }[], id: string) => sent.filter((s) => s.userId === id).map((s) => String((s.message as { content: string }).content));

export function query<T>(dbPath: string, sql: string): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

