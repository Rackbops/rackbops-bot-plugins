import { describeSchedule, type Task, type User } from "@rackbops/docket-core";
import type { BaselineRule, PriceConfig, RenewalConfig } from "@rackbops/docket-types";
import { NO_SUCH_TASK, type TaskResult, type TrackerDeps } from "../actions.js";
import type { Queue } from "../discord-common.js";
import { editPrice, editReminder, editRenewal, renewalDate } from "../edit.js";
import { loadHistory } from "../history.js";
import { deleteTask, type Done, ownLiveTask, pauseTask, resumeTask } from "../manage.js";
import { createReminder, type Repeat, repeatOf } from "../reminders.js";
import { finishPrice, previewPrice, startPrice } from "../price.js";
import { createRenewal, type PeriodUnit } from "../tracked.js";
import { type EditorType, confirmDeletePage, editTaskPage, fieldsFor, newTaskPage, notice, ownerControls, taskHref, type Values } from "./editor-pages.js";
import { htmlResponse, redirect } from "./html.js";
import { historyPage, notFoundPage, type Viewer } from "./pages.js";

/**
 * The task editor's routes (rackbops-bot-plugins#80, plan 5.10): new, edit, pause, resume, delete,
 * for the signed-in person's own tasks only. app.ts has already checked the session, the method,
 * the `Origin` and the CSRF token; here every act loads the task by id and checks, in the queue,
 * that the viewer owns it -- an id in the path is never trusted for ownership -- and anything else
 * answers the same 404 as an unknown id. The rules are the commands' own (reminders.ts, tracked.ts,
 * edit.ts, manage.ts); this file only reads the form and renders. Every write takes its turn in the
 * surface's one queue, against the person as the store has them then.
 */

export interface Editor {
  d: TrackerDeps;
  v: Viewer;
  queue: Queue;
  /** Who has a new price's page read in flight (tracker user ids): one at a time per person. */
  reading: Set<string>;
}

export const READING = "I am still reading the page of your last new price tracker; try again when it is done.";

const GONE = "You are no longer on this tracker's list.";

/** Runs `fn` in the queue with the viewer as the store has them now. */
function asViewer<T extends { ok: boolean }>(e: Editor, fn: (user: User) => Promise<T>): Promise<T | { ok: false; error: string }> {
  return e.queue(async () => {
    const user = await e.d.store.getUser(e.v.user.id);
    return user ? fn(user) : { ok: false as const, error: GONE };
  });
}

// --- reading a form: text as typed; a number that is not one becomes NaN, which the rules refuse ----

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
function typed(type: EditorType, mode: "new" | "edit", form: URLSearchParams): Values {
  return Object.fromEntries(fieldsFor(type, mode).map((f) => [f.name, str(form, f.name)]));
}

function reminderInput(form: URLSearchParams) {
  const when = opt(form, "when");
  return { text: str(form, "text"), ...(when !== undefined ? { when } : {}), repeat: (str(form, "repeat") || "none") as Repeat };
}

