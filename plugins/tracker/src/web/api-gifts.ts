import {
  type GiftAllocationFields,
  GiftDuplicateError,
  type GiftDuplicateReport,
  GiftIdempotencyError,
  type GiftKind,
  type GiftLedger,
  GiftNotFoundError,
  type GiftRecord,
  GiftRevisionError,
  type GiftSyncDecision,
  type GiftSyncPreview,
  GiftValidationError,
  type GiftWriteMeta,
  editGroupMembers,
  giftProblems,
  giftBuckets,
  giftCoverage,
  giftSpend,
  occasionBudget,
  planGroupSync,
  previewGroupSync,
  purchaseShares,
  type User,
} from "@rackbops/docket-core";
import type { TrackerDeps } from "../actions.js";
import { NO_LONGER_LISTED } from "../actions.js";
import type { ApiAnswer } from "./api-tasks.js";
import { problem } from "./api-tasks.js";
import type { Writer } from "./editor.js";
import { sha256 } from "./secrets.js";
import { canonicalJson } from "./task-version.js";
import { GIFT_COLLECTIONS, type GiftCollection, MAX_GIFT_BATCH } from "./api-gift-names.js";
import { rollover, rolloverPreview, rolloverQuery } from "./api-gift-rollover.js";

export { GIFT_COLLECTIONS, type GiftCollection, MAX_GIFT_BATCH, MAX_GIFT_BATCH_BYTES } from "./api-gift-names.js";

/**
 * The gift organizer's routes in the task API (rackbops-bot-plugins#383, epic Rackbops/docket#94),
 * under `/api/v1/gifts/`. Every route reads and writes only the caller's own gift ledger
 * (`GiftLedger` over gift-store.ts): another person's id, a guessed id, or an id of another kind
 * is the same 404 as one that never existed, and a list holds only the caller's rows. A gift
 * recipient is a name in the owner's ledger, never a tracker person, so sharing a task with
 * someone gives them nothing here.
 *
 * - `GET|POST /gifts/<collection>`: list (`?includeArchived=true`, `?occasionId=`, `?itemId=`
 *   where the collection takes them), or create from every field of the record.
 * - `GET|PATCH /gifts/<collection>/<id>`: one record, or change some of its fields at the
 *   `expectedRevision` the caller read (`archived: true|false` archives or restores; nothing is
 *   deleted). A stale revision is 409 and changes nothing.
 * - `POST /gifts/groups/<id>/members`: add and remove members (`dryRun: true` shows the change).
 *   A filter group (docket#98, `filter: {labels}`) has no list: it is refused (409 `filter_group`),
 *   and its labels are changed with a PATCH of the group instead.
 * - `GET|POST /gifts/occasions/<id>/sync`: the reviewed roster sync with the occasion's groups as
 *   they are now (docket's `previewGroupSync`), then applying it with a decision for every
 *   affected gift and the `previewToken` the preview gave, so nothing the owner did not see is
 *   written.
 * - `GET|POST /gifts/occasions/<id>/rollover` (api-gift-rollover.ts, docket#99): "set up next
 *   year", previewed (with `previewToken`) and then made from the preview the owner reviewed.
 * - `POST /gifts/allocations` (and a batch create of an allocation), and a PATCH or batch update
 *   that changes an allocation's item, occasion or people, ask docket's `giftDuplicates` first
 *   (docket#100); a sync's reassign decision does not (a known gap). Docket refuses no write for a warning; this route is the
 *   host's "shown when allocating" step: a warning the body's `repeatOf` does not name is 409
 *   `possible_duplicate` with the report, and nothing is written. Resending with `repeatOf`
 *   naming the warned allocations is the owner accepting them. A possible duplicate alone never
 *   refuses: it rides on the 201 answer as `duplicates`.
 * - `GET /gifts/occasions/<id>/summary`: coverage of each live roster row, the budget and what the
 *   occasion's gifts cost; `GET /gifts/spend`: spend per currency over the whole ledger.
 * - `POST /gifts/batch`: up to `MAX_GIFT_BATCH` creates and updates, each with its own outcome, in
 *   order; one refused row writes nothing for itself and leaves the others as they went.
 *
 * Writes follow the task API's rules (#369): an `Idempotency-Key` makes a retry one write (api.ts
 * keeps the answer), and each runs in the API's one write queue, so the ledger's reference checks
 * and its write are never split by another API or web write (`GiftLedger`'s own note). Nothing here
 * waits on city-hall or calls a model.
 */

