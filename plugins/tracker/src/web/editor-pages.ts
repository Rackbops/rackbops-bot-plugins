import type { Task } from "@rackbops/docket-core";
import { MAX_REMINDER_TEXT } from "../reminders.js";
import { MAX_NEAR, MAX_POLL_HOURS } from "../price.js";
import { MAX_EVERY, MAX_LEAD_DAYS, MAX_NOTE } from "../tracked.js";
import { html, type Html } from "./html.js";
import { framed, type Viewer } from "./pages.js";

/**
 * The task editor's pages (rackbops-bot-plugins#80, plan 5.10), pure: a form per task type, for a
 * new task and an edit, re-rendered with what was typed and why it was refused; the delete
 * confirmation; and the owner's controls on a task's page. Every value is escaped by `html`, and
 * every form posts back to this origin with the session's CSRF token. No script.
 */

export type EditorType = "reminder" | "renewal" | "price";
export const EDITOR_TYPES: readonly EditorType[] = ["reminder", "renewal", "price"];

export type Values = Readonly<Record<string, string>>;

interface Field {
  name: string;
  label: string;
  kind: "text" | "number" | "date" | "url" | "select";
  help?: string;
  required?: boolean;
  maxlength?: number;
  min?: number;
  max?: number;
  decimal?: boolean;
  options?: readonly (readonly [string, string])[];
}

const REPEAT_OPTIONS = [["none", "once"], ["day", "daily"], ["week", "weekly"], ["month", "monthly"]] as const;
const UNIT_OPTIONS = [["year", "yearly"], ["month", "monthly"], ["week", "weekly"], ["day", "daily"]] as const;
const BASELINE_OPTIONS = [["last", "the last price seen"], ["first", "the first price seen"], ["peak", "the highest price seen"]] as const;

const PRICE_SETTINGS: readonly Field[] = [
  { name: "name", label: "Name", kind: "text", maxlength: 100, help: "Leave it empty to use the page's address." },
  { name: "hours", label: "Hours between checks", kind: "number", min: 1, max: MAX_POLL_HOURS, help: `1 to ${MAX_POLL_HOURS}; 12 when empty.` },
  { name: "drop", label: "Alert on a drop of at least (percent)", kind: "text", decimal: true, help: "1 to 90; 10 when empty." },
  { name: "baseline", label: "Measure the drop from", kind: "select", options: BASELINE_OPTIONS },
];

/** The fields each form shows, in order. An edit of a price leaves out the page itself. */
export function fieldsFor(type: EditorType, mode: "new" | "edit"): readonly Field[] {
  switch (type) {
  case "reminder":
    return [
      { name: "text", label: "Remind me to", kind: "text", required: true, maxlength: MAX_REMINDER_TEXT },
      {
        name: "when",
        label: "When",
        kind: "text",
        maxlength: 100,
        help:
          mode === "new"
            ? 'For example "in 20 minutes", "tomorrow 9am", "fri at 17:30". A repeating one with none starts today at your preferred hour.'
            : "Leave it empty to keep the time it has, unless you change how it repeats.",
      },
      { name: "repeat", label: "Repeat", kind: "select", options: REPEAT_OPTIONS },
    ];
  case "renewal":
    return [
      { name: "name", label: "What renews", kind: "text", required: true, maxlength: 100, help: "A subscription, a domain, a warranty." },
      { name: "amount", label: "What one period costs", kind: "text", required: true, decimal: true },
      { name: "currency", label: "Currency", kind: "text", required: true, maxlength: 3, help: "A three-letter code, such as USD or EUR." },
      { name: "renews", label: "Next renewal or expiry date", kind: "date", required: true },
      { name: "unit", label: "Renews", kind: "select", options: UNIT_OPTIONS },
      { name: "every", label: "Every how many of those", kind: "number", min: 1, max: MAX_EVERY, help: "1 when empty." },
      { name: "lead", label: "Days before the date to ask", kind: "number", min: 0, max: MAX_LEAD_DAYS, help: "7 when empty." },
      { name: "note", label: "Note", kind: "text", maxlength: MAX_NOTE, help: "Carried on every ask: where to cancel, which account." },
    ];
  case "price":
    return mode === "edit"
      ? PRICE_SETTINGS
      : [
        { name: "url", label: "Product page", kind: "url", required: true, maxlength: 1000 },
        ...PRICE_SETTINGS,
        { name: "near", label: "Words just before the price", kind: "text", maxlength: MAX_NEAR, help: "Only if I cannot find the price on my own." },
      ];
  }
}

/** Text with `code` spans, as the shared answers write them: each piece escaped. */
export function prose(text: string): Html {
  return html`${text.split("`").map((part, i) => (i % 2 === 1 ? html`<code>${part}</code>` : part))}`;
}

function field(f: Field, values: Values): Html {
  const value = values[f.name] ?? "";
  const help = f.help ? html`<p class="rb-field__help">${f.help}</p>` : null;
  if (f.kind === "select") {
    return html`<div class="rb-field">
<label class="rb-label" for="${f.name}">${f.label}</label>
<select class="rb-select" id="${f.name}" name="${f.name}">${(f.options ?? []).map(
      ([v, label]) => html`<option value="${v}"${v === value ? html` selected` : null}>${label}</option>`,
    )}</select>
${help}
</div>`;
  }
  const type = f.kind === "number" ? "number" : f.kind === "date" ? "date" : f.kind === "url" ? "url" : "text";
  return html`<div class="rb-field">
<label class="rb-label" for="${f.name}">${f.label}</label>
<input class="rb-input" id="${f.name}" name="${f.name}" type="${type}" value="${value}"${f.maxlength ? html` maxlength="${f.maxlength}"` : null}${
    f.min !== undefined ? html` min="${f.min}"` : null
  }${f.max !== undefined ? html` max="${f.max}"` : null}${f.decimal ? html` inputmode="decimal"` : null}${f.required ? html` required` : null}>
${help}
</div>`;
}

