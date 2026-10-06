import { describeSchedule, hasFired, type Task, type User } from "@rackbops/docket-core";
import type { PriceConfig, ResearchConfig } from "@rackbops/docket-types";
import { NO_LONGER_LISTED, NO_SUCH_TASK, ownTask, type TrackerDeps } from "../actions.js";
import { loadHistory } from "../history.js";
import { TASK_BUSY } from "../locks.js";
import { FINISHED, ownLiveTask } from "../manage.js";
import { RESEARCH_OFF } from "../research.js";
import { SCOUT_OFF } from "../scout.js";
import { INBOX_OFF, JUDGE_OFF, type WatchConfig, watchSite } from "../want.js";
import { actOn, editableTask, makeTask, READING, saveEdit, type TaskAction, type Writer, type Written } from "./editor.js";
import { EDITOR_TYPES, type EditorType, type Field, fieldsFor, MODEL_TYPES, NEW_TYPES, type NewType } from "./editor-pages.js";
import { editValues } from "./form-input.js";

/**
 * The task API's task routes (rackbops-bot-plugins#80, slice 4; plan 5.10, E10): list, read, make,
 * edit, pause, resume and delete the token owner's own tasks, through the very calls the web
 * editor makes (editor.ts's `makeTask`, `saveEdit`, `actOn`), fed the same fields: a JSON body is
 * checked against the editor's field list (`fieldsFor`), turned into those fields, and read by
 * form-input.ts exactly as a form post is -- one set of defaults, limits, caps and messages. api.ts
 * has already authenticated the token, re-read its owner and checked the method and the body.
 *
 * A research request (#82) is made here as `/research` makes it, and paused, resumed or deleted, but
 * never edited, as in Discord: a `PATCH` of one answers 409.
 *
 * Owner only: a task that is not the owner's answers the same 404 as an unknown id, whoever holds
 * the token -- an admin's token included (an admin's wider reads stay on the signed-in web pages).
 */

export type ApiAnswer = { status: number; body: unknown; headers?: Record<string, string> };

export function problem(status: number, code: string, message: string, headers?: Record<string, string>): ApiAnswer {
  return { status, body: { error: { code, message } }, ...(headers ? { headers } : {}) };
}

export const NOT_FOUND_MESSAGE = "No such task.";
const notFound = (): ApiAnswer => problem(404, "not_found", NOT_FOUND_MESSAGE);

/** A JSON value's type as the API takes each editor field: a whole number, a number, or text. */
function jsonKind(f: Field): "integer" | "number" | "string" {
  if (f.kind === "number") return "integer";
  return f.decimal ? "number" : "string";
}

/** The types this bot makes now: research and the scout only while the model runner is set up (`d.research`). */
export function offeredTypes(d: Pick<TrackerDeps, "research">): readonly NewType[] {
  return d.research ? NEW_TYPES : NEW_TYPES.filter((t) => !MODEL_TYPES.has(t));
}

export const NOT_EDITABLE = "A research request cannot be edited. Delete it and ask again.";

/**
 * `GET /types`: what each type's create and edit take -- the editor's own field list, as the
 * readable description of what the API takes, so an agent (E10) can ask one question per field.
 * It is the tracker's editor fields, not docket-core's `TaskType.intake` (`IntakeSpec`), which
 * names the type's own config and not what these endpoints accept. `editable` says whether a
 * `PATCH` takes one at all (a research request's is false, its `edit` empty); research is listed
 * only while it is available.
 */
export function typesAnswer(d: Pick<TrackerDeps, "research">): ApiAnswer {
  const describe = (fields: readonly Field[], mode: "new" | "edit") =>
    fields.map((f) => ({
      name: f.name,
      type: jsonKind(f),
      // An edit keeps whatever it is not sent: no field of an edit is required.
      required: mode === "new" && f.required === true,
      description: f.help ? `${f.label}. ${f.help}` : f.label,
      ...(f.maxlength !== undefined ? { maxLength: f.maxlength } : {}),
      ...(f.min !== undefined ? { minimum: f.min } : {}),
      ...(f.max !== undefined ? { maximum: f.max } : {}),
      ...(f.options ? { enum: f.options.map(([value]) => value) } : {}),
    }));
  return {
    status: 200,
    body: {
      types: offeredTypes(d).map((type) => ({
        type,
        editable: type !== "research",
        create: describe(fieldsFor(type, "new"), "new"),
        edit: describe(fieldsFor(type, "edit"), "edit"),
      })),
    },
  };
}

