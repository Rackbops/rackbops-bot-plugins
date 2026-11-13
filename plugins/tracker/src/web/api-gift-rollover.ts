import { type GiftLedger, type GiftRolloverPreview, type GiftWriteMeta, previewGiftRollover } from "@rackbops/docket-core";
import { invalid, notFound, previewToken, refusal, shown } from "./api-gifts.js";
import type { ApiAnswer } from "./api-tasks.js";
import { problem } from "./api-tasks.js";

/**
 * "Set up next year" (docket#99) in the task API and on the web page (gift-rollover-web.ts):
 * `GET /gifts/occasions/<id>/rollover` shows what docket's `previewGiftRollover` would make, with a
 * `previewToken` naming exactly that preview; `POST` makes it with `GiftLedger.applyGiftRollover`,
 * only when the token still names the preview made now from the same choices. The old occasion is
 * never written. A retry with the same `Idempotency-Key` is answered from api.ts's store of
 * answers, as every gift write is.
 */

/** The owner's choices for the new occasion; each left out takes docket's default. */
export interface RolloverChoices {
  /** The new date, or null for none; default a year after the old one. */
  date?: string | null;
  /** The new title; default the old one with its year moved on. */
  title?: string;
  /** The new shop-by day, or null for none; default as docket carries it. */
  deadline?: string | null;
  /** The old occasion's unbought gifts to carry, by allocation id; default none. */
  ideaIds?: string[];
}

/** The choices a `GET` names: `date`, `title`, `deadline` (blank for none) and `ideaIds` (a comma list). */
export function rolloverQuery(params: URLSearchParams): RolloverChoices {
  const c: RolloverChoices = {};
  const date = params.get("date");
  if (date !== null) c.date = date.trim() === "" ? null : date.trim();
  const title = params.get("title");
  if (title !== null) c.title = title;
  const deadline = params.get("deadline");
  if (deadline !== null) c.deadline = deadline.trim() === "" ? null : deadline.trim();
  const ideas = params.get("ideaIds");
  if (ideas !== null) c.ideaIds = ideas.split(",").map((x) => x.trim()).filter((x) => x !== "");
  return c;
}

/** The rollover preview of one of the owner's occasions with its token; 404 for no such occasion, 400 for a choice docket refuses. */
export async function rolloverPreview(gifts: GiftLedger, ownerId: string, id: string, c: RolloverChoices): Promise<ApiAnswer | { preview: GiftRolloverPreview; previewToken: string }> {
  const occasion = await gifts.get("occasion", ownerId, id);
  if (!occasion) return notFound();
  const all = { includeArchived: true };
  try {
    const p = previewGiftRollover({
      occasion,
      groups: (await gifts.list("group", ownerId, all)).filter((g) => occasion.groupIds.includes(g.id)),
      recipients: await gifts.list("recipient", ownerId, all),
      roster: await gifts.list("occasionRecipient", ownerId, { ...all, occasionId: occasion.id }),
      allocations: await gifts.list("allocation", ownerId, { ...all, occasionId: occasion.id }),
      ...(c.ideaIds !== undefined ? { pick: c.ideaIds } : {}),
      ...(c.title !== undefined ? { title: c.title } : {}),
      ...(c.date !== undefined ? { date: c.date } : {}),
      ...(c.deadline !== undefined ? { deadline: c.deadline } : {}),
    });
    return { preview: p, previewToken: previewToken(p) };
  } catch (err) {
    return refusal(err);
  }
}

const isDateOrNull = (v: unknown) => v === undefined || v === null || typeof v === "string";

/**
 * `POST /gifts/occasions/<id>/rollover` (and the web page's confirm): makes the rollover the owner
 * reviewed, named by its token, previewed again now from the same choices. 201 with the new
 * occasion and its roster.
 */
export async function rollover(gifts: GiftLedger, meta: GiftWriteMeta, id: string, body: Record<string, unknown>): Promise<ApiAnswer> {
  const { previewToken: token, date, title, deadline, ideaIds, ...rest } = body;
  if (Object.keys(rest).length > 0) return invalid(`Unknown field(s): ${Object.keys(rest).join(", ")}. Send previewToken, and date, title, deadline and ideaIds as the preview had them.`);
  if (typeof token !== "string") return invalid("`previewToken` is the token the rollover preview gave.");
  if (!isDateOrNull(date) || !isDateOrNull(deadline)) return invalid("`date` and `deadline` are YYYY-MM-DD or null.");
  if (title !== undefined && typeof title !== "string") return invalid("`title` is text.");
  if (ideaIds !== undefined && !(Array.isArray(ideaIds) && ideaIds.every((x) => typeof x === "string"))) return invalid("`ideaIds` is a list of allocation ids.");
  const c: RolloverChoices = {
    ...(date !== undefined ? { date: date as string | null } : {}),
    ...(title !== undefined ? { title: title as string } : {}),
    ...(deadline !== undefined ? { deadline: deadline as string | null } : {}),
    ...(ideaIds !== undefined ? { ideaIds: ideaIds as string[] } : {}),
  };
  const now = await rolloverPreview(gifts, meta.ownerId, id, c);
  if ("status" in now) return now;
  // The occasion, its groups, its people or its gifts moved since the preview: the owner reviews again.
  if (now.previewToken !== token) return problem(409, "stale_preview", "The occasion, its groups, people or gifts changed since that preview; preview again.");
  try {
    const made = await gifts.applyGiftRollover(meta, now.preview);
    const roster = await gifts.list("occasionRecipient", meta.ownerId, { occasionId: made.id });
    return { status: 201, body: { occasion: shown("occasion", made), roster: roster.map((x) => shown("occasionRecipient", x)) } };
  } catch (err) {
    // docket writes a rollover step by step: a refusal part way leaves the steps before it made.
    const answer = refusal(err);
    const e = (answer.body as { error: { message: string } }).error;
    e.message += " Earlier steps of this rollover may have been made; look for the new occasion before trying again.";
    return answer;
  }
}
