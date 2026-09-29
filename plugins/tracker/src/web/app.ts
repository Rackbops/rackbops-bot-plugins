import type { User } from "@rackbops/docket-core";
import { type Membership, NOT_MEMBER } from "../access.js";
import type { PluginHttpInfo } from "../../../../packages/api/contract.js";
import { loadTaskList, saveSettings, type TrackerDeps } from "../actions.js";
import type { Queue } from "../discord-common.js";
import { loadHistory } from "../history.js";
import { cookie, htmlResponse, readCookie, redirect } from "./html.js";
import { errorPage, historyPage, loginPage, notFoundPage, settingsPage, signInHelpPage, tasksPage, type Viewer } from "./pages.js";
import { randomToken, safeEqual } from "./secrets.js";
import { SESSION_TTL_MS, type Session } from "./sessions.js";
import { LINK_TTL_MS } from "./signin-link.js";
import { STYLESHEET, STYLESHEET_PATH } from "./theme.js";

/**
 * The web area's router (plan 5.10; rackbops-bot-plugins#80), behind the host's `http` handler:
 * `info.path` arrives with `/<name>` already stripped. Pure over the injected deps and clock -- no
 * server, no network -- so the tests call it with a `Request` and read the `Response`.
 *
 * - Public: the stylesheet, `/signin` (how to get a link), `/login` (the one-time link).
 * - Everything else needs a session, re-checked on every request against the store: a person no
 *   longer in it, or no longer registered, is signed out (every one of their sessions dropped).
 * - Every state change is a POST carrying the session's CSRF token (compared in constant time),
 *   and a POST whose `Origin` is present and is not `TRACKER_WEB_URL`'s is refused. Sign-in itself
 *   has no session yet, so its form carries a double-submit token from a `SameSite=Strict` cookie
 *   the link's page sets: a cross-site page cannot sign a person in as someone else.
 * - Links and redirects are paths on this origin, never built from the `Host` header.
 * - With a membership gate (`TRACKER_GUILD_ID`), a session whose membership was last confirmed
 *   `MEMBER_RECHECK_MS` ago or more is re-checked by one member lookup (outside the write queue,
 *   given `MEMBER_CHECK_TIMEOUT_MS`): not a member signs the person out everywhere; a member
 *   refreshes the time; an error, a timeout or no Discord client yet lets them on while the last
 *   confirmation is under `MEMBER_GRACE_MS` old, and signs them out after that.
 */

export const MEMBER_RECHECK_MS = 15 * 60 * 1000;
export const MEMBER_GRACE_MS = 24 * 60 * 60 * 1000;
export const MEMBER_CHECK_TIMEOUT_MS = 3000;

export const LEFT_SERVER = `You are signed out. ${NOT_MEMBER}`;
export const RECHECK_FAILED = "You are signed out: I could not check that you are still a member of this tracker's server.";

export interface WebWiring {
  /** The plugin's name: the path prefix and the cookie names. */
  name: string;
  /** `TRACKER_WEB_URL`'s origin; null = no web area (everything but health answers 404). */
  origin: string | null;
  deps(): TrackerDeps | null;
  /** The surface's one queue: a store write from here takes its turn with the commands' and buttons'. */
  queue: Queue;
  /** `TRACKER_GUILD_ID`; null = no membership gate, and no re-check. */
  guildId: string | null;
  /** One member lookup of `TRACKER_GUILD_ID`; null when there is no Discord client to ask yet. */
  membership(discordId: string): Promise<Membership | null>;
}

/** The biggest form body read: the forms here are a few short fields. */
export const MAX_FORM_BYTES = 8 * 1024;

const TASK_PATH = /^\/tasks\/([^/]+)$/;

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
  });
}

type Auth =
  | { kind: "none" }
  | { kind: "stale" }
  | { kind: "signed-out"; note: string }
  | { kind: "ok"; id: string; session: Session; user: User };

/** The lookup, or "unknown" when it throws or takes longer than `ms`. */
export async function lookupWithin(lookup: () => Promise<Membership | null>, ms: number): Promise<Membership | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Membership>((resolve) => {
    timer = setTimeout(() => resolve("unknown"), ms);
  });
  try {
    return await Promise.race([lookup().catch((): Membership => "unknown"), late]);
  } finally {
    clearTimeout(timer);
  }
}

