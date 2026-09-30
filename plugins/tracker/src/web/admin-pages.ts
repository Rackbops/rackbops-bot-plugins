import { formatInstant, type Task, type User } from "@rackbops/docket-core";
import { type BlockRow, FORGOTTEN, type PersonRow } from "../roster.js";
import { prose, taskHref } from "./editor-pages.js";
import { html, type Html } from "./html.js";
import { framed, type Viewer } from "./pages.js";

/**
 * The admin view and forget-me's pages (rackbops-bot-plugins#80, slice 3; plan 5.10), pure: data
 * in, an HTML string out, every value escaped by `html`. Every form posts back to this origin with
 * the session's CSRF token; nothing here changes anything on a GET. No script.
 */

/** Shown on a configured admin's page, where Revoke and Remove are not offered. */
export const CONFIGURED_NOTE =
  "Named in TRACKER_ADMIN_DISCORD_IDS: made an admin again at every start, so they cannot be revoked or removed here. Remove them from the configuration first.";

/** The word typed to confirm an erasure: the second post carries it with `confirm=yes`. */
export const CONFIRM_WORD = "forget";

/** A person by the name they gave, else their tracker id. */
export function nameOf(p: { id: string; displayName: string | null } | undefined | null, fallback = "someone"): string {
  if (!p) return fallback;
  return p.displayName ?? p.id;
}

/** Answers shared with the commands name people as Discord mentions; on a page they are plain ids. */
export function unmention(text: string): string {
  return text.replace(/<@([0-9]{17,20})>/g, "$1");
}

function flash(result: { ok: boolean; text: string } | null): Html | null {
  if (!result) return null;
  const text = prose(unmention(result.text));
  return result.ok
    ? html`<div class="rb-alert rb-alert--success" role="status"><p>${text}</p></div>`
    : html`<div class="rb-alert rb-alert--danger" role="alert"><p>${text}</p></div>`;
}

export type Result = { ok: boolean; text: string } | null;

function hidden(v: Viewer): Html {
  return html`<input type="hidden" name="csrf" value="${v.csrf}">`;
}

function adminNav(v: Viewer): Html {
  return html`<p class="tr-row"><a class="rb-link" href="${v.base}/admin">People</a> <a class="rb-link" href="${v.base}/admin/tasks">All tasks</a></p>`;
}

