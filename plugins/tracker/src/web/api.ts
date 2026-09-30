import type { User } from "@rackbops/docket-core";
import type { TrackerDeps } from "../actions.js";
import type { Queue } from "../discord-common.js";
import type { ApiToken } from "./api-tokens.js";
import {
  actAnswer,
  type ApiAnswer,
  createAnswer,
  editAnswer,
  getAnswer,
  listAnswer,
  problem,
  typesAnswer,
} from "./api-tasks.js";
import type { Writer } from "./editor.js";
import { readBody } from "./html.js";

/**
 * The tracker's JSON task API (rackbops-bot-plugins#80, slice 4; plan 5.10, E5), under
 * `/<name>/api/v1/`: what a later intake agent (E10, deferred; plan item 31) would post a task
 * definition to, authenticated as the person. app.ts hands every `/api/` path here before its own
 * method and cookie handling.
 *
 * - **Bearer tokens only** (api-tokens.ts). The session cookie is never read here: every plugin
 *   shares one browser origin, so a cookie-authenticated JSON API would be callable by any script on
 *   it. No CORS header is ever sent, and a request carrying an `Origin` header -- which a browser
 *   adds to every cross-origin request and to a same-origin one that is not a GET -- is refused, so
 *   the API is for programs, not pages.
 * - Every request re-reads the token's owner, as the web does a session: gone, or no longer
 *   registered, is refused; with `TRACKER_GUILD_ID`, membership is re-checked on the web's schedule
 *   (app.ts's `recheck`), and one who has left loses every token and session.
 * - A token acts as its owner with the owner's rights only, and only on the owner's own tasks.
 * - Each token has its own rate limit (a bucket of `RATE_BURST` requests, refilled at
 *   `RATE_PER_SECOND`), taken before the owner is looked up, so a busy token costs no Discord calls.
 *   Requests whose token does not look up share one global bucket (`FAILED_BURST`, refilled at
 *   `FAILED_PER_SECOND`): past it they get 429 instead of 401, and a valid token is unaffected.
 * - A body is JSON (`Content-Type: application/json`), an object, at most `MAX_API_BYTES`, read no
 *   further than that. Errors are `{"error": {"code", "message"}}`.
 */

export const API_PREFIX = "/api/v1";
export const MAX_API_BYTES = 16 * 1024;
export const RATE_BURST = 60;
export const RATE_PER_SECOND = 1;
/** One bucket shared by every request whose token fails to look up (unknown, revoked, expired, malformed). */
export const FAILED_BURST = 30;
export const FAILED_PER_SECOND = 0.5;
const FAILED_KEY = "failed";

/** What the owner re-check found (app.ts): let them on, they have left every listed server, or it could not tell for too long. */
export type Recheck = "ok" | "not-member" | "unknown";

export interface ApiWiring {
  d: TrackerDeps;
  queue: Queue;
  reading: Set<string>;
  /** The plugin's path prefix, `/tracker`. */
  base: string;
  limiter: RateLimiter;
  /** The one bucket for failed token lookups, keyed by `FAILED_KEY` only, so its memory is one entry. */
  failed: RateLimiter;
  /** The web's membership re-check, for a token's owner (app.ts). */
  recheck(user: User, checkedAt: string | null): Promise<Recheck>;
}

/**
 * A token bucket per key, in memory: `burst` requests at once, then `perSecond`. A restart refills
 * every bucket, which is fine for what it guards (a runaway script, not an attacker with a token).
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
  ) {}

  /** 0 when allowed (and counted); else the whole seconds until one more is. */
  take(key: string, nowMs: number): number {
    const b = this.buckets.get(key);
    const elapsed = b ? Math.max(0, nowMs - b.at) / 1000 : 0;
    const tokens = b ? Math.min(this.burst, b.tokens + elapsed * this.perSecond) : this.burst;
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: nowMs });
      return Math.max(1, Math.ceil((1 - tokens) / this.perSecond));
    }
    this.buckets.set(key, { tokens: tokens - 1, at: nowMs });
    if (this.buckets.size > 10_000) {
      // Forget the buckets that would be full again anyway.
      for (const [k, v] of this.buckets) if (v.tokens + ((nowMs - v.at) / 1000) * this.perSecond >= this.burst) this.buckets.delete(k);
    }
    return 0;
  }
}

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
};

export function json(a: ApiAnswer): Response {
  return new Response(JSON.stringify(a.body), { status: a.status, headers: { ...HEADERS, ...(a.headers ?? {}) } });
}

const CHALLENGE = 'Bearer realm="tracker"';

/** The bearer value of an `Authorization` header, or null when there is none of that form. */
export function bearer(header: string | null): string | null {
  if (header === null) return null;
  const m = /^Bearer +([^\s]+) *$/i.exec(header);
  return m?.[1] ?? null;
}

type Route =
  | { kind: "me" | "types" | "tasks" }
  | { kind: "task"; id: string }
  | { kind: "act"; id: string; action: "pause" | "resume" };

const ACT = /^\/tasks\/([^/]+)\/(pause|resume)$/;
const ONE = /^\/tasks\/([^/]+)$/;

function segment(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? "");
  } catch {
    return "";
  }
}

function route(rest: string): Route | null {
  if (rest === "/me") return { kind: "me" };
  if (rest === "/types") return { kind: "types" };
  if (rest === "/tasks") return { kind: "tasks" };
  const act = ACT.exec(rest);
  if (act) return { kind: "act", id: segment(act[1]), action: act[2] as "pause" | "resume" };
  const one = ONE.exec(rest);
  return one ? { kind: "task", id: segment(one[1]) } : null;
}

