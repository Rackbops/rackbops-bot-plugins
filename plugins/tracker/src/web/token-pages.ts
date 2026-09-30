import { formatInstant, type User } from "@rackbops/docket-core";
import { type ApiToken, DEFAULT_EXPIRY_DAYS, MAX_TOKEN_NAME, MAX_TOKENS_PER_PERSON, TOKEN_EXPIRY_DAYS } from "./api-tokens.js";
import { html, type Html } from "./html.js";
import { framed, type Viewer } from "./pages.js";

/**
 * The API tokens pages (rackbops-bot-plugins#80, slice 4), pure: a person's own tokens with the
 * form to make one and a Revoke each, and the list an admin sees on a person's page. Every value is
 * escaped by `html`; every form posts back with the session's CSRF token. A token's secret never
 * appears on any page: it is sent by Discord DM (tokens.ts).
 */

export function tokenHref(v: Viewer, id: string): string {
  return `${v.base}/tokens/${encodeURIComponent(id)}/revoke`;
}

export function adminTokenHref(v: Viewer, id: string): string {
  return `${v.base}/admin/tokens/${encodeURIComponent(id)}/revoke`;
}

function at(iso: string | null, viewer: User, now: Date, none: string): string {
  return iso ? formatInstant(iso, viewer.timeZone, now) : none;
}

/** A table of tokens, each with a Revoke form posting to `href(id)`. */
export function tokenTable(v: Viewer, tokens: readonly ApiToken[], now: Date, href: (id: string) => string): Html {
  if (tokens.length === 0) return html`<p class="rb-muted">None.</p>`;
  return html`<div class="rb-table-scroll"><table class="rb-table">
<thead><tr><th>Name</th><th>Made</th><th>Last used</th><th>Expires</th><th></th></tr></thead>
<tbody>${tokens.map(
    (t) => html`<tr>
<td>${t.name}</td>
<td>${at(t.createdAt, v.user, now, "")}</td>
<td>${at(t.lastUsedAt, v.user, now, "never")}</td>
<td>${at(t.expiresAt, v.user, now, "never")}</td>
<td><form method="post" action="${href(t.id)}"><input type="hidden" name="csrf" value="${v.csrf}"><button class="rb-btn rb-btn--danger rb-btn--sm" type="submit">Revoke</button></form></td>
</tr>`,
  )}</tbody>
</table></div>`;
}

export interface TokensForm {
  error?: string;
  /** What was typed, shown again with a refusal. */
  name?: string;
  expiry?: string;
  result?: string;
}

/** `/tokens`: the person's tokens and the form to make another. A token's secret is never on it: it goes by DM (tokens.ts). */
export function tokensPage(v: Viewer, tokens: readonly ApiToken[], now: Date, f: TokensForm = {}): string {
  const expiry = f.expiry ?? String(DEFAULT_EXPIRY_DAYS);
  const choices: readonly (readonly [string, string])[] = TOKEN_EXPIRY_DAYS.map((d) => [String(d), `in ${d} days`] as const);
  return framed(
    v,
    "API tokens",
    html`<section>
<p><a class="rb-link" href="${v.base}/settings">Settings</a></p>
<h1>API tokens</h1>
<p>A token lets a program use the tracker's task API as you: list, read, make, edit, pause, resume and delete your own tasks, nothing more. Send it as <code>Authorization: Bearer &lt;token&gt;</code> to <code>${v.base}/api/v1/</code>. Anyone holding it can act as you, so keep it secret, and revoke it when the program no longer needs it. A new token is sent to you by Discord DM, once, and never shown here. At most ${MAX_TOKENS_PER_PERSON}, each for a year at most.</p>
${f.result ? html`<div class="rb-alert rb-alert--success" role="status"><p>${f.result}</p></div>` : null}
${f.error ? html`<div class="rb-alert rb-alert--danger" role="alert"><p class="rb-alert__title">Not made</p><p>${f.error}</p></div>` : null}
${tokenTable(v, tokens, now, (id) => tokenHref(v, id))}
</section>
<section>
<h2>Make a token</h2>
<form method="post" action="${v.base}/tokens" class="tr-stack">
<input type="hidden" name="csrf" value="${v.csrf}">
<div class="rb-field">
<label class="rb-label" for="name">Name</label>
<input class="rb-input" id="name" name="name" value="${f.name ?? ""}" maxlength="${MAX_TOKEN_NAME}" required>
<p class="rb-field__help">What will use it, so you know which to revoke.</p>
</div>
<div class="rb-field">
<label class="rb-label" for="expiry">Expires</label>
<select class="rb-select" id="expiry" name="expiry">${choices.map(
      ([value, label]) => html`<option value="${value}"${value === expiry ? html` selected` : null}>${label}</option>`,
    )}</select>
</div>
<div><button class="rb-btn rb-btn--primary" type="submit">Make token</button></div>
</form>
</section>`,
  );
}