export function createWebHandler(w: WebWiring): (request: Request, info: PluginHttpInfo) => Promise<Response> {
  const base = `/${w.name}`;
  const SESSION_COOKIE = `__Secure-${w.name}-session`;
  const LOGIN_COOKIE = `__Secure-${w.name}-login`;
  const clear = (name: string) => cookie(name, "", { base, maxAgeSeconds: 0, sameSite: "Lax" });

  async function authenticate(d: TrackerDeps, request: Request): Promise<Auth> {
    const id = readCookie(request, SESSION_COOKIE);
    if (!id) return { kind: "none" };
    const session = d.sessions.find(id, d.clock.now());
    if (!session) return { kind: "stale" };
    const user = await d.store.getUser(session.userId);
    if (!user || !d.admissions.isRegistered(user.id)) {
      d.sessions.deleteForUser(session.userId);
      return { kind: "stale" };
    }
    const refused = await recheckMembership(d, session, user);
    if (refused) return refused;
    return { kind: "ok", id, session, user };
  }

  async function recheckMembership(d: TrackerDeps, session: Session, user: User): Promise<Auth | null> {
    if (w.guildId === null) return null;
    const now = d.clock.now();
    const age = session.memberCheckedAt ? now.getTime() - Date.parse(session.memberCheckedAt) : Number.POSITIVE_INFINITY;
    if (age < MEMBER_RECHECK_MS) return null;
    const discordId = user.discordId;
    const found = discordId ? await lookupWithin(() => w.membership(discordId), MEMBER_CHECK_TIMEOUT_MS) : "unknown";
    if (found === "not-member") {
      d.sessions.deleteForUser(user.id);
      return { kind: "signed-out", note: LEFT_SERVER };
    }
    if (found === "member") {
      d.sessions.confirmMember(user.id, now.toISOString());
      return null;
    }
    if (age < MEMBER_GRACE_MS) return null;
    d.sessions.deleteForUser(user.id);
    return { kind: "signed-out", note: RECHECK_FAILED };
  }

  async function readForm(request: Request): Promise<URLSearchParams | null> {
    const type = request.headers.get("content-type") ?? "";
    if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
    const body = await request.text();
    if (Buffer.byteLength(body) > MAX_FORM_BYTES) return null;
    return new URLSearchParams(body);
  }

  function forbidden(): Response {
    return htmlResponse(errorPage(base, "Refused", "That form was stale or came from somewhere else. Go back, reload the page and try again."), 403);
  }

  async function loginGet(d: TrackerDeps, url: URL): Promise<Response> {
    const token = url.searchParams.get("t") ?? "";
    const valid = d.logins.peek(token, d.clock.now());
    if (!valid) return htmlResponse(loginPage(base, { token: "", loginCsrf: "", valid: false }));
    const loginCsrf = randomToken();
    return htmlResponse(loginPage(base, { token, loginCsrf, valid: true }), 200, {
      "Set-Cookie": cookie(LOGIN_COOKIE, loginCsrf, { base, maxAgeSeconds: LINK_TTL_MS / 1000, sameSite: "Strict" }),
    });
  }

  async function loginPost(d: TrackerDeps, request: Request): Promise<Response> {
    const form = await readForm(request);
    if (!form) return plain(400, "Bad request");
    const expected = readCookie(request, LOGIN_COOKIE);
    const sent = form.get("csrf") ?? "";
    if (!expected || !safeEqual(expected, sent)) return forbidden();
    const now = d.clock.now();
    const link = d.logins.consume(form.get("t") ?? "", now);
    const user = link ? await d.store.getUser(link.userId) : null;
    if (!user || !d.admissions.isRegistered(user.id)) {
      return htmlResponse(signInHelpPage(base, "That sign-in link has expired or was already used."), 400, { "Set-Cookie": clear(LOGIN_COOKIE) });
    }
    const { id } = d.sessions.create(user.id, now, link?.memberCheckedAt ?? null);
    return redirect(`${base}/`, [cookie(SESSION_COOKIE, id, { base, maxAgeSeconds: SESSION_TTL_MS / 1000, sameSite: "Lax" }), clear(LOGIN_COOKIE)]);
  }

  async function settingsPost(d: TrackerDeps, v: Viewer, form: URLSearchParams): Promise<Response> {
    const hour = (form.get("hour") ?? "").trim();
    const zone = (form.get("zone") ?? "").trim();
    let error: string | null = null;
    if (!/^([0-9]|1[0-9]|2[0-3])$/.test(hour)) error = "The preferred hour must be a whole hour from 0 to 23.";
    else if (zone === "" || zone.length > 64) error = "Give a time zone, such as America/New_York.";
    else {
      error = await w.queue(async () => {
        const fresh = await d.store.getUser(v.user.id);
        return fresh ? saveSettings(d, fresh, { hour: Number(hour), zone }) : "You are no longer on this tracker's list.";
      });
    }
    if (error !== null) return htmlResponse(settingsPage(v, { hour, zone, error }), 400);
    return redirect(`${base}/settings?saved=1`);
  }

  return async (request, info) => {
    const method = request.method;
    if (method !== "GET" && method !== "POST") return plain(405, "Method not allowed", { Allow: "GET, POST" });
    if (w.origin === null) return plain(404, "Not found");
    const d = w.deps();
    if (!d) return plain(503, "The tracker is starting up; try again in a minute.");
    if (method === "POST") {
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== w.origin) return forbidden();
    }
    const path = info.path;
    const url = new URL(request.url);
    const only = (allowed: "GET" | "POST") => (method === allowed ? null : plain(405, "Method not allowed", { Allow: allowed }));

    // Public.
    if (path === STYLESHEET_PATH) {
      return (
        only("GET") ??
        new Response(STYLESHEET, {
          headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
        })
      );
    }
    if (path === "/signin") return only("GET") ?? htmlResponse(signInHelpPage(base, url.searchParams.get("out") === "1" ? "You are signed out." : undefined));
    if (path === "/login") return method === "GET" ? loginGet(d, url) : loginPost(d, request);

    // Signed in.
    const task = TASK_PATH.exec(path);
    const route = path === "/" ? "tasks" : path === "/settings" ? "settings" : path === "/logout" ? "logout" : task ? "history" : null;
    if (route === null) return htmlResponse(notFoundPage(base), 404);
    const wrong = route === "logout" ? only("POST") : route === "settings" ? null : only("GET");
    if (wrong) return wrong;

    const auth = await authenticate(d, request);
    if (auth.kind === "signed-out") return htmlResponse(signInHelpPage(base, auth.note), 403, { "Set-Cookie": clear(SESSION_COOKIE) });
    if (auth.kind !== "ok") return redirect(`${base}/signin`, auth.kind === "stale" ? [clear(SESSION_COOKIE)] : []);
    const v: Viewer = { base, user: auth.user, csrf: auth.session.csrf };

    if (method === "POST") {
      const form = await readForm(request);
      if (!form) return plain(400, "Bad request");
      if (!safeEqual(auth.session.csrf, form.get("csrf") ?? "")) return forbidden();
      if (route === "logout") {
        d.sessions.delete(auth.id);
        return redirect(`${base}/signin?out=1`, [clear(SESSION_COOKIE)]);
      }
      return settingsPost(d, v, form);
    }

    const now = d.clock.now();
    switch (route) {
    case "tasks":
      return htmlResponse(tasksPage(v, await loadTaskList(d, auth.user), now));
    case "history": {
      let id: string;
      try {
        id = decodeURIComponent(task?.[1] ?? "");
      } catch {
        return htmlResponse(notFoundPage(base, v), 404);
      }
      const view = await loadHistory(d, auth.user, id);
      return view ? htmlResponse(historyPage(v, view)) : htmlResponse(notFoundPage(base, v), 404);
    }
    default:
      return htmlResponse(
        settingsPage(v, { hour: String(auth.user.preferredHour), zone: auth.user.timeZone, saved: url.searchParams.get("saved") === "1" }),
      );
    }
  };
}