function allowedMethods(r: Route): string {
  if (r.kind === "tasks") return "GET, POST";
  if (r.kind === "task") return "GET, PATCH, DELETE";
  if (r.kind === "act") return "POST";
  return "GET";
}

type Read = { ok: true; body: Record<string, unknown> } | { ok: false; answer: ApiAnswer };

/** The body as a JSON object, or the answer refusing it. (A result wrapper: the body is the caller's, whatever its keys.) */
async function readJson(request: Request): Promise<Read> {
  const type = (request.headers.get("content-type") ?? "").trim();
  const no = (answer: ApiAnswer): Read => ({ ok: false, answer });
  if (!/^application\/json *(;.*)?$/i.test(type)) return no(problem(415, "unsupported_media_type", "Send the body as Content-Type: application/json."));
  const text = await readBody(request, MAX_API_BYTES);
  if (text === null) return no(problem(413, "too_large", `The body is over ${MAX_API_BYTES} bytes.`));
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return no(problem(400, "invalid_json", "The body is not JSON."));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return no(problem(400, "invalid_json", "The body must be a JSON object."));
  return { ok: true, body: value as Record<string, unknown> };
}

/** The token and its owner, or the answer refusing the request. */
type Auth = { ok: true; token: ApiToken; user: User } | { ok: false; answer: ApiAnswer };

async function authenticate(w: ApiWiring, request: Request): Promise<Auth> {
  const { d } = w;
  const no = (answer: ApiAnswer): Auth => ({ ok: false, answer });
  const header = request.headers.get("authorization");
  if (header === null) return no(problem(401, "unauthorized", "Send Authorization: Bearer <token>. Make a token on the web area's API tokens page.", { "WWW-Authenticate": CHALLENGE }));
  const invalid = problem(401, "invalid_token", "That token is unknown, revoked or expired.", { "WWW-Authenticate": `${CHALLENGE}, error="invalid_token"` });
  const sent = bearer(header);
  const now = d.clock.now();
  const token = sent === null ? null : d.apiTokens.find(sent, now);
  if (!token) {
    const waitFailed = w.failed.take(FAILED_KEY, now.getTime());
    if (waitFailed > 0) return no(problem(429, "rate_limited", `Too many requests with bad tokens; try again in ${waitFailed} s.`, { "Retry-After": String(waitFailed) }));
    return no(invalid);
  }
  const wait = w.limiter.take(token.id, now.getTime());
  if (wait > 0) return no(problem(429, "rate_limited", `Too many requests with this token; try again in ${wait} s.`, { "Retry-After": String(wait) }));
  const user = await d.store.getUser(token.userId);
  if (!user || !d.admissions.isRegistered(user.id)) {
    // As the web drops a session of someone no longer registered: their tokens go too.
    d.apiTokens.deleteForUser(token.userId);
    return no(invalid);
  }
  const found = await w.recheck(user, token.memberCheckedAt);
  if (found === "not-member") return no(problem(403, "not_member", "The token's owner is no longer a member of this tracker's server; their tokens are revoked."));
  if (found === "unknown") return no(problem(503, "membership_unknown", "I could not check that the token's owner is still a member of this tracker's server; try again later.", { "Retry-After": "60" }));
  // The re-check may have waited: act only on the token as it stands now.
  const current = d.apiTokens.find(sent as string, d.clock.now());
  if (!current) return no(invalid);
  d.apiTokens.touch(current, d.clock.now());
  return { ok: true, token: current, user };
}

/** Answers one request under `/api/`; `path` is the plugin-relative path (`/api/v1/tasks`). */
export async function handleApi(w: ApiWiring, request: Request, path: string): Promise<Response> {
  // A browser's request -- cross-origin, or a same-origin one other than GET -- carries Origin;
  // a program's does not. Refused before anything is read.
  if (request.headers.get("origin") !== null) return json(problem(403, "origin_refused", "The task API is not for browsers: send no Origin header."));
  const auth = await authenticate(w, request);
  if (!auth.ok) return json(auth.answer);
  const { user } = auth;
  const r = path.startsWith(`${API_PREFIX}/`) ? route(path.slice(API_PREFIX.length)) : null;
  if (r === null) return json(problem(404, "not_found", "No such endpoint."));
  const allowed = allowedMethods(r);
  const method = request.method;
  if (!allowed.split(", ").includes(method)) return json(problem(405, "method_not_allowed", `Use ${allowed}.`, { Allow: allowed }));
  const writer: Writer = { d: w.d, queue: w.queue, reading: w.reading, userId: user.id };
  const base = `${w.base}${API_PREFIX}`;

  if (method === "POST" || method === "PATCH") {
    const read = await readJson(request);
    if (!read.ok) return json(read.answer);
    const { body } = read;
    if (r.kind === "tasks") return json(await createAnswer(writer, user, body, base));
    if (r.kind === "task") return json(await editAnswer(writer, user, r.id, body, base));
    if (r.kind === "act") {
      if (Object.keys(body).length > 0) return json(problem(400, "unknown_field", `\`${r.action}\` takes no fields: send {}.`));
      return json(await actAnswer(writer, user, r.id, r.action));
    }
  }
  if (method === "DELETE" && r.kind === "task") return json(await actAnswer(writer, user, r.id, "delete"));
  if (r.kind === "types") return json(typesAnswer());
  if (r.kind === "tasks") return json(await listAnswer(w.d, user));
  if (r.kind === "task") return json(await getAnswer(w.d, user, r.id));
  return json({
    status: 200,
    body: {
      user: { id: user.id, name: user.displayName, timeZone: user.timeZone, preferredHour: user.preferredHour },
      token: { id: auth.token.id, name: auth.token.name, createdAt: auth.token.createdAt, expiresAt: auth.token.expiresAt },
    },
  });
}