export type GiftRoute =
  | { kind: "collection"; collection: GiftCollection }
  | { kind: "record"; collection: GiftCollection; id: string }
  | { kind: "members" | "sync" | "summary" | "rollover"; id: string }
  | { kind: "spend" | "batch" };

const COLLECTION = /^\/gifts\/([a-z-]+)$/;
const RECORD = /^\/gifts\/([a-z-]+)\/([^/]+)$/;
const MEMBERS = /^\/gifts\/groups\/([^/]+)\/members$/;
const OCCASION_VIEW = /^\/gifts\/occasions\/([^/]+)\/(sync|summary|rollover)$/;

const isCollection = (name: string | undefined): name is GiftCollection => name !== undefined && Object.hasOwn(GIFT_COLLECTIONS, name);

function segment(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? "");
  } catch {
    return "";
  }
}

/** The gift route a path under `/api/v1` names, or null when it is not one. */
export function giftRoute(rest: string): GiftRoute | null {
  if (rest === "/gifts/spend") return { kind: "spend" };
  if (rest === "/gifts/batch") return { kind: "batch" };
  const members = MEMBERS.exec(rest);
  if (members) return { kind: "members", id: segment(members[1]) };
  const view = OCCASION_VIEW.exec(rest);
  if (view) return { kind: view[2] as "sync" | "summary" | "rollover", id: segment(view[1]) };
  const collection = COLLECTION.exec(rest);
  if (collection) return isCollection(collection[1]) ? { kind: "collection", collection: collection[1] } : null;
  const record = RECORD.exec(rest);
  if (record && isCollection(record[1])) return { kind: "record", collection: record[1], id: segment(record[2]) };
  return null;
}

/** The methods a gift route takes. */
export function giftMethods(r: GiftRoute): string[] {
  switch (r.kind) {
    case "collection":
      return ["GET", "POST"];
    case "record":
      return ["GET", "PATCH"];
    case "sync":
    case "rollover":
      return ["GET", "POST"];
    case "members":
    case "batch":
      return ["POST"];
    case "summary":
    case "spend":
      return ["GET"];
  }
}

const NOT_FOUND = "No such gift record.";
export const notFound = (): ApiAnswer => problem(404, "not_found", NOT_FOUND);
export const invalid = (message: string, problems?: string[]): ApiAnswer => ({
  status: 400,
  body: { error: { code: "invalid", message, ...(problems ? { problems } : {}) } },
});

/** A ledger refusal as its answer; anything else is thrown on (api.ts keeps the key as outcome unknown). */
export function refusal(err: unknown): ApiAnswer {
  if (err instanceof GiftNotFoundError) return notFound();
  if (err instanceof GiftRevisionError) {
    return {
      status: 409,
      body: { error: { code: "revision_conflict", message: `That record has moved on to revision ${err.currentRevision}; read it again and resend.`, currentRevision: err.currentRevision } },
    };
  }
  if (err instanceof GiftDuplicateError) return problem(409, "duplicate", "That occasion already has this recipient on its roster; restore their row instead.");
  if (err instanceof GiftValidationError) return invalid(`Refused: ${err.problems.join("; ")}.`, err.problems);
  if (err instanceof GiftIdempotencyError) return problem(409, "idempotency_conflict", err.message);
  throw err;
}

/** The record as the API shows it: its fields, the base fields, and `recordKind` (a recipient has its own `kind`). */
export const shown = <K extends GiftKind>(kind: K, record: GiftRecord<K>) => ({ ...record, recordKind: kind });

