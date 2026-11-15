import type { GiftImportMatch, GiftImportOutcome, GiftWriteMeta } from "@rackbops/docket-core";
import { NO_LONGER_LISTED } from "../actions.js";
import { DEFAULT_IMPORT_CURRENCY, type ImportInput, type ImportReview, importApply, importInput, MAX_IMPORT_TEXT_BYTES, reviewOf, TOO_LARGE } from "./api-gift-import.js";
import type { Editor } from "./editor.js";
import { alerts, csrfField, input, money, select } from "./gift-pages.js";
import { html, type Html, htmlResponse } from "./html.js";
import { errorPage, framed, type Viewer } from "./pages.js";

/**
 * `/gifts/import` (docket#102): paste a CSV or a list (one gift a line), review how each row matched
 * the person's people and occasions, tick the rows to bring in, import. The review and the import
 * are the task API's own code (api-gift-import.ts); the import runs in the web's one write queue and
 * only for the review the page showed (its token): anything that moved since is reviewed again.
 * Ambiguous and invalid rows are shown and cannot be ticked. Same CSRF and escaping as every gift form.
 */

/** The biggest import form body read: the list's 200 KB percent-encoded (up to three bytes a byte), and the ticks. */
export const MAX_IMPORT_FORM_BYTES = 640 * 1024;

const FORMATS = [
  ["csv", "CSV with a header row (title, recipients, occasion, quantity, price, currency, link, notes)"],
  ["list", "One gift a line: title | people | occasion | quantity | price | link"],
] as const;

const TICKABLE = new Set(["ready", "new"]);

function names(ms: readonly GiftImportMatch[]): string {
  return ms.map((m) => `${m.name}${m.status === "new" ? " (new)" : m.status === "ambiguous" ? " (more than one)" : ""}`).join(", ");
}

function inputForm(v: Viewer, i: ImportInput | null, step: Html): Html {
  return html`${csrfField(v)}
${select("format", "Format", FORMATS, i?.format ?? "csv")}
<div class="rb-field"><label class="rb-label" for="text">The list</label>
<textarea class="rb-textarea" id="text" name="text" rows="12" required>
${i?.text ?? ""}</textarea>
<p class="rb-field__help">At most ${String(MAX_IMPORT_TEXT_BYTES / 1024)} KiB and 500 gifts. Nothing is saved until you press Import.</p></div>
${input("currency", "Currency", i?.currency ?? DEFAULT_IMPORT_CURRENCY, { max: 3, help: "For a price whose row names no currency." })}
${step}`;
}

