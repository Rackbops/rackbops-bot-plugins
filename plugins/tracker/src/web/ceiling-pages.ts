import { type BudgetLimits, formatInstant, type Spent } from "@rackbops/docket-core";
import { type CeilingBounds, type CeilingChange, describeLimits, HISTORY_SHOWN, isRaised, limitsOf } from "../ceilings.js";
import { FORGOTTEN } from "../roster.js";
import { html, type Html } from "./html.js";
import type { Viewer } from "./pages.js";

/**
 * The person page's daily-ceiling section (plan 5.7, 5.10; rackbops-bot-plugins#82), pure: what
 * they spent today, their ceiling now, the form that raises it or puts it back, and the latest
 * `HISTORY_SHOWN` (20) changes an admin made, newest first (older rows stay in the table). The form posts to `/admin/people/<id>/ceiling` with the session's CSRF
 * token; nothing here changes anything on a GET.
 */

export interface CeilingView {
  latest: CeilingChange | null;
  history: readonly CeilingChange[];
  today: Spent;
  defaults: BudgetLimits;
  bounds: CeilingBounds;
  /** Admins' names by id, for "set by". */
  names: ReadonlyMap<string, string>;
}

function setBy(id: string, names: ReadonlyMap<string, string>): string {
  if (id === FORGOTTEN) return "an admin since forgotten";
  return names.get(id) ?? id;
}

function change(c: CeilingChange, v: Viewer, now: Date, names: ReadonlyMap<string, string>): Html {
  const what = c.usd === null || c.calls === null ? "back to the default" : `raised to ${describeLimits({ usd: c.usd, calls: c.calls })}`;
  return html`<li>${formatInstant(c.at, v.user.timeZone, now)}: ${what}, by ${setBy(c.setBy, names)}</li>`;
}

function limitText(n: number | null, unit: string): string {
  return n === null ? `no ${unit} ceiling` : String(n);
}

export function ceilingSection(v: Viewer, personId: string, view: CeilingView, now: Date): Html {
  const limits = limitsOf(view.latest, view.defaults);
  const raised = isRaised(view.latest);
  const action = `${v.base}/admin/people/${encodeURIComponent(personId)}/ceiling`;
  const csrf = html`<input type="hidden" name="csrf" value="${v.csrf}">`;
  const { min, max } = view.bounds;
  return html`<section>
<h2>Daily model budget</h2>
<p>Today: ${view.today.usd.toFixed(2)} USD and ${view.today.calls} model call(s). Ceiling: ${describeLimits(limits)}${raised ? html` <span class="rb-badge">raised</span>` : " (the default)"}.</p>
<p class="rb-muted">A raise stands until an admin changes it. Setting exactly the default puts them back on it. It may not go below the default (${describeLimits(view.defaults)}) or above the global ceiling (${describeLimits(max)}), which still applies to everyone together. A day ends at midnight Eastern.</p>
<form method="post" action="${action}" class="tr-stack">
${csrf}
<div class="tr-row">
<div class="rb-field"><label class="rb-label" for="ceiling-usd">Dollars a day</label>
<input class="rb-input" id="ceiling-usd" name="usd" inputmode="decimal" maxlength="7" value="${limits.usd === null ? "" : limits.usd.toFixed(2)}" required></div>
<div class="rb-field"><label class="rb-label" for="ceiling-calls">Model calls a day</label>
<input class="rb-input" id="ceiling-calls" name="calls" inputmode="numeric" maxlength="5" value="${limits.calls === null ? "" : String(limits.calls)}" required></div>
</div>
<p class="rb-muted">From ${limitText(min.usd, "dollar")} to ${limitText(max.usd, "dollar")} dollars; from ${limitText(min.calls, "call")} to ${limitText(max.calls, "call")} calls.</p>
<div class="tr-row"><button class="rb-btn rb-btn--accent" type="submit">Set ceiling</button></div>
</form>
${
  raised
    ? html`<form method="post" action="${action}">${csrf}<input type="hidden" name="reset" value="yes"><button class="rb-btn rb-btn--ghost" type="submit">Back to the default</button></form>`
    : null
}
${
  view.history.length === 0
    ? html`<p class="rb-muted">No admin has changed their ceiling.</p>`
    : html`<h3>Changes</h3><p class="rb-muted">The latest ${HISTORY_SHOWN} at most, newest first.</p><ul>${view.history.map((c) => change(c, v, now, view.names))}</ul>`
}
</section>`;
}
