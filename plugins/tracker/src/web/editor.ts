import { describeSchedule, type Task, type User } from "@rackbops/docket-core";
import type { PriceConfig } from "@rackbops/docket-types";
import { NO_LONGER_LISTED, NO_SUCH_TASK, type TaskResult, type TrackerDeps } from "../actions.js";
import type { Queue } from "../discord-common.js";
import { editPrice, editReminder, editRenewal } from "../edit.js";
import { createScout, editScout, SCOUT_OFF } from "../scout.js";
import { loadHistory } from "../history.js";
import { deleteTask, type Done, ownLiveTask, pauseTask, resumeTask } from "../manage.js";
import { createReminder } from "../reminders.js";
import { runNow } from "../run-now.js";
import { finishPrice, previewPrice, startPrice } from "../price.js";
import { createResearch, RESEARCH_OFF } from "../research.js";
import { createRenewal } from "../tracked.js";
import { editWant, finishWant, previewWant, startWant, type WatchConfig, watchSite } from "../want.js";
import { EDITOR_TYPES, type EditorType, confirmDeletePage, editTaskPage, type NewType, newTaskPage, notice, ownerControls, taskHref, type Values } from "./editor-pages.js";
import { editValues, priceEdit, priceInput, reminderEdit, reminderInput, renewalEdit, renewalInput, researchInput, scoutEdit, scoutInput, typed, wantEdit, wantInput } from "./form-input.js";
import { htmlResponse, redirect } from "./html.js";
import { taskVersion, VERSION_MISMATCH } from "./task-version.js";
import { historyPage, notFoundPage, type Viewer } from "./pages.js";

/**
 * The task editor's routes (rackbops-bot-plugins#80, plan 5.10): new, edit, pause, resume, delete,
 * for the signed-in person's own tasks only. app.ts has already checked the session, the method,
 * the `Origin` and the CSRF token; here every act loads the task by id and checks, in the queue,
 * that the viewer owns it -- an id in the path is never trusted for ownership -- and anything else
 * answers the same 404 as an unknown id. The rules are the commands' own (reminders.ts, tracked.ts,
 * price.ts, research.ts, scout.ts, want.ts, edit.ts, manage.ts); this file only reads the form and
 * renders. Every write takes its turn in the surface's one queue, against the person as the store has
 * them then.
 *
 * The writes themselves (`makeTask`, `saveEdit`, `actOn`) are shared with the JSON task API
 * (api.ts, slice 4): the same fields, read by form-input.ts, through the same calls.
 */

export interface Editor {
  d: TrackerDeps;
  v: Viewer;
  queue: Queue;
  /** Who has a new price's or watch's page read in flight (tracker user ids): one at a time per person. */
  reading: Set<string>;
  /** `performance.now()` when the host handed app.ts the request: a first page read's deadline counts from it. */
  arrived: number;
}

/** Who writes, and through what: the web editor's viewer or an API token's owner. */
export interface Writer {
  d: TrackerDeps;
  queue: Queue;
  /** Shared by the web and the API: one new price tracker's or page watch's read per person, wherever it was asked. */
  reading: Set<string>;
  userId: string;
  /** `performance.now()` when the request arrived (app.ts, api.ts), before any sign-in or membership check. */
  arrived: number;
  /**
   * The task API's `If-Match` (rackbops-bot-plugins#369): the version the client last read of the
   * task it writes. Checked in the queue, against the task as it stands then, so no other web, API or
   * command write slips between the check and the change. A tick does not use the queue: a run that
   * finishes the task can still land in between, and the act then meets the finished task's rules.
   */
  ifMatch?: { taskId: string; version: string };
}

export const READING = "I am still reading a page for your last new price tracker or want-list watch; try again when it is done.";

const GONE = NO_LONGER_LISTED;

const writer = (e: Editor): Writer => ({ d: e.d, queue: e.queue, reading: e.reading, userId: e.v.user.id, arrived: e.arrived });

/** Runs `fn` in the queue with the writer as the store has them now. */
function asUser<T extends { ok: boolean }>(w: Writer, fn: (user: User) => Promise<T>): Promise<T | { ok: false; error: string }> {
  return w.queue(async () => {
    const user = await w.d.store.getUser(w.userId);
    if (!user) return { ok: false as const, error: GONE };
    if (w.ifMatch) {
      const task = await w.d.store.getTask(w.ifMatch.taskId);
      if (!task || taskVersion(task) !== w.ifMatch.version) return { ok: false as const, error: VERSION_MISMATCH };
    }
    return fn(user);
  });
}

export type Written = TaskResult | { ok: false; error: string };

/**
 * The host answers a call with 504 once it has taken 10 s, without cancelling it (contract.d.ts,
 * `http`). A new price's or page watch's first read, which fetch.ts lets run 15 s, gives up
 * `WEB_READ_MS` after the request arrived -- counted from before the sign-in, the membership
 * re-check, the body read and the queue, not from when the create starts -- so a slow page makes
 * nothing behind a 504 that a retry would then make a second time (#174). The about 2 s left after
 * the read is a margin for the finish's turn in the queue, not a bound on it: a queue slower than
 * that can still make the task after the host has answered 504.
 */
