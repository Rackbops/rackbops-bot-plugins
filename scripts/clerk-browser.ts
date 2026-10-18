// The helper the clerk-browser-search skill (.claude/skills/clerk-browser-search/SKILL.md, #125)
// calls to talk to Clerk's JSON task API: it reads the two secrets from files and sends them as
// headers, so neither ever enters a Claude transcript, a command line or a log. Run on the owner's
// own machine, never in CI. The API it calls is plugins/tracker/README.md's "Task API".
//
//   bun scripts/clerk-browser.ts check              who the token acts as (proves both secrets work)
//   bun scripts/clerk-browser.ts pending            the watches and research requests waiting on the browser
//   bun scripts/clerk-browser.ts listings <id> <file.json>   send {"listings": [...]} to an inbox watch
//   bun scripts/clerk-browser.ts sources <id> <file.json>    send {"pages": [...]} to a research request
//   bun scripts/clerk-browser.ts ready <id>         start the research request on the pages it holds
//
// Secrets, under $TOOLING_SECRETS_DIR (default R:\repos\secrets, the Tooling repo's secrets root):
//   cloudflare-access.json   the Cloudflare Access service token, {"clientId", "clientSecret"}
//                            (the one the uptime monitor already uses on clerk.rackbops.com, item 74)
//   clerk-tracker-token.txt  a personal tracker API token (trk_...), made on the web area's /tokens page
// CLERK_API_URL overrides the API's base (default https://clerk.rackbops.com/tracker/api/v1).
import { join } from "node:path";

export const DEFAULT_BASE = "https://clerk.rackbops.com/tracker/api/v1";
export const DEFAULT_SECRETS_DIR = "R:\\repos\\secrets";
export const ACCESS_FILE = "cloudflare-access.json";
export const TOKEN_FILE = "clerk-tracker-token.txt";

/** The task API's own caps (plugins/tracker/README.md, Task API), checked here first so a bad batch costs no request. */
export const MAX_LISTINGS = 40;
export const MAX_PAGES = 10;
export const MAX_PAGE_CHARS = 12_000;
const LISTINGS_BODY_BYTES = 64 * 1024;
const SOURCES_BODY_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;

export interface Secrets {
  clientId: string;
  clientSecret: string;
  bearer: string;
}

