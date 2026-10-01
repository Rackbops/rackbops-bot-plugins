import type { Database } from "bun:sqlite";
import { type BudgetLimits, type BudgetPolicy, budgetDay, DEFAULT_BUDGET, type Spent, spent, type Store, type User } from "@rackbops/docket-core";
import { NOT_ADMIN } from "./access.js";
import type { TrackerDeps } from "./actions.js";
import { isPersonId, NO_SUCH_PERSON } from "./admin.js";
import type { Done } from "./manage.js";

/**
 * A person's own daily ceiling, raised by an admin from the web area (plan 5.7: "The admin raises
 * a person's ceiling from the web area (5.10)"; section 8 item 18; rackbops-bot-plugins#82).
 *
 * **A raise stands until an admin changes it** -- raises it again, or puts it back to the default.
 * That is the default proposed on #82 for roshne to confirm, not a decision: 5.7 and item 18 call it
 * the person's ceiling, a setting beside the global one, and docket's `BudgetPolicy.personFor` says
 * "A person's own ceiling, when an admin raised it (plan 5.10); the host stores it". A today-only
 * raise would be one change here, in `limitsOf`.
 *
 * The enforcement stays docket's (`budgetHold`, docket#17): the execute lane asks `personFor` before
 * each run, and the global ceiling is checked first. Every change is an append-only row in
 * `ceiling_changes` -- who, for whom, the values, when -- and a host log line, the way 5.6 logs a
 * grant's use; the person's ceiling is their newest row. A row with neither value is "back to the
 * default". A raise lifts a hold at once (the next tick runs), but docket's once-a-day notice key
 * (`budget:person:<id>:<day>`) is already claimed, so reaching the raised ceiling the same day
 * sends no second DM.
 */

/** One change to a person's ceiling; `usd` and `calls` both null means back to the default. */
export interface CeilingChange {
  id: string;
  userId: string;
  usd: number | null;
  calls: number | null;
  /** The admin's tracker id; `forgotten` once that admin is forgotten (roster.ts). */
  setBy: string;
  at: string;
}

/** The bounds a raise must fall in: at least the default, at most the global ceiling (checked first, so more is no raise). */
export interface CeilingBounds {
  min: BudgetLimits;
  max: BudgetLimits;
}

export function boundsOf(policy: Pick<BudgetPolicy, "person" | "global"> = DEFAULT_BUDGET): CeilingBounds {
  return { min: policy.person, max: policy.global };
}

/** What a person's ceiling is, given their newest change: the raise when there is one, else the default. Pure. */
export function limitsOf(latest: CeilingChange | null, defaults: BudgetLimits = DEFAULT_BUDGET.person): BudgetLimits {
  if (!latest || latest.usd === null || latest.calls === null) return defaults;
  return { usd: latest.usd, calls: latest.calls };
}

export type CeilingInput = { reset: true } | { reset: false; usd: string; calls: string };

export type Decided = { ok: true; limits: BudgetLimits | null } | { ok: false; error: string };

const USD = /^[0-9]{1,4}(\.[0-9]{1,2})?$/;
const CALLS = /^[0-9]{1,5}$/;

function money(n: number): string {
  return `${n.toFixed(2)} USD`;
}

/**
 * Checks an admin's form, pure: a reset, or two numbers -- dollars to the cent and a whole call
 * count -- each at least the default and at most the global ceiling. `limits` null means reset.
 * A bound that is null (no ceiling of that kind) does not limit.
 */
export function decideCeiling(input: CeilingInput, bounds: CeilingBounds = boundsOf()): Decided {
  if (input.reset) return { ok: true, limits: null };
  const usdText = input.usd.trim();
  const callsText = input.calls.trim();
  if (!USD.test(usdText)) return { ok: false, error: "Give the dollars as a number, like 4 or 4.50." };
  if (!CALLS.test(callsText)) return { ok: false, error: "Give the model calls as a whole number, like 40." };
  const usd = Number(usdText);
  const calls = Number(callsText);
  const { min, max } = bounds;
  if (min.usd !== null && usd < min.usd) return { ok: false, error: `The dollars cannot go below the default, ${money(min.usd)}.` };
  if (min.calls !== null && calls < min.calls) return { ok: false, error: `The model calls cannot go below the default, ${min.calls}.` };
  if (max.usd !== null && usd > max.usd) return { ok: false, error: `The dollars cannot go above the global ceiling, ${money(max.usd)} a day.` };
  if (max.calls !== null && calls > max.calls) return { ok: false, error: `The model calls cannot go above the global ceiling, ${max.calls} a day.` };
  return { ok: true, limits: { usd, calls } };
}