type Revision = { ok: true; revision: number; fields: Record<string, unknown> } | { ok: false; answer: ApiAnswer };

/** `expectedRevision` out of a body, and the rest of it as the fields to change. */
function splitRevision(body: Record<string, unknown>): Revision {
  const { expectedRevision, ...fields } = body;
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    return { ok: false, answer: invalid("`expectedRevision` is the record's `revision` as you read it.") };
  }
  return { ok: true, revision: expectedRevision as number, fields };
}

/** Everything the summaries and the sync read: the owner's whole lists, archived rows too, in creation order. */
async function wholeLedger(gifts: GiftLedger, ownerId: string) {
  const all = { includeArchived: true };
  const [allocations, purchases] = await Promise.all([gifts.list("allocation", ownerId, all), gifts.list("purchase", ownerId, all)]);
  return { allocations, purchases, buckets: giftBuckets(allocations, purchases) };
}

/** The sync preview of one of the owner's occasions, with the token that names exactly it; null when there is no such occasion. */
async function preview(gifts: GiftLedger, ownerId: string, id: string): Promise<{ preview: GiftSyncPreview; previewToken: string } | null> {
  const occasion = await gifts.get("occasion", ownerId, id);
  if (!occasion) return null;
  const all = { includeArchived: true };
  const groups = (await gifts.list("group", ownerId, all)).filter((g) => occasion.groupIds.includes(g.id));
  const roster = await gifts.list("occasionRecipient", ownerId, { ...all, occasionId: occasion.id });
  const { allocations, buckets } = await wholeLedger(gifts, ownerId);
  // Every recipient of the owner, archived ones too: the list a filter group (docket#98) is
  // resolved over, here and again in `applyGiftSync`, so a preview and its apply agree.
  const recipients = await gifts.list("recipient", ownerId, all);
  const p = previewGroupSync(occasion, groups, roster, allocations, buckets, recipients);
  return { preview: p, previewToken: previewToken(p) };
}

/** The token that names exactly one preview (a sync's or a rollover's). */
export const previewToken = (p: unknown): string => sha256(canonicalJson(p)).slice(0, 32);

const LIST_FILTERS: Record<string, readonly GiftKind[]> = {
  occasionId: ["occasionRecipient", "allocation"],
  itemId: ["purchase", "allocation"],
};

/** `GET` on a gift route: the caller's own records only. */
export async function giftRead(d: TrackerDeps, user: User, r: GiftRoute, params: URLSearchParams): Promise<ApiAnswer> {
  const gifts = d.gifts;
  if (r.kind === "collection") {
    const kind = GIFT_COLLECTIONS[r.collection];
    const filter: { includeArchived?: boolean; occasionId?: string; itemId?: string } = {};
    const archived = params.get("includeArchived");
    if (archived !== null) {
      if (archived !== "true" && archived !== "false") return invalid("`includeArchived` is true or false.");
      filter.includeArchived = archived === "true";
    }
    for (const [name, kinds] of Object.entries(LIST_FILTERS)) {
      const value = params.get(name);
      if (value === null) continue;
      if (!kinds.includes(kind)) return invalid(`\`${name}\` filters only ${kinds.map((k) => collectionOf(k)).join(" and ")}.`);
      filter[name as "occasionId" | "itemId"] = value;
    }
    return { status: 200, body: { records: (await gifts.list(kind, user.id, filter)).map((x) => shown(kind, x)) } };
  }
  if (r.kind === "record") {
    const kind = GIFT_COLLECTIONS[r.collection];
    const record = await gifts.get(kind, user.id, r.id);
    return record ? { status: 200, body: { record: shown(kind, record) } } : notFound();
  }
  if (r.kind === "sync") {
    const p = await previewOrRefusal(gifts, user.id, r.id);
    return "status" in p ? p : { status: 200, body: p };
  }
  if (r.kind === "summary") return summary(gifts, user.id, r.id);
  if (r.kind === "rollover") {
    const p = await rolloverPreview(gifts, user.id, r.id, rolloverQuery(params));
    return "status" in p ? p : { status: 200, body: p };
  }
  if (r.kind === "spend") {
    const { allocations, purchases } = await wholeLedger(gifts, user.id);
    const items = await gifts.list("item", user.id, { includeArchived: true });
    return { status: 200, body: { spend: giftSpend(purchases, allocations, items) } };
  }
  return problem(405, "method_not_allowed", "Not a read.");
}