/**
 * A JSON body as the editor's fields: only `type`'s fields (plus `type` itself on a create), each of
 * its JSON type; anything else is refused by name. Numbers go through as the text a form would
 * carry, so the same reading (and the same refusal of a fraction where a whole number goes) applies.
 */
export function asFields(body: Record<string, unknown>, type: NewType, mode: "new" | "edit"): URLSearchParams | ApiAnswer {
  const fields = new Map(fieldsFor(type, mode).map((f) => [f.name, f]));
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (mode === "new" && key === "type") continue;
    const f = fields.get(key);
    if (!f) return problem(400, "unknown_field", `\`${key.slice(0, 40)}\` is not a field of a ${type}${mode === "edit" ? " edit" : ""}. GET types lists them.`);
    const kind = jsonKind(f);
    // A watch's top price is the one number an edit can clear: `null` sends it empty, as the form does.
    if (value === null && mode === "edit" && (type === "wantlist" || type === "wantjudge") && key === "max") {
      form.set(key, "");
      continue;
    }
    if (kind === "string") {
      if (typeof value !== "string") return problem(400, "invalid", `\`${key}\` must be a string.`);
      form.set(key, value);
    } else {
      if (typeof value !== "number" || !Number.isFinite(value)) return problem(400, "invalid", `\`${key}\` must be a number.`);
      // A form carries digits: `String` of a finite number is what the form readers parse.
      form.set(key, String(value));
    }
  }
  return form;
}

/** What a shared rule's refusal is, over the API: its words, and a status and code that say what kind. */
export function refusal(error: string): ApiAnswer {
  if (error === NO_SUCH_TASK) return notFound();
  if (error === NO_LONGER_LISTED) return problem(401, "invalid_token", "The token's owner is no longer on this tracker's list.");
  if (error === READING || error === TASK_BUSY) return problem(409, "busy", error);
  if (error === NOT_EDITABLE) return problem(409, "conflict", error);
  if (error === RESEARCH_OFF || error === SCOUT_OFF) return problem(503, "unavailable", error);
  if (error === FINISHED || /^That task is [a-z]+, not [a-z]+\.$/.test(error)) return problem(409, "conflict", error);
  if (/^You already (have|track|watch for) [0-9]+ /.test(error)) return problem(409, "limit_reached", error);
  if (error === INBOX_OFF || error === JUDGE_OFF) return problem(503, "unavailable", error);
  if (/ (is|are) not available on this bot\.$/.test(error)) return problem(503, "unavailable", error);
  return problem(400, "invalid", error);
}

/** The next queued run's instant, or null (nothing queued, or paused). A run put back to finish has fired: not next. */
async function nextAt(d: TrackerDeps, task: Task): Promise<string | null> {
  if (task.status !== "active") return null;
  const queued = await d.store.listOccurrences({ taskId: task.id, status: "queued" });
  return queued.find((o) => !hasFired(o))?.dueAt ?? null;
}

/**
 * A task as the API shows it: what it is, its schedule in the owner's words, its next run, and its
 * settings -- the values its edit would keep, typed as the edit takes them -- and, for a price, its
 * page as a top-level `url`, which no edit changes.
 */
export async function taskJson(d: TrackerDeps, user: User, task: Task) {
  const type = (EDITOR_TYPES as readonly string[]).includes(task.type) ? (task.type as EditorType) : null;
  const values = editValues(d, user, task);
  const settings: Record<string, string | number> = {};
  if (task.type === "research") {
    // No edit takes these: they are what was asked, shown to the owner alone (the API is owner-only).
    const c = task.config as ResearchConfig;
    settings.question = c.question;
    if (c.context !== undefined) settings.context = c.context;
    if (c.deadline !== undefined) settings.deadline = c.deadline;
  }
  if (type) {
    for (const f of fieldsFor(type, "edit")) {
      if (f.name === "when") continue; // an edit's "keep the time"; `nextAt` says when
      const raw = values[f.name];
      if (raw === undefined) continue;
      // An unset number (a watch with no top price) is left out, not read as 0.
      if (jsonKind(f) !== "string" && raw === "") continue;
      settings[f.name] = jsonKind(f) === "string" ? raw : Number(raw);
    }
  }
  return {
    id: task.id,
    type: task.type,
    title: task.title,
    status: task.status === "archived" ? "deleted" : task.status,
    cadence: task.schedule ? describeSchedule(task.schedule, user, user.timeZone, d.clock.now()) : "no schedule",
    nextAt: await nextAt(d, task),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    settings,
    // A price's page: read-only, since another page is another tracker (no edit takes it).
    ...(task.type === "price" ? { url: String((task.config as PriceConfig).url) } : {}),
    // A watch's source and target: read-only too, since another place to look is another watch.
    ...(task.type === "wantlist" || task.type === "wantjudge" ? watchJson(task.config as WatchConfig) : {}),
  };
}

