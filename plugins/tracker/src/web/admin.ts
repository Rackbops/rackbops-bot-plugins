import { DEFAULT_BUDGET, type User } from "@rackbops/docket-core";
import type { Membership } from "../access.js";
import { allowPerson, MEMBER_ROLE, type TrackerDeps, type UsrLink } from "../actions.js";
import { type AllowResult, UsrError } from "../usr.js";
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
import { boundsOf, type CeilingInput, setCeiling, spentToday } from "../ceilings.js";
import type { Queue } from "../discord-common.js";
import type { Done } from "../manage.js";
import { adminDeliveriesPage, adminPage, adminTasksPage, CONFIRM_WORD, confirmForgetPage, forgetPage, nameOf, personHref, personPage, type Result } from "./admin-pages.js";
import { htmlResponse, redirect } from "./html.js";
import { loadUsage } from "../usage.js";
import { adminUsagePage } from "./usage-pages.js";
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
  /** The server usr records a backfilled link against (`TRACKER_GUILD_ID`'s first); null with no gate. */
  usrGuildId: string | null;
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
  const people = a.d.roster.people();
  const data = { people, blocks: a.d.roster.activeBlocks(a.d.clock.now()), now: a.d.clock.now() };
  const usr = a.d.usr;
  const usrUnlinked = usr ? people.filter((p) => p.discordId !== null && usr.links.subjectOf(p.id) === null).length : null;
  return htmlResponse(
    adminPage(a.v, data, { result, unlimited: a.d.budgetUnlimited === true, usrUnlinked, ...(allow !== undefined ? { allow } : {}) }),
    status,
  );
}

async function onePerson(a: AdminWeb, id: string, result: Result = null): Promise<Response> {
  const everyone = a.d.roster.people();
  const p = everyone.find((x) => x.id === id);
  if (!p) return htmlResponse(notFoundPage(a.v.base, a.v), 404);
  const tasks = await a.d.store.listTasks({ ownerId: p.id });
  const now = a.d.clock.now();
  const tokens = a.d.apiTokens.listFor(p.id, now);
  const budget = {
    latest: a.d.ceilings.latest(p.id),
    history: a.d.ceilings.history(p.id),
    today: await spentToday(a.d.store, p.id, now),
    defaults: DEFAULT_BUDGET.person,
    bounds: boundsOf(),
    names: new Map(everyone.map((x) => [x.id, nameOf(x)])),
    unlimited: a.d.budgetUnlimited === true,
  };
  return htmlResponse(personPage(a.v, p, tasks, now, result, isConfiguredAdmin(a.d, p), tokens, budget), result && !result.ok ? 400 : 200);
}

