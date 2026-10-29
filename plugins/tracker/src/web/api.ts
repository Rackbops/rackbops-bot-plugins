import type { User } from "@rackbops/docket-core";
import type { TrackerDeps, UsrLink } from "../actions.js";
import type { UsrDelegation } from "../usr-identity.js";
import { operationOf } from "./api-delegation.js";
import type { Queue } from "../discord-common.js";
import { type ApiToken, TOKEN_PREFIX } from "./api-tokens.js";
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
import { listingsAnswer } from "./api-listings.js";
import { sourcesAnswer, sourcesReadyAnswer } from "./api-sources.js";
import type { Writer } from "./editor.js";
import { readBody } from "./html.js";
import { isIdempotencyKey } from "./api-idempotency.js";
import { sha256 } from "./secrets.js";
import { canonicalJson, ifMatchVersion } from "./task-version.js";

export { canonicalJson };

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
 *   further than that (`MAX_LISTINGS_BYTES` for the listings route, whose 40 listings with their
 *   addresses need more, and `MAX_SOURCES_BYTES` for the sources route). Errors are `{"error": {"code", "message"}}`.
 * - `POST /tasks/<id>/listings` (0.19.0, api-listings.ts) sends listings in to the owner's inbox
 *   watch -- an eBay watch, or a BGG one on a bot without BGG access -- since such a watch never opens
 *   either site itself; `GET /tasks` shows such a watch's `site`, its words to `search` for and its
 *   top price, for the browser helper that finds them.
 * - `POST /tasks/<id>/sources` and `POST /tasks/<id>/sources/ready` (0.28.0, api-sources.ts) send
 *   the pages the owner's browser gathered in to their research request made with `sources:
 *   browser`, then start its run on them (body up to `MAX_SOURCES_BYTES`: ten pages of text);
 *   `GET /tasks` shows such a request's `sources: "browser"`, its `pages` and `waitingForPages`.
 */

export const API_PREFIX = "/api/v1";
export const MAX_API_BYTES = 16 * 1024;
/** The listings route's body: up to 40 listings, each with its address (docket keeps up to 400 characters of one) and text. */
export const MAX_LISTINGS_BYTES = 64 * 1024;
/**
 * The sources route's body: ten pages, each kept to docket's 12,000 characters of text
 * (`MAX_PAGE_CHARS`; a UTF-8 character is up to 4 bytes, and JSON escaping can double a quote or a
 * line break), with room for addresses, titles and a browser's own whitespace. A page sent longer is
 * cut by docket anyway, so a browser should trim before it sends.
 */
export const MAX_SOURCES_BYTES = 1024 * 1024;
export const RATE_BURST = 60;
export const RATE_PER_SECOND = 1;
/** One bucket shared by every request whose token fails to look up (unknown, revoked, expired, malformed). */
export const FAILED_BURST = 30;
export const FAILED_PER_SECOND = 0.5;
const FAILED_KEY = "failed";

/**
 * The 503 once the owner's membership has gone unchecked past the grace. The bot looks members up
 * through the Discord client of the last command or button it handled (index.ts), so after a restart
 * no lookup can run until someone uses one: an unattended script is told what unsticks it (#229).
 */
export const MEMBERSHIP_UNKNOWN =
  "I could not check that the token's owner is still a member of this tracker's server; try again later. After a restart I can check only once someone has used one of my commands or buttons in Discord.";

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
  /** `performance.now()` when the request arrived, before authentication: a create's first page read counts from it (editor.ts). */
  arrived: number;
  /** The web's membership re-check, for a token's owner (app.ts). */
  recheck(user: User, checkedAt: string | null): Promise<Recheck>;
  /** When the person's membership was last confirmed by any check, for a delegation token's person (app.ts). */
  confirmedAt(userId: string): string | null;
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
  | { kind: "act"; id: string; action: "pause" | "resume" }
  | { kind: "listings"; id: string }
  | { kind: "sources" | "ready"; id: string };

const ACT = /^\/tasks\/([^/]+)\/(pause|resume)$/;
const LISTINGS = /^\/tasks\/([^/]+)\/listings$/;
const SOURCES = /^\/tasks\/([^/]+)\/sources(\/ready)?$/;
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
  const listings = LISTINGS.exec(rest);
  if (listings) return { kind: "listings", id: segment(listings[1]) };
  const sources = SOURCES.exec(rest);
  if (sources) return { kind: sources[2] ? "ready" : "sources", id: segment(sources[1]) };
  const one = ONE.exec(rest);
  return one ? { kind: "task", id: segment(one[1]) } : null;
}

function allowedMethods(r: Route): string {
  if (r.kind === "tasks") return "GET, POST";
  if (r.kind === "task") return "GET, PATCH, DELETE";
  if (r.kind === "act" || r.kind === "listings" || r.kind === "sources" || r.kind === "ready") return "POST";
  return "GET";
}

type Read = { ok: true; body: Record<string, unknown> } | { ok: false; answer: ApiAnswer };

/** The body as a JSON object, or the answer refusing it. (A result wrapper: the body is the caller's, whatever its keys.) */
async function readJson(request: Request, max = MAX_API_BYTES): Promise<Read> {
  const type = (request.headers.get("content-type") ?? "").trim();
  const no = (answer: ApiAnswer): Read => ({ ok: false, answer });
  if (!/^application\/json *(;.*)?$/i.test(type)) return no(problem(415, "unsupported_media_type", "Send the body as Content-Type: application/json."));
  const text = await readBody(request, max);
  if (text === null) return no(problem(413, "too_large", `The body is over ${max} bytes.`));
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return no(problem(400, "invalid_json", "The body is not JSON."));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return no(problem(400, "invalid_json", "The body must be a JSON object."));
  return { ok: true, body: value as Record<string, unknown> };
}

/** What a request was authenticated by: one of the owner's `trk_` tokens, or a usr delegation token (#370). */
type Credential = { kind: "token"; token: ApiToken } | { kind: "delegation"; delegation: UsrDelegation };

/** The credential and the person it acts as, or the answer refusing the request. */
type Auth = { ok: true; via: Credential; user: User } | { ok: false; answer: ApiAnswer };

async function authenticate(w: ApiWiring, request: Request): Promise<Auth> {
  const { d } = w;
  const no = (answer: ApiAnswer): Auth => ({ ok: false, answer });
  const header = request.headers.get("authorization");
  if (header === null) return no(problem(401, "unauthorized", "Send Authorization: Bearer <token>. Make a token on the web area's API tokens page.", { "WWW-Authenticate": CHALLENGE }));
  const invalid = problem(401, "invalid_token", "That token is unknown, revoked or expired.", { "WWW-Authenticate": `${CHALLENGE}, error="invalid_token"` });
  const sent = bearer(header);
  const now = d.clock.now();
  // A usr delegation token (#370) is a JWT, never `trk_`; taken only from the services
  // TRACKER_API_DELEGATES names. Anything else is looked up as a `trk_` token, as before.
  const delegates = d.usr?.delegates;
  if (sent !== null && !sent.startsWith(TOKEN_PREFIX) && d.usr && delegates && delegates.size > 0) {
    return authenticateDelegation(w, d.usr, delegates, sent, invalid);
  }
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
  if (found === "not-member") return no(problem(403, "not_member", "The token's owner is no longer a member of this tracker's server, or lost the role it asks for; their tokens are revoked."));
  if (found === "unknown") return no(problem(503, "membership_unknown", MEMBERSHIP_UNKNOWN, { "Retry-After": "60" }));
  // The re-check may have waited: act only on the token as it stands now.
  const current = d.apiTokens.find(sent as string, d.clock.now());
  if (!current) return no(invalid);
  d.apiTokens.touch(current, d.clock.now());
  return { ok: true, via: { kind: "token", token: current }, user };
}

/**
 * A usr delegation token (usr-identity.ts `verifyDelegation`): for this app (`aud`), signed by usr,
 * unexpired, from a listed service (`act.sub`), for a person linked to a usr account who is still
 * registered and a member. usr's keys out of reach is 503, never a pass. Its rate limit is the
 * person's (`sub`), shared by every service acting for them.
 */
async function authenticateDelegation(w: ApiWiring, usr: UsrLink, delegates: ReadonlySet<string>, sent: string, invalid: ApiAnswer): Promise<Auth> {
  const { d } = w;
  const no = (answer: ApiAnswer): Auth => ({ ok: false, answer });
  const failed = (): Auth => {
    const wait = w.failed.take(FAILED_KEY, d.clock.now().getTime());
    return no(wait > 0 ? problem(429, "rate_limited", `Too many requests with bad tokens; try again in ${wait} s.`, { "Retry-After": String(wait) }) : invalid);
  };
  const checked = await usr.verifier.verifyDelegation(sent, usr.app);
  if (checked === "unavailable") return no(problem(503, "usr_unavailable", "I could not fetch usr's signing keys to check that token; try again in a minute.", { "Retry-After": "60" }));
  if (checked === "invalid" || !delegates.has(checked.actor)) return failed();
  const wait = w.limiter.take(`dlg:${checked.sub}`, d.clock.now().getTime());
  if (wait > 0) return no(problem(429, "rate_limited", `Too many requests for this person; try again in ${wait} s.`, { "Retry-After": String(wait) }));
  const userId = usr.links.userOfSubject(checked.sub);
  const user = userId ? await d.store.getUser(userId) : null;
  if (!user || !d.admissions.isRegistered(user.id)) return failed();
  const found = await w.recheck(user, w.confirmedAt(user.id));
  if (found === "not-member") return no(problem(403, "not_member", "That person is no longer a member of this tracker's server, or lost the role it asks for."));
  if (found === "unknown") return no(problem(503, "membership_unknown", MEMBERSHIP_UNKNOWN, { "Retry-After": "60" }));
  return { ok: true, via: { kind: "delegation", delegation: checked }, user };
}

/** One write -- create, edit, pause, resume, delete, listings, sources -- as its answer. */
async function write(writer: Writer, user: User, r: Route, method: string, body: Record<string, unknown>, base: string): Promise<ApiAnswer> {
  if (method === "DELETE") return actAnswer(writer, user, (r as { id: string }).id, "delete");
  if (r.kind === "tasks") return createAnswer(writer, user, body, base);
  if (r.kind === "task") return editAnswer(writer, user, r.id, body, base);
  if (r.kind === "act") {
    if (Object.keys(body).length > 0) return problem(400, "unknown_field", `\`${r.action}\` takes no fields: send {}.`);
    return actAnswer(writer, user, r.id, r.action);
  }
  if (r.kind === "listings") return listingsAnswer(writer, user, r.id, body);
  if (r.kind === "sources") return sourcesAnswer(writer, user, r.id, body);
  if (r.kind === "ready") {
    if (Object.keys(body).length > 0) return problem(400, "unknown_field", "`ready` takes no fields: send {}.");
    return sourcesReadyAnswer(writer, user, r.id);
  }
  return problem(405, "method_not_allowed", "Not a write.");
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
  // A delegation token does only what its scope names: one operation per route and method (#370).
  if (auth.via.kind === "delegation") {
    const operation = operationOf(r, method);
    // Every route and method that got this far names one (the table's own test), so null is a
    // refusal that cannot happen, kept so a future route without an operation fails closed.
    if (operation === null) return json(problem(403, "insufficient_scope", "No delegation token can do this."));
    const needed = `${w.d.usr?.app}:${operation}`;
    if (!auth.via.delegation.scopes.has(needed)) {
      return json(problem(403, "insufficient_scope", `That token does not allow this: it needs ${needed}.`, { "WWW-Authenticate": `${CHALLENGE}, error="insufficient_scope", scope="${needed}"` }));
    }
    if (method !== "GET") w.d.log.info(`api: ${operation} for ${user.id} by usr ${auth.via.delegation.actor} (token ${auth.via.delegation.jti})`);
  }
  const writer: Writer = { d: w.d, queue: w.queue, reading: w.reading, userId: user.id, arrived: w.arrived };
  const base = `${w.base}${API_PREFIX}`;

  if (method === "POST" || method === "PATCH" || method === "DELETE") {
    // `If-Match` (#369): only on a write to one task, and only a version this API made; anything
    // else is refused rather than ignored, so a client never believes a write was conditional when
    // it was not.
    const ifMatchRaw = request.headers.get("if-match");
    if (ifMatchRaw !== null) {
      const onOneTask = (r.kind === "task" && method !== "POST") || r.kind === "act";
      if (!onOneTask) return json(problem(400, "if_match_unsupported", "If-Match goes only with PATCH or DELETE of a task, or its pause or resume."));
      const version = ifMatchVersion(ifMatchRaw);
      if (version === null) return json(problem(400, "invalid_if_match", 'If-Match is one task version in quotes, as its ETag gives it: "0123456789abcdef".'));
      writer.ifMatch = { taskId: (r as { id: string }).id.trim(), version };
    }
    const key = request.headers.get("idempotency-key");
    if (key !== null && !isIdempotencyKey(key)) return json(problem(400, "invalid_idempotency_key", "Idempotency-Key is 8 to 128 letters, digits, '-', '_', '.' or ':'; a UUID will do."));
    let body: Record<string, unknown> = {};
    if (method !== "DELETE") {
      const read = await readJson(request, r.kind === "listings" ? MAX_LISTINGS_BYTES : r.kind === "sources" ? MAX_SOURCES_BYTES : MAX_API_BYTES);
      if (!read.ok) return json(read.answer);
      body = read.body;
    }
    if (key === null) return json(await write(writer, user, r, method, body, base));
    // The same key for the same request is one write (#369): the claim is taken before the write
    // runs, so a retry sent while the first is still running is told to wait, not run twice.
    // The If-Match version is part of the request: the same body under another version is another write.
    const hash = sha256(`${method} ${path}\n${writer.ifMatch?.version ?? ""}\n${canonicalJson(body)}`);
    const begun = w.d.apiIdempotency.begin(user.id, key, hash, w.d.clock.now());
    if (begun.kind === "conflict") return json(problem(409, "idempotency_conflict", "That Idempotency-Key was used for a different request; use a new key for a new request."));
    if (begun.kind === "in_progress") return json(problem(409, "idempotency_in_progress", "A request with that Idempotency-Key is still running; try again in a moment.", { "Retry-After": "1" }));
    if (begun.kind === "replay") return json({ status: begun.answer.status, body: begun.answer.body, headers: { ...begun.answer.headers, "Idempotency-Replayed": "true" } });
    let answer: ApiAnswer;
    try {
      answer = await write(writer, user, r, method, body, base);
    } catch (err) {
      // It may have thrown after its change was saved (building the answer), so a retry must not run
      // it again: the key answers "outcome unknown" until it expires.
      w.d.apiIdempotency.fail(user.id, key, begun.claim);
      throw err;
    }
    w.d.apiIdempotency.finish(user.id, key, begun.claim, { status: answer.status, body: answer.body, headers: answer.headers ?? {} });
    return json(answer);
  }
  if (r.kind === "types") return json(typesAnswer(w.d));
  if (r.kind === "tasks") return json(await listAnswer(w.d, user));
  if (r.kind === "task") return json(await getAnswer(w.d, user, r.id));
  return json({
    status: 200,
    body: {
      user: { id: user.id, name: user.displayName, timeZone: user.timeZone, preferredHour: user.preferredHour },
      ...(auth.via.kind === "token"
        ? { token: { id: auth.via.token.id, name: auth.via.token.name, createdAt: auth.via.token.createdAt, expiresAt: auth.via.token.expiresAt } }
        : { delegation: { actor: auth.via.delegation.actor, scopes: [...auth.via.delegation.scopes].sort(), expiresAt: new Date(auth.via.delegation.expiresAt).toISOString() } }),
    },
  });
}