function alert(error: string | undefined): Html | null {
  return error ? html`<div class="rb-alert rb-alert--danger" role="alert"><p class="rb-alert__title">Not saved</p><p>${prose(error)}</p></div>` : null;
}

export function taskHref(v: Viewer, id: string, action = ""): string {
  return `${v.base}/tasks/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
}

const NOUN: Record<EditorType, string> = { reminder: "reminder", renewal: "renewal", price: "price tracker" };

/** A new task of `type`: the empty form, or the one just refused with what was typed. */
export function newTaskPage(v: Viewer, type: EditorType, values: Values, error?: string): string {
  const intro = type === "price" ? html`<p class="rb-muted">I read the page once now; nothing is made unless I find a price in it.</p>` : null;
  return framed(
    v,
    `New ${NOUN[type]}`,
    html`<section>
<p><a class="rb-link" href="${v.base}/">My tasks</a></p>
<h1>New ${NOUN[type]}</h1>
${intro}
${alert(error)}
<form method="post" action="${v.base}/new/${type}" class="tr-stack">
<input type="hidden" name="csrf" value="${v.csrf}">
${fieldsFor(type, "new").map((f) => field(f, values))}
<div><button class="rb-btn rb-btn--primary" type="submit">Create</button></div>
</form>
</section>`,
  );
}

/** The edit form of the owner's task; `now` is its schedule in words, `page` a price's page. */
export function editTaskPage(v: Viewer, task: Task, values: Values, o: { now: string; page?: string; error?: string }): string {
  const type = task.type as EditorType;
  return framed(
    v,
    `Edit ${task.title}`,
    html`<section>
<p><a class="rb-link" href="${taskHref(v, task.id)}">Back to the task</a></p>
<h1>Edit ${task.title}</h1>
<p class="rb-muted">Now: ${o.now}.${task.status === "paused" ? " Paused." : ""}</p>
${o.page ? html`<p class="rb-muted">Page: ${o.page}. To track another page, make a new price tracker.</p>` : null}
${alert(o.error)}
<form method="post" action="${taskHref(v, task.id, "edit")}" class="tr-stack">
<input type="hidden" name="csrf" value="${v.csrf}">
${fieldsFor(type, "edit").map((f) => field(f, values))}
<div><button class="rb-btn rb-btn--primary" type="submit">Save</button></div>
</form>
</section>`,
  );
}

/** The second step of a delete: nothing is deleted until this form's button is pressed. */
export function confirmDeletePage(v: Viewer, task: Task): string {
  return framed(
    v,
    `Delete ${task.title}`,
    html`<section class="rb-card">
<h1>Delete ${task.title}?</h1>
<p>It stops at once and leaves your lists; nothing more is sent about it. Its history is kept, and an admin of this tracker can still see it.</p>
<form method="post" action="${taskHref(v, task.id, "delete")}" class="tr-row">
<input type="hidden" name="csrf" value="${v.csrf}">
<input type="hidden" name="confirm" value="yes">
<button class="rb-btn rb-btn--danger" type="submit">Delete</button>
<a class="rb-btn rb-btn--ghost" href="${taskHref(v, task.id)}">Keep it</a>
</form>
</section>`,
  );
}

function post(v: Viewer, task: Task, action: string, label: string, style: string): Html {
  return html`<form method="post" action="${taskHref(v, task.id, action)}"><input type="hidden" name="csrf" value="${v.csrf}"><button class="rb-btn ${style} rb-btn--sm" type="submit">${label}</button></form>`;
}

/** The owner's controls on their task's page: edit, pause or resume, delete. None once it is deleted. */
export function ownerControls(v: Viewer, task: Task): Html | null {
  if (task.status === "archived") return null;
  const live = task.status === "active" || task.status === "paused";
  const editor = (EDITOR_TYPES as readonly string[]).includes(task.type);
  return html`<div class="tr-row">
${live && editor ? html`<a class="rb-btn rb-btn--primary rb-btn--sm" href="${taskHref(v, task.id, "edit")}">Edit</a>` : null}
${task.status === "active" ? post(v, task, "pause", "Pause", "rb-btn--ghost") : null}
${task.status === "paused" ? post(v, task, "resume", "Resume", "rb-btn--accent") : null}
${post(v, task, "delete", "Delete", "rb-btn--danger")}
</div>`;
}

/** What a finished action says on the page it lands on; a fixed list, so nothing from the URL is echoed. */
export const NOTICES: Readonly<Record<string, string>> = {
  created: "Created.",
  saved: "Saved.",
  paused: "Paused: nothing is sent until you resume it.",
  resumed: "Resumed.",
  deleted: "Deleted. Its history is kept.",
};

export function notice(key: string | null, error?: string): Html | null {
  if (error) return html`<div class="rb-alert rb-alert--danger" role="alert"><p>${prose(error)}</p></div>`;
  const text = key !== null && Object.hasOwn(NOTICES, key) ? NOTICES[key] : undefined;
  return text ? html`<div class="rb-alert rb-alert--success" role="status"><p class="rb-alert__title">${text}</p></div>` : null;
}
