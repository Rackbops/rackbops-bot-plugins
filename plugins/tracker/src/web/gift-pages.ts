import type { GiftGroup, GiftOccasion, GiftRecipient, GiftSpend, GiftSyncPreview } from "@rackbops/docket-core";
import type { GiftForm } from "./gifts-web.js";
import { minorDigits, STAGE_COLUMNS, type Overview, type OverviewFilter } from "./gift-overview.js";
import { html, type Html } from "./html.js";
import { framed, type Viewer } from "./pages.js";

/**
 * The family gift pages (rackbops-bot-plugins#384), pure: the overview, the five add forms and the
 * occasion's sync review. Server-rendered forms, no script, every value escaped by `html`, every
 * form posting back with the session's CSRF token. Nothing here posts to Discord.
 */

export const GIFT_FORM_TITLES: Record<GiftForm, string> = {
  person: "Add a person or household",
  group: "Add a group",
  occasion: "Add an occasion",
  gift: "Add a gift",
  purchase: "Record a purchase",
};

/** Minor units as a plain amount in the currency's own digits: 1250 USD is 12.50, 1250 JPY is 1250. */
export function money(minor: number, currency: string): string {
  const digits = minorDigits(currency);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const scale = 10 ** digits;
  const whole = Math.floor(abs / scale);
  return `${sign}${whole}${digits > 0 ? `.${String(abs % scale).padStart(digits, "0")}` : ""} ${currency}`;
}

const csrfField = (v: Viewer) => html`<input type="hidden" name="csrf" value="${v.csrf}">`;
const giftsHref = (v: Viewer, q: Record<string, string | undefined> = {}) => {
  const params = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== ""));
  const s = params.toString();
  return `${v.base}/gifts${s ? `?${s}` : ""}`;
};

function alerts(f: { error?: string | undefined; problems?: string[] | undefined; notice?: string | undefined }): Html {
  return html`${f.notice ? html`<div class="rb-alert rb-alert--success" role="status"><p>${f.notice}</p></div>` : null}
${f.error ? html`<div class="rb-alert rb-alert--danger" role="alert"><p class="rb-alert__title">Not saved</p><p>${f.error}</p>${
    f.problems && f.problems.length > 0 ? html`<ul>${f.problems.map((p) => html`<li>${p}</li>`)}</ul>` : null
  }</div>` : null}`;
}

function select(name: string, label: string, options: readonly (readonly [string, string])[], chosen: string | undefined, blank?: string): Html {
  return html`<div class="rb-field"><label class="rb-label" for="${name}">${label}</label>
<select class="rb-select" id="${name}" name="${name}">${blank !== undefined ? html`<option value="">${blank}</option>` : null}${options.map(
    ([value, text]) => html`<option value="${value}"${value === chosen ? html` selected` : null}>${text}</option>`,
  )}</select></div>`;
}

function checks(name: string, legend: string, options: readonly (readonly [string, string])[], chosen: readonly string[]): Html {
  if (options.length === 0) return html`<fieldset class="rb-field"><legend class="rb-label">${legend}</legend><p class="rb-muted">None yet.</p></fieldset>`;
  return html`<fieldset class="rb-field"><legend class="rb-label">${legend}</legend><div class="tr-row">${options.map(
    ([value, text]) =>
      html`<label class="rb-choice"><input class="rb-checkbox" type="checkbox" name="${name}" value="${value}"${chosen.includes(value) ? html` checked` : null}> ${text}</label>`,
  )}</div></fieldset>`;
}

function input(name: string, label: string, value: string, o: { type?: string; required?: boolean; help?: string; max?: number } = {}): Html {
  return html`<div class="rb-field"><label class="rb-label" for="${name}">${label}</label>
<input class="rb-input" id="${name}" name="${name}" type="${o.type ?? "text"}" value="${value}"${o.required ? html` required` : null}${o.max ? html` maxlength="${o.max}"` : null}>
${o.help ? html`<p class="rb-field__help">${o.help}</p>` : null}</div>`;
}

