import type { GiftKind } from "@rackbops/docket-core";

/**
 * The gift routes' names and limits (rackbops-bot-plugins#383), apart from api-gifts.ts so that
 * api-tasks.ts's capabilities answer reads them without the two modules importing each other.
 */

/** The record kind each collection holds, by its path name. */
export const GIFT_COLLECTIONS = {
  recipients: "recipient",
  groups: "group",
  occasions: "occasion",
  "occasion-recipients": "occasionRecipient",
  items: "item",
  purchases: "purchase",
  allocations: "allocation",
} as const satisfies Record<string, GiftKind>;
export type GiftCollection = keyof typeof GIFT_COLLECTIONS;

/** Rows in one `POST /gifts/batch`. */
export const MAX_GIFT_BATCH = 25;
/** A batch's body: `MAX_GIFT_BATCH` records' fields, each up to docket's notes length. */
export const MAX_GIFT_BATCH_BYTES = 128 * 1024;
