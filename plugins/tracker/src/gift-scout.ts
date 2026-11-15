import {
  GiftNotFoundError,
  GiftValidationError,
  type GiftRecord,
  type GiftWriteMeta,
  type GiftWriteSource,
  isEbayFinding,
  type OutgoingMessage,
  type Store,
  type StoredFinding,
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

/**
 * The numbered items of a scout or news DM, in the order its text numbers them, each with the
 * address on its own `   <url>` line (docket-types' `renderScout` and `renderNews`): the run's
 * own item order, as sent. An item whose address the text lost (a DM cut to fit) is left out.
 */
export function dmItems(text: string): { n: number; url: string }[] {
  const out: { n: number; url: string }[] = [];
  let current: number | null = null;
  let url: string | null = null;
  // The item's own address is its last link-shaped line before the next head: a model-written
  // `why` or summary line above it may itself look like `<https://...>`, and must not win.
  const close = () => {
    if (current !== null && url !== null) out.push({ n: current, url });
  };
  for (const line of text.split("\n")) {
    const head = /^(\d{1,3})\. /.exec(line);
    if (head) {
      close();
      current = Number(head[1]);
      url = null;
      continue;
    }
    const link = /^ {3}<(https?:\/\/[^\s<>]+)>$/.exec(line);
    if (link && current !== null) url = link[1] as string;
  }
  close();
  return out;
}

/** Reads one task's findings by their address: the tracker's store does it in one indexed query (store.ts `findingsBySource`). */
export interface FindingsBySource {
  findingsBySource(taskId: string, ownerId: string, sources: readonly string[]): Promise<StoredFinding[]>;
}

const hasLookup = (store: Store): store is Store & FindingsBySource => typeof (store as Partial<FindingsBySource>).findingsBySource === "function";

/**
 * The buttons for `message` to `userId`, at most `room`; none when it is not the owner's DM of a
 * scout or news run, or names no item. Each DM item is matched to its finding by address -- this
 * run's finding first, else the newest of the task's (a link shown again keeps its first finding
 * row, ON CONFLICT DO NOTHING) -- and carries the DM's own number, so a button never points at
 * another item; an item with no finding, or an eBay one, gets none. Only the DM's addresses are read.
 */
export async function findingButtons(store: Store, userId: string, message: OutgoingMessage, room: number): Promise<HostButton[]> {
  const ref = message.ref;
  if (!ref?.occurrenceId || room <= 0) return [];
  const items = dmItems(message.text);
  if (items.length === 0) return [];
  const task = await store.getTask(ref.taskId);
  if (!task || task.ownerId !== userId || !GIFT_IDEA_TYPES.has(task.type)) return [];
  const sources = [...new Set(items.map((i) => i.url))];
  const found = hasLookup(store)
    ? await store.findingsBySource(task.id, userId, sources)
    : (await store.listFindings({ taskId: task.id, ownerId: userId })).filter((f) => f.source !== null && sources.includes(f.source));
  const buttons: HostButton[] = [];
  for (const { n, url } of items) {
    const same = found.filter((f) => f.source === url);
    const f = same.find((x) => x.occurrenceId === ref.occurrenceId) ?? same.at(-1);
    if (!f || isEbayFinding(f)) continue;
    buttons.push({ customId: giftIdeaButtonId(f.id), label: `${n}. Save as gift idea`, style: "secondary" });
  }
  return buttons.slice(0, room);
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