export const WEB_READ_MS = 8_000;
export const SLOW_PAGE = `That page did not answer within ${WEB_READ_MS / 1000} seconds, so I made nothing; try again later.`;

/** `read`'s result, or null once `WEB_READ_MS` from `arrived` (a `performance.now()`) has passed first. */
async function within<T>(read: Promise<T>, arrived: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, WEB_READ_MS - (performance.now() - arrived)));
  });
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ends the writer's one page read: at once, or, for a read given up on (`late`), only when it
 * really ends, so a retry meanwhile is refused as busy rather than read alongside it.
 */
function release(w: Writer, late: Promise<unknown> | null): void {
  const done = () => void w.reading.delete(w.userId);
  if (late) late.then(done, done);
  else done();
}

/** A new task of `type` from its fields: `/remind`'s, `/renewal`'s, `/price`'s, `/research`'s or `/scout new`'s rules, in the queue. */
export async function makeTask(w: Writer, type: NewType, form: URLSearchParams): Promise<Written> {
  if (type === "reminder") return asUser(w, (u) => createReminder(w.d, u, reminderInput(form)));
  if (type === "renewal") return asUser(w, (u) => createRenewal(w.d, u, renewalInput(form)));
  // Research only queues a Job: nothing reaches city-hall until the execute tick, so nothing slow runs here.
  if (type === "research") return asUser(w, (u) => createResearch(w.d, u, researchInput(form)));
  if (type === "scout") return asUser(w, (u) => createScout(w.d, u, scoutInput(form)));
  if (type === "wantlist") return makeWant(w, form);
  const input = priceInput(form);
  // One page read per person at a time: the web has no Discord rate limit in front of it, and
  // each read is an outbound request of up to 15 s (cut to `WEB_READ_MS` after arrival here).
  if (w.reading.has(w.userId)) return { ok: false, error: READING };
  w.reading.add(w.userId);
  let late: Promise<unknown> | null = null;
  try {
    const started = await asUser(w, (u) => startPrice(w.d, u, input));
    if (!started.ok) return started;
    // The page is read outside the queue, as `/price` reads it: a slow page holds up no one else.
    const { pending } = started;
    const read = previewPrice(w.d, pending);
    const seen = await within(read, w.arrived);
    if (seen === null) {
      late = read;
      return { ok: false, error: SLOW_PAGE };
    }
    return await asUser(w, (u) => finishPrice(w.d, u, pending, seen));
  } finally {
    release(w, late);
  }
}

/**
 * `/want`'s rules, a page read outside the queue as a new price's is. Only a `page` watch has a first
 * read (a BGG or inbox watch reads nothing when it is made), so only it takes the
 * one-read-per-person guard, and only once `startWant` has said which it is. Its read gets what is
 * left of `WEB_READ_MS` from the request's arrival, so `startWant`'s queue wait counts against it; a
 * BGG or inbox watch awaits only the queue, as a reminder does, and reads nothing to bound.
 */
async function makeWant(w: Writer, form: URLSearchParams): Promise<Written> {
  const started = await asUser(w, (u) => startWant(w.d, u, wantInput(form)));
  if (!started.ok) return started;
  const { start } = started;
  if (start.config.source !== "page") return asUser(w, (u) => finishWant(w.d, u, start, { ok: true, text: "" }));
  if (w.reading.has(w.userId)) return { ok: false, error: READING };
  w.reading.add(w.userId);
  let late: Promise<unknown> | null = null;
  try {
    const read = previewWant(w.d, start);
    const seen = await within(read, w.arrived);
    if (seen === null) {
      late = read;
      return { ok: false, error: SLOW_PAGE };
    }
    return await asUser(w, (u) => finishWant(w.d, u, start, seen));
  } finally {
    release(w, late);
  }
}

/** The owner's live task of an editor type, or null (the 404). */
export async function editableTask(d: TrackerDeps, user: User, id: string): Promise<Task | null> {
  const task = await ownLiveTask(d, user, id);
  return task && (EDITOR_TYPES as readonly string[]).includes(task.type) ? task : null;
}

/** An edit of `task` (already found to be the writer's) from its fields: edit.ts's rules, in the queue. */
export function saveEdit(w: Writer, task: Task, form: URLSearchParams): Promise<Written> {
  if (task.type === "reminder") return asUser(w, (u) => editReminder(w.d, u, task.id, reminderEdit(form)));
  if (task.type === "renewal") return asUser(w, (u) => editRenewal(w.d, u, task.id, renewalEdit(form)));
  if (task.type === "scout") return asUser(w, (u) => editScout(w.d, u, task.id, scoutEdit(form)));
  if (task.type === "wantlist" || task.type === "wantjudge") return asUser(w, (u) => editWant(w.d, u, task.id, wantEdit(form)));
  return asUser(w, (u) => editPrice(w.d, u, task.id, priceEdit(form)));
}

