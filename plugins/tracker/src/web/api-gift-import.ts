import { type GiftImportReviewed, type GiftImportStaged, type GiftLedger, type GiftWriteMeta, parseGiftImport, reviewGiftImport } from "@rackbops/docket-core";
import { invalid, previewToken, refusal } from "./api-gifts.js";
import type { ApiAnswer } from "./api-tasks.js";
import { problem } from "./api-tasks.js";

/**
 * Importing a list of gifts (docket#102) in the task API and on the web page (gift-import-web.ts):
 *
 * - `POST /gifts/import/review` `{format: "csv"|"list", text, currency?}`: docket's
 *   `parseGiftImport`, then `reviewGiftImport` against the caller's live people and occasions.
 *   Writes no gift record (with an `Idempotency-Key`, api.ts keeps its answer, as for any API answer). 200 `{staged: {unknownColumns, problems}, rows, reviewToken}`; the token names
 *   exactly this input and this review.
 * - `POST /gifts/import` `{format, text, currency?, reviewToken, approve: [rowKey...]}`: the same
 *   input parsed and reviewed again now; a token that no longer names it is 409 `stale_review` and
 *   writes nothing. Then `GiftLedger.applyGiftImport` with the approved rows only (docket reviews
 *   them once more and skips an ambiguous or invalid one, or one whose match moved). 200
 *   `{outcomes}`, one per approved row. Not atomic: each row has its own outcome.
 *
 * docket keys every write by the row's content, never by the caller's key, so importing the same
 * rows again creates nothing twice, with or without an `Idempotency-Key` (api.ts keeps the answer
 * under one, as for every gift write). `text` is at most `MAX_IMPORT_TEXT_BYTES` (200 KiB; `413` over it); docket caps the
 * rows at 500. A row's own currency wins; one with none takes `currency`, else `DEFAULT_IMPORT_CURRENCY`
 * for an occasion the import makes.
 */

/** The longest list or CSV taken, in UTF-8 bytes. */
export const MAX_IMPORT_TEXT_BYTES = 200 * 1024;
/** An import's JSON body: the text with room for escaping, and the approved keys. */
export const MAX_GIFT_IMPORT_BYTES = 640 * 1024;
/** The currency of an occasion an import makes when neither its row nor `currency` names one. */
export const DEFAULT_IMPORT_CURRENCY = "USD";

export interface ImportInput {
  format: "csv" | "list";
  text: string;
  currency?: string;
}

export interface ImportReview {
  staged: Pick<GiftImportStaged, "unknownColumns" | "problems">;
  rows: GiftImportReviewed[];
  reviewToken: string;
}

/** What a list over the cap is told, on the web page and in the API's 413 alike. */
export const TOO_LARGE = "That list is too large: import it in parts.";
const tooLarge = (): ApiAnswer => problem(413, "too_large", TOO_LARGE);

/** The input fields of a body, or the answer refusing them; `extra` are the other fields the route takes. */
export function importInput(body: Record<string, unknown>, extra: readonly string[]): ImportInput | ApiAnswer {
  const unknown = Object.keys(body).filter((k) => !["format", "text", "currency", ...extra].includes(k));
  if (unknown.length > 0) return invalid(`Unknown field(s): ${unknown.join(", ")}. Send format, text, currency${extra.map((x) => `, ${x}`).join("")}.`);
  const { format, text, currency } = body;
  if (format !== "csv" && format !== "list") return invalid('`format` is "csv" (a header row) or "list" (one gift a line).');
  if (typeof text !== "string") return invalid("`text` is the list or CSV, as text.");
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_TEXT_BYTES) return tooLarge();
  if (currency !== undefined && typeof currency !== "string") return invalid("`currency` is a currency code, such as USD.");
  return { format, text, ...(currency !== undefined && currency.trim() !== "" ? { currency: currency.trim().toUpperCase() } : {}) };
}

/** The review of `input` against the owner's people and occasions as they are now, with its token. Reads only. */
export async function reviewOf(gifts: GiftLedger, ownerId: string, input: ImportInput): Promise<ImportReview> {
  const staged = parseGiftImport(input.text, { format: input.format, source: "pasted", ...(input.currency !== undefined ? { currency: input.currency } : {}) });
  const all = { includeArchived: true };
  const rows = reviewGiftImport(staged.rows, { recipients: await gifts.list("recipient", ownerId, all), occasions: await gifts.list("occasion", ownerId, all) });
  const reviewToken = previewToken({ format: input.format, text: input.text, currency: input.currency ?? null, rows });
  return { staged: { unknownColumns: staged.unknownColumns, problems: staged.problems }, rows, reviewToken };
}

export async function importReview(gifts: GiftLedger, ownerId: string, body: Record<string, unknown>): Promise<ApiAnswer> {
  const input = importInput(body, []);
  if ("status" in input) return input;
  return { status: 200, body: await reviewOf(gifts, ownerId, input) };
}

/** Applies the approved rows of the review named by `reviewToken`; the web page's Import too. */
export async function importApply(gifts: GiftLedger, meta: GiftWriteMeta, body: Record<string, unknown>): Promise<ApiAnswer> {
  const input = importInput(body, ["reviewToken", "approve"]);
  if ("status" in input) return input;
  const { reviewToken, approve } = body;
  if (typeof reviewToken !== "string") return invalid("`reviewToken` is the token the review gave.");
  if (!Array.isArray(approve) || !approve.every((k) => typeof k === "string")) return invalid("`approve` is a list of the review's row keys.");
  const now = await reviewOf(gifts, meta.ownerId, input);
  // The input, a person or an occasion moved since the review: the owner reviews again.
  if (now.reviewToken !== reviewToken) return problem(409, "stale_review", "Your people or occasions changed since that review, or the list did; review it again.");
  if (now.staged.problems.length > 0) return invalid(`The list cannot be imported: ${now.staged.problems.join("; ")}.`, now.staged.problems);
  const keys = new Set(approve as string[]);
  const unknown = [...keys].filter((k) => !now.rows.some((r) => r.key === k));
  if (unknown.length > 0) return invalid(`No row of the review has the key(s) ${unknown.join(", ")}.`);
  try {
    const outcomes = await gifts.applyGiftImport(meta, now.rows.filter((r) => keys.has(r.key)), { currency: input.currency ?? DEFAULT_IMPORT_CURRENCY });
    return { status: 200, body: { outcomes } };
  } catch (err) {
    return refusal(err);
  }
}