export interface Deps {
  fetch: typeof fetch;
  readFile: (path: string) => Promise<string>;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** The service-token file: a JSON object with non-empty string `clientId` and `clientSecret` (the shape Tooling's notify.py reads). */
export function parseAccessToken(text: string, path: string): { clientId: string; clientSecret: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not JSON; it must hold {"clientId": "...", "clientSecret": "..."}`);
  }
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || typeof d.clientId !== "string" || !d.clientId || typeof d.clientSecret !== "string" || !d.clientSecret) {
    throw new Error(`${path} must hold a JSON object with non-empty "clientId" and "clientSecret"`);
  }
  return { clientId: d.clientId.trim(), clientSecret: d.clientSecret.trim() };
}

/** The tracker token file: one `trk_` token (43 more characters), whitespace around it ignored. */
export function parseBearer(text: string, path: string): string {
  const token = text.trim();
  if (!/^trk_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error(`${path} must hold one tracker API token: trk_ and 43 characters, as the bot's DM gave it`);
  }
  return token;
}

export async function loadSecrets(d: Pick<Deps, "readFile" | "env">): Promise<Secrets> {
  const dir = d.env.TOOLING_SECRETS_DIR?.trim() || DEFAULT_SECRETS_DIR;
  const read = async (name: string) => {
    const path = join(dir, name);
    try {
      return { path, text: await d.readFile(path) };
    } catch {
      throw new Error(`cannot read ${path} (set TOOLING_SECRETS_DIR if your secrets live elsewhere)`);
    }
  };
  const access = await read(ACCESS_FILE);
  const token = await read(TOKEN_FILE);
  return { ...parseAccessToken(access.text, access.path), bearer: parseBearer(token.text, token.path) };
}

/** No `Origin`: the API refuses any request carrying one. */
export function headers(s: Secrets, json: boolean): Record<string, string> {
  return {
    "CF-Access-Client-Id": s.clientId,
    "CF-Access-Client-Secret": s.clientSecret,
    Authorization: `Bearer ${s.bearer}`,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

/** One thing waiting on the browser: an inbox watch to fill with listings, or a research request to fill with pages. */
export type Job =
  | { kind: "listings"; id: string; title: string; site: string; search?: string; game?: string; max?: number | string; currency?: string }
  | { kind: "research"; id: string; title: string; question: string; context?: string; deadline?: string; fullerPass: boolean; pages: number; blocked: { site: string; url?: string; why: string }[] };

/**
 * `GET /tasks`'s answer -> the active tasks waiting on the browser: an inbox watch (`source: "inbox"`,
 * eBay or BGG), and a research request with `waitingForPages` (a `sources: browser` request, or one
 * waiting for a fuller pass, whose `blocked` names the pages its run could not open). Paused and
 * finished ones are left out: a paused watch would hold listings without telling anyone.
 */
export function pendingJobs(body: unknown): Job[] {
  const tasks = (body as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) throw new Error("the API's answer has no tasks list");
  const jobs: Job[] = [];
  for (const raw of tasks) {
    const t = raw as Record<string, unknown>;
    if (!t || t.status !== "active") continue;
    const settings = (t.settings ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
    if ((t.type === "wantlist" || t.type === "wantjudge") && t.source === "inbox") {
      const max = typeof settings.max === "number" || typeof settings.max === "string" ? settings.max : undefined;
      jobs.push({
        kind: "listings",
        id: String(t.id),
        title: String(t.title ?? ""),
        site: str(t.site) ?? "ebay",
        ...(str(t.search) ? { search: str(t.search) } : {}),
        ...(t.game !== undefined && t.game !== null ? { game: String(t.game) } : {}),
        ...(max !== undefined && max !== "" ? { max } : {}),
        ...(str(settings.currency) ? { currency: str(settings.currency) } : {}),
      });
    } else if (t.type === "research" && t.waitingForPages === true) {
      const blocked = Array.isArray(t.blocked) ? (t.blocked as { site: string; url?: string; why: string }[]) : [];
      jobs.push({
        kind: "research",
        id: String(t.id),
        title: String(t.title ?? ""),
        question: String(settings.question ?? t.title ?? ""),
        ...(str(settings.context) ? { context: str(settings.context) } : {}),
        ...(str(settings.deadline) ? { deadline: str(settings.deadline) } : {}),
        fullerPass: t.sources !== "browser",
        pages: typeof t.pages === "number" ? t.pages : 0,
        blocked,
      });
    }
  }
  return jobs;
}

const isHttpUrl = (v: unknown): boolean => {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

/** Problems with a `{"listings": [...]}` body before it is sent; empty when it is fine to send. */
export function listingsProblems(body: unknown): string[] {
  const list = (body as { listings?: unknown })?.listings;
  if (!Array.isArray(list)) return ['the file must hold {"listings": [ ... ]}'];
  const problems: string[] = [];
  if (list.length === 0) problems.push("no listings");
  if (list.length > MAX_LISTINGS) problems.push(`${list.length} listings; send at most ${MAX_LISTINGS} a request`);
  list.forEach((l, i) => {
    const x = (l ?? {}) as Record<string, unknown>;
    if (typeof x.title !== "string" || !x.title.trim()) problems.push(`listing ${i + 1} has no title`);
    if (!isHttpUrl(x.url)) problems.push(`listing ${i + 1} has no absolute http(s) url`);
  });
  if (new TextEncoder().encode(JSON.stringify(body)).length > LISTINGS_BODY_BYTES) problems.push("the body is over 64 KiB");
  return problems;
}

/**
 * Problems with a `{"pages": [...]}` body before it is sent. A page's text is cut to the API's
 * 12,000 characters here (the API would cut it the same way), so a long page costs no upload.
 */
export function pagesProblems(body: unknown): string[] {
  const list = (body as { pages?: unknown })?.pages;
  if (!Array.isArray(list)) return ['the file must hold {"pages": [ ... ]}'];
  const problems: string[] = [];
  if (list.length === 0) problems.push("no pages");
  if (list.length > MAX_PAGES) problems.push(`${list.length} pages; send at most ${MAX_PAGES}`);
  list.forEach((p, i) => {
    const x = (p ?? {}) as Record<string, unknown>;
    if (!isHttpUrl(x.url)) problems.push(`page ${i + 1} has no absolute http(s) url`);
    if (typeof x.text !== "string" || !x.text.trim()) problems.push(`page ${i + 1} has no text`);
  });
  if (new TextEncoder().encode(JSON.stringify(body)).length > SOURCES_BODY_BYTES) problems.push("the body is over 1 MiB");
  return problems;
}

/** Cuts each page's text to the API's 12,000 characters, never inside a surrogate pair. */
export function trimPages(body: { pages: { text?: unknown }[] }): void {
  for (const p of body.pages) {
    if (!p || typeof p.text !== "string" || p.text.length <= MAX_PAGE_CHARS) continue;
    const cut = p.text.charCodeAt(MAX_PAGE_CHARS - 1);
    p.text = p.text.slice(0, cut >= 0xd800 && cut <= 0xdbff ? MAX_PAGE_CHARS - 1 : MAX_PAGE_CHARS);
  }
}

/** The API's base: `CLERK_API_URL` or the default, https only (http for localhost), so no secret goes out in clear text. */
export function apiBase(env: Record<string, string | undefined>): string | null {
  const base = (env.CLERK_API_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
  try {
    const u = new URL(base);
    if (u.protocol === "https:") return base;
    if (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return base;
  } catch {
    // not a URL
  }
  return null;
}

const ID = /^[A-Za-z0-9_-]{1,40}$/;

/** One call; prints the JSON answer, or says plainly who refused it. Returns the exit code. */
async function call(d: Deps, s: Secrets, method: string, path: string, body?: unknown): Promise<{ code: number; json?: unknown }> {
  const base = apiBase(d.env);
  if (!base) {
    d.err("CLERK_API_URL must be an https:// address (http:// only for localhost), or unset");
    return { code: 64 };
  }
  let res: Response;
  try {
    res = await d.fetch(`${base}${path}`, {
      method,
      headers: headers(s, body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    d.err(`could not reach ${base}: ${e instanceof Error ? e.message : String(e)}`);
    return { code: 2 };
  }
  const type = res.headers.get("content-type") ?? "";
  if (res.status >= 300 && res.status < 400) {
    d.err(`${res.status}: Cloudflare Access sent the request to its sign-in page, so it did not take the service token in ${ACCESS_FILE} (wrong or revoked token, or no Service Auth policy on the Clerk application)`);
    return { code: 2 };
  }
  if (!type.includes("application/json")) {
    d.err(`${res.status}: the answer is not the tracker's JSON (${type || "no content type"}); Cloudflare Access or the tunnel answered instead${res.status === 403 ? " -- Access refused the service token" : ""}`);
    return { code: 2 };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    d.err(`${res.status}: the answer says it is JSON but is not; the tracker or the tunnel cut it short`);
    return { code: 2 };
  }
  if (!res.ok) {
    d.err(`${res.status} ${JSON.stringify(json)}`);
    if (res.status === 429) d.err(`rate limited; wait ${res.headers.get("retry-after") ?? "a few"} seconds`);
    return { code: 1, json };
  }
  return { code: 0, json };
}

const USAGE = "usage: bun scripts/clerk-browser.ts check | pending | listings <id> <file.json> | sources <id> <file.json> | ready <id>";

export async function main(argv: string[], d: Deps): Promise<number> {
  const [cmd, id, file] = argv;
  const needId = cmd === "listings" || cmd === "sources" || cmd === "ready";
  if (!cmd || !["check", "pending", "listings", "sources", "ready"].includes(cmd) || (needId && (!id || !ID.test(id))) || ((cmd === "listings" || cmd === "sources") && !file)) {
    d.err(USAGE);
    return 64;
  }
  let body: unknown;
  if (cmd === "listings" || cmd === "sources") {
    // Never echo the parser's message: it quotes what it choked on, which could be a secret.
    try {
      body = JSON.parse(await d.readFile(file as string));
    } catch {
      d.err(`cannot read ${file} as JSON`);
      return 64;
    }
    if (cmd === "sources" && Array.isArray((body as { pages?: unknown })?.pages)) trimPages(body as { pages: { text?: unknown }[] });
    const problems = cmd === "listings" ? listingsProblems(body) : pagesProblems(body);
    if (problems.length > 0) {
      for (const p of problems) d.err(p);
      return 64;
    }
  }
  let s: Secrets;
  try {
    s = await loadSecrets(d);
  } catch (e) {
    d.err(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (cmd === "check") {
    const r = await call(d, s, "GET", "/me");
    if (r.code === 0) {
      const me = r.json as { user?: { name?: string }; token?: { name?: string; expiresAt?: string } };
      d.out(`ok: the task API answers as ${me.user?.name ?? "?"} (token "${me.token?.name ?? "?"}", expires ${me.token?.expiresAt ?? "?"})`);
    }
    return r.code;
  }
  if (cmd === "pending") {
    const r = await call(d, s, "GET", "/tasks");
    if (r.code !== 0) return r.code;
    d.out(JSON.stringify(pendingJobs(r.json), null, 2));
    return 0;
  }
  const path = cmd === "listings" ? `/tasks/${id}/listings` : cmd === "sources" ? `/tasks/${id}/sources` : `/tasks/${id}/sources/ready`;
  const r = await call(d, s, "POST", path, cmd === "ready" ? {} : body);
  if (r.code === 0) d.out(JSON.stringify(r.json, null, 2));
  return r.code;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    fetch,
    readFile: (p) => Bun.file(p).text(),
    env: process.env,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
  process.exit(code);
}