export async function previewOrRefusal(gifts: GiftLedger, ownerId: string, id: string): Promise<ApiAnswer | { preview: GiftSyncPreview; previewToken: string }> {
  const occasion = await gifts.get("occasion", ownerId, id);
  if (!occasion) return notFound();
  if (occasion.archived) return problem(409, "archived", "That occasion is archived: it keeps the roster it had. Restore it to sync.");
  return (await preview(gifts, ownerId, id)) ?? notFound();
}

function collectionOf(kind: GiftKind): GiftCollection {
  return (Object.keys(GIFT_COLLECTIONS) as GiftCollection[]).find((c) => GIFT_COLLECTIONS[c] === kind) as GiftCollection;
}

/** `GET /gifts/occasions/<id>/summary`: who is covered, the budget, and the cost of this occasion's gifts. */
async function summary(gifts: GiftLedger, ownerId: string, id: string): Promise<ApiAnswer> {
  const occasion = await gifts.get("occasion", ownerId, id);
  if (!occasion) return notFound();
  const rows = await gifts.list("occasionRecipient", ownerId, { includeArchived: true, occasionId: occasion.id });
  const { allocations, purchases, buckets } = await wholeLedger(gifts, ownerId);
  const coverage = rows.filter((row) => !row.archived).map((row) => giftCoverage(row, buckets));
  const counts: Record<string, number> = {};
  for (const c of coverage) counts[c.status] = (counts[c.status] ?? 0) + 1;
  // Each purchase line's total split over the gifts it filled (largest remainder), keeping only
  // this occasion's: a line shared with another occasion is never counted whole twice.
  const onThis = new Set(allocations.filter((a) => a.occasionId === occasion.id).map((a) => a.id));
  const cost = new Map<string, number>();
  for (const p of purchases) {
    for (const s of purchaseShares(p, buckets, allocations).shares) {
      if (onThis.has(s.allocationId)) cost.set(p.currency, (cost.get(p.currency) ?? 0) + s.minor);
    }
  }
  return {
    status: 200,
    body: {
      occasion: shown("occasion", occasion),
      budget: occasionBudget(occasion, rows),
      coverage,
      counts,
      done: coverage.filter((c) => c.done).length,
      cost: [...cost].map(([currency, minor]) => ({ currency, minor })),
    },
  };
}

/** One create or update, as its answer. */
async function writeOne(gifts: GiftLedger, meta: GiftWriteMeta, collection: GiftCollection, id: string | null, body: Record<string, unknown>): Promise<ApiAnswer> {
  const kind = GIFT_COLLECTIONS[collection];
  try {
    if (id === null) {
      const report = kind === "allocation" ? await duplicatesFirst(gifts, meta.ownerId, body) : null;
      if (report?.warnings.some((w) => !w.accepted)) return warned(report);
      const record = await gifts.create(kind, meta, body as never);
      return { status: 201, body: { record: shown(kind, record), ...possibleOf(report) } };
    }
    const split = splitRevision(body);
    if (!split.ok) return split.answer;
    const report = kind === "allocation" ? await editDuplicatesFirst(gifts, meta.ownerId, id, split.revision, split.fields) : null;
    if (report?.warnings.some((w) => !w.accepted)) return warned(report);
    const record = await gifts.update(kind, id, meta, split.revision, split.fields as never);
    return { status: 200, body: { record: shown(kind, record), ...possibleOf(report) } };
  } catch (err) {
    return refusal(err);
  }
}

