import type { User } from "@rackbops/docket-core";
import { type Membership, NOT_MEMBER } from "../access.js";
import type { PluginHttpInfo } from "../../../../packages/api/contract.js";
import { loadTaskList, MEMBER_ROLE, saveSettings, type TrackerDeps, type UsrLink } from "../actions.js";
import type { Queue } from "../discord-common.js";
import { MAX_ZONE } from "../limits.js";
import { adminGet, adminPost, type AdminWeb, forgetRoute, unknownPage } from "./admin.js";
import { FAILED_BURST, FAILED_PER_SECOND, handleApi, json, RATE_BURST, RATE_PER_SECOND, RateLimiter, type Recheck } from "./api.js";
import { problem } from "./api-tasks.js";
import { CreationLog, tokensGet, tokensPost, tokenRevokePost } from "./tokens.js";
import { actionPost, editGet, editPost, type Editor, newGet, newPost, taskPage } from "./editor.js";
import { notice } from "./editor-pages.js";
import { cookie, htmlResponse, readBody, readCookie, redirect } from "./html.js";
import { errorPage, loginPage, notFoundPage, settingsPage, signInHelpPage, tasksPage, type Viewer } from "./pages.js";
import { isAdminRoute, methodsOf, route } from "./routes.js";
import { randomToken, safeEqual } from "./secrets.js";
import { SESSION_TTL_MS, type Session } from "./sessions.js";
import { LINK_TTL_MS } from "./signin-link.js";
import { refreshUrl, SSO_COOKIE } from "../usr-identity.js";
import { STYLESHEET, STYLESHEET_PATH } from "./theme.js";

/**
 * The web area's router (plan 5.10; rackbops-bot-plugins#80), behind the host's `http` handler:
 * `info.path` arrives with `/<name>` already stripped. Pure over the injected deps and clock -- no
 * server, no network -- so the tests call it with a `Request` and read the `Response`.
 *
 * - Public: the stylesheet, `/signin` (how to get a link), `/login` (the one-time link).
 * - `/api/...`: the JSON task API (api.ts), which authenticates by bearer token only and never
 *   reads the session cookie; it shares this closure's membership re-check and price-read guard.
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
 *   confirmation is under `MEMBER_GRACE_MS` old, and signs them out after that. Concurrent requests
 *   share one lookup per person, held until Discord answers (a timed-out one is abandoned, not
 *   cancelled); after a failed one the person is not looked up again for `MEMBER_RETRY_MS`, so an
 *   outage or a rate limit does not pile calls into the bot's shared REST queue. A confirmation
 *   time in the future (a clock set back) counts as stale.
 */

export const MEMBER_RECHECK_MS = 15 * 60 * 1000;
export const MEMBER_GRACE_MS = 24 * 60 * 60 * 1000;
export const MEMBER_CHECK_TIMEOUT_MS = 3000;
export const MEMBER_RETRY_MS = 60 * 1000;

export const LEFT_SERVER = `You are signed out. ${NOT_MEMBER}`;
/**
 * usr sent the browser back still without an `nz_id` the tracker can accept: usr's keys could not be
 * fetched, the clocks disagree, or usr minted no token. (A cookie domain that misses this site never
 * gets here: usr refuses the return address and keeps the browser.)
 */
export const USR_NO_COOKIE = "I could not confirm your usr sign-in. Try again in a minute, or run /web in Discord for a one-time link. If it keeps happening, tell an admin.";
export const USR_NOT_MEMBER = "Your usr account does not have this tracker's member role yet: ask an admin to run /allow for you in the server.";
export const USR_NOT_LINKED = "Your usr account is not linked to anyone on this tracker yet: ask an admin to run /allow for you in the server, then run /register.";
/** The mark on the address usr sends the browser back to, so a missing cookie never loops. */
export const USR_BACK = "usr";
/** `?usr=go`: the sign-in page's "Sign in with usr" button, which signs in even after a sign-out. */
export const USR_GO = "go";
/**
 * After Sign out, how long a GET does not sign the person back in from usr's cookie on its own:
 * longer than usr's longest `nz_id` (30 minutes by default). Signing out here does not sign out of usr.
 */
export const SIGNED_OUT_MS = 12 * 60 * 60 * 1000;
export const RECHECK_FAILED = "You are signed out: I could not check that you are still a member of this tracker's server.";

export interface WebWiring {
  /** The plugin's name: the path prefix and the cookie names. */
  name: string;
  /** `TRACKER_WEB_URL`'s origin; null = no web area (everything but health answers 404). */
  origin: string | null;
  deps(): TrackerDeps | null;
  /** The surface's one queue: a store write from here takes its turn with the commands' and buttons'. */
  queue: Queue;
  /** `TRACKER_GUILD_ID`'s servers; null = no membership gate, and no re-check. */
  guildIds: readonly string[] | null;
  /** One membership lookup across `TRACKER_GUILD_ID`'s servers; null when there is no Discord client to ask yet. */
  membership(discordId: string): Promise<Membership | null>;
}

