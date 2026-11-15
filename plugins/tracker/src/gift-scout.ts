import {
  GiftNotFoundError,
  GiftValidationError,
  type GiftRecord,
  type GiftWriteMeta,
  type GiftWriteSource,
  isEbayFinding,
  type OutgoingMessage,
  type Store,
  type User,
} from "@rackbops/docket-core";
import type { HostButton } from "../../../packages/api/contract.js";
import type { TrackerDeps } from "./actions.js";
import { giftIdeaButtonId } from "./buttons.js";

/**
 * "Save as gift idea" (docket#101): one of the owner's scout or news findings made an item in the
 * `idea` state of their gift ledger, linked back to it, from a button on the run's DM, from the
 * task API (`POST /api/v1/gifts/finding-ideas`, web/api-gift-links.ts) or by nothing else. docket's
 * `GiftLedger.saveFindingAsIdea` writes only the item: the task and its findings are never touched.
 *
 * The buttons go on the owner's copy only (a recipient's press would be refused: the finding is not
 * theirs), one per finding of that run, numbered as the DM numbers its items, and never on an eBay
 * finding, which keeps nothing of the listing for a gift to start from. News findings share the
 * scout's shape (a title line and the item's address), so a news run's DM carries them too.
 */

/** The task types whose run DMs offer "Save as gift idea". */
export const GIFT_IDEA_TYPES: ReadonlySet<string> = new Set(["scout", "news"]);

/** The buttons for `message` to `userId`, at most `room`; none when it is not the owner's DM of a scout or news run. */
export async function findingButtons(store: Store, userId: string, message: OutgoingMessage, room: number): Promise<HostButton[]> {
  const ref = message.ref;
  if (!ref?.occurrenceId || room <= 0) return [];
  const task = await store.getTask(ref.taskId);
  if (!task || task.ownerId !== userId || !GIFT_IDEA_TYPES.has(task.type)) return [];
  const findings = (await store.listFindings({ taskId: task.id, ownerId: userId })).filter((f) => f.occurrenceId === ref.occurrenceId);
  return findings
    .map((f, i) => ({ f, n: i + 1 }))
    .filter(({ f }) => !isEbayFinding(f))
    .slice(0, room)
    .map(({ f, n }) => ({ customId: giftIdeaButtonId(f.id), label: `${n}. Save as gift idea`, style: "secondary" as const }));
}

export type SavedIdea =
  | { kind: "saved"; item: GiftRecord<"item"> }
  /** A live item is already linked to the finding. */
  | { kind: "already"; itemId: string }
  /** No such finding of this person's (another's reads the same). */
  | { kind: "not-found" }
  /** docket refused it: an eBay finding with no title given, for one. */
  | { kind: "refused"; problems: string[] };

/**
 * Saves finding `findingId` (of task `taskId`, when given) as a gift idea of `user`'s. Run it in the
 * one write queue: the "already saved" check and the write are then never split by another save, so
 * a double press makes one idea. `key` makes a retry of the same request replay its item.
 */
export async function saveFindingIdea(
  d: Pick<TrackerDeps, "store" | "gifts" | "clock">,
  user: User,
  findingId: string,
  o: { source: GiftWriteSource; taskId?: string; key?: string; title?: string },
): Promise<SavedIdea> {
  const finding = (await d.store.listFindings({ ownerId: user.id, ...(o.taskId !== undefined ? { taskId: o.taskId } : {}) })).find((f) => f.id === findingId);
  if (!finding) return { kind: "not-found" };
  const ref = `${finding.taskId}/${finding.id}`;
  const linked = (await d.gifts.list("item", user.id)).find((i) => i.source.kind === "scout" && i.source.ref === ref);
  if (linked) return { kind: "already", itemId: linked.id };
  const meta: GiftWriteMeta = { ownerId: user.id, actor: user.id, source: o.source, at: d.clock.now().toISOString(), ...(o.key !== undefined ? { idempotencyKey: o.key } : {}) };
  try {
    return { kind: "saved", item: await d.gifts.saveFindingAsIdea(meta, finding, o.title !== undefined ? { title: o.title } : {}) };
  } catch (err) {
    if (err instanceof GiftNotFoundError) return { kind: "not-found" };
    if (err instanceof GiftValidationError) return { kind: "refused", problems: err.problems };
    throw err;
  }
}