/**
 * A duplicate warning not accepted yet: nothing is written. api.ts keeps only a 2xx answer under
 * an Idempotency-Key (api-idempotency.ts `finish`), so the resend that accepts it may reuse the key.
 */
function warned(report: GiftDuplicateReport): ApiAnswer {
  return {
    status: 409,
    body: {
      error: {
        code: "possible_duplicate",
        message: "This may repeat a gift already planned or given to the same person. To give it anyway, resend with repeatOf set to the warned ids (a refusal is not kept under an Idempotency-Key, so the same key or a new one will do).",
        warnings: report.warnings,
        possible: report.possible,
      },
    },
  };
}

/** Possible duplicates (never a refusal) as they ride on a write's answer. */
const possibleOf = (report: GiftDuplicateReport | null) => (report && report.possible.length > 0 ? { duplicates: report.possible } : {});

/** The fields that make an allocation another gift: changing one asks the duplicate check again. */
const GIFT_IDENTITY = ["recipientIds", "occasionId", "itemId"] as const;

/**
 * The duplicate report for a PATCH of an allocation that changes who it is for, its occasion or its
 * item, checked as an edit (`id` given, so docket skips the allocation itself and counts a gift
 * whose own `repeatOf` names it as accepted); null when the patch changes none of them, or the
 * update would be refused anyway (gone, stale, a field docket refuses, an id not the owner's).
 */
async function editDuplicatesFirst(gifts: GiftLedger, ownerId: string, id: string, revision: number, patch: Record<string, unknown>): Promise<GiftDuplicateReport | null> {
  const current = await gifts.get("allocation", ownerId, id);
  if (!current || current.revision !== revision || current.archived || patch.archived === true) return null;
  if (!GIFT_IDENTITY.some((k) => Object.hasOwn(patch, k) && canonicalJson(patch[k]) !== canonicalJson(current[k]))) return null;
  const { id: _id, ownerId: _owner, revision: _revision, archived: _archived, createdAt: _created, updatedAt: _updated, ...fields } = current;
  const { archived: _a, ...changes } = patch;
  return duplicatesFirst(gifts, ownerId, { ...fields, ...changes }, id);
}

/**
 * docket's duplicate report for an allocation about to be made or changed (docket#100), or null
 * when the write would refuse it anyway -- a field docket refuses, or an id that is not the
 * owner's -- so it refuses as it always did (400, then 404), never with a warning first.
 */
async function duplicatesFirst(gifts: GiftLedger, ownerId: string, body: Record<string, unknown>, editing?: string): Promise<GiftDuplicateReport | null> {
  if (giftProblems("allocation", body as never).length > 0) return null;
  const a = body as unknown as GiftAllocationFields;
  const refs: [GiftKind, string][] = [
    ["item", a.itemId],
    ["occasion", a.occasionId],
    ...a.recipientIds.map((id): [GiftKind, string] => ["recipient", id]),
    ...(a.purchaseId === null ? [] : [["purchase", a.purchaseId] as [GiftKind, string]]),
    ...(a.repeatOf ?? []).map((id): [GiftKind, string] => ["allocation", id]),
  ];
  for (const [kind, id] of refs) if (!(await gifts.get(kind, ownerId, id))) return null;
  return gifts.giftDuplicates(ownerId, { itemId: a.itemId, occasionId: a.occasionId, recipientIds: a.recipientIds, repeatOf: a.repeatOf ?? null, ...(editing !== undefined ? { id: editing } : {}) });
}