export function importPage(v: Viewer, i: ImportInput | null, r: ImportReview | null, error?: string): string {
  const review = r
    ? html`<h2>Review</h2>
${r.staged.unknownColumns.length > 0 ? html`<p class="rb-muted">Columns not imported: ${r.staged.unknownColumns.join(", ")}.</p>` : null}
${r.staged.problems.length > 0 ? html`<div class="rb-alert rb-alert--danger" role="alert"><p class="rb-alert__title">This list cannot be imported</p><ul>${r.staged.problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : null}
${r.rows.length === 0 ? html`<p class="rb-muted">No rows.</p>` : html`<input type="hidden" name="token" value="${r.reviewToken}">
<div class="rb-table-scroll"><table class="rb-table" aria-label="Rows to import">
<thead><tr><th>Import</th><th>Line</th><th>Gift</th><th>Status</th><th>People</th><th>Occasion</th><th>Quantity</th><th>Price</th><th>Problems</th></tr></thead>
<tbody>${r.rows.map(
        (row) => html`<tr data-row="${row.key}"><td>${TICKABLE.has(row.status) ? html`<input class="rb-checkbox" type="checkbox" name="row" value="${row.key}" checked aria-label="Import line ${String(row.line)}">` : html`<span class="rb-muted">-</span>`}</td><td class="rb-num">${String(row.line)}</td><td>${row.title}</td><td>${row.status}</td><td>${row.occasion === null ? row.recipientNames.join(", ") : names(row.recipients)}</td><td>${row.occasion ? names([row.occasion]) : "-"}</td><td class="rb-num">${String(row.quantity)}</td><td>${row.priceMinor === null ? "-" : money(row.priceMinor, row.currency ?? i?.currency ?? DEFAULT_IMPORT_CURRENCY)}</td><td>${row.problems.join("; ")}</td></tr>`,
      )}</tbody></table></div>`}`
    : null;
  return framed(
    v,
    "Import gifts",
    html`<section>
<p><a class="rb-link" href="${v.base}/gifts">Gifts</a></p>
<h1>Import a list of gifts</h1>
${alerts({ error })}
<form method="post" action="${v.base}/gifts/import" class="tr-stack">
${inputForm(v, i, html`<div class="tr-row"><button class="rb-btn" type="submit" name="step" value="review">Review</button>${r?.rows.some((x) => TICKABLE.has(x.status)) && r.staged.problems.length === 0 ? html` <button class="rb-btn rb-btn--primary" type="submit" name="step" value="import">Import the ticked rows</button>` : null}</div>`)}
${review}
</form>
</section>`,
  );
}

export function outcomesPage(v: Viewer, outcomes: readonly GiftImportOutcome[]): string {
  const applied = outcomes.filter((o) => o.status === "applied").length;
  return framed(
    v,
    "Imported",
    html`<section>
<p><a class="rb-link" href="${v.base}/gifts">Gifts</a></p>
<h1>Imported ${String(applied)} of ${String(outcomes.length)}</h1>
<div class="rb-table-scroll"><table class="rb-table" aria-label="What each row did">
<thead><tr><th>Line</th><th>Outcome</th><th>Notes</th></tr></thead>
<tbody>${outcomes.map((o) => html`<tr data-row="${o.key}"><td class="rb-num">${String(o.line)}</td><td>${o.status}</td><td>${o.problems.join("; ")}</td></tr>`)}</tbody></table></div>
<p class="rb-muted">Importing the same rows again makes nothing twice.</p>
</section>`,
  );
}

/** A POST whose form was over `MAX_IMPORT_FORM_BYTES` (app.ts): unread, so nothing is written, and the page says why. */
export function importTooLarge(v: Viewer): Response {
  return htmlResponse(importPage(v, null, null, TOO_LARGE), 413);
}

/** `GET /gifts/import`. */
export function importGet(e: Editor): Response {
  return htmlResponse(importPage(e.v, null, null));
}

const errorOf = (body: unknown) => (body as { error: { message: string } }).error.message;

/** `POST /gifts/import`: Review, or Import the ticked rows of the review the page showed. */
export async function importPost(e: Editor, f: URLSearchParams): Promise<Response> {
  const body = { format: f.get("format") ?? "", text: f.get("text") ?? "", currency: f.get("currency") ?? "" };
  const i = importInput(body, []);
  if ("status" in i) return htmlResponse(importPage(e.v, null, null, errorOf(i.body)), i.status);
  if (f.get("step") !== "import") return htmlResponse(importPage(e.v, i, await reviewOf(e.d.gifts, e.v.user.id, i)));
  const answer = await e.queue(async () => {
    if (!(await e.d.store.getUser(e.v.user.id))) return null;
    const meta: GiftWriteMeta = { ownerId: e.v.user.id, actor: e.v.user.id, source: "web", at: e.d.clock.now().toISOString() };
    return importApply(e.d.gifts, meta, { ...i, reviewToken: f.get("token") ?? "", approve: f.getAll("row") });
  });
  if (answer === null) return htmlResponse(errorPage(e.v.base, "Not saved", NO_LONGER_LISTED), 403);
  if (answer.status === 200) return htmlResponse(outcomesPage(e.v, (answer.body as { outcomes: GiftImportOutcome[] }).outcomes));
  // Moved since the review (or the list was edited without Review): nothing was written; review again.
  const again = await reviewOf(e.d.gifts, e.v.user.id, i);
  const message = (answer.body as { error: { code: string } }).error.code === "stale_review" ? "Something changed since the review: check it again, then import." : errorOf(answer.body);
  return htmlResponse(importPage(e.v, i, again, message), answer.status);
}