function spendTable(spend: readonly GiftSpend[]): Html {
  if (spend.length === 0) return html`<p class="rb-muted">Nothing planned or bought yet.</p>`;
  return html`<div class="rb-table-scroll"><table class="rb-table">
<thead><tr><th>Currency</th><th>Planned</th><th>Spent</th><th>Refunded</th><th>Net</th></tr></thead>
<tbody>${spend.map(
    (s) => html`<tr><td>${s.currency}</td><td>${money(s.plannedMinor, s.currency)}</td><td>${money(s.spentMinor, s.currency)}${s.incomplete ? html` <span class="rb-badge rb-badge--warning">incomplete</span>` : null}</td><td>${money(s.refundedMinor, s.currency)}</td><td>${money(s.netMinor, s.currency)}</td></tr>`,
  )}</tbody></table></div>`;
}

const people = (recipients: readonly GiftRecipient[]) => recipients.filter((r) => !r.archived).map((r) => [r.id, r.displayName] as const);

/** `/gifts`: one family list for an occasion, with the filters, the coverage columns and the money. */
export function giftsPage(v: Viewer, o: Overview, f: OverviewFilter, recipients: readonly GiftRecipient[], groups: readonly GiftGroup[], notice?: string): string {
  const occasion = o.occasion;
  const filters = html`<form method="get" action="${v.base}/gifts" class="tr-row">
${select("occasion", "Occasion", [...o.occasions, ...(occasion?.archived ? [occasion] : [])].map((x) => [x.id, x.archived ? `${x.title} (archived)` : x.title] as const), occasion?.id)}
${select("person", "Person or household", people(recipients), f.person, "Everyone")}
${select("group", "Group", groups.filter((g) => !g.archived).map((g) => [g.id, g.name] as const), f.group, "Any group")}
${select("stage", "Stage", STAGE_COLUMNS, f.stage, "Any stage")}
<div><button class="rb-btn rb-btn--sm" type="submit">Show</button></div>
</form>`;
  const add = html`<p class="tr-row">${(Object.keys(GIFT_FORM_TITLES) as GiftForm[]).map(
    (k) => html`<a class="rb-btn rb-btn--ghost rb-btn--sm" href="${v.base}/gifts/new/${k}">${GIFT_FORM_TITLES[k]}</a>`,
  )}</p>`;
  const body = occasion
    ? html`<section>
<h2>${occasion.title}${occasion.archived ? html` <span class="rb-badge">archived</span>` : null}</h2>
<div class="rb-table-scroll"><table class="rb-table" aria-label="Who still needs a gift">
<thead><tr>${STAGE_COLUMNS.map(([k, label]) => html`<th><a class="rb-link" href="${giftsHref(v, { occasion: occasion.id, person: f.person, group: f.group, stage: k })}">${label}</a></th>`)}</tr></thead>
<tbody><tr>${STAGE_COLUMNS.map(([k]) => html`<td class="rb-num" data-stage="${k}">${o.counts[k]}</td>`)}</tr></tbody>
</table></div>
${o.rows.length === 0 ? html`<p class="rb-muted">Nobody on this occasion matches.</p>` : html`<div class="rb-table-scroll"><table class="rb-table">
<thead><tr><th>Who</th><th>Stage</th><th>Gifts</th><th>Bought</th><th>Done</th><th>Groups</th></tr></thead>
<tbody>${o.rows.map(
      (r) => html`<tr data-recipient="${r.recipient.id}"><td>${r.recipient.displayName}${r.recipient.kind === "household" ? html` <span class="rb-badge rb-badge--info">household</span>` : null}</td><td>${
        STAGE_COLUMNS.find(([k]) => k === r.column)?.[1]
      }</td><td class="rb-num">${r.coverage.gifts}</td><td class="rb-num">${r.coverage.bought}</td><td>${r.coverage.done ? "yes" : "no"}</td><td>${r.groups.join(", ")}</td></tr>`,
    )}</tbody></table></div>`}
${o.budget ? html`<p class="rb-muted">Budget: ${o.budget.budgetMinor === null ? "none set" : money(o.budget.budgetMinor, o.budget.currency)}; people's budgets add up to ${money(o.budget.recipientBudgetsMinor, o.budget.currency)} for ${o.budget.recipients}.</p>` : null}
<h3>Gifts for ${occasion.title}</h3>
${o.gifts.length === 0 ? html`<p class="rb-muted">None yet.</p>` : html`<div class="rb-table-scroll"><table class="rb-table">
<thead><tr><th>Gift</th><th>For</th><th>Units</th><th>Stage</th></tr></thead>
<tbody>${o.gifts.map(
      (g) => html`<tr><td>${g.title}${g.allocation.shared ? html` <span class="rb-badge">shared</span>` : null}</td><td>${g.recipients.join(", ")}</td><td class="rb-num">${g.units}</td><td>${g.stage ?? "nothing left"}</td></tr>`,
    )}</tbody></table></div>`}
${occasion.groupIds.length > 0 && !occasion.archived ? html`<p><a class="rb-link" href="${v.base}/gifts/occasions/${encodeURIComponent(occasion.id)}/sync">Review changes to its groups</a></p>` : null}
</section>`
    : f.occasion
      ? html`<section><p class="rb-muted">That occasion is not on your list.</p></section>`
      : html`<section><p class="rb-muted">No occasions yet. Add the people you buy for, then an occasion.</p></section>`;
  return framed(
    v,
    "Gifts",
    html`<section>
<h1>Gifts</h1>
<p class="rb-muted">Your own gift list. Only you see it here; nothing on this page is posted to Discord. Tracker admins can read the database it lives in.</p>
${alerts({ notice })}
${add}
${o.occasions.length > 0 || occasion ? filters : null}
</section>
${body}
<section><h2>Money, all occasions</h2>${spendTable(o.spend)}</section>`,
  );
}

export interface FormState {
  values: URLSearchParams;
  error?: string;
  problems?: string[];
  /** The unique roster the chosen groups and overrides give, shown before an occasion is saved. */
  preview?: { names: string[]; excluded: string[] };
}

export interface FormChoices {
  recipients: GiftRecipient[];
  groups: GiftGroup[];
  occasions: GiftOccasion[];
  /** Gifts with no purchase yet, for the purchase form: id and a label. */
  unbought: (readonly [string, string])[];
}

/** `/gifts/new/<form>`: one add form. */
export function giftFormPage(v: Viewer, form: GiftForm, c: FormChoices, s: FormState): string {
  const val = (k: string, d = "") => s.values.get(k) ?? d;
  const all = (k: string) => s.values.getAll(k);
  const persons = c.recipients.filter((r) => !r.archived && r.kind === "person").map((r) => [r.id, r.displayName] as const);
  let fields: Html;
  switch (form) {
    case "person":
      fields = html`${input("name", "Name", val("name"), { required: true, max: 200 })}
${select("kind", "Kind", [["person", "A person"], ["household", "A household or couple (one gift unit)"]], val("kind", "person"))}
${checks("member", "Its people (a household only)", persons, all("member"))}
${input("labels", "Labels", val("labels"), { help: "Your own words, separated by commas, such as aunt, cousin. Optional." })}
${input("notes", "Notes", val("notes"), { max: 2000 })}`;
      break;
    case "group":
      fields = html`${input("name", "Name", val("name"), { required: true, max: 200 })}
${checks("member", "Members", people(c.recipients), all("member"))}`;
      break;
    case "occasion":
      fields = html`${select("kind", "Kind", [["christmas", "Christmas"], ["birthday", "Birthday"], ["anniversary", "Anniversary"], ["custom", "Other"]], val("kind", "christmas"))}
${input("title", "Title", val("title"), { required: true, max: 200, help: "Such as Christmas 2026: each year is its own occasion." })}
${input("date", "Date", val("date"), { type: "date" })}
${input("currency", "Currency", val("currency", "USD"), { max: 3 })}
${input("budget", "Budget", val("budget"), { help: "Optional, such as 500 or 500.00." })}
${checks("group", "Shop for these groups", c.groups.filter((g) => !g.archived).map((g) => [g.id, g.name] as const), all("group"))}
${checks("include", "Also add", people(c.recipients), all("include"))}
${checks("exclude", "Leave out", people(c.recipients), all("exclude"))}
${s.preview ? html`<div class="rb-alert rb-alert--info" role="status"><p class="rb-alert__title">Who this occasion will cover (${s.preview.names.length})</p><p>${s.preview.names.join(", ") || "Nobody yet."}</p>${s.preview.excluded.length > 0 ? html`<p>Left out: ${s.preview.excluded.join(", ")}</p>` : null}</div>` : null}`;
      break;
    case "gift":
      fields = html`${input("title", "Gift", val("title"), { required: true, max: 200 })}
${input("url", "Link", val("url"), { type: "url" })}
${input("estimate", "Price estimate", val("estimate"), { help: "Optional; a plan, never spend." })}
${input("currency", "Currency", val("currency", "USD"), { max: 3 })}
${select("occasion", "Occasion", c.occasions.filter((o) => !o.archived).map((o) => [o.id, o.title] as const), val("occasion"), "Not yet (an idea for later)")}
${checks("for", "For", people(c.recipients), all("for"))}
${input("quantity", "How many each", val("quantity", "1"), { type: "number" })}
<label class="rb-choice"><input class="rb-checkbox" type="checkbox" name="shared" value="1"${val("shared") === "1" ? html` checked` : null}> One shared gift for all of them</label>`;
      break;
    case "purchase":
      fields = html`${select("gift", "Gift", c.unbought, val("gift"), "Choose a gift")}
${input("merchant", "Shop", val("merchant"), { max: 200 })}
${input("price", "Price each", val("price"), { required: true, help: "Such as 24.99." })}
${input("currency", "Currency", val("currency", "USD"), { max: 3 })}
${input("on", "Bought on", val("on"), { type: "date" })}
<label class="rb-choice"><input class="rb-checkbox" type="checkbox" name="received" value="1"${val("received") === "1" ? html` checked` : null}> I have it already</label>`;
      break;
  }
  const preview = form === "occasion" ? html`<button class="rb-btn" type="submit" name="step" value="preview">Preview who it covers</button> ` : null;
  return framed(
    v,
    GIFT_FORM_TITLES[form],
    html`<section>
<p><a class="rb-link" href="${v.base}/gifts">Gifts</a></p>
<h1>${GIFT_FORM_TITLES[form]}</h1>
${alerts(s)}
<form method="post" action="${v.base}/gifts/new/${form}" class="tr-stack">
${csrfField(v)}
${fields}
<div class="tr-row">${preview}<button class="rb-btn rb-btn--primary" type="submit" name="step" value="save">Save</button></div>
</form>
</section>`,
  );
}

/** `/gifts/occasions/<id>/sync`: what syncing the occasion with its groups would change, and a decision for each affected gift. */
export function syncPage(v: Viewer, occasion: GiftOccasion, p: GiftSyncPreview, token: string, names: (id: string) => string, titles: (allocationId: string) => string, error?: string): string {
  const roster = p.roster.map(names);
  return framed(
    v,
    `Sync ${occasion.title}`,
    html`<section>
<p><a class="rb-link" href="${v.base}/gifts?occasion=${encodeURIComponent(occasion.id)}">Gifts</a></p>
<h1>Sync ${occasion.title} with its groups</h1>
${alerts({ error })}
<p>Coming on: ${p.added.length > 0 ? p.added.map((a) => names(a.recipientId)).join(", ") : "nobody"}.</p>
<p>Leaving: ${p.removed.length > 0 ? p.removed.map((r) => names(r.row.recipientId)).join(", ") : "nobody"}.</p>
<p class="rb-muted">After the sync the occasion covers ${roster.length}: ${roster.join(", ")}. Budgets change by ${money(p.budgetDeltaMinor, occasion.currency)}.</p>
<form method="post" action="${v.base}/gifts/occasions/${encodeURIComponent(occasion.id)}/sync" class="tr-stack">
${csrfField(v)}
<input type="hidden" name="token" value="${token}">
${p.affected.map(
      (a) => html`<fieldset class="rb-field"><legend class="rb-label">${titles(a.allocationId)} for ${a.recipientIds.map(names).join(", ")}${a.bought ? " (bought)" : ""}</legend>
<div class="tr-row">
<label class="rb-choice"><input class="rb-radio" type="radio" name="decision-${a.allocationId}" value="keep" required> Keep as it is</label>
<label class="rb-choice"><input class="rb-radio" type="radio" name="decision-${a.allocationId}" value="unassign"> Take ${a.dropped.map(names).join(", ")} off it</label>
${p.roster.filter((id) => !a.recipientIds.includes(id)).map((id) => html`<label class="rb-choice"><input class="rb-radio" type="radio" name="decision-${a.allocationId}" value="reassign:${id}"> Give ${a.dropped.map(names).join(", ")}'s to ${names(id)}</label>`)}
</div></fieldset>`,
    )}
<div><button class="rb-btn rb-btn--primary" type="submit">Apply</button></div>
</form>
</section>`,
  );
}
