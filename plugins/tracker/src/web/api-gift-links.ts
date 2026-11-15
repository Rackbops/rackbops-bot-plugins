import type { GiftWriteMeta, User } from "@rackbops/docket-core";
import type { TrackerDeps } from "../actions.js";
import { saveFindingIdea } from "../gift-scout.js";
import { invalid, notFound, refusal, shown } from "./api-gifts.js";
import type { ApiAnswer } from "./api-tasks.js";

/**
 * The gift ledger joined to the scout (docket#101) in the task API, each in the write queue as the
 * caller (api-gifts.ts `giftWrite`):
 *
 * - `POST /gifts/finding-ideas` `{taskId, findingId, title?}`: one of the caller's findings (the
 *   `id` the task's `findings` show) saved as a gift idea (gift-scout.ts `saveFindingIdea`): 201
 *   with the item; 409 `already_saved` when a live item is already linked to it; 404 for a task or
 *   finding not the caller's. `title` names the gift, which an eBay finding needs (docket copies
 *   nothing of an eBay listing). The task and its findings are never written.
 * - `POST /gifts/items/<id>/watches` `{expectedRevision, watchTaskIds}`: the price and want-list
 *   watches the item follows, checked against the caller's own tasks by docket's `linkGiftWatches`
 *   (400 `invalid` for any other id or type), at the revision the caller read (409 when stale).
 *   Only the item is written, never a task. docket's record validation does not check
 *   `watchTaskIds` (the gift store cannot see tasks), so a create, PATCH or batch row of an item
 *   that names it is refused (api-gifts.ts `writeOne`): this call is the one way to set it.
 */

const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export async function findingIdea(d: TrackerDeps, user: User, body: Record<string, unknown>): Promise<ApiAnswer> {
  const { taskId, findingId, title, ...rest } = body;
  if (Object.keys(rest).length > 0) return invalid(`Unknown field(s): ${Object.keys(rest).join(", ")}. Send taskId, findingId and, for an eBay finding, title.`);
  if (typeof taskId !== "string" || typeof findingId !== "string") return invalid("`taskId` and `findingId` name one of your findings, as the task's `findings` show it.");
  if (title !== undefined && typeof title !== "string") return invalid("`title` is text.");
  const saved = await saveFindingIdea(d, user, findingId, { source: "api", taskId, ...(title !== undefined ? { title } : {}) });
  switch (saved.kind) {
    case "saved":
      return { status: 201, body: { record: shown("item", saved.item) } };
    case "already":
      return { status: 409, body: { error: { code: "already_saved", message: "That finding is already saved as a gift idea.", itemId: saved.itemId } } };
    case "not-found":
      return notFound();
    case "refused":
      return invalid(`Refused: ${saved.problems.join("; ")}.`, saved.problems);
  }
}

export async function watches(d: TrackerDeps, meta: GiftWriteMeta, id: string, body: Record<string, unknown>): Promise<ApiAnswer> {
  const { expectedRevision, watchTaskIds, ...rest } = body;
  if (Object.keys(rest).length > 0) return invalid(`Unknown field(s): ${Object.keys(rest).join(", ")}. Send expectedRevision and watchTaskIds.`);
  if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) return invalid("`expectedRevision` is the item's `revision` as you read it.");
  if (!isIdList(watchTaskIds)) return invalid("`watchTaskIds` is a list of your price and want-list watch task ids.");
  if (!(await d.gifts.get("item", meta.ownerId, id))) return notFound();
  const tasks = await d.store.listTasks({ ownerId: meta.ownerId });
  try {
    const record = await d.gifts.linkGiftWatches(meta, id, expectedRevision as number, [...new Set(watchTaskIds)], tasks);
    return { status: 200, body: { record: shown("item", record) } };
  } catch (err) {
    return refusal(err);
  }
}
