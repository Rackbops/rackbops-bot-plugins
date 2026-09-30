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
 *
 * A new token's secret never appears in a web response: every plugin shares one browser origin, so
 * another plugin's script (or an XSS there) could ride the session cookie, make a token and read
 * the page -- a credential outliving the session. The secret goes to the owner by Discord DM
 * instead, through the host's `dm`; if that DM fails, the token is deleted and the page says so.
 */

export const TOKEN_SENT = "Your new token is in your Discord DMs from this bot. It is not shown here, and the tracker keeps only a hash of it.";
export const TOKEN_NOT_SENT = "I could not DM you the token, so none was made. Open your DMs from this server's members and try again.";

/** The DM that carries a token's secret: the one place it is ever shown. */
export function tokenMessage(name: string, token: string, expiresAt: string | null): string {
  return [
    `Your tracker API token "${name}"${expiresAt ? `, expiring ${expiresAt.slice(0, 10)}` : ""}:`,
    `\`${token}\``,
    "Anyone holding it can use the tracker's task API as you: keep it secret, and revoke it on the web area's API tokens page when you no longer need it. If you did not make it, revoke it now.",
  ].join("\n");
}

export function tokensGet(d: TrackerDeps, v: Viewer): Response {
  return htmlResponse(tokensPage(v, d.apiTokens.listFor(v.user.id, d.clock.now()), d.clock.now()));
}

export async function tokensPost(d: TrackerDeps, v: Viewer, session: Session, form: URLSearchParams): Promise<Response> {
  const now = d.clock.now();
  const name = (form.get("name") ?? "").slice(0, 200);
  const expiry = form.get("expiry") ?? String(DEFAULT_EXPIRY_DAYS);
  const days = expiryChoice(expiry);
  const refuse = (error: string) =>
    htmlResponse(tokensPage(v, d.apiTokens.listFor(v.user.id, d.clock.now()), d.clock.now(), { error, name, expiry: days === undefined ? String(DEFAULT_EXPIRY_DAYS) : expiry }), 400);
  if (days === undefined) return refuse("Choose when the token expires.");
  const discordId = v.user.discordId;
  if (!d.dm || !discordId) return refuse(TOKEN_NOT_SENT);
  // The token inherits the session's membership confirmation, as a session inherits its link's.
  const made = d.apiTokens.create(v.user.id, { name, days }, now, session.memberCheckedAt);
  if (!made.ok) return refuse(made.error);
  try {
    await d.dm(discordId, { content: tokenMessage(made.row.name, made.token, made.row.expiresAt) });
  } catch (err) {
    // Nobody has the secret: the token is of no use to anyone, so it goes.
    d.apiTokens.revokeOwn(v.user.id, made.row.id);
    d.log.warn(`${v.user.id}'s API token ${made.row.id} deleted: the DM carrying it failed (${err instanceof Error ? err.message : String(err)})`);
    return refuse(TOKEN_NOT_SENT);
  }
  d.log.info(`${v.user.id} made API token ${made.row.id}`);
  return htmlResponse(tokensPage(v, d.apiTokens.listFor(v.user.id, d.clock.now()), d.clock.now(), { result: `"${made.row.name}": ${TOKEN_SENT}` }));
}

export function tokenRevokePost(d: TrackerDeps, v: Viewer, id: string): Response {
  if (!d.apiTokens.revokeOwn(v.user.id, id)) return htmlResponse(notFoundPage(v.base, v), 404);
  d.log.info(`${v.user.id} revoked their API token ${id}`);
  const now = d.clock.now();
  return htmlResponse(tokensPage(v, d.apiTokens.listFor(v.user.id, now), now, { result: "Revoked: that token no longer works." }));
}
