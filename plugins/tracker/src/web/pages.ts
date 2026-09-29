import { ADMIN_DISCLOSURE, describeSchedule, formatInstant, type TaskListEntry, type User } from "@rackbops/docket-core";
import type { PausedTask } from "../actions.js";
import type { HistoryView } from "../history.js";
import { html, type Html, page } from "./html.js";

/**
 * The web area's pages (rackbops-bot-plugins#80), pure: data in, an HTML string out, every value
 * escaped by `html`. What they show is what the Discord commands show -- `/tasks`, `/task history`,
 * `/settings` -- read through the same functions.
 */

export interface Viewer {
  base: string;
  user: User;
  csrf: string;
}

function name(u: User): string {
  return u.displayName ?? "you";
}

function framed(v: Viewer, title: string, body: Html): string {
  return page({ base: v.base, title, signedIn: { name: name(v.user), csrf: v.csrf }, body });
}

/** Where a request that is not signed in lands. */
export function signInHelpPage(base: string, note?: string): string {
  return page({
    base,
    title: "Sign in",
    body: html`<section class="rb-card">
<h1>Sign in</h1>
${note ? html`<p class="rb-muted">${note}</p>` : null}
<p>Run <code>/web</code> in Discord: the bot answers you alone with a sign-in link, good for ten minutes and one use.</p>
</section>`,
  });
}

/** The page a link opens: nothing is used up until its button is pressed. */
export function loginPage(base: string, input: { token: string; loginCsrf: string; valid: boolean }): string {
  if (!input.valid) return signInHelpPage(base, "That sign-in link has expired or was already used.");
  return page({
    base,
    title: "Sign in",
    body: html`<section class="rb-card">
<h1>Sign in to the tracker</h1>
<p>This link works once. Press the button to sign in on this browser.</p>
<form method="post" action="${base}/login">
<input type="hidden" name="t" value="${input.token}">
<input type="hidden" name="csrf" value="${input.loginCsrf}">
<button class="rb-btn rb-btn--primary" type="submit">Sign in</button>
</form>
</section>`,
  });
}

function when(entry: TaskListEntry, viewer: User, now: Date): string {
  return entry.next ? formatInstant(entry.next.dueAt, viewer.timeZone, now) : "nothing due";
}

function cadence(entry: TaskListEntry, viewer: User, now: Date): string {
  const s = entry.task.schedule;
  if (!s || s.kind === "once") return "once";
  return describeSchedule(s, entry.from ?? viewer, viewer.timeZone, now);
}

