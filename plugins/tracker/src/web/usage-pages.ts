import type { BudgetLimits } from "@rackbops/docket-core";
import { describeLimits } from "../ceilings.js";
import type { Measured, UsageReport } from "../usage.js";
import { adminNav, budgetsOffBanner, personHref } from "./admin-pages.js";
import { html, type Html } from "./html.js";
import { framed, type Viewer } from "./pages.js";

/**
 * `/admin/usage` (plan 5.7; roshne, 2026-10-02: "evaluate usage during alpha, then test budgets
 * during beta"), pure and read-only: the model spend per budget day for the last `USAGE_DAYS`, in
 * all and per person, each measured against the default ceilings -- whether the day reached one,
 * and how many calls were charged after it had. It reads docket's `usage` table, which every run
 * is charged to whether budgets are on or off. No form, no script.
 */

export interface UsagePageData {
  report: UsageReport;
  names: ReadonlyMap<string, string>;
  unlimited: boolean;
}

function marker(m: Measured, limits: BudgetLimits): Html {
  if (m.reached === null) return html`<span class="rb-muted">under</span>`;
  const which = m.reached === "calls" ? `${limits.calls} call` : `${(limits.usd ?? 0).toFixed(2)} USD`;
  const past = m.past > 0 ? `; ${m.past} call(s) after it` : "";
  return html`<span class="rb-badge">would have hit the ${which} limit</span>${past}`;
}

function row(day: string | null, who: Html | string, m: Measured, limits: BudgetLimits): Html {
  return html`<tr>
<td>${day ?? ""}</td>
<td>${who}</td>
<td>${m.usd.toFixed(2)}</td>
<td>${m.calls}</td>
<td>${marker(m, limits)}</td>
</tr>`;
}

export function adminUsagePage(v: Viewer, data: UsagePageData): string {
  const { report, names } = data;
  const rows = report.days.map((d) => {
    if (d.everyone.calls === 0 && d.everyone.usd === 0) {
      return html`<tr><td>${d.day}</td><td colspan="4" class="rb-muted">No model use.</td></tr>`;
    }
    return [
      row(d.day, html`<strong>Everyone</strong>`, d.everyone, report.global),
      ...d.people.map((p) => row(null, html`<a class="rb-link" href="${personHref(v, p.userId)}">${names.get(p.userId) ?? p.userId}</a>`, p, report.person)),
    ];
  });
  const total = report.days.reduce((s, d) => ({ usd: s.usd + d.everyone.usd, calls: s.calls + d.everyone.calls }), { usd: 0, calls: 0 });
  return framed(
    v,
    "Usage",
    html`<section>
<h1>Model usage</h1>
${adminNav(v)}
${budgetsOffBanner(data.unlimited)}
<p>The last ${report.days.length} days, newest first: ${total.usd.toFixed(2)} USD and ${total.calls} model call(s) in all. A day ends at midnight Eastern. Dollars are the CLI's list-price estimate, not a bill.</p>
<p class="rb-muted">Each row is measured against the default ceilings -- ${describeLimits(report.person)} a person, ${describeLimits(report.global)} for everyone together -- not a person's raised one. "Would have hit" means that day's spend reached the ceiling; "calls after it" are the calls charged once it had, roughly what it would have held (the ceiling is checked before a run and the run charged at its end).${data.unlimited ? " While budgets are off, nothing is held." : ""}</p>
<div class="rb-table-scroll"><table class="rb-table">
<thead><tr><th scope="col">Day</th><th scope="col">Who</th><th scope="col">USD</th><th scope="col">Calls</th><th scope="col">Default ceiling</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
</section>`,
  );
}