export type TaskAction = "pause" | "resume" | "delete";

/** A run now (run-now.ts, #369), in the surface's one queue as the owner's other acts are. */
export function runOn(w: Writer, taskId: string): Promise<Done | { ok: false; error: string }> {
  return asUser(w, (u) => runNow(w.d, u, taskId));
}

/** Pause, resume or delete the writer's task: manage.ts's rules, in the queue. */

export function actOn(w: Writer, taskId: string, action: TaskAction): Promise<Done | { ok: false; error: string }> {
  const act = action === "pause" ? pauseTask : action === "resume" ? resumeTask : deleteTask;
  return asUser(w, (u) => act(w.d, u, taskId));
}

// --- new ------------------------------------------------------------------------------------------

const DEFAULTS: Record<NewType, Values> = {
  reminder: { repeat: "none" },
  renewal: { unit: "year", every: "1", lead: "7" },
  price: { hours: "12", drop: "10", baseline: "last" },
  research: {},
  scout: { lens: "general", every: "1" },
  wantlist: { source: "page" },
  wantjudge: {},
};

export function newGet(e: Editor, type: NewType): Response {
  // Without the model runner the page says so instead of offering a form that can only be refused.
  if (type === "research" && !e.d.research) return htmlResponse(newTaskPage(e.v, type, {}, undefined, RESEARCH_OFF));
  if (type === "scout" && !e.d.research) return htmlResponse(newTaskPage(e.v, type, {}, undefined, SCOUT_OFF));
  if (type === "wantlist") return htmlResponse(newTaskPage(e.v, type, { ...DEFAULTS.wantlist, judge: e.d.research ? "yes" : "no" }));
  return htmlResponse(newTaskPage(e.v, type, type === "renewal" ? { ...DEFAULTS.renewal, currency: "USD" } : DEFAULTS[type]));
}

export async function newPost(e: Editor, type: NewType, form: URLSearchParams): Promise<Response> {
  const made = await makeTask(writer(e), type, form);
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

function wantWhere(c: WatchConfig): string {
  const site = watchSite(c);
  if (site) {
    const what = c.game !== undefined ? `BGG game ${c.game}` : `"${c.search ?? ""}"`;
    return `${site === "ebay" ? "the eBay listings" : "the BoardGameGeek listings"} you send in for ${what}`;
  }
  if (c.source === "shopify") return `Shopify stores' search for "${c.target}"`;
  if (c.source === "ebay") return `eBay's search for "${c.target}"`;
  return c.source === "bgg" ? `BoardGameGeek game ${c.target}` : c.target;
}

function editPage(e: Editor, task: Task, values: Values, error?: string): string {
  const now = task.schedule ? describeSchedule(task.schedule, e.v.user, e.v.user.timeZone, e.d.clock.now()) : "no schedule";
  const page = task.type === "price" ? String((task.config as PriceConfig).url) : task.type === "wantlist" || task.type === "wantjudge" ? wantWhere(task.config as WatchConfig) : undefined;
  return editTaskPage(e.v, task, values, { now, ...(page !== undefined ? { page } : {}), ...(error !== undefined ? { error } : {}) });
}

export async function editGet(e: Editor, id: string): Promise<Response> {
  const task = await editableTask(e.d, e.v.user, id);
  if (!task) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  // A finished task has nothing to edit: its page says what it is.
  if (task.status !== "active" && task.status !== "paused") return redirect(taskHref(e.v, task.id));
  return htmlResponse(editPage(e, task, editValues(e.d, e.v.user, task)));
}

export async function editPost(e: Editor, id: string, form: URLSearchParams): Promise<Response> {
  const task = await editableTask(e.d, e.v.user, id);
  if (!task) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  const saved = await saveEdit(writer(e), task, form);
  if (saved.ok) return redirect(`${taskHref(e.v, task.id)}?done=saved`);
  if (saved.error === NO_SUCH_TASK) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  return htmlResponse(editPage(e, task, typed(task.type as EditorType, "edit", form), saved.error), 400);
}

// --- pause, resume, delete ------------------------------------------------------------------------

export async function actionPost(e: Editor, id: string, action: TaskAction, form: URLSearchParams): Promise<Response> {
  const task = await ownLiveTask(e.d, e.v.user, id);
  if (!task) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  // Deleting takes two posts: the first only asks.
  if (action === "delete" && form.get("confirm") !== "yes") return htmlResponse(confirmDeletePage(e.v, task));
  const done = await actOn(writer(e), task.id, action);
  if (!done.ok) return done.error === NO_SUCH_TASK ? htmlResponse(notFoundPage(e.v.base, e.v), 404) : taskPage(e, task.id, null, done.error);
  if (action === "delete") return redirect(`${e.v.base}/?done=deleted`);
  return redirect(`${taskHref(e.v, task.id)}?done=${action === "pause" ? "paused" : "resumed"}`);
}