/**
 * Where a watch looks, as the API shows it. An inbox watch adds what a browser helper needs to fill
 * it (want.ts): its `site` (`ebay` or `bgg`, from its inbox key) and its words to `search` for, and
 * a BGG `game` when one was named; its top price and currency are in `settings` as for any watch.
 */
function watchJson(c: WatchConfig) {
  const site = watchSite(c);
  return {
    source: c.source,
    target: c.target,
    ...(site ? { site, ...(c.search !== undefined ? { search: c.search } : {}), ...(c.game !== undefined ? { game: c.game } : {}) } : {}),
  };
}

/** `GET /tasks`: the owner's tasks that are not deleted -- active, paused and done -- oldest first. */
export async function listAnswer(d: TrackerDeps, user: User): Promise<ApiAnswer> {
  const tasks = (await d.store.listTasks({ ownerId: user.id })).filter((t) => t.status !== "archived");
  const out = [];
  for (const t of tasks) out.push(await taskJson(d, user, t));
  return { status: 200, body: { tasks: out } };
}

/** `GET /tasks/<id>`: one of the owner's tasks (a deleted one too, as its web page stays), with its history and findings. */
export async function getAnswer(d: TrackerDeps, user: User, id: string): Promise<ApiAnswer> {
  const task = await ownTask(d, user, id);
  if (!task) return notFound();
  const view = await loadHistory(d, user, task.id);
  if (!view) return notFound();
  return {
    status: 200,
    body: {
      task: await taskJson(d, user, view.task),
      history: { next: view.next, runs: view.runs, earlierRuns: view.earlierRuns, changes: view.changes, earlierChanges: view.earlierChanges },
      // docket 0.5.0 (#82): a research request's stored claims, oldest first; empty for other types.
      findings: view.findings.map((f) => ({ claim: f.claim, source: f.source, at: f.atIso })),
    },
  };
}

async function written(w: Writer, user: User, result: Written, status: number, base: string): Promise<ApiAnswer> {
  if (!result.ok) return refusal(result.error);
  const task = (await w.d.store.getTask(result.task.id)) ?? result.task;
  return {
    status,
    body: { task: await taskJson(w.d, user, task), message: result.text },
    ...(status === 201 ? { headers: { Location: `${base}/tasks/${encodeURIComponent(task.id)}` } } : {}),
  };
}

/**
 * `POST /tasks`: `type` names the kind; the rest are that kind's create fields. `research` and `scout`
 * are known types even while they are unavailable, and then answer 503 with their commands' words.
 */
export async function createAnswer(w: Writer, user: User, body: Record<string, unknown>, base: string): Promise<ApiAnswer> {
  const type = body.type;
  if (typeof type !== "string" || !(NEW_TYPES as readonly string[]).includes(type)) {
    return problem(400, "invalid", `\`type\` is one of ${offeredTypes(w.d).join(", ")}.`);
  }
  if (type === "research" && !w.d.research) return refusal(RESEARCH_OFF);
  if (type === "scout" && !w.d.research) return refusal(SCOUT_OFF);
  const form = asFields(body, type as NewType, "new");
  if (!(form instanceof URLSearchParams)) return form;
  return written(w, user, await makeTask(w, type as NewType, form), 201, base);
}

/** `PATCH /tasks/<id>`: the fields to change; one left out keeps what the task has. */
export async function editAnswer(w: Writer, user: User, id: string, body: Record<string, unknown>, base: string): Promise<ApiAnswer> {
  const task = await editableTask(w.d, user, id);
  if (!task) return (await ownLiveTask(w.d, user, id))?.type === "research" ? refusal(NOT_EDITABLE) : notFound();
  const form = asFields(body, task.type as EditorType, "edit");
  if (!(form instanceof URLSearchParams)) return form;
  return written(w, user, await saveEdit(w, task, form), 200, base);
}

/** `POST /tasks/<id>/pause`, `/resume`, and `DELETE /tasks/<id>`. */
export async function actAnswer(w: Writer, user: User, id: string, action: TaskAction): Promise<ApiAnswer> {
  const task = await ownTask(w.d, user, id);
  if (!task || task.status === "archived") return notFound();
  const done = await actOn(w, task.id, action);
  if (!done.ok) return refusal(done.error);
  const after = (await w.d.store.getTask(task.id)) ?? task;
  return { status: 200, body: { task: await taskJson(w.d, user, after), message: done.text } };
}
