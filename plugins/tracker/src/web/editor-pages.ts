import type { Task } from "@rackbops/docket-core";
import { CURRENCY_LENGTH, MAX_AMOUNT, MAX_CONFIRM_TEXT, MAX_EXCLUDE_TEXT, MAX_NEAR, MAX_NOTE, MAX_REMINDER_TEXT, MAX_TITLE, MAX_URL, MAX_WHEN } from "../limits.js";
import { backOn } from "../delivery-health.js";
import { MAX_POLL_HOURS } from "../price.js";
import { MAX_CONTEXT_CHARS, MAX_QUESTION_CHARS } from "../research.js";
import { DEFAULT_NEWS_EVERY, MAX_INCLUDE_TEXT, MAX_NEWS_EVERY, NEWS_COST_TEXT } from "../news.js";
import { MAX_INTERESTS_TEXT, MAX_SCOUT_EVERY } from "../scout.js";
import { LOOKBACK_DAYS, MAX_DISAMBIGUATE_CHARS, MAX_FOR_CHARS, MAX_INCLUDE, MAX_SCOUT_NOTES, MAX_SUBJECT_CHARS } from "@rackbops/docket-types";
import { DEFAULT_BGG_HOURS, DEFAULT_EBAY_HOURS, DEFAULT_INBOX_HOURS, DEFAULT_PAGE_HOURS, DEFAULT_SHOPIFY_HOURS, MAX_WANT_HOURS, MIN_SHOPIFY_HOURS } from "../want.js";
import { MAX_EVERY, MAX_LEAD_DAYS } from "../tracked.js";
import { html, type Html } from "./html.js";
import { framed, type Viewer } from "./pages.js";

/**
 * The task editor's pages (rackbops-bot-plugins#80, plan 5.10), pure: a form per task type, for a
 * new task and an edit, re-rendered with what was typed and why it was refused; the delete
 * confirmation; and the owner's controls on a task's page. Every value is escaped by `html`, and
 * every form posts back to this origin with the session's CSRF token. No script.
 */

/**
 * The types the editor edits; the scout (#83) is made only while the model runner is set up. A judged
 * watch (`wantjudge`) is edited here like a plain one but made through the want-list form (`judge`).
 */
export type EditorType = "reminder" | "renewal" | "price" | "scout" | "news" | "wantlist" | "wantjudge";
export const EDITOR_TYPES: readonly EditorType[] = ["reminder", "renewal", "price", "scout", "news", "wantlist", "wantjudge"];

/**
 * What the web and the API can make: the editor's types, and a research request
 * (rackbops-bot-plugins#82), which is made and then paused, resumed or deleted but never edited --
 * `/research` has no edit either. It is offered only while research is available (`d.research`).
 */
export type NewType = EditorType | "research";
export const NEW_TYPES: readonly NewType[] = ["reminder", "renewal", "price", "research", "scout", "news", "wantlist"];
// `wantjudge` is in `NewType` only as an editor type: no form or API create names it.

/** The types that run on the model runner: made only while it is set up (`d.research`); a scout or news watch made before stays editable. */
export const MODEL_TYPES: ReadonlySet<NewType> = new Set<NewType>(["research", "scout", "news"]);

export type Values = Readonly<Record<string, string>>;