function renewalInput(form: URLSearchParams) {
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

/** An edit's form: an empty field is left out (kept), except a note or a name, where empty clears. */
function reminderEdit(form: URLSearchParams) {
  const text = opt(form, "text");
  const when = opt(form, "when");
  const repeat = opt(form, "repeat");
  return { ...(text !== undefined ? { text } : {}), ...(when !== undefined ? { when } : {}), ...(repeat !== undefined ? { repeat: repeat as Repeat } : {}) };
}

function renewalEdit(form: URLSearchParams) {
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

function priceEdit(form: URLSearchParams) {
  const { name: _name, ...rest } = priceSettings(form);
  return { ...rest, ...(form.has("name") ? { name: str(form, "name") } : {}) };
}

// --- new ------------------------------------------------------------------------------------------

const DEFAULTS: Record<EditorType, Values> = {
  reminder: { repeat: "none" },
  renewal: { unit: "year", every: "1", lead: "7" },
  price: { hours: "12", drop: "10", baseline: "last" },
};

export function newGet(e: Editor, type: EditorType): Response {
  return htmlResponse(newTaskPage(e.v, type, type === "renewal" ? { ...DEFAULTS.renewal, currency: "USD" } : DEFAULTS[type]));
}

export async function newPost(e: Editor, type: EditorType, form: URLSearchParams): Promise<Response> {
  let made: TaskResult | { ok: false; error: string };
  if (type === "reminder") made = await asViewer(e, (u) => createReminder(e.d, u, reminderInput(form)));
  else if (type === "renewal") made = await asViewer(e, (u) => createRenewal(e.d, u, renewalInput(form)));
  else {
    const near = opt(form, "near");
    const input = { url: str(form, "url"), ...priceSettings(form), ...(near !== undefined ? { near } : {}) };
    // One page read per person at a time: the web has no Discord rate limit in front of it, and
    // each read is an outbound request of up to 15 s.
    const who = e.v.user.id;
    if (e.reading.has(who)) made = { ok: false, error: READING };
    else {
      e.reading.add(who);
      try {
        const started = await asViewer(e, (u) => startPrice(e.d, u, input));
        // The page is read outside the queue, as `/price` reads it: a slow page holds up no one else.
        if (!started.ok) made = started;
        else {
          const { pending } = started;
          const seen = await previewPrice(e.d, pending);
          made = await asViewer(e, (u) => finishPrice(e.d, u, pending, seen));
        }
      } finally {
        e.reading.delete(who);
      }
    }
  }
  if (!made.ok) return htmlResponse(newTaskPage(e.v, type, typed(type, "new", form), made.error), 400);
  return redirect(`${taskHref(e.v, made.task.id)}?done=created`);
}

// --- a task's page, and edit ----------------------------------------------------------------------

export async function taskPage(e: Editor, id: string, done: string | null, error?: string): Promise<Response> {
  const view = await loadHistory(e.d, e.v.user, id);
  if (!view) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  const own = view.task.ownerId === e.v.user.id;
  const controls = own ? ownerControls(e.v, view.task) : null;
  const owner = own ? null : ((await e.d.store.getUser(view.task.ownerId))?.displayName ?? view.task.ownerId);
  return htmlResponse(historyPage(e.v, view, { controls, flash: notice(done, error), owner }), error ? 400 : 200);
}

/** The edit form's values as the task stands: what each field would say to keep it as it is. */
function current(d: TrackerDeps, user: User, task: Task): Values {
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
  if (task.type !== "price") return {};
  const c = task.config as PriceConfig;
  const every = task.schedule?.kind === "poll" ? task.schedule.every : 12;
  return { name: task.title, hours: String(every), drop: String(c.dropPercent ?? 10), baseline: c.baseline ?? "last" };
}

function editPage(e: Editor, task: Task, values: Values, error?: string): string {
  const now = task.schedule ? describeSchedule(task.schedule, e.v.user, e.v.user.timeZone, e.d.clock.now()) : "no schedule";
  const page = task.type === "price" ? String((task.config as PriceConfig).url) : undefined;
  return editTaskPage(e.v, task, values, { now, ...(page !== undefined ? { page } : {}), ...(error !== undefined ? { error } : {}) });
}

/** The owner's live task of an editor type, or null (the 404). */
async function editableTask(e: Editor, id: string): Promise<Task | null> {
  const task = await ownLiveTask(e.d, e.v.user, id);
  return task && (task.type === "reminder" || task.type === "renewal" || task.type === "price") ? task : null;
}

export async function editGet(e: Editor, id: string): Promise<Response> {
  const task = await editableTask(e, id);
  if (!task) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  // A finished task has nothing to edit: its page says what it is.
  if (task.status !== "active" && task.status !== "paused") return redirect(taskHref(e.v, task.id));
  return htmlResponse(editPage(e, task, current(e.d, e.v.user, task)));
}

export async function editPost(e: Editor, id: string, form: URLSearchParams): Promise<Response> {
  const task = await editableTask(e, id);
  if (!task) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  const saved =
    task.type === "reminder"
      ? await asViewer(e, (u) => editReminder(e.d, u, task.id, reminderEdit(form)))
      : task.type === "renewal"
        ? await asViewer(e, (u) => editRenewal(e.d, u, task.id, renewalEdit(form)))
        : await asViewer(e, (u) => editPrice(e.d, u, task.id, priceEdit(form)));
  if (saved.ok) return redirect(`${taskHref(e.v, task.id)}?done=saved`);
  if (saved.error === NO_SUCH_TASK) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  return htmlResponse(editPage(e, task, typed(task.type as EditorType, "edit", form), saved.error), 400);
}

// --- pause, resume, delete ------------------------------------------------------------------------

export type TaskAction = "pause" | "resume" | "delete";

export async function actionPost(e: Editor, id: string, action: TaskAction, form: URLSearchParams): Promise<Response> {
  const task = await ownLiveTask(e.d, e.v.user, id);
  if (!task) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  // Deleting takes two posts: the first only asks.
  if (action === "delete" && str(form, "confirm") !== "yes") return htmlResponse(confirmDeletePage(e.v, task));
  const act = action === "pause" ? pauseTask : action === "resume" ? resumeTask : deleteTask;
  const done: Done | { ok: false; error: string } = await asViewer(e, (u) => act(e.d, u, task.id));
  if (!done.ok) return done.error === NO_SUCH_TASK ? htmlResponse(notFoundPage(e.v.base, e.v), 404) : taskPage(e, task.id, null, done.error);
  if (action === "delete") return redirect(`${e.v.base}/?done=deleted`);
  return redirect(`${taskHref(e.v, task.id)}?done=${action === "pause" ? "paused" : "resumed"}`);
}
