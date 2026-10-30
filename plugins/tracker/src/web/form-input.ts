import type { Task, User } from "@rackbops/docket-core";
import type { BaselineRule, NewsConfig, PriceConfig, RenewalConfig, ScoutConfig, WantConfig } from "@rackbops/docket-types";
import type { TrackerDeps } from "../actions.js";
import { renewalDate } from "../edit.js";
import type { PriceInput } from "../price.js";
import { type ReminderInput, type Repeat, repeatOf } from "../reminders.js";
import type { ResearchInput } from "../research.js";
import { DEFAULT_NEWS_EVERY, kindsOf, type NewsEdit, type NewsInput } from "../news.js";
import type { ScoutEdit, ScoutInput } from "../scout.js";
import type { PeriodUnit, RenewalInput } from "../tracked.js";
import { type WantEdit, type WantInput, wordsText } from "../want.js";
import { fieldsFor, type NewType, type Values } from "./editor-pages.js";

/**
 * What a task editor's fields say, read into the inputs of the shared rules (reminders.ts,
 * tracked.ts, price.ts, research.ts, scout.ts, want.ts, edit.ts), for the web forms and the JSON
 * task API alike (rackbops-bot-plugins#80, slices 2 and 4): api.ts turns a JSON body into the same
 * fields, so one reading -- and so one set of defaults and messages -- serves both. Text is taken as
 * typed; a number that is not one becomes NaN, which the rules refuse with their own words.
 */

const str = (form: URLSearchParams, name: string): string => form.get(name) ?? "";
const opt = (form: URLSearchParams, name: string): string | undefined => (str(form, name).trim() === "" ? undefined : str(form, name));

