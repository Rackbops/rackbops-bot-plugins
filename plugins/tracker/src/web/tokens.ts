import type { TrackerDeps } from "../actions.js";
import { DEFAULT_EXPIRY_DAYS, expiryChoice } from "./api-tokens.js";
import { htmlResponse } from "./html.js";
import { notFoundPage, type Viewer } from "./pages.js";
import type { Session } from "./sessions.js";
import { tokensPage } from "./token-pages.js";

/**
 * The web area's API tokens routes (rackbops-bot-plugins#80, slice 4): a signed-in person's own
 * tokens -- the page (GET), making one (POST), revoking one (POST). app.ts has already checked the
 * session (re-reading the person), the method, and on a POST the `Origin` and the CSRF token. A
 * token id in the path names a token to look up, never whose it is: revoking anyone else's answers
 * the same 404 as an unknown id. The log names the token by id, never by its secret.
 */

export function tokensGet(d: TrackerDeps, v: Viewer): Response {
  return htmlResponse(tokensPage(v, d.apiTokens.listFor(v.user.id, d.clock.now()), d.clock.now()));
}

export function tokensPost(d: TrackerDeps, v: Viewer, session: Session, form: URLSearchParams): Response {
  const now = d.clock.now();
  const name = (form.get("name") ?? "").slice(0, 200);
  const expiry = form.get("expiry") ?? String(DEFAULT_EXPIRY_DAYS);
  const days = expiryChoice(expiry);
  const refuse = (error: string) =>
    htmlResponse(tokensPage(v, d.apiTokens.listFor(v.user.id, now), now, { error, name, expiry: days === undefined ? String(DEFAULT_EXPIRY_DAYS) : expiry }), 400);
  if (days === undefined) return refuse("Choose when the token expires.");
  // The token inherits the session's membership confirmation, as a session inherits its link's.
  const made = d.apiTokens.create(v.user.id, { name, days }, now, session.memberCheckedAt);
  if (!made.ok) return refuse(made.error);
  d.log.info(`${v.user.id} made API token ${made.row.id}`);
  return htmlResponse(tokensPage(v, d.apiTokens.listFor(v.user.id, now), now, { made: { token: made.token, name: made.row.name } }));
}

export function tokenRevokePost(d: TrackerDeps, v: Viewer, id: string): Response {
  if (!d.apiTokens.revokeOwn(v.user.id, id)) return htmlResponse(notFoundPage(v.base, v), 404);
  d.log.info(`${v.user.id} revoked their API token ${id}`);
  const now = d.clock.now();
  return htmlResponse(tokensPage(v, d.apiTokens.listFor(v.user.id, now), now, { result: "Revoked: that token no longer works." }));
}