const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** `POST /gifts/groups/<id>/members`: `add` and `remove` lists, at the group's `expectedRevision`. */
async function members(gifts: GiftLedger, meta: GiftWriteMeta, id: string, body: Record<string, unknown>): Promise<ApiAnswer> {
  const { add = [], remove = [], dryRun = false, ...rest } = body;
  const unknown = Object.keys(rest).filter((k) => k !== "expectedRevision");
  if (unknown.length > 0) return invalid(`Unknown field(s): ${unknown.join(", ")}. Send expectedRevision, add, remove and dryRun.`);
  if (!isIdList(add) || !isIdList(remove)) return invalid("`add` and `remove` are lists of recipient ids.");
  if (typeof dryRun !== "boolean") return invalid("`dryRun` is true or false.");
  const group = await gifts.get("group", meta.ownerId, id);
  if (!group) return notFound();
  // A filter group (docket#98) has no list to edit, so neither a dry run nor a write is tried.
  if (group.filter !== undefined && group.filter !== null) {
    return problem(409, "filter_group", "This group is a saved filter over your labels; change its labels instead.");
  }
  // Every id added is checked as the write would check it, so a preview never promises what the write refuses.
  for (const recipientId of add) if (!(await gifts.get("recipient", meta.ownerId, recipientId))) return notFound();
  const edit = editGroupMembers(group, add, remove);
  if (dryRun) return { status: 200, body: { ...edit, revision: group.revision } };
  const split = splitRevision({ expectedRevision: rest.expectedRevision });
  if (!split.ok) return split.answer;
  try {
    const record = await gifts.update("group", id, meta, split.revision, { memberIds: edit.memberIds });
    return { status: 200, body: { added: edit.added, removed: edit.removed, record: shown("group", record) } };
  } catch (err) {
    return refusal(err);
  }
}

/**
 * Each decision exactly as docket reads it, or null: `planGroupSync` takes anything that is not
 * keep or reassign as unassign, so a misspelt action must be refused here, never planned.
 */
function decisionsOf(v: unknown): Record<string, GiftSyncDecision> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  // No prototype: a "__proto__" key is an entry like any other (and then refused by docket as no affected gift).
  const out: Record<string, GiftSyncDecision> = Object.create(null);
  for (const [id, d] of Object.entries(v)) {
    if (typeof d !== "object" || d === null || Array.isArray(d)) return null;
    const { action, recipientIds, ...rest } = d as Record<string, unknown>;
    if (Object.keys(rest).length > 0) return null;
    if ((action === "keep" || action === "unassign") && recipientIds === undefined) out[id] = { action };
    else if (action === "reassign" && isIdList(recipientIds)) out[id] = { action, recipientIds };
    else return null;
  }
  return out;
}

/** `POST /gifts/occasions/<id>/sync` (and the web page's sync review, gifts-web.ts): applies the preview the owner reviewed, named by its token, with their decisions. */
export async function sync(gifts: GiftLedger, meta: GiftWriteMeta, id: string, body: Record<string, unknown>): Promise<ApiAnswer> {
  const { previewToken, decisions = {}, ...rest } = body;
  if (Object.keys(rest).length > 0) return invalid(`Unknown field(s): ${Object.keys(rest).join(", ")}. Send previewToken and decisions.`);
  if (typeof previewToken !== "string") return invalid("`previewToken` is the token the sync preview gave.");
  const chosen = decisionsOf(decisions);
  if (!chosen) return invalid('`decisions` maps each affected allocation id to {"action": "keep"}, {"action": "unassign"} or {"action": "reassign", "recipientIds": [...]}.');
  const now = await previewOrRefusal(gifts, meta.ownerId, id);
  if ("status" in now) return now;
  // The roster, the groups or a gift moved since the preview: the owner reviews again.
  if (now.previewToken !== previewToken) return problem(409, "stale_preview", "The occasion, its groups or its gifts changed since that preview; preview again.");
  let plan: ReturnType<typeof planGroupSync>;
  try {
    plan = planGroupSync(now.preview, chosen);
  } catch (err) {
    return refusal(err); // nothing planned, nothing written
  }
  try {
    await gifts.applyGiftSync(meta, plan);
  } catch (err) {
    // docket writes a sync step by step: a refusal part way leaves the steps before it made.
    const answer = refusal(err);
    const e = (answer.body as { error: { message: string } }).error;
    e.message += " Earlier steps of this sync may have been made; preview again before deciding.";
    return answer;
  }
  const occasion = await gifts.get("occasion", meta.ownerId, id);
  const roster = await gifts.list("occasionRecipient", meta.ownerId, { occasionId: id });
  return { status: 200, body: { occasion: occasion && shown("occasion", occasion), roster: roster.map((x) => shown("occasionRecipient", x)) } };
}