/** The admin view's pages (GET): people, all tasks, the DMs that did not arrive, model usage, one person. */
export async function adminGet(a: AdminWeb, r: Route): Promise<Response> {
  if (r.kind === "admin") return peoplePage(a, null, 200);
  if (r.kind === "admin-person") return onePerson(a, r.id);
  if (r.kind === "admin-usage") {
    // Read-only (plan 5.7; roshne, 2026-10-02: "evaluate usage during alpha").
    const now = a.d.clock.now();
    const people = new Map(a.d.roster.people().map((p) => [p.id, nameOf(p)]));
    return htmlResponse(adminUsagePage(a.v, { report: await loadUsage(a.d.store, now), names: people, unlimited: a.d.budgetUnlimited === true }));
  }
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

/** The admin view's acts (POST): allow, the admin flag, resuming delivery, a person's ceiling, lifting a block, revoking an API token, removing a person. */
export async function adminPost(a: AdminWeb, r: Route, form: URLSearchParams): Promise<Response> {
  const base = a.v.base;
  if (r.kind === "admin-allow") {
    const raw = (form.get("discord_id") ?? "").trim();
    if (!/^[0-9]{17,20}$/.test(raw)) return peoplePage(a, { ok: false, text: "That is not a Discord user id (17 to 20 digits)." }, 400, raw.slice(0, 20));
    // Looked up outside the queue, as `/allow` looks it up before its turn.
    const membership = await a.memberOf(raw);
    // A web form cannot tell a bot's id from a person's; a bot's row is harmless, since it can never run `/register`.
    // No server here, so no call to usr: with the link on, the answer says to use `/allow` in the server.
    const text = await fresh(a, true, async (me) => {
      const answer = await allowPerson(a.d, me, { discordId: raw, bot: false, membership }, null);
      if (typeof answer !== "string") throw new Error("allowPerson called out without a server");
      return answer;
    });
    if (text === null) return unknownPage(base);
    const ok = text.startsWith("Allowed") || text.includes("already on the list");
    return peoplePage(a, { ok, text }, ok ? 200 : 400);
  }
  if (r.kind === "admin-usr-link") {
    if (!a.d.usr) return unknownPage(base);
    const result = await linkEveryone(a, a.d.usr);
    if (result === null) return unknownPage(base);
    return peoplePage(a, result, result.ok ? 200 : 400);
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
  if (r.kind === "admin-ceiling") {
    // A raise or a reset (plan 5.7: "The admin raises a person's ceiling from the web area").
    const input: CeilingInput = form.get("reset") === "yes" ? { reset: true } : { reset: false, usd: form.get("usd") ?? "", calls: form.get("calls") ?? "" };
    const done = await fresh(a, true, (me) => setCeiling(a.d, me, r.id, input));
    if (done === null) return unknownPage(base);
    if (!done.ok && done.error === NO_SUCH_PERSON) return htmlResponse(notFoundPage(base, a.v), 404);
    return onePerson(a, r.id, said(done));
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

/** The most people one press of "Link everyone to usr" asks usr about; the page says to press again for the rest. */
export const MAX_USR_LINKS = 50;

/**
 * "Link everyone to usr" (the link design's backfill, after `/allow` went through usr in 0.21.0):
 * each person on the list with a Discord id and no usr link is allowed in usr as `<app>:member`,
 * with the pressing admin as the invoker, one at a time and outside the queue, then linked in it.
 * It never runs on its own. usr records each link against `TRACKER_GUILD_ID`'s first server, so
 * without a gate it refuses and says to use `/allow` in the server. A refusal about the admin
 * themselves (not linked, missing roles) stops at the first person: every other ask would fail the same way.
 */
async function linkEveryone(a: AdminWeb, usr: UsrLink): Promise<Result | null> {
  const me = await a.d.store.getUser(a.v.user.id);
  if (!me?.admin) return null;
  if (a.usrGuildId === null) {
    return { ok: false, text: "usr needs a server for each link, and TRACKER_GUILD_ID is unset: run /allow on each person in the server instead." };
  }
  if (me.discordId === null) return { ok: false, text: "You have no Discord id here, and usr asks who is allowing them by it." };
  const member = `${usr.app}:${MEMBER_ROLE}`;
  const waiting = a.d.roster.people().filter((p) => p.discordId !== null && usr.links.subjectOf(p.id) === null);
  if (waiting.length === 0) return { ok: true, text: "Everyone on the list is already linked to usr." };
  const batch = waiting.slice(0, MAX_USR_LINKS);
  let linked = 0;
  const problems: string[] = [];
  for (const p of batch) {
    const answer = await usr.client
      .allow({ discordId: p.discordId as string, guildId: a.usrGuildId, invokerDiscordId: me.discordId, roles: [member], ...(p.displayName ? { displayName: p.displayName } : {}) })
      .catch((err: unknown) => err);
    if (answer instanceof UsrError && answer.status === 403 && /invoker|cannot grant|outside the/.test(answer.reason)) {
      return { ok: false, text: `usr refused before linking anyone further (${answer.reason}). Linked ${linked} so far. Fix that, then press again.` };
    }
    if (answer instanceof Error) {
      if (!(answer instanceof UsrError)) a.d.log.error("usr allow failed", answer);
      problems.push(`${nameOf(p)}: ${answer instanceof UsrError ? answer.message : "something went wrong"}`);
      continue;
    }
    const allowed = answer as AllowResult;
    if (!allowed.roles.includes(member)) {
      problems.push(`${nameOf(p)}: usr did not give them ${member}`);
      continue;
    }
    // Linked in the queue, by an admin still there; someone forgotten meanwhile reads as gone.
    const outcome = await fresh(a, true, async () => {
      try {
        return usr.links.link(p.id, allowed.userId);
      } catch (err) {
        a.d.log.error("usr link failed", err);
        return "failed" as const;
      }
    });
    if (outcome === null) return null;
    if (outcome === "linked" || outcome === "relinked" || outcome === "unchanged") linked++;
    else if (outcome === "taken") problems.push(`${nameOf(p)}: their usr account is already linked to someone else here`);
    else if (outcome === "gone") problems.push(`${nameOf(p)}: left the tracker meanwhile`);
    else problems.push(`${nameOf(p)}: something went wrong keeping their usr link`);
  }
  const more = waiting.length - batch.length;
  const parts = [`Linked ${linked} of ${batch.length} to usr.`];
  if (problems.length > 0) parts.push(`Not linked: ${problems.join("; ")}.`);
  if (more > 0) parts.push(`${more} more to go: press again.`);
  return { ok: problems.length === 0, text: parts.join(" ") };
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