/**
 * The biggest form body read. The longest form is a reminder of 1500 characters, which
 * percent-encoded can take about 13.5 KiB; anything bigger is refused before it is parsed.
 */
export const MAX_FORM_BYTES = 32 * 1024;

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
  });
}

/** What the sign-in help page says after a sign-out or an erasure: fixed texts, nothing from the address. */
function signInNote(q: URLSearchParams): string | undefined {
  if (q.get("forgotten") === "1") return "Everything the tracker held about you is deleted, and you are signed out.";
  return q.get("out") === "1" ? "You are signed out." : undefined;
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
  const OUT_COOKIE = `__Secure-${w.name}-out`;
  const clear = (name: string) => cookie(name, "", { base, maxAgeSeconds: 0, sameSite: "Lax" });
  // In memory only, per tracker user id: the lookup still waiting on Discord, and when the last one
  // failed.
  const inFlight = new Map<string, Promise<Membership | null>>();
  const failedAt = new Map<string, number>();
  // New price trackers whose page is being read, per tracker user id (editor.ts): the web's and
  // the API's alike, so one person has one in flight wherever they asked.
  const reading = new Set<string>();
  // The task API's per-token rate limit (api.ts).
  const limiter = new RateLimiter(RATE_BURST, RATE_PER_SECOND);
  const failed = new RateLimiter(FAILED_BURST, FAILED_PER_SECOND);
  // API token creations per person per hour (tokens.ts): each sends a DM.
  const created = new CreationLog();

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
    // The lookup may have waited: act only on the session as it stands now.
    const current = d.sessions.find(id, d.clock.now());
    if (!current) return { kind: "stale" };
    return { kind: "ok", id, session: current, user };
  }

  /** One lookup per person at a time, kept until Discord answers; each caller waits at most the timeout. */
  function lookupShared(userId: string, discordId: string): Promise<Membership | null> {
    let pending = inFlight.get(userId);
    if (!pending) {
      const started = w.membership(discordId).catch((): Membership => "unknown");
      pending = started;
      inFlight.set(userId, started);
      void started.finally(() => {
        if (inFlight.get(userId) === started) inFlight.delete(userId);
      });
    }
    const shared = pending;
    return lookupWithin(() => shared, MEMBER_CHECK_TIMEOUT_MS);
  }

  /**
   * The membership re-check, for a session and an API token alike (`checkedAt` is theirs): "ok",
   * or "not-member" -- then every session and every API token of the person is gone -- or "unknown"
   * once the last confirmation is too old to trust (the caller decides what that ends).
   */
  async function recheck(d: TrackerDeps, user: User, checkedAt: string | null): Promise<Recheck> {
    if (w.guildIds === null) return "ok";
    const now = d.clock.now().getTime();
    const age = checkedAt ? now - Date.parse(checkedAt) : Number.POSITIVE_INFINITY;
    const fresh = (limit: number) => age >= 0 && age < limit;
    if (fresh(MEMBER_RECHECK_MS)) return "ok";
    const lastFailed = failedAt.get(user.id);
    const backingOff = lastFailed !== undefined && now - lastFailed >= 0 && now - lastFailed < MEMBER_RETRY_MS;
    let found: Membership | null = "unknown";
    if (!backingOff && user.discordId) {
      found = await lookupShared(user.id, user.discordId);
      if (found === "member" || found === "not-member") failedAt.delete(user.id);
      else failedAt.set(user.id, d.clock.now().getTime());
    }
    if (found === "not-member") {
      d.sessions.deleteForUser(user.id);
      d.apiTokens.deleteForUser(user.id);
      return "not-member";
    }
    if (found === "member") {
      const at = d.clock.now().toISOString();
      d.sessions.confirmMember(user.id, at);
      d.apiTokens.confirmMember(user.id, at);
      return "ok";
    }
    return fresh(MEMBER_GRACE_MS) ? "ok" : "unknown";
  }

  async function recheckMembership(d: TrackerDeps, session: Session, user: User): Promise<Auth | null> {
    const found = await recheck(d, user, session.memberCheckedAt);
    if (found === "ok") return null;
    if (found === "not-member") return { kind: "signed-out", note: LEFT_SERVER };
    d.sessions.deleteForUser(user.id);
    return { kind: "signed-out", note: RECHECK_FAILED };
  }

  /** `/allow`'s membership check from the web: one bounded lookup; no Discord client yet is `unknown`, which refuses. */
  async function memberOf(discordId: string): Promise<Membership> {
    if (w.guildIds === null) return "not-checked";
    return (await lookupWithin(() => w.membership(discordId), MEMBER_CHECK_TIMEOUT_MS)) ?? "unknown";
  }

  async function readForm(request: Request): Promise<URLSearchParams | null> {
    const type = request.headers.get("content-type") ?? "";
    if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
    const body = await readBody(request, MAX_FORM_BYTES);
    return body === null ? null : new URLSearchParams(body);
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

  /**
   * Sign-in through usr (usr-identity.ts): a valid `nz_id` naming a usr account linked to a
   * registered person, holding `<app>:member`, opens a session as `/login` does, and the browser goes
   * on to the page it asked for. With no valid cookie the browser is sent to usr once to get one,
   * marked so that coming back without it shows why instead of going round again. The one-time
   * `/web` link stays beside it.
   */
  async function usrSignIn(d: TrackerDeps, usr: UsrLink, request: Request, path: string, url: URL, origin: string, stale: string[]): Promise<Response> {
    const asked = url.searchParams.get(USR_BACK);
    // Signed out a moment ago: only the sign-in page's button signs back in, never any GET.
    if (readCookie(request, OUT_COOKIE) !== null && asked !== USR_GO) return redirect(`${base}/signin?out=1`, stale);
    const identity = await usr.verifier.verify(readCookie(request, SSO_COOKIE));
    const help = (note: string) => htmlResponse(signInHelpPage(base, note), 403, stale[0] ? { "Set-Cookie": stale[0] } : {});
    // The address's own query, without our mark, kept across the trip to usr and back.
    const query = new URLSearchParams(url.searchParams);
    query.delete(USR_BACK);
    const rest = query.toString();
    if (!identity) {
      if (asked === "1") return help(USR_NO_COOKIE);
      // An address built from TRACKER_WEB_URL and our own path, never from the request's Host.
      const back = refreshUrl(usr.url, `${origin}${base}${path}?${rest ? `${rest}&` : ""}${USR_BACK}=1`);
      const h = new Headers({ Location: back, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      for (const c of stale) h.append("Set-Cookie", c);
      return new Response(null, { status: 303, headers: h });
    }
    if (!identity.roles.includes(`${usr.app}:${MEMBER_ROLE}`)) return help(USR_NOT_MEMBER);
    const userId = usr.links.userOfSubject(identity.sub);
    const user = userId ? await d.store.getUser(userId) : null;
    if (!user || !d.admissions.isRegistered(user.id)) return help(USR_NOT_LINKED);
    // Membership of TRACKER_GUILD_ID, checked now as `/web` checks it before giving a link, so the
    // session starts confirmed rather than failing its first page on a slow lookup.
    const member = await recheck(d, user, null);
    if (member === "not-member") return help(LEFT_SERVER);
    if (member !== "ok") return help(RECHECK_FAILED);
    const now = d.clock.now();
    const { id } = d.sessions.create(user.id, now, w.guildIds === null ? null : now.toISOString());
    return redirect(`${base}${path}${rest ? `?${rest}` : ""}`, [cookie(SESSION_COOKIE, id, { base, maxAgeSeconds: SESSION_TTL_MS / 1000, sameSite: "Lax" }), clear(OUT_COOKIE)]);
  }

  /**
   * A signed-in person whose usr cookie, for their own linked account, no longer carries
   * `<app>:member` (an admin took it away in usr) is signed out of every session now, not when the
   * session ends. Without the cookie nothing is known, and the session stands.
   */
  async function usrRevoked(d: TrackerDeps, request: Request, user: User): Promise<boolean> {
    const usr = d.usr;
    if (!usr) return false;
    const identity = await usr.verifier.verify(readCookie(request, SSO_COOKIE));
    if (!identity || identity.sub !== usr.links.subjectOf(user.id) || identity.roles.includes(`${usr.app}:${MEMBER_ROLE}`)) return false;
    d.sessions.deleteForUser(user.id);
    return true;
  }

  async function settingsPost(d: TrackerDeps, v: Viewer, form: URLSearchParams): Promise<Response> {
    const hour = (form.get("hour") ?? "").trim();
    const zone = (form.get("zone") ?? "").trim();
    let error: string | null = null;
    if (!/^([0-9]|1[0-9]|2[0-3])$/.test(hour)) error = "The preferred hour must be a whole hour from 0 to 23.";
    else if (zone === "" || zone.length > MAX_ZONE) error = "Give a time zone, such as America/New_York.";
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
    // The JSON task API (api.ts): bearer tokens, never the cookie, and its own methods and errors.
    if (info.path === "/api" || info.path.startsWith("/api/")) {
      if (w.origin === null) return plain(404, "Not found");
      const d = w.deps();
      if (!d) return json(problem(503, "starting", "The tracker is starting up; try again in a minute.", { "Retry-After": "60" }));
      return handleApi({ d, queue: w.queue, reading, base, limiter, failed, recheck: (user, at) => recheck(d, user, at) }, request, info.path);
    }
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
    if (path === "/signin") return only("GET") ?? htmlResponse(signInHelpPage(base, signInNote(url.searchParams), Boolean(d.usr)));
    if (path === "/login") return method === "GET" ? loginGet(d, url) : loginPost(d, request);

    // Signed in.
    const r = route(path);
    if (r === null) return htmlResponse(notFoundPage(base), 404);
    const allowed = methodsOf(r);
    const admin = isAdminRoute(r);
    // An admin route's method is checked only once the viewer is known to be an admin, so to anyone
    // else it answers exactly as an unknown path does.
    if (!admin && !allowed.split(", ").includes(method)) return plain(405, "Method not allowed", { Allow: allowed });

    const auth = await authenticate(d, request);
    if (auth.kind === "signed-out") return htmlResponse(signInHelpPage(base, auth.note), 403, { "Set-Cookie": clear(SESSION_COOKIE) });
    if (auth.kind !== "ok") {
      const stale = auth.kind === "stale" ? [clear(SESSION_COOKIE)] : [];
      if (method === "GET" && d.usr && w.origin !== null) return usrSignIn(d, d.usr, request, path, url, w.origin, stale);
      return redirect(`${base}/signin`, stale);
    }
    if (await usrRevoked(d, request, auth.user)) return htmlResponse(signInHelpPage(base, USR_NOT_MEMBER), 403, { "Set-Cookie": clear(SESSION_COOKIE) });
    // The one admin definition, read from the store on this request (authenticate re-read the row):
    // an admin whose flag was revoked a moment ago is refused now, not at their next sign-in.
    if (admin && !auth.user.admin) return unknownPage(base);
    if (admin && !allowed.split(", ").includes(method)) return plain(405, "Method not allowed", { Allow: allowed });
    const v: Viewer = { base, user: auth.user, csrf: auth.session.csrf };
    const e: Editor = { d, v, queue: w.queue, reading };
    const a: AdminWeb = { d, v, queue: w.queue, memberOf: (id) => memberOf(id), signOutCookie: clear(SESSION_COOKIE) };

    if (method === "POST") {
      const form = await readForm(request);
      if (!form) return plain(400, "Bad request");
      if (!safeEqual(auth.session.csrf, form.get("csrf") ?? "")) return forbidden();
      switch (r.kind) {
      case "logout":
        d.sessions.delete(auth.id);
        return redirect(`${base}/signin?out=1`, [
          clear(SESSION_COOKIE),
          ...(d.usr ? [cookie(OUT_COOKIE, "1", { base, maxAgeSeconds: SIGNED_OUT_MS / 1000, sameSite: "Lax" })] : []),
        ]);
      case "settings":
        return settingsPost(d, v, form);
      case "new":
        return newPost(e, r.type, form);
      case "edit":
        return editPost(e, r.id, form);
      case "act":
        return actionPost(e, r.id, r.action, form);
      case "forget":
        return forgetRoute(a, method, form);
      case "tokens":
        return tokensPost(d, v, auth.session, form, created);
      case "token-revoke":
        return tokenRevokePost(d, v, r.id);
      case "admin-allow":
      case "admin-act":
      case "admin-ceiling":
      case "admin-lift":
      case "admin-token-revoke":
        return adminPost(a, r, form);
      default:
        return plain(405, "Method not allowed", { Allow: allowed });
      }
    }

    const now = d.clock.now();
    const done = url.searchParams.get("done");
    switch (r.kind) {
    case "tasks":
      return htmlResponse(tasksPage(v, await loadTaskList(d, auth.user), now, notice(done), d.research === true));
    case "task":
      return taskPage(e, r.id, done);
    case "edit":
      return editGet(e, r.id);
    case "new":
      return newGet(e, r.type);
    case "forget":
      return forgetRoute(a, method, null);
    case "tokens":
      return tokensGet(d, v);
    case "admin":
    case "admin-tasks":
    case "admin-deliveries":
    case "admin-usage":
    case "admin-person":
      return adminGet(a, r);
    default:
      return htmlResponse(
        settingsPage(v, { hour: String(auth.user.preferredHour), zone: auth.user.timeZone, saved: url.searchParams.get("saved") === "1" }),
      );
    }
  };
}
