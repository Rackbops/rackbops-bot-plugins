import type { User } from "@rackbops/docket-core";
import type { Membership } from "../access.js";
import { allowPerson, type TrackerDeps } from "../actions.js";
import {
  BUSY,
  CONFIGURED_SELF,
  forgetPerson,
  isConfiguredAdmin,
  liftDeclineBlock,
  NO_SUCH_PERSON,
  resumeDelivery,
  setAdminFlag,
  ticksSettled,
} from "../admin.js";
import type { Queue } from "../discord-common.js";
import type { Done } from "../manage.js";
import { adminDeliveriesPage, adminPage, adminTasksPage, CONFIRM_WORD, confirmForgetPage, forgetPage, nameOf, personHref, personPage, type Result } from "./admin-pages.js";
import { htmlResponse, redirect } from "./html.js";
import { notFoundPage, type Viewer } from "./pages.js";
import type { Route } from "./routes.js";

/**
 * The admin view's and forget-me's routes (rackbops-bot-plugins#80, slice 3; plan 5.10). app.ts has
 * already checked the session (re-read from the store, with the membership re-check), the method,
 * and on a POST the `Origin` and the CSRF token -- and, for an admin route, that the viewer's row
 * says admin on this very request. Every write here re-reads the viewer inside the queue and runs
 * only if they are still there (and still an admin, for an admin act); anyone else gets the same
 * 404 as an unknown page. The rules are admin.ts's and actions.ts's; this file reads forms and
 * renders.
 */

export interface AdminWeb {
  d: TrackerDeps;
  v: Viewer;
  queue: Queue;
  /** One membership lookup of `TRACKER_GUILD_ID` for `/allow`'s check, bounded in time; `not-checked` with no gate. */
  memberOf(discordId: string): Promise<Membership>;
  /** The `Set-Cookie` that ends this browser's session. */
  signOutCookie: string;
}

/** The unknown page's 404, word for word, for anyone an admin route is not for. */
export function unknownPage(base: string): Response {
  return htmlResponse(notFoundPage(base), 404);
}

/** `fn` in the queue with the viewer as the store has them now; null when they are gone, or not an admin when `admin`. */
function fresh<T>(a: AdminWeb, admin: boolean, fn: (me: User) => Promise<T>): Promise<T | null> {
  return a.queue(async () => {
    const me = await a.d.store.getUser(a.v.user.id);
    if (!me || (admin && !me.admin)) return null;
    return fn(me);
  });
}

function said(done: Done): Result {
  return done.ok ? { ok: true, text: done.text } : { ok: false, text: done.error };
}

function confirmed(form: URLSearchParams): "ask" | "wrong" | "yes" {
  if (form.get("confirm") !== "yes") return "ask";
  return (form.get("word") ?? "").trim().toLowerCase() === CONFIRM_WORD ? "yes" : "wrong";
}

const WRONG_WORD = `Type ${CONFIRM_WORD} to confirm. Nothing was deleted.`;

async function peoplePage(a: AdminWeb, result: Result, status: number, allow?: string): Promise<Response> {
  const data = { people: a.d.roster.people(), blocks: a.d.roster.activeBlocks(a.d.clock.now()), now: a.d.clock.now() };
  return htmlResponse(adminPage(a.v, data, { result, ...(allow !== undefined ? { allow } : {}) }), status);
}

async function onePerson(a: AdminWeb, id: string, result: Result = null): Promise<Response> {
  const p = a.d.roster.people().find((x) => x.id === id);
  if (!p) return htmlResponse(notFoundPage(a.v.base, a.v), 404);
  const tasks = await a.d.store.listTasks({ ownerId: p.id });
  const tokens = a.d.apiTokens.listFor(p.id, a.d.clock.now());
  return htmlResponse(personPage(a.v, p, tasks, a.d.clock.now(), result, isConfiguredAdmin(a.d, p), tokens), result && !result.ok ? 400 : 200);
}

/** The admin view's pages (GET): people, all tasks, the DMs that did not arrive, one person. */
export async function adminGet(a: AdminWeb, r: Route): Promise<Response> {
  if (r.kind === "admin") return peoplePage(a, null, 200);
  if (r.kind === "admin-person") return onePerson(a, r.id);
  const people = new Map(a.d.roster.people().map((p) => [p.id, nameOf(p)]));
  if (r.kind === "admin-deliveries") {
    const now = a.d.clock.now();
    return htmlResponse(adminDeliveriesPage(a.v, { ...a.d.roster.undelivered(now), names: people, now }));
  }
  const rows = [];
  for (const task of await a.d.store.listTasks()) {
    const receiving = (await a.d.store.listRecipients(task.id)).filter((x) => x.state === "accepted").length;
    rows.push({ task, owner: people.get(task.ownerId) ?? task.ownerId, receiving });
  }
  return htmlResponse(adminTasksPage(a.v, rows));
}

