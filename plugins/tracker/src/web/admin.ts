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
  const usrRun = usr ? usrLinkRuns.get(usr) : undefined;
  return htmlResponse(
    adminPage(a.v, data, { result, unlimited: a.d.budgetUnlimited === true, usrUnlinked, ...(usrRun ? { usrRun } : {}), ...(allow !== undefined ? { allow } : {}) }),
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
    const usr = a.d.usr;
    const result = await fresh(a, true, async (me) => startLinkEveryone(a, usr, me));
    if (result === null) return unknownPage(base);
    // Started: the admin page shows where it has got to.
    if (result === "started") return redirect(`${base}/admin`);
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

/** Where "Link everyone to usr" has got to: one run at a time per tracker, shown on the admin page. */
export interface UsrLinkRun {
  running: boolean;
  done: number;
  total: number;
  /** The last run's outcome, once it ends. */
  result: Result;
}

const usrLinkRuns = new WeakMap<UsrLink, UsrLinkRun>();
const usrLinkPending = new Set<Promise<void>>();

/** For tests: every run started so far has ended. */
export async function usrLinkRunsSettled(): Promise<void> {
  while (usrLinkPending.size > 0) await Promise.all([...usrLinkPending]);
}

/**
 * "Link everyone to usr" (the link design's backfill, after `/allow` went through usr in 0.21.0).
 * The bot answers a web request it waited 10 seconds on with a 504 and does not stop it, so the
 * press only starts a run in the background and goes back to the admin page, which shows how far
 * it got; a second press while one runs starts nothing. Each person on the list with a Discord id
 * and no usr link is, one at a time, checked as `/allow` checks them (a member of the server, with
 * its role), re-read in the queue (someone forgotten meanwhile is skipped, never sent to usr),
 * allowed in usr as `<app>:member` with the pressing admin as the invoker, then linked in the queue.
 * usr records each link against `TRACKER_GUILD_ID`'s first server, so without a gate it refuses and
 * says to use `/allow` in the server. Only a 400 from usr is about the one person; any other refusal
 * or failure (the admin's own usr roles, the key, usr unreachable) would fail everyone the same way,
 * so the run stops there.
 */
function startLinkEveryone(a: AdminWeb, usr: UsrLink, me: User): Exclude<Result, null> | "started" {
  if (a.usrGuildId === null) {
    return { ok: false, text: "usr needs a server for each link, and TRACKER_GUILD_ID is unset: run /allow on each person in the server instead." };
  }
  if (me.discordId === null) return { ok: false, text: "You have no Discord id here, and usr asks who is allowing them by it." };
  const current = usrLinkRuns.get(usr);
  if (current?.running) return { ok: false, text: `Already linking everyone to usr: ${current.done} of ${current.total} done.` };
  const waiting = a.d.roster.people().filter((p) => p.discordId !== null && usr.links.subjectOf(p.id) === null);
  if (waiting.length === 0) return { ok: true, text: "Everyone on the list is already linked to usr." };
  const run: UsrLinkRun = { running: true, done: 0, total: waiting.length, result: null };
  usrLinkRuns.set(usr, run);
  const pending: Promise<void> = linkEveryone(a, usr, me.discordId, nameOf(me), a.usrGuildId, waiting.map((p) => p.id), run)
    .catch((err: unknown) => {
      a.d.log.error("usr link run failed", err);
      run.result = { ok: false, text: `Linking to usr stopped: something went wrong. Linked ${run.done} so far; press again to go on.` };
    })
    .finally(() => {
      run.running = false;
      usrLinkPending.delete(pending);
    });
  usrLinkPending.add(pending);
  return "started";
}

async function linkEveryone(a: AdminWeb, usr: UsrLink, invoker: string, by: string, guildId: string, ids: string[], run: UsrLinkRun): Promise<void> {
  const member = `${usr.app}:${MEMBER_ROLE}`;
  let linked = 0;
  const problems: string[] = [];
  const end = (ok: boolean, stopped?: string) => {
    const parts = [stopped ?? `Linked ${linked} of ${ids.length} to usr.`];
    if (problems.length > 0) parts.push(`Not linked: ${problems.join("; ")}.`);
    run.result = { ok: ok && problems.length === 0, text: parts.join(" ") };
  };
  const notAdmin = () => end(false, `Linking to usr stopped: ${by}, who started it, is no longer an admin here. Linked ${linked} so far.`);
  // Read in the queue: still on the list, with a Discord id, and still not linked.
  const stillWaiting = (id: string) =>
    fresh(a, true, async () => {
      const p = await a.d.store.getUser(id);
      return p && p.discordId !== null && usr.links.subjectOf(id) === null ? p : ("skip" as const);
    });
  for (const id of ids) {
    const first = await stillWaiting(id);
    if (first === null) return notAdmin();
    if (first === "skip") {
      run.done++;
      continue;
    }
    const membership = await a.memberOf(first.discordId as string);
    if (membership === "not-member" || membership === "unknown") {
      problems.push(`${nameOf(first)}: ${membership === "not-member" ? "not a member of the server, or lacks its role" : "could not check they are a member of the server"}`);
      run.done++;
      continue;
    }
    // Again just before asking usr, so someone forgotten during the membership check is never sent.
    const p = await stillWaiting(id);
    if (p === null) return notAdmin();
    if (p === "skip") {
      run.done++;
      continue;
    }
    const answer = await usr.client
      .allow({ discordId: p.discordId as string, guildId, invokerDiscordId: invoker, roles: [member], ...(p.displayName ? { displayName: p.displayName } : {}) })
      .catch((err: unknown) => err);
    // A 400 about the request itself (the server, the admin, the role) would fail everyone; only one about the person is theirs.
    if (answer instanceof UsrError && answer.status === 400 && !/guild_id|invoker|roles|role "/.test(answer.reason)) {
      problems.push(`${nameOf(p)}: ${answer.message}`);
      run.done++;
      continue;
    }
    if (answer instanceof Error) {
      if (!(answer instanceof UsrError)) a.d.log.error("usr allow failed", answer);
      const why = answer instanceof UsrError ? answer.message : "something went wrong";
      return end(false, `Linking to usr stopped, since it would fail for everyone: ${why}. Linked ${linked} so far; fix that, then press again.`);
    }
    const allowed = answer as AllowResult;
    if (!allowed.roles.includes(member)) {
      return end(false, `Linking to usr stopped: usr did not give ${nameOf(p)} ${member}. Check that the tracker's usr key's Discord service is set to app ${usr.app} (TRACKER_USR_APP). Linked ${linked} so far.`);
    }
    const outcome = await fresh(a, true, async () => {
      try {
        return usr.links.link(id, allowed.userId);
      } catch (err) {
        a.d.log.error("usr link failed", err);
        // Another process linked the account at the same moment (the unique index): the same as taken, as `/allow` says.
        return err instanceof Error && /UNIQUE constraint failed/.test(err.message) ? ("taken" as const) : ("failed" as const);
      }
    });
    if (outcome === null) return notAdmin();
    run.done++;
    if (outcome === "linked" || outcome === "relinked" || outcome === "unchanged") linked++;
    else if (outcome === "taken") problems.push(`${nameOf(p)}: their usr account is already linked to someone else here`);
    else if (outcome === "gone") problems.push(`${nameOf(p)}: left the tracker meanwhile`);
    else problems.push(`${nameOf(p)}: something went wrong keeping their usr link`);
  }
  end(true);
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
