import { describeSchedule, hasFired, type Task, type User } from "@rackbops/docket-core";
import type { IntakeType, PriceConfig, ResearchConfig } from "@rackbops/docket-types";
import { NO_LONGER_LISTED, NO_SUCH_TASK, ownTask, type TrackerDeps } from "../actions.js";
import { loadHistory } from "../history.js";
import { TASK_BUSY } from "../locks.js";
import { FINISHED, ownLiveTask } from "../manage.js";
import { RESEARCH_OFF } from "../research.js";
import { awaitingPages, blockedPages, sentResearch, waitingForPages } from "../research-sources.js";
import { SCOUT_OFF } from "../scout.js";
import { INBOX_OFF, JUDGE_OFF, type WatchConfig, watchSite } from "../want.js";
import { actOn, editableTask, makeTask, READING, saveEdit, SLOW_PAGE, type TaskAction, type Writer, type Written } from "./editor.js";
import { EDITOR_TYPES, type EditorType, type Field, fieldsFor, MODEL_TYPES, NEW_TYPES, type NewType } from "./editor-pages.js";
import { editValues } from "./form-input.js";
import { etag, taskVersion, VERSION_MISMATCH } from "./task-version.js";
import { MAX_LIVE_TASKS } from "../limits.js";
import { MAX_PRICE_TASKS } from "../price.js";
import { MAX_LIVE_RESEARCH } from "../research.js";
import { MAX_LIVE_SCOUTS } from "../scout.js";
import { MAX_WANT_TASKS } from "../want.js";

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
  return { status: 200, body: { types: intakeTypes(d) } };
}

/** `GET /types`'s list, as the intake (intake.ts) hands it to the model: the same fields, the same checks. */
export function intakeTypes(d: Pick<TrackerDeps, "research">): IntakeType[] {
  const describe = (type: NewType, fields: readonly Field[], mode: "new" | "edit") =>
    fields.map((f) => ({
      name: f.name,
      type: jsonKind(f),
      // An edit keeps whatever it is not sent: no field of an edit is required.
      required: mode === "new" && f.required === true,
      description: `${f.help ? `${f.label}. ${f.help}` : f.label}${clearsWithNull(type, mode, f.name) ? " Send null to clear it." : ""}`,
      ...(f.maxlength !== undefined ? { maxLength: f.maxlength } : {}),
      ...(f.min !== undefined ? { minimum: f.min } : {}),
      ...(f.max !== undefined ? { maximum: f.max } : {}),
      ...(f.options ? { enum: f.options.map(([value]) => value) } : {}),
      // The one field an edit clears with `null` says so in data too (docket-types 0.14.0's `IntakeField.nullable`).
      ...(clearsWithNull(type, mode, f.name) ? { nullable: true } : {}),
    }));
  return offeredTypes(d).map((type) => ({
    type,
    editable: type !== "research",
    create: describe(type, fieldsFor(type, "new", "api"), "new"),
    edit: describe(type, fieldsFor(type, "edit", "api"), "edit"),
  }));
}

