import { type BudgetLimits, type BudgetPolicy, budgetDay, DEFAULT_BUDGET, reached, type Spent, type Store, type Usage } from "@rackbops/docket-core";
import { budgetPolicy, type Ceilings } from "./ceilings.js";

/**
 * Budgets off for the alpha, and the usage view that evaluates them (rackbops-bot-plugins#82; plan
 * 5.7). roshne, 2026-10-02: "lets build in an unlimited budget "flag" during alpha, evaluate usage
 * during alpha, then test budgets during beta."
 *
 * `TRACKER_BUDGET_UNLIMITED` (true or 1; unset, empty, false or 0 is off) is bot-wide. On, the
 * execute lane hands docket's `budgetHold` a policy with no ceiling of either kind, person or
 * global (`BudgetLimits` null = "no ceiling of that kind", docket-core 0.5.0 budget.ts), and no
 * `personFor`, so no run is held and no ceiling notice goes out. Nothing else changes: each Job's own
 * caps (max turns, max USD) still bound one run, and docket still charges every run to the `usage`
 * table, which the admin's usage page reads. Off, the policy is 0.13.0's exactly (`budgetPolicy`).
 */

export const BUDGET_UNLIMITED_KEY = "TRACKER_BUDGET_UNLIMITED";

/** The manifest's `format` (POSIX ERE): true, false, 1 or 0, any case, spaces around allowed; empty is off. */
export const BUDGET_UNLIMITED_FORMAT = "^ *([Tt][Rr][Uu][Ee]|[Ff][Aa][Ll][Ss][Ee]|1|0)? *$";

/** Whether budgets are off. Unset or empty is off; throws, naming the variable, on anything but true/false/1/0. */
export function parseBudgetUnlimited(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new Error(`${BUDGET_UNLIMITED_KEY} must be true, 1, false or 0 (or unset)`);
}

/** No ceiling of either kind. */
export const NO_LIMITS: BudgetLimits = Object.freeze({ usd: null, calls: null });

/** The policy while budgets are off: docket's `budgetHold` finds nothing reached, for anyone. */
export const UNLIMITED_BUDGET: BudgetPolicy = Object.freeze({ person: NO_LIMITS, global: NO_LIMITS });

/** The execute lane's budget: none while `unlimited`, else docket's defaults with each person's raise. */
export function executeBudget(ceilings: Pick<Ceilings, "personFor">, unlimited: boolean): BudgetPolicy {
  return unlimited ? UNLIMITED_BUDGET : budgetPolicy(ceilings);
}

/** The one line the bot logs at start while budgets are off. */
export const UNLIMITED_LOG = `budgets off (alpha): ${BUDGET_UNLIMITED_KEY} is on, so no daily ceiling holds a model run; each Job's own caps still apply and usage is still recorded`;

/** What the admin's pages say while budgets are off. */
export const UNLIMITED_BANNER = "Budgets off (alpha): unlimited. No daily ceiling holds a model run while TRACKER_BUDGET_UNLIMITED is on; usage is still recorded.";

/** How many budget days the usage page shows, today included. */
export const USAGE_DAYS = 14;

/** One spend, measured against a ceiling it was not necessarily held to. */
export interface Measured extends Spent {
  /** Which default ceiling the day's spend reached (docket's `reached`: calls first), or null. */
  reached: "calls" | "usd" | null;
  /**
   * Calls charged after that ceiling was already reached that day, in charge order: what the
   * ceiling would have held, roughly. docket checks before a run and charges at its end, so a run
   * that started just under it and ended past it is not counted.
   */
  past: number;
}

export interface UsageDay {
  /** `YYYY-MM-DD` in `BUDGET_ZONE`. */
  day: string;
  everyone: Measured;
  /** Each person with a charge that day, by spend (dollars, then calls) highest first. */
  people: (Measured & { userId: string })[];
}

export interface UsageReport {
  /** Newest first, every day in the window, those with no charge too. */
  days: UsageDay[];
  person: BudgetLimits;
  global: BudgetLimits;
  /** The window, for the query: the first day's start and the end of today. */
  since: string;
  before: string;
}

/** The last `days` budget days ending with today's, oldest first, each by `budgetDay` (so a DST day is 23 or 25 hours). */
export function usageWindow(now: Date, days = USAGE_DAYS): { day: string; start: string; end: string }[] {
  const out = [budgetDay(now)];
  while (out.length < days) out.unshift(budgetDay(new Date(Date.parse((out[0] as { start: string }).start) - 1)));
  return out;
}

/** Replays `rows` (charge order) against `limits`: the total, which ceiling it reached, and the calls past it. Pure. */
export function measure(rows: readonly Usage[], limits: BudgetLimits): Measured {
  const total: Spent = { usd: 0, calls: 0 };
  let past = 0;
  for (const r of rows) {
    if (reached(total, limits) !== null) past += r.calls;
    total.usd += r.costUsd;
    total.calls += r.calls;
  }
  return { ...total, reached: reached(total, limits), past };
}

function byAt(a: Usage, b: Usage): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
}

/**
 * Daily spend per person and in all, for the window `usageWindow` gives, measured against the
 * default ceilings (`policy`, docket's `DEFAULT_BUDGET`), not a person's raise: the question for the
 * beta is what the defaults would have done. Rows outside the window are ignored. Pure.
 */
export function usageReport(rows: readonly Usage[], now: Date, days = USAGE_DAYS, policy: Pick<BudgetPolicy, "person" | "global"> = DEFAULT_BUDGET): UsageReport {
  const window = usageWindow(now, days);
  const index = new Map(window.map((w, i) => [w.day, i]));
  const buckets: Usage[][] = window.map(() => []);
  for (const r of [...rows].sort(byAt)) {
    const i = index.get(budgetDay(new Date(r.at)).day);
    if (i !== undefined) buckets[i]?.push(r);
  }
  const out: UsageDay[] = window.map((w, i) => {
    const dayRows = buckets[i] ?? [];
    const users = [...new Set(dayRows.map((r) => r.userId))];
    const people = users
      .map((userId) => ({ userId, ...measure(dayRows.filter((r) => r.userId === userId), policy.person) }))
      .sort((a, b) => b.usd - a.usd || b.calls - a.calls || (a.userId < b.userId ? -1 : 1));
    return { day: w.day, everyone: measure(dayRows, policy.global), people };
  });
  return {
    days: out.reverse(),
    person: policy.person,
    global: policy.global,
    since: (window[0] as { start: string }).start,
    before: (window.at(-1) as { end: string }).end,
  };
}

/** The usage page's data: the store's charges in the window, reported. */
export async function loadUsage(store: Pick<Store, "listUsage">, now: Date, days = USAGE_DAYS): Promise<UsageReport> {
  const window = usageWindow(now, days);
  const rows = await store.listUsage({ since: (window[0] as { start: string }).start, before: (window.at(-1) as { end: string }).end });
  return usageReport(rows, now, days);
}