/** The admin view's acts (POST): allow, the admin flag, resuming delivery, lifting a block, revoking an API token, removing a person. */
export async function adminPost(a: AdminWeb, r: Route, form: URLSearchParams): Promise<Response> {
  const base = a.v.base;
  if (r.kind === "admin-allow") {
    const raw = (form.get("discord_id") ?? "").trim();
    if (!/^[0-9]{17,20}$/.test(raw)) return peoplePage(a, { ok: false, text: "That is not a Discord user id (17 to 20 digits)." }, 400, raw.slice(0, 20));
    // Looked up outside the queue, as `/allow` looks it up before its turn.
    const membership = await a.memberOf(raw);
    // A web form cannot tell a bot's id from a person's; a bot's row is harmless, since it can never run `/register`.
    const text = await fresh(a, true, (me) => allowPerson(a.d, me, { discordId: raw, bot: false, membership }));
    if (text === null) return unknownPage(base);
    const ok = text.startsWith("Allowed") || text.includes("already on the list");
    return peoplePage(a, { ok, text }, ok ? 200 : 400);
  }
  if (r.kind === "admin-lift") {
    const done = await fresh(a, true, (me) => liftDeclineBlock(a.d, me, r.id));
    if (done === null) return unknownPage(base);
    return peoplePage(a, said(done), done.ok ? 200 : 400);
  }
  if (r.kind === "admin-token-revoke") {
    // Any person's token (plan 5.10: an admin manages everything); the owner is told nothing, as
    // with a revoked admin flag. Re-checked as an admin in the queue, like every admin act.
    const owner = await fresh(a, true, async (me) => {
      const whose = a.d.apiTokens.revokeAny(r.id);
      if (whose !== null) a.d.log.info(`${me.id} revoked API token ${r.id} of ${whose}`);
      return { whose };
    });
    if (owner === null) return unknownPage(base);
    if (owner.whose === null) return htmlResponse(notFoundPage(base, a.v), 404);
    return onePerson(a, owner.whose, { ok: true, text: "Revoked: that token no longer works." });
  }
  if (r.kind !== "admin-act") return unknownPage(base);
  if (r.action === "forget") {
    const target = a.d.roster.people().find((x) => x.id === r.id);
    if (!target) return htmlResponse(notFoundPage(base, a.v), 404);
    const step = confirmed(form);
    const self = target.id === a.v.user.id;
    const note = self && isConfiguredAdmin(a.d, target) ? { note: CONFIGURED_SELF } : {};
    const page = (error?: string) =>
      confirmForgetPage(a.v, { action: personHref(a.v, target.id, "forget"), self, name: nameOf(target), ...note, ...(error ? { error } : {}) });
    if (step === "ask") return htmlResponse(page());
    if (step === "wrong") return htmlResponse(page(WRONG_WORD), 400);
    // The wait for a running tick is here, before the queue turn: nothing slow runs in the queue.
    // From the wait to the erasure no execute tick starts, so none can keep forget-me BUSY.
    const done = await a.d.lanes.excludeExecute(async () =>
      (await ticksSettled(a.d)) ? fresh(a, true, (me) => forgetPerson(a.d, me, target.id)) : ({ ok: false, error: BUSY } as const),
    );
    if (done === null) return unknownPage(base);
    if (!done.ok) return htmlResponse(page(done.error), done.error === NO_SUCH_PERSON ? 404 : done.error === BUSY ? 503 : 400);
    if (self) return redirect(`${base}/signin?forgotten=1`, [a.signOutCookie]);
    return peoplePage(a, said(done), 200);
  }
  const act =
    r.action === "grant"
      ? (me: User) => setAdminFlag(a.d, me, r.id, true)
      : r.action === "revoke"
        ? (me: User) => setAdminFlag(a.d, me, r.id, false)
        : (me: User) => resumeDelivery(a.d, me, r.id);
  const done = await fresh(a, true, act);
  if (done === null) return unknownPage(base);
  if (!done.ok && done.error === NO_SUCH_PERSON) return htmlResponse(notFoundPage(base, a.v), 404);
  // An admin who just revoked their own flag has no admin view any more.
  const me = await a.d.store.getUser(a.v.user.id);
  if (!me?.admin) return redirect(`${base}/`);
  return onePerson(a, r.id, said(done));
}

/** `/forget`, the person's own: the page (GET), the confirmation (POST), the erasure (POST with the word). */
export async function forgetRoute(a: AdminWeb, method: string, form: URLSearchParams | null): Promise<Response> {
  const base = a.v.base;
  const note = isConfiguredAdmin(a.d, a.v.user) ? CONFIGURED_SELF : undefined;
  if (method === "GET" || !form) return htmlResponse(forgetPage(a.v, note));
  const page = (error?: string) =>
    confirmForgetPage(a.v, { action: `${base}/forget`, self: true, name: nameOf(a.v.user), ...(note ? { note } : {}), ...(error ? { error } : {}) });
  const step = confirmed(form);
  if (step === "ask") return htmlResponse(page());
  if (step === "wrong") return htmlResponse(page(WRONG_WORD), 400);
  const done = await a.d.lanes.excludeExecute(async () =>
    (await ticksSettled(a.d)) ? fresh(a, false, (me) => forgetPerson(a.d, me, me.id)) : ({ ok: false, error: BUSY } as const),
  );
  if (done === null) return redirect(`${base}/signin`, [a.signOutCookie]);
  if (!done.ok) return htmlResponse(page(done.error), done.error === BUSY ? 503 : 400);
  return redirect(`${base}/signin?forgotten=1`, [a.signOutCookie]);
}