/** The one field `null` is a value of: a watch's top price in an edit, which it clears (`GET /types` says so). */
function clearsWithNull(type: string, mode: "new" | "edit", name: string): boolean {
  return mode === "edit" && (type === "wantlist" || type === "wantjudge") && name === "max";
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
    if (value === null && clearsWithNull(type, mode, key)) {
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
  // The page did not answer before the host's deadline (editor.ts, #174): nothing made, worth a retry.
  if (error === SLOW_PAGE) return problem(503, "slow_page", error, { "Retry-After": "10" });
  if (error === NOT_EDITABLE) return problem(409, "conflict", error);
  if (error === VERSION_MISMATCH) return problem(412, "version_mismatch", error);
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
    settings.sources = sentResearch(task) ? "browser" : "web";
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
    // What `If-Match` names to make a write conditional (task-version.ts; #369).
    version: taskVersion(task),
    cadence: task.schedule ? describeSchedule(task.schedule, user, user.timeZone, d.clock.now()) : "no schedule",
    nextAt: await nextAt(d, task),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    settings,
    // A price's page: read-only, since another page is another tracker (no edit takes it).
    ...(task.type === "price" ? { url: String((task.config as PriceConfig).url) } : {}),
    // A watch's source and target: read-only too, since another place to look is another watch.
    ...(task.type === "wantlist" || task.type === "wantjudge" ? watchJson(task.config as WatchConfig) : {}),
    // A browser research request (0.28.0), or one whose first answer listed pages its run could not
    // open (0.29.0, the fuller pass): where its pages come from (`browser`, the same word as
    // `settings.sources` and the create field, docket's config calling it `sent`; or `web`), how many
    // are in, whether it waits for them now (`POST /tasks/<id>/sources`, then `/sources/ready`), and
    // those blocked pages, `{site, url?, why}`, so the browser knows what to gather.
    ...(sentResearch(task) || blockedPages(task).length > 0 || (await awaitingPages(d.store, task))
      ? { sources: sentResearch(task) ? "browser" : "web", pages: d.sources?.count(task.id) ?? 0, waitingForPages: await waitingForPages(d.store, task), blocked: blockedPages(task) }
      : {}),
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

/** The most tasks one page of `GET /tasks` holds. */
export const MAX_PAGE = 200;

/** A page's cursor: the last task it held, opaque to the client. */
const cursorOf = (taskId: string): string => Buffer.from(taskId).toString("base64url");
const CURSOR = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `GET /tasks`: the owner's tasks that are not deleted -- active, paused and done -- oldest first.
 * With `limit` (1 to `MAX_PAGE`) it is one page, and `nextCursor` names where the next begins; send
 * it back as `cursor`. A cursor is the last task the page held, found among every task the owner
 * ever made (a deleted one stays in the store), so a task deleted or made between two pages moves
 * no other task across the cut: each task still there is listed exactly once. Without `limit`, every
 * task in one answer, as before.
 */
export async function listAnswer(d: TrackerDeps, user: User, query: URLSearchParams = new URLSearchParams()): Promise<ApiAnswer> {
  const rawLimit = query.get("limit");
  const rawCursor = query.get("cursor");
  for (const key of query.keys()) {
    if (key !== "limit" && key !== "cursor") return problem(400, "unknown_field", `\`${key.slice(0, 40)}\` is not a query parameter of GET tasks: it takes limit and cursor.`);
  }
  let limit: number | null = null;
  if (rawLimit !== null) {
    limit = /^[0-9]{1,4}$/.test(rawLimit) ? Number(rawLimit) : 0;
    if (limit < 1 || limit > MAX_PAGE) return problem(400, "invalid", `\`limit\` is a whole number from 1 to ${MAX_PAGE}.`);
  }
  if (rawCursor !== null && limit === null) return problem(400, "invalid", "`cursor` goes with `limit`.");
  // Every task, deleted ones too, in the store's order (oldest first): the cursor is found here.
  const all = await d.store.listTasks({ ownerId: user.id });
  let start = 0;
  if (rawCursor !== null) {
    const at = CURSOR.test(rawCursor) ? all.findIndex((t) => cursorOf(t.id) === rawCursor) : -1;
    if (at < 0) return problem(400, "invalid_cursor", "That cursor is not one this API gave you: start again without it.");
    start = at + 1;
  }
  const out = [];
  let last: Task | null = null;
  let more = false;
  for (let i = start; i < all.length; i++) {
    const t = all[i] as Task;
    if (t.status === "archived") continue;
    if (limit !== null && out.length === limit) {
      more = true;
      break;
    }
    out.push(await taskJson(d, user, t));
    last = t;
  }
  return { status: 200, body: { tasks: out, ...(limit !== null ? { nextCursor: more && last ? cursorOf(last.id) : null } : {}) } };
}

/**
 * `GET /capabilities`: what this bot can make for the owner, in one read -- the types and their fields
 * (as `GET /types`), the owner's zone and preferred hour, the caps on how many tasks a person keeps,
 * the request limits, and which sources are set up, as true or false only: never a key, a token, an
 * address or any other configured value.
 */
export function capabilitiesAnswer(d: TrackerDeps, user: User, rate: { burst: number; perSecond: number }): ApiAnswer {
  return {
    status: 200,
    body: {
      types: intakeTypes(d),
      owner: { timeZone: user.timeZone, preferredHour: user.preferredHour },
      limits: {
        liveTasks: MAX_LIVE_TASKS,
        priceTrackers: MAX_PRICE_TASKS,
        researchWaiting: MAX_LIVE_RESEARCH,
        scouts: MAX_LIVE_SCOUTS,
        wantWatches: MAX_WANT_TASKS,
        pageSize: MAX_PAGE,
        requestsBurst: rate.burst,
        requestsPerSecond: rate.perSecond,
      },
      sources: {
        // The model runner (city-hall's executor): research and scouts.
        runner: d.research === true,
        bgg: d.bgg === true,
        ebay: d.ebay === true,
        shopify: d.shopify === true,
        mail: d.mail != null,
        web: d.webEditor,
      },
    },
  };
}

/** `GET /tasks/<id>`: one of the owner's tasks (a deleted one too, as its web page stays), with its history and findings. */
export async function getAnswer(d: TrackerDeps, user: User, id: string): Promise<ApiAnswer> {
  const task = await ownTask(d, user, id);
  if (!task) return notFound();
  const view = await loadHistory(d, user, task.id);
  if (!view) return notFound();
  return {
    status: 200,
    headers: { ETag: etag(taskVersion(view.task)) },
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
  const tag = { ETag: etag(taskVersion(task)) };
  return {
    status,
    body: { task: await taskJson(w.d, user, task), message: result.text },
    headers: status === 201 ? { ...tag, Location: `${base}/tasks/${encodeURIComponent(task.id)}` } : tag,
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

/** The writer with its `If-Match` bound to the task the route found, not to the id as the client spelled it. */
function bound(w: Writer, task: Task): Writer {
  return w.ifMatch ? { ...w, ifMatch: { taskId: task.id, version: w.ifMatch.version } } : w;
}

/** `PATCH /tasks/<id>`: the fields to change; one left out keeps what the task has. */
export async function editAnswer(w: Writer, user: User, id: string, body: Record<string, unknown>, base: string): Promise<ApiAnswer> {
  const task = await editableTask(w.d, user, id);
  if (!task) return (await ownLiveTask(w.d, user, id))?.type === "research" ? refusal(NOT_EDITABLE) : notFound();
  const form = asFields(body, task.type as EditorType, "edit");
  if (!(form instanceof URLSearchParams)) return form;
  return written(w, user, await saveEdit(bound(w, task), task, form), 200, base);
}

/** `POST /tasks/<id>/pause`, `/resume`, and `DELETE /tasks/<id>`. */
export async function actAnswer(w: Writer, user: User, id: string, action: TaskAction): Promise<ApiAnswer> {
  const task = await ownTask(w.d, user, id);
  if (!task || task.status === "archived") return notFound();
  const done = await actOn(bound(w, task), task.id, action);
  if (!done.ok) return refusal(done.error);
  const after = (await w.d.store.getTask(task.id)) ?? task;
  return { status: 200, headers: { ETag: etag(taskVersion(after)) }, body: { task: await taskJson(w.d, user, after), message: done.text } };
}