function int(form: URLSearchParams, name: string): number | undefined {
  const raw = str(form, name).trim();
  if (raw === "") return undefined;
  return /^[0-9]{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
}

function decimal(form: URLSearchParams, name: string): number | undefined {
  const raw = str(form, name).trim();
  if (raw === "") return undefined;
  return /^[0-9]{1,12}(\.[0-9]{1,6})?$/.test(raw) ? Number(raw) : Number.NaN;
}

/** What was typed into `type`'s fields, and nothing else, to show again with a refusal. */
export function typed(type: NewType, mode: "new" | "edit", form: URLSearchParams): Values {
  return Object.fromEntries(fieldsFor(type, mode).map((f) => [f.name, str(form, f.name)]));
}

export function reminderInput(form: URLSearchParams): ReminderInput {
  const when = opt(form, "when");
  return { text: str(form, "text"), ...(when !== undefined ? { when } : {}), repeat: (str(form, "repeat") || "none") as Repeat };
}

/** A textarea sends a line break as CRLF; keep it one character, as the browser's maxlength counted it. */
function lines(v: string | undefined): string | undefined {
  return v?.replace(/\r\n?/g, "\n");
}

/** `/research`'s options: an empty `context`, `deadline`, `at` or `sources` is left out, as an unset option is. */
export function researchInput(form: URLSearchParams): ResearchInput {
  const context = lines(opt(form, "context"));
  const deadline = opt(form, "deadline");
  const at = opt(form, "at");
  const sources = opt(form, "sources");
  return {
    question: lines(str(form, "question")) ?? "",
    ...(context !== undefined ? { context } : {}),
    ...(deadline !== undefined ? { deadline } : {}),
    ...(at !== undefined ? { at } : {}),
    ...(sources !== undefined ? { sources } : {}),
  };
}

/** `/scout new`'s options: an empty lens, who, notes or every is left out, as an unset option is. */
export function scoutInput(form: URLSearchParams): ScoutInput {
  const lens = opt(form, "lens");
  const who = opt(form, "for");
  const notes = lines(opt(form, "notes"));
  const every = int(form, "every");
  return {
    interests: lines(str(form, "interests")) ?? "",
    ...(lens !== undefined ? { lens } : {}),
    ...(who !== undefined ? { for: who } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(every !== undefined ? { every } : {}),
  };
}

/** A scout's edit: empty interests, lens or every keep the scout's; a sent empty `for` or `notes` clears it. */
export function scoutEdit(form: URLSearchParams): ScoutEdit {
  const interests = lines(opt(form, "interests"));
  const lens = opt(form, "lens");
  const every = int(form, "every");
  return {
    ...(interests !== undefined ? { interests } : {}),
    ...(lens !== undefined ? { lens } : {}),
    ...(form.has("for") ? { for: str(form, "for") } : {}),
    ...(form.has("notes") ? { notes: lines(str(form, "notes")) ?? "" } : {}),
    ...(every !== undefined ? { every } : {}),
  };
}

/** `/news new`'s options: an empty include, exclude, disambiguate, notes, shows or every is left out, as an unset option is. */
export function newsInput(form: URLSearchParams): NewsInput {
  const include = lines(opt(form, "include"));
  const exclude = opt(form, "exclude");
  const disambiguate = lines(opt(form, "disambiguate"));
  const notes = lines(opt(form, "notes"));
  const every = int(form, "every");
  return {
    subject: str(form, "subject"),
    ...(include !== undefined ? { include } : {}),
    ...(exclude !== undefined ? { exclude } : {}),
    ...(disambiguate !== undefined ? { disambiguate } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(opt(form, "shows") !== undefined ? { shows: str(form, "shows") } : {}),
    ...(every !== undefined ? { every } : {}),
  };
}

/** A news watch's edit: an empty subject or every keeps the watch's; a sent empty include, exclude, disambiguate or notes clears it. */
export function newsEdit(form: URLSearchParams): NewsEdit {
  const subject = opt(form, "subject");
  const every = int(form, "every");
  return {
    ...(subject !== undefined ? { subject } : {}),
    ...(form.has("include") ? { include: lines(str(form, "include")) ?? "" } : {}),
    ...(form.has("exclude") ? { exclude: str(form, "exclude") } : {}),
    ...(form.has("disambiguate") ? { disambiguate: lines(str(form, "disambiguate")) ?? "" } : {}),
    ...(form.has("notes") ? { notes: lines(str(form, "notes")) ?? "" } : {}),
    ...(opt(form, "shows") !== undefined ? { shows: str(form, "shows") } : {}),
    ...(every !== undefined ? { every } : {}),
  };
}

/** `/want`'s options: an empty target, max, currency, exclude, confirm, unconfirmed or hours is left out, as an unset option is. */
export function wantInput(form: URLSearchParams): WantInput {
  const target = opt(form, "target");
  const exclude = opt(form, "exclude");
  const confirm = opt(form, "confirm");
  const unconfirmed = opt(form, "unconfirmed");
  const max = decimal(form, "max");
  const currency = opt(form, "currency");
  const hours = int(form, "hours");
  const judge = opt(form, "judge");
  return {
    name: str(form, "name"),
    source: str(form, "source") || "page",
    // "yes" or "no"; anything else is left out, so the default applies.
    ...(judge === "yes" || judge === "no" ? { judge: judge === "yes" } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(exclude !== undefined ? { exclude } : {}),
    ...(confirm !== undefined ? { confirm } : {}),
    ...(unconfirmed !== undefined ? { unconfirmed } : {}),
    ...(hours !== undefined ? { hours } : {}),
  };
}

/** A watch's edit: an empty name or hours keeps the watch's; a sent empty `max`, `currency`, `exclude`, `confirm` or `unconfirmed` clears it. */
export function wantEdit(form: URLSearchParams): WantEdit {
  const name = opt(form, "name");
  const hours = int(form, "hours");
  return {
    ...(name !== undefined ? { name } : {}),
    ...(form.has("max") ? { max: decimal(form, "max") ?? null } : {}),
    ...(form.has("currency") ? { currency: str(form, "currency") } : {}),
    ...(form.has("exclude") ? { exclude: str(form, "exclude") } : {}),
    ...(form.has("confirm") ? { confirm: str(form, "confirm") } : {}),
    ...(form.has("unconfirmed") ? { unconfirmed: str(form, "unconfirmed") } : {}),
    ...(hours !== undefined ? { hours } : {}),
  };
}

export function renewalInput(form: URLSearchParams): RenewalInput {
  const every = int(form, "every");
  const lead = int(form, "lead");
  const unit = opt(form, "unit");
  const note = opt(form, "note");
  return {
    name: str(form, "name"),
    amount: decimal(form, "amount") ?? Number.NaN,
    currency: str(form, "currency"),
    renews: str(form, "renews"),
    ...(every !== undefined ? { every } : {}),
    ...(lead !== undefined ? { lead } : {}),
    ...(unit !== undefined ? { unit: unit as PeriodUnit } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

function priceSettings(form: URLSearchParams) {
  const name = opt(form, "name");
  const hours = int(form, "hours");
  const drop = decimal(form, "drop");
  const baseline = opt(form, "baseline");
  return {
    ...(name !== undefined ? { name } : {}),
    ...(hours !== undefined ? { hours } : {}),
    ...(drop !== undefined ? { drop } : {}),
    ...(baseline !== undefined ? { baseline: baseline as BaselineRule } : {}),
  };
}

export function priceInput(form: URLSearchParams): PriceInput {
  const near = opt(form, "near");
  return { url: str(form, "url"), ...priceSettings(form), ...(near !== undefined ? { near } : {}) };
}

/** An edit's form: an empty field is left out (kept), except a note or a name, where empty clears. */
export function reminderEdit(form: URLSearchParams) {
  const text = opt(form, "text");
  const when = opt(form, "when");
  const repeat = opt(form, "repeat");
  return { ...(text !== undefined ? { text } : {}), ...(when !== undefined ? { when } : {}), ...(repeat !== undefined ? { repeat: repeat as Repeat } : {}) };
}

export function renewalEdit(form: URLSearchParams) {
  const name = opt(form, "name");
  const amount = decimal(form, "amount");
  const currency = opt(form, "currency");
  const renews = opt(form, "renews");
  const every = int(form, "every");
  const lead = int(form, "lead");
  const unit = opt(form, "unit");
  return {
    ...(name !== undefined ? { name } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(renews !== undefined ? { renews } : {}),
    ...(every !== undefined ? { every } : {}),
    ...(lead !== undefined ? { lead } : {}),
    ...(unit !== undefined ? { unit: unit as PeriodUnit } : {}),
    ...(form.has("note") ? { note: str(form, "note") } : {}),
  };
}

export function priceEdit(form: URLSearchParams) {
  const { name: _name, ...rest } = priceSettings(form);
  return { ...rest, ...(form.has("name") ? { name: str(form, "name") } : {}) };
}

/** The edit form's values as the task stands: what each field would say to keep it as it is. */
export function editValues(d: Pick<TrackerDeps, "clock">, user: User, task: Task): Values {
  const now = d.clock.now();
  if (task.type === "reminder") return { text: String((task.config as { text?: unknown } | null)?.text ?? ""), when: "", repeat: repeatOf(task.schedule) };
  if (task.type === "renewal" && task.schedule?.kind === "period") {
    const s = task.schedule;
    const c = task.config as RenewalConfig;
    const carried = (task.state as { amount?: unknown } | null)?.amount;
    // After a period has rolled the anchor is in the past: offer the next period date, which edit.ts
    // takes as the schedule as it is.
    const renews = renewalDate(task, user, now);
    return {
      name: task.title,
      amount: String(typeof carried === "number" ? carried : c.amount),
      currency: c.currency,
      renews,
      unit: s.unit,
      every: String(s.every),
      lead: String(s.leadDays ?? 0),
      note: c.note ?? "",
    };
  }
  if (task.type === "scout") {
    const c = task.config as ScoutConfig;
    const every = task.schedule?.kind === "calendar" ? task.schedule.every : 1;
    return { interests: c.interests.join("\n"), lens: c.lens, for: c.for ?? "", notes: c.notes ?? "", every: String(every) };
  }
  if (task.type === "news") {
    const c = task.config as NewsConfig;
    const every = task.schedule?.kind === "calendar" ? task.schedule.every : DEFAULT_NEWS_EVERY;
    const exclude = Array.isArray(c.exclude) ? c.exclude.filter((e) => typeof e === "string").join(", ") : typeof c.exclude === "string" ? c.exclude : "";
    return { subject: c.subject, include: kindsOf(c.include).join("\n"), exclude, disambiguate: c.disambiguate ?? "", notes: c.notes ?? "", shows: c.shows === true ? "yes" : "no", every: String(every) };
  }
  if (task.type === "wantlist" || task.type === "wantjudge") {
    const c = task.config as WantConfig;
    const every = task.schedule?.kind === "poll" ? task.schedule.every : "";
    const exclude = Array.isArray(c.exclude) ? c.exclude.filter((e) => typeof e === "string").join(", ") : "";
    return { name: task.title, max: c.maxPrice !== undefined ? String(c.maxPrice) : "", currency: c.currency ?? "", exclude, confirm: wordsText(c.confirm), unconfirmed: wordsText(c.unconfirmed), hours: String(every) };
  }
  if (task.type !== "price") return {};
  const c = task.config as PriceConfig;
  const every = task.schedule?.kind === "poll" ? task.schedule.every : 12;
  return { name: task.title, hours: String(every), drop: String(c.dropPercent ?? 10), baseline: c.baseline ?? "last" };
}