export interface Field {
  name: string;
  label: string;
  kind: "text" | "textarea" | "number" | "date" | "url" | "select";
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

type Mode = "new" | "edit";

/** Who reads the help: the web form, or the task API's `types` answer, whose PATCH refuses an empty number. */
export type Surface = "web" | "api";

/**
 * What an empty number field means: on a new task, the default (`onNew`); on an edit, the task's own
 * value, since form-input.ts leaves an empty number out and the rules keep what the task has. The
 * API keeps a field it is not sent, and refuses `""` where a number goes.
 */
const empty = (mode: Mode, onNew: string, surface: Surface): string =>
  mode === "new" ? onNew : surface === "web" ? "Leave it empty to keep what it has." : "Omit it to keep what it has.";

const priceSettings = (mode: Mode, surface: Surface): readonly Field[] => [
  { name: "name", label: "Name", kind: "text", maxlength: MAX_TITLE, help: "Leave it empty to use the page's address." },
  { name: "hours", label: "Hours between checks", kind: "number", min: 1, max: MAX_POLL_HOURS, help: `1 to ${MAX_POLL_HOURS}. ${empty(mode, "12 when empty.", surface)}` },
  { name: "drop", label: "Alert on a drop of at least (percent)", kind: "text", decimal: true, help: `1 to 90. ${empty(mode, "10 when empty.", surface)}` },
  { name: "baseline", label: "Measure the drop from", kind: "select", options: BASELINE_OPTIONS },
];

const RESEARCH_SOURCE_OPTIONS = [["web", "the web: the research searches"], ["browser", "my browser: pages it sends in"]] as const;

/** `/research`'s options, as research.ts reads them: `at` and `deadline` in `parseWhen`'s words. */
const RESEARCH_FIELDS: readonly Field[] = [
  { name: "question", label: "What to look into", kind: "textarea", required: true, maxlength: MAX_QUESTION_CHARS },
  { name: "context", label: "Context", kind: "textarea", maxlength: MAX_CONTEXT_CHARS, help: "Anything that narrows it down. Only you see it here; it goes to the model with the question." },
  { name: "deadline", label: "Deadline", kind: "text", maxlength: MAX_WHEN, help: 'For example "fri 17:00". Past it nothing more is run.' },
  { name: "at", label: "Start", kind: "text", maxlength: MAX_WHEN, help: "Leave it empty to start now. Not with pages from your browser, which start when they are in." },
  {
    name: "sources",
    label: "Where the pages come from",
    kind: "select",
    options: RESEARCH_SOURCE_OPTIONS,
    help: "Your browser: the research waits for the pages your own browser gathers, such as Claude in Chrome, sent in through the task API (for a BoardGameGeek page that refuses the research, or eBay, which the research never opens).",
  },
];

const LENS_OPTIONS = [
  ["general", "general: no occasion in particular"],
  ["birthday", "birthday: fun or a little grandiose"],
  ["anniversary", "anniversary: a romantic angle"],
  ["christmas", "Christmas: tied to their interests"],
] as const;

/** `/scout`'s options; the same on an edit (but for what an empty number means), where each field shows what the scout has. */
const scoutFields = (mode: Mode, surface: Surface): readonly Field[] => [
  { name: "interests", label: "Interests", kind: "textarea", required: true, maxlength: MAX_INTERESTS_TEXT, help: "Separated by commas or one per line, at most 20." },
  { name: "lens", label: "Gift lens", kind: "select", options: LENS_OPTIONS },
  { name: "for", label: "Who it is for", kind: "text", maxlength: MAX_FOR_CHARS, help: "Leave it empty if it is for you." },
  { name: "notes", label: "Notes", kind: "textarea", maxlength: MAX_SCOUT_NOTES, help: "Anything else to weigh: a budget, what they own already. It goes to the model." },
  { name: "every", label: "Days between runs", kind: "number", min: 1, max: MAX_SCOUT_EVERY, help: `1 to ${MAX_SCOUT_EVERY}. ${empty(mode, "1 when empty.", surface)} Each run is at your preferred hour.` },
];

const SHOWS_OPTIONS = [["no", "no"], ["yes", "yes: give each show's city, venue, date and tickets"]] as const;

const newsFields = (mode: Mode, surface: Surface): readonly Field[] => [
  { name: "subject", label: "Who or what to watch", kind: "text", required: true, maxlength: MAX_SUBJECT_CHARS, help: "With enough to tell it apart, such as Platinum Blonde (the Canadian band)." },
  { name: "include", label: "What counts", kind: "textarea", maxlength: MAX_INCLUDE_TEXT, help: `Kinds of news separated by commas or one per line, at most ${MAX_INCLUDE}: new music, reissues, show announcements. Leave it empty for any news.` },
  { name: "exclude", label: "What never counts", kind: "text", maxlength: MAX_EXCLUDE_TEXT, help: "Words or phrases, separated by commas: an item whose title or kind has any of them is left out, such as concert. At most 20. Leave it empty to leave nothing out." },
  { name: "disambiguate", label: "How to tell it apart", kind: "textarea", maxlength: MAX_DISAMBIGUATE_CHARS, help: "Similarly named acts or things it is not. It goes to the model." },
  { name: "shows", label: "Shows", kind: "select", options: SHOWS_OPTIONS },
  { name: "every", label: "Days between runs", kind: "number", min: 1, max: MAX_NEWS_EVERY, help: `1 to ${MAX_NEWS_EVERY}. ${empty(mode, `${DEFAULT_NEWS_EVERY} when empty.`, surface)} Each run is at your preferred hour.` },
];

const SOURCE_OPTIONS = [["page", "a listing page I paste"], ["bgg", "BoardGameGeek's marketplace"], ["ebay", "eBay: its own API, or listings I send in"], ["shopify", "Shopify stores: new copies in stock"]] as const;
const JUDGE_OPTIONS = [["yes", "yes: the model checks each new listing and its seller first"], ["no", "no: DM me every new listing"]] as const;

/** `/want`'s limits, the same on an edit (but for what an empty number means): where it looks is fixed once made. */
const wantLimits = (mode: Mode, surface: Surface): readonly Field[] => [
  { name: "max", label: "Top price", kind: "text", decimal: true, help: "Only listings at or under it, and so only listings that show a price. Leave it empty for any price." },
  { name: "currency", label: "Currency", kind: "text", maxlength: CURRENCY_LENGTH, help: "Only listings in it, such as USD. Leave it empty for any." },
  { name: "exclude", label: "Leave out titles with", kind: "text", maxlength: MAX_EXCLUDE_TEXT, help: "Words or phrases, separated by commas: a listing whose title has any of them is left out, such as investigator for a campaign box. At most 20. Leave it empty to leave nothing out." },
  { name: "confirm", label: "Double-check titles without", kind: "text", maxlength: MAX_CONFIRM_TEXT, help: "Words or phrases, separated by commas, that say a listing is the thing, such as campaign. A listing whose title has none is read in full where the source can (eBay's item specifics and description), then DMed if that has one, and otherwise DMed marked to check. For a plain watch only (judge: no). Leave it empty to check nothing." },
  { name: "unconfirmed", label: "Then leave out ones with", kind: "text", maxlength: MAX_CONFIRM_TEXT, help: "Words or phrases, separated by commas: a listing that the words above did not confirm is left out when its title or full listing has any of them, such as investigator. Needs the words above. Leave it empty to leave none out." },
  { name: "hours", label: "Hours between looks", kind: "number", min: 1, max: MAX_WANT_HOURS, help: `1 to ${MAX_WANT_HOURS}, and at least ${MIN_SHOPIFY_HOURS} for Shopify, since each Shopify look is a paid Firecrawl search. ${empty(mode, `When empty, ${DEFAULT_PAGE_HOURS} for a page, ${DEFAULT_BGG_HOURS} for BGG, ${DEFAULT_EBAY_HOURS} for eBay, ${DEFAULT_INBOX_HOURS} for BGG when this bot has no BGG access, whose listings are sent in, and ${DEFAULT_SHOPIFY_HOURS} for Shopify.`, surface)}` },
];

/**
 * The fields each form shows, in order. An edit of a price leaves out the page itself; a research
 * request has no edit. `surface` changes only the help's words (the task API's `types` passes "api").
 */
export function fieldsFor(type: NewType, mode: Mode, surface: Surface = "web"): readonly Field[] {
  switch (type) {
  case "research":
    return mode === "new" ? RESEARCH_FIELDS : [];
  case "scout":
    return scoutFields(mode, surface);
  case "news":
    return newsFields(mode, surface);
  case "wantlist":
  case "wantjudge":
    return [
      { name: "name", label: "What you want", kind: "text", required: true, maxlength: MAX_TITLE },
      ...(mode === "new"
        ? [
          { name: "source", label: "Where to look", kind: "select", options: SOURCE_OPTIONS } as const,
          {
            name: "target",
            label: "The page, the BGG game, or the words to search eBay or Shopify for",
            kind: "text",
            maxlength: MAX_URL,
            help:
              "A shop's listing or search page, or a BGG game's address or id. For eBay, the words to search for (the name when empty): with this bot's eBay keys, each look is one search through eBay's own API, and a listing counts only when its title has every word; without them, a watch never opens eBay, so its listings reach the watch when you send them in through the task API, such as from Claude in Chrome in your own browser. BGG works the same way while this bot has no BGG access. For Shopify, the words to search Shopify stores for (the name when empty): a product counts only when its title has every word.",
          } as const,
          {
            name: "judge",
            label: "Check listings with the model",
            kind: "select",
            options: JUDGE_OPTIONS,
            help: "Each check counts against your daily model budget. Needs the model runner; fixed once the watch is made. An eBay watch that searches eBay itself is never checked, whatever this says.",
          } as const,
        ]
        : []),
      ...wantLimits(mode, surface),
    ];
  case "reminder":
    return [
      { name: "text", label: "Remind me to", kind: "text", required: true, maxlength: MAX_REMINDER_TEXT },
      {
        name: "when",
        label: "When",
        kind: "text",
        maxlength: MAX_WHEN,
        help:
          mode === "new"
            ? 'For example "in 20 minutes", "tomorrow 9am", "fri at 17:30". A repeating one with none starts today at your preferred hour.'
            : "Leave it empty to keep the time it has, unless you change how it repeats.",
      },
      { name: "repeat", label: "Repeat", kind: "select", options: REPEAT_OPTIONS },
    ];
  case "renewal":
    return [
      { name: "name", label: "What renews", kind: "text", required: true, maxlength: MAX_TITLE, help: "A subscription, a domain, a warranty." },
      { name: "amount", label: "What one period costs", kind: "text", required: true, decimal: true, min: 0, max: MAX_AMOUNT, help: `0 to ${MAX_AMOUNT.toLocaleString("en-US")}.` },
      { name: "currency", label: "Currency", kind: "text", required: true, maxlength: CURRENCY_LENGTH, help: "A three-letter code, such as USD or EUR." },
      { name: "renews", label: "Next renewal or expiry date", kind: "date", required: true },
      { name: "unit", label: "Renews", kind: "select", options: UNIT_OPTIONS },
      { name: "every", label: "Every how many of those", kind: "number", min: 1, max: MAX_EVERY, help: empty(mode, "1 when empty.", surface) },
      { name: "lead", label: "Days before the date to ask", kind: "number", min: 0, max: MAX_LEAD_DAYS, help: empty(mode, "7 when empty.", surface) },
      { name: "note", label: "Note", kind: "text", maxlength: MAX_NOTE, help: "Carried on every ask: where to cancel, which account." },
    ];
  case "price":
    return mode === "edit"
      ? priceSettings(mode, surface)
      : [
        { name: "url", label: "Product page", kind: "url", required: true, maxlength: MAX_URL },
        ...priceSettings(mode, surface),
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
  if (f.kind === "textarea") {
    return html`<div class="rb-field">
<label class="rb-label" for="${f.name}">${f.label}</label>
<textarea class="rb-textarea" id="${f.name}" name="${f.name}" rows="4"${f.maxlength ? html` maxlength="${f.maxlength}"` : null}${f.required ? html` required` : null}>${value}</textarea>
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

const NOUN: Record<NewType, string> = { reminder: "reminder", renewal: "renewal", price: "price tracker", research: "research request", scout: "scout", news: "news watch", wantlist: "want-list watch", wantjudge: "checked want-list watch" };

const INTRO: Partial<Record<NewType, string>> = {
  price: "I read the page once now; nothing is made unless I find a price in it.",
  wantlist:
    "I look at the page or BGG every few hours, or at the eBay listings you send in every hour, and DM you each new listing within your limits, until you press Done. A page is read once now; nothing is made unless I find listings in it.",
  research:
    "A research run looks it up on the web, then a second run checks the answer against its sources; only an answer that passes is DMed to you. It can take a while, and requests share a daily budget.",
  scout:
    "Each run looks on the web for 5 to 10 new things that fit the interests, through the lens, and DMs them to you; a link shown before is not shown again. A run can cost up to 1.50 USD of the daily model budget.",
  news:
    `Each run looks on the web for new items about the subject from the last ${LOOKBACK_DAYS} days; a second run checks each one against its own page, and only what passes is DMed to you. A run with nothing new sends nothing; three failed runs in a row are told once. A run counts against the daily model budget, ${NEWS_COST_TEXT}.`,
};

/**
 * A new task of `type`: the empty form, or the one just refused with what was typed. `off` is why
 * the type cannot be made on this bot (research without the model runner): said instead of a form.
 */
export function newTaskPage(v: Viewer, type: NewType, values: Values, error?: string, off?: string): string {
  const text = INTRO[type];
  const intro = text ? html`<p class="rb-muted">${text}</p>` : null;
  const form = off
    ? html`<div class="rb-alert rb-alert--warning" role="status"><p>${prose(off)}</p></div>`
    : html`${alert(error)}
<form method="post" action="${v.base}/new/${type}" class="tr-stack">
<input type="hidden" name="csrf" value="${v.csrf}">
${fieldsFor(type, "new").map((f) => field(f, values))}
<div><button class="rb-btn rb-btn--primary" type="submit">Create</button></div>
</form>`;
  return framed(
    v,
    `New ${NOUN[type]}`,
    html`<section>
<p><a class="rb-link" href="${v.base}/">My tasks</a></p>
<h1>New ${NOUN[type]}</h1>
${intro}
${form}
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
${o.page ? html`<p class="rb-muted">${task.type === "wantlist" || task.type === "wantjudge" ? html`Looking at: ${o.page}. To look somewhere else, make a new watch.` : html`Page: ${o.page}. To track another page, make a new price tracker.`}</p>` : null}
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

function success(text: string): Html {
  return html`<div class="rb-alert rb-alert--success" role="status"><p class="rb-alert__title">${text}</p></div>`;
}

export function notice(key: string | null, error?: string): Html | null {
  if (error) return html`<div class="rb-alert rb-alert--danger" role="alert"><p>${prose(error)}</p></div>`;
  const text = key !== null && Object.hasOwn(NOTICES, key) ? NOTICES[key] : undefined;
  return text ? success(text) : null;
}

/** Where Resume DMs lands (`?done=resumed-dms`, app.ts). */
export const RESUMED_DMS = "resumed-dms";

/**
 * Resume DMs' notice on My tasks: how many tasks came back on, in `resumedNotice`'s words, while
 * this process still holds the count for the person (app.ts); after a reload or a restart, only
 * that DMs resumed. Nothing in it comes from the address.
 */
export function resumedDmsNotice(back: number | undefined): Html {
  return success(back === undefined ? "DMs resumed." : `DMs resumed. ${backOn(back)}`);
}