/** `POST /gifts/batch`: each row its own write, in order, each with its own outcome. */
async function batch(gifts: GiftLedger, meta: GiftWriteMeta, body: Record<string, unknown>, warn: (text: string) => void): Promise<ApiAnswer> {
  const { writes, ...rest } = body;
  if (Object.keys(rest).length > 0) return invalid(`Unknown field(s): ${Object.keys(rest).join(", ")}. Send writes.`);
  if (!Array.isArray(writes) || writes.length === 0 || writes.length > MAX_GIFT_BATCH) return invalid(`\`writes\` is a list of 1 to ${MAX_GIFT_BATCH} writes.`);
  const results: { index: number; status: number; body: unknown }[] = [];
  for (const [index, row] of writes.entries()) {
    let answer: ApiAnswer;
    try {
      answer = await batchRow(gifts, meta, row);
    } catch (err) {
      warn(`api: gift batch row ${index} for ${meta.ownerId} failed: ${err instanceof Error ? err.message : String(err)}`);
      // Not a ledger refusal (those are answers already): this row's outcome is unknown, and the rows after it still run.
      answer = problem(500, "internal", "This write failed unexpectedly; it may or may not have been made. Read the record before trying again.");
    }
    results.push({ index, status: answer.status, body: answer.body });
  }
  return { status: 200, body: { results } };
}

async function batchRow(gifts: GiftLedger, meta: GiftWriteMeta, row: unknown): Promise<ApiAnswer> {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return invalid("A write is an object.");
  const { op, collection, id, expectedRevision, fields, ...rest } = row as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return invalid(`Unknown field(s): ${Object.keys(rest).join(", ")}.`);
  if (typeof collection !== "string" || !isCollection(collection)) return invalid(`\`collection\` is one of ${Object.keys(GIFT_COLLECTIONS).join(", ")}.`);
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return invalid("`fields` is an object.");
  if (op === "create") {
    if (id !== undefined || expectedRevision !== undefined) return invalid("A create takes no `id` or `expectedRevision`.");
    return writeOne(gifts, meta, collection, null, fields as Record<string, unknown>);
  }
  if (op === "update") {
    if (typeof id !== "string") return invalid("An update names the record's `id`.");
    return writeOne(gifts, meta, collection, id, { ...(fields as Record<string, unknown>), expectedRevision });
  }
  return invalid("`op` is create or update.");
}

/**
 * A write on a gift route, in the write queue, as the caller's own records. The caller's account
 * is read again in the queue: one forgotten while the request waited writes nothing.
 */
export function giftWrite(w: Writer, user: User, r: GiftRoute, body: Record<string, unknown>): Promise<ApiAnswer> {
  return w.queue(async () => {
    if (!(await w.d.store.getUser(user.id))) return problem(403, "not_registered", NO_LONGER_LISTED);
    const gifts = w.d.gifts;
    const meta: GiftWriteMeta = { ownerId: user.id, actor: user.id, source: "api", at: w.d.clock.now().toISOString() };
    switch (r.kind) {
      case "collection":
        return writeOne(gifts, meta, r.collection, null, body);
      case "record":
        return writeOne(gifts, meta, r.collection, r.id, body);
      case "members":
        return members(gifts, meta, r.id, body);
      case "sync":
        return sync(gifts, meta, r.id, body);
      case "rollover":
        return rollover(gifts, meta, r.id, body);
      case "batch":
        return batch(gifts, meta, body, (text) => w.d.log.warn(text));
      default:
        return problem(405, "method_not_allowed", "Not a write.");
    }
  });
}