/** A ceiling in words: "4.00 USD and 40 model calls a day". */
export function describeLimits(l: BudgetLimits): string {
  const usd = l.usd === null ? "no dollar ceiling" : money(l.usd);
  const calls = l.calls === null ? "no call ceiling" : `${l.calls} model calls`;
  return `${usd} and ${calls} a day`;
}

/** Whether a person's ceiling is their own (raised) rather than the default. */
export function isRaised(latest: CeilingChange | null): boolean {
  return latest !== null && latest.usd !== null && latest.calls !== null;
}

type Row = { seq: number; user_id: string; usd: number | null; calls: number | null; set_by: string; at: string };

function toChange(r: Row): CeilingChange {
  return { id: `c${r.seq}`, userId: r.user_id, usd: r.usd, calls: r.calls, setBy: r.set_by, at: r.at };
}

/** The `ceiling_changes` table (schema migration 7): append-only, read newest first. */
export class Ceilings {
  constructor(private readonly db: Database) {}

  /** The person's newest change; null when an admin never changed their ceiling. */
  latest(userId: string): CeilingChange | null {
    const r = this.db.query("SELECT * FROM ceiling_changes WHERE user_id = ? ORDER BY seq DESC LIMIT 1").get(userId) as Row | null;
    return r ? toChange(r) : null;
  }

  /** The person's changes, newest first, at most `limit`. */
  history(userId: string, limit = 20): CeilingChange[] {
    return (this.db.query("SELECT * FROM ceiling_changes WHERE user_id = ? ORDER BY seq DESC LIMIT ?").all(userId, limit) as Row[]).map(toChange);
  }

  /** Appends one change; `limits` null puts the person back on the default. */
  record(userId: string, limits: BudgetLimits | null, setBy: string, at: string): CeilingChange {
    const r = this.db
      .query("INSERT INTO ceiling_changes (user_id, usd, calls, set_by, at) VALUES (?, ?, ?, ?, ?) RETURNING *")
      .get(userId, limits?.usd ?? null, limits?.calls ?? null, setBy, at) as Row;
    return toChange(r);
  }

  /** docket's `personFor`: the person's raised ceiling, or null for the default. */
  personFor(user: User): BudgetLimits | null {
    const latest = this.latest(user.id);
    return isRaised(latest) ? limitsOf(latest) : null;
  }
}

/** The execute lane's budget: docket's defaults, with each person's raise from `ceilings`. */
export function budgetPolicy(ceilings: Pick<Ceilings, "personFor">, base: BudgetPolicy = DEFAULT_BUDGET): BudgetPolicy {
  return { person: base.person, global: base.global, personFor: (u) => ceilings.personFor(u) };
}

/** What a person has spent today (the budget day, `BUDGET_ZONE`), for the admin's page. */
export async function spentToday(store: Pick<Store, "listUsage">, userId: string, now: Date): Promise<Spent> {
  const day = budgetDay(now);
  const rows = await store.listUsage({ userId, since: day.start, before: day.end });
  return spent(rows);
}

function who(u: User): string {
  return u.displayName ?? u.discordId ?? u.id;
}

/**
 * An admin changes a person's ceiling (plan 5.7, 5.10). The caller re-read the admin inside the
 * queue; the flag is checked again here. Logged twice: the `ceiling_changes` row and a host log line.
 */
export async function setCeiling(
  d: Pick<TrackerDeps, "store" | "clock" | "log" | "ceilings">,
  admin: User,
  targetId: string,
  input: CeilingInput,
): Promise<Done> {
  if (!admin.admin) return { ok: false, error: NOT_ADMIN };
  const target = isPersonId(targetId) ? await d.store.getUser(targetId) : null;
  if (!target) return { ok: false, error: NO_SUCH_PERSON };
  const decided = decideCeiling(input);
  if (!decided.ok) return { ok: false, error: decided.error };
  const before = d.ceilings.latest(target.id);
  if (decided.limits === null && !isRaised(before)) return { ok: true, text: `${who(target)} is already on the default ceiling.` };
  const change = d.ceilings.record(target.id, decided.limits, admin.id, d.clock.now().toISOString());
  const now = limitsOf(change);
  d.log.info(`${admin.id} set ${target.id}'s daily ceiling to ${decided.limits === null ? "the default" : `${now.usd} USD / ${now.calls} calls`} (${change.id})`);
  return decided.limits === null
    ? { ok: true, text: `${who(target)} is back on the default ceiling: ${describeLimits(now)}.` }
    : { ok: true, text: `${who(target)}'s ceiling is now ${describeLimits(now)}, until an admin changes it.` };
}