export function personHref(v: Viewer, id: string, action = ""): string {
  return `${v.base}/admin/people/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
}

function admittedBy(p: PersonRow, names: ReadonlyMap<string, string>): string {
  if (p.admittedBy === null) return "the configuration";
  if (p.admittedBy === FORGOTTEN) return "an admin since forgotten";
  return names.get(p.admittedBy) ?? p.admittedBy;
}

function delivery(p: PersonRow, viewer: User, now: Date): string {
  if (p.deliveryPausedAt) return `paused since ${formatInstant(p.deliveryPausedAt, viewer.timeZone, now)}`;
  return p.failures > 0 ? `on (${p.failures} failed in a row)` : "on";
}

function counts(p: PersonRow): string {
  const o = p.owned;
  return `${o.active} active, ${o.paused} paused, ${o.done} done, ${o.archived} deleted; receives ${p.receiving}`;
}

export interface AdminData {
  people: readonly PersonRow[];
  blocks: readonly BlockRow[];
  now: Date;
}

/** `/admin`: everyone on the list, the decline blocks in force, and the allow form. */
export function adminPage(v: Viewer, data: AdminData, o: { result?: Result; allow?: string } = {}): string {
  const names = new Map(data.people.map((p) => [p.id, nameOf(p)]));
  const rows = data.people.map(
    (p) => html`<tr>
<td><a class="rb-link" href="${personHref(v, p.id)}">${nameOf(p)}</a>${p.admin ? html` <span class="rb-badge">admin</span>` : null}</td>
<td>${p.registeredAt ? "registered" : "admitted, not registered"}</td>
<td>${p.timeZone}, ${String(p.preferredHour).padStart(2, "0")}:00</td>
<td>${delivery(p, v.user, data.now)}</td>
<td>${counts(p)}</td>
</tr>`,
  );
  const blocks =
    data.blocks.length === 0
      ? html`<p class="rb-muted">No decline blocks are in force.</p>`
      : html`<ul>${data.blocks.map(
          (b) => html`<li class="tr-row">${names.get(b.ownerId) ?? b.ownerId} may not invite ${names.get(b.recipientId) ?? b.recipientId} ${
            b.expiresAt ? `until ${formatInstant(b.expiresAt, v.user.timeZone, data.now)}` : "until an admin lifts it"
          }
<form method="post" action="${v.base}/admin/blocks/${encodeURIComponent(b.id)}/lift">${hidden(v)}<button class="rb-btn rb-btn--ghost rb-btn--sm" type="submit">Lift</button></form></li>`,
        )}</ul>`;
  return framed(
    v,
    "Admin",
    html`<section>
<h1>People</h1>
${adminNav(v)}
${flash(o.result ?? null)}
<div class="rb-table-scroll"><table class="rb-table">
<thead><tr><th scope="col">Person</th><th scope="col">Status</th><th scope="col">Zone, hour</th><th scope="col">Delivery</th><th scope="col">Tasks</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="rb-muted">Admitted by: ${data.people.map((p) => `${nameOf(p)} -- ${admittedBy(p, names)}`).join("; ")}.</p>
</section>
<section>
<h2>Allow a person</h2>
<form method="post" action="${v.base}/admin/allow" class="tr-stack">
${hidden(v)}
<div class="rb-field">
<label class="rb-label" for="discord_id">Discord user id</label>
<input class="rb-input" id="discord_id" name="discord_id" value="${o.allow ?? ""}" maxlength="20" inputmode="numeric" required>
<p class="rb-field__help">What <code>/allow</code> does: they can then <code>/register</code>.</p>
</div>
<div><button class="rb-btn rb-btn--primary" type="submit">Allow</button></div>
</form>
</section>
<section>
<h2>Decline blocks</h2>
${blocks}
</section>`,
  );
}

/** `/admin/tasks`: every task in the store, whoever owns it, each linking to its read-only page. */
export function adminTasksPage(v: Viewer, tasks: readonly { task: Task; owner: string; receiving: number }[]): string {
  const rows = tasks.map(
    ({ task, owner, receiving }) => html`<tr>
<td><a class="rb-link" href="${taskHref(v, task.id)}">${task.title}</a></td>
<td>${task.type}</td>
<td>${owner}</td>
<td>${task.status === "archived" ? "deleted" : task.status}</td>
<td>${receiving}</td>
</tr>`,
  );
  return framed(
    v,
    "All tasks",
    html`<section>
<h1>All tasks</h1>
${adminNav(v)}
${
  tasks.length === 0
    ? html`<p class="rb-muted">There are no tasks.</p>`
    : html`<div class="rb-table-scroll"><table class="rb-table">
<thead><tr><th scope="col">Task</th><th scope="col">Type</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col">Recipients</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`
}
</section>`,
  );
}

function post(v: Viewer, p: PersonRow, action: string, label: string, style: string): Html {
  return html`<form method="post" action="${personHref(v, p.id, action)}">${hidden(v)}<button class="rb-btn ${style} rb-btn--sm" type="submit">${label}</button></form>`;
}

/** `/admin/people/<id>`: one person, their tasks, and what an admin may do about them. */
export function personPage(v: Viewer, p: PersonRow, tasks: readonly Task[], now: Date, result: Result = null, configured = false): string {
  return framed(
    v,
    nameOf(p),
    html`<section>
${adminNav(v)}
<h1>${nameOf(p)}${p.admin ? html` <span class="rb-badge">admin</span>` : null}</h1>
${flash(result)}
<ul>
<li>Discord id: ${p.discordId ?? "none"}</li>
<li>${p.registeredAt ? `Registered ${formatInstant(p.registeredAt, v.user.timeZone, now)}` : "Admitted, not registered yet"}</li>
<li>Zone and hour: ${p.timeZone}, ${String(p.preferredHour).padStart(2, "0")}:00</li>
<li>Delivery: ${delivery(p, v.user, now)}</li>
<li>Tasks: ${counts(p)}</li>
</ul>
${configured ? html`<p class="rb-muted">${CONFIGURED_NOTE}</p>` : null}
<div class="tr-row">
${p.admin ? (configured ? null : post(v, p, "revoke", "Revoke admin", "rb-btn--ghost")) : post(v, p, "grant", "Make admin", "rb-btn--ghost")}
${p.deliveryPausedAt ? post(v, p, "resume-delivery", "Resume delivery", "rb-btn--accent") : null}
${configured && p.id !== v.user.id ? null : post(v, p, "forget", "Remove from the tracker", "rb-btn--danger")}
</div>
</section>
<section>
<h2>Their tasks</h2>
${
  tasks.length === 0
    ? html`<p class="rb-muted">None.</p>`
    : html`<ul>${tasks.map((t) => html`<li><a class="rb-link" href="${taskHref(v, t.id)}">${t.title}</a> -- ${t.type}, ${t.status === "archived" ? "deleted" : t.status}</li>`)}</ul>`
}
</section>`,
  );
}

const WHAT_GOES =
  "every task (deleted ones too) with its runs, replies and history; your replies, answers and history on other people's tasks, " +
  "and your place on the tasks shared with you; decline blocks either way; delivery pauses; your settings and sign-in sessions; and your place on the list.";

/** `/forget`: what forget-me deletes, and the button that asks for the confirmation. */
export function forgetPage(v: Viewer, note?: string): string {
  return framed(
    v,
    "Forget me",
    html`<section class="rb-card">
<h1>Forget me</h1>
<p>This deletes everything the tracker holds about you, at once and for good: ${WHAT_GOES}</p>
<p>Nothing is kept or archived. Messages the bot already sent you stay in your Discord DMs, where only you can delete them. To use the tracker again later, an admin has to <code>/allow</code> you again, and you start from nothing.</p>
${note ? html`<div class="rb-alert rb-alert--warning" role="note"><p>${note}</p></div>` : null}
<form method="post" action="${v.base}/forget">${hidden(v)}<button class="rb-btn rb-btn--danger" type="submit">Continue</button></form>
</section>`,
  );
}

/** The second step of an erasure, the person's own or an admin's: nothing is deleted until the word is typed and posted. */
export function confirmForgetPage(v: Viewer, o: { action: string; self: boolean; name: string; error?: string; note?: string }): string {
  const title = o.self ? "Delete everything about you?" : `Remove ${o.name} from the tracker?`;
  const what = o.self
    ? html`<p>Everything the tracker holds about you is deleted: ${WHAT_GOES} You are signed out.</p>`
    : html`<p>Everything the tracker holds about ${o.name} is deleted, as forget-me deletes it: their tasks, their replies and history, blocks, pauses, settings and sessions. They are signed out and must be allowed again to come back.</p>`;
  return framed(
    v,
    o.self ? "Forget me" : `Remove ${o.name}`,
    html`<section class="rb-card">
<h1>${title}</h1>
${what}
${o.note ? html`<div class="rb-alert rb-alert--warning" role="note"><p>${o.note}</p></div>` : null}
${o.error ? html`<div class="rb-alert rb-alert--danger" role="alert"><p>${o.error}</p></div>` : null}
<form method="post" action="${o.action}" class="tr-stack">
${hidden(v)}
<input type="hidden" name="confirm" value="yes">
<div class="rb-field">
<label class="rb-label" for="word">Type ${CONFIRM_WORD} to confirm</label>
<input class="rb-input" id="word" name="word" maxlength="20" autocomplete="off" required>
</div>
<div class="tr-row"><button class="rb-btn rb-btn--danger" type="submit">${o.self ? "Delete everything" : "Remove"}</button>
<a class="rb-btn rb-btn--ghost" href="${o.self ? `${v.base}/settings` : `${v.base}/admin`}">Keep</a></div>
</form>
</section>`,
  );
}