export function tasksPage(v: Viewer, data: { entries: readonly TaskListEntry[]; paused: readonly PausedTask[] }, now: Date): string {
  const rows = data.entries.map(
    (e) => html`<tr>
<td><a class="rb-link" href="${v.base}/tasks/${e.task.id}">${e.task.title}</a></td>
<td>${e.from ? name(e.from) : "you"}</td>
<td>${when(e, v.user, now)}</td>
<td>${cadence(e, v.user, now)}</td>
</tr>`,
  );
  const active =
    data.entries.length === 0
      ? html`<p class="rb-muted">You have no active tasks. <code>/remind</code> in Discord sets one.</p>`
      : html`<div class="rb-table-scroll"><table class="rb-table">
<thead><tr><th scope="col">Task</th><th scope="col">From</th><th scope="col">Next</th><th scope="col">Repeats</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
  const paused =
    data.paused.length === 0
      ? null
      : html`<section>
<h2>Paused</h2>
<ul>${data.paused.map(
          (p) => html`<li><a class="rb-link" href="${v.base}/tasks/${p.task.id}">${p.task.title}</a>${
            p.held.length > 0 ? html` -- I could not DM ${p.held.join(", ")}; <code>/task resume ${p.task.id}</code> goes on without them.` : null
          }</li>`,
        )}</ul>
</section>`;
  return framed(
    v,
    "My tasks",
    html`<section>
<h1>My tasks</h1>
<p class="rb-muted">Times are in ${v.user.timeZone}.</p>
${active}
</section>
${paused}
<p class="rb-muted tr-foot">${ADMIN_DISCLOSURE}</p>`,
  );
}

export function historyPage(v: Viewer, h: HistoryView): string {
  const runs =
    h.runs.length === 0
      ? html`<p class="rb-muted">No runs yet.</p>`
      : html`<div class="rb-table-scroll"><table class="rb-table">
<thead><tr><th scope="col">Due</th><th scope="col">Status</th><th scope="col">Answers</th></tr></thead>
<tbody>${h.runs.map(
          (r) => html`<tr>
<td>${r.due}</td>
<td>${r.status}${r.late ? " (late)" : ""}${r.error ? html`<br><span class="rb-muted">${r.error}</span>` : null}</td>
<td>${r.answers.join("; ")}</td>
</tr>`,
        )}</tbody>
</table></div>`;
  return framed(
    v,
    h.task.title,
    html`<section>
<p><a class="rb-link" href="${v.base}/">My tasks</a></p>
<h1>${h.task.title}</h1>
<p>${h.task.type}, ${h.task.status}, ${h.cadence}. Next: ${h.next ?? "nothing scheduled"}.</p>
</section>
<section>
<h2>Runs</h2>
${h.earlierRuns > 0 ? html`<p class="rb-muted">${h.earlierRuns} earlier run(s) not shown.</p>` : null}
${runs}
</section>
<section>
<h2>Changes</h2>
${h.earlierChanges > 0 ? html`<p class="rb-muted">${h.earlierChanges} earlier change(s) not shown.</p>` : null}
<ul>${h.changes.map((c) => html`<li>${c.at} ${c.kind}${c.detail !== null ? `: ${c.detail}` : ""}</li>`)}</ul>
</section>`,
  );
}

export interface SettingsForm {
  hour: string;
  zone: string;
  saved?: boolean;
  error?: string;
}

export function settingsPage(v: Viewer, form: SettingsForm): string {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return framed(
    v,
    "Settings",
    html`<section>
<h1>Settings</h1>
${form.saved ? html`<div class="rb-alert rb-alert--success" role="status"><p class="rb-alert__title">Saved.</p></div>` : null}
${form.error ? html`<div class="rb-alert rb-alert--danger" role="alert"><p class="rb-alert__title">Not saved</p><p>${form.error}</p></div>` : null}
<form method="post" action="${v.base}/settings" class="tr-stack">
<input type="hidden" name="csrf" value="${v.csrf}">
<div class="rb-field">
<label class="rb-label" for="hour">Preferred hour</label>
<select class="rb-select" id="hour" name="hour">${hours.map(
      (h) => html`<option value="${h}"${String(h) === form.hour ? html` selected` : null}>${String(h).padStart(2, "0")}:00</option>`,
    )}</select>
<p class="rb-field__help">A reminder without a time of day arrives at this hour.</p>
</div>
<div class="rb-field">
<label class="rb-label" for="zone">Time zone</label>
<input class="rb-input" id="zone" name="zone" value="${form.zone}" maxlength="64" required${form.error ? html` aria-invalid="true"` : null}>
<p class="rb-field__help">An IANA name, such as America/New_York or Europe/London.</p>
</div>
<div><button class="rb-btn rb-btn--primary" type="submit">Save</button></div>
</form>
</section>`,
  );
}

export function notFoundPage(base: string, v?: Viewer): string {
  const body = html`<section><h1>Not found</h1><p>There is nothing here, or nothing you can see.</p><p><a class="rb-link" href="${base}/">My tasks</a></p></section>`;
  return v ? framed(v, "Not found", body) : page({ base, title: "Not found", body });
}

export function errorPage(base: string, title: string, message: string): string {
  return page({ base, title, body: html`<section class="rb-card"><h1>${title}</h1><p>${message}</p></section>` });
}
