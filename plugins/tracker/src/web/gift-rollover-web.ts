import type { GiftWriteMeta } from "@rackbops/docket-core";
import { NO_LONGER_LISTED } from "../actions.js";
import { type RolloverChoices, rollover, rolloverPreview } from "./api-gift-rollover.js";
import type { Editor } from "./editor.js";
import { loadLedger } from "./gift-overview.js";
import { rolloverPage } from "./gift-pages.js";
import { htmlResponse, redirect } from "./html.js";
import { errorPage, notFoundPage } from "./pages.js";

/**
 * The "Roll over to next year" review (docket#99) on the family gift pages: the preview with the
 * old occasion's unbought gifts to pick, and a confirm that makes exactly the preview shown,
 * through the task API's own code path (api-gift-rollover.ts `rollover`), in the web's one write
 * queue with the person read again inside it.
 */

async function view(e: Editor, id: string, c: RolloverChoices, error?: string, status = 200): Promise<Response> {
  const gifts = e.d.gifts;
  const occasion = await gifts.get("occasion", e.v.user.id, id);
  if (!occasion) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  const p = await rolloverPreview(gifts, e.v.user.id, id, c);
  if ("status" in p) {
    if (p.status === 404) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
    // A pick docket refuses (bought since, nobody left on the roster): say why, and offer the plain preview.
    if (c.ideaIds && c.ideaIds.length > 0) return view(e, id, {}, (p.body as { error: { message: string } }).error.message, p.status);
    return htmlResponse(errorPage(e.v.base, "Cannot roll over", (p.body as { error: { message: string } }).error.message), p.status);
  }
  const l = await loadLedger(gifts, e.v.user.id);
  const name = (rid: string) => l.recipients.find((r) => r.id === rid)?.displayName ?? rid;
  const title = (aid: string) => {
    const a = l.allocations.find((x) => x.id === aid);
    const item = l.items.find((i) => i.id === a?.itemId)?.title ?? aid;
    return a ? `${item} for ${a.recipientIds.map(name).join(", ")}` : item;
  };
  return htmlResponse(rolloverPage(e.v, occasion, p.preview, p.previewToken, name, title, error), status);
}

/** `GET /gifts/occasions/<id>/rollover`: the preview with nothing picked. */
export function rolloverGet(e: Editor, id: string): Promise<Response> {
  return view(e, id, {});
}

/** `POST /gifts/occasions/<id>/rollover`: "Update the preview" with the picks, or "Set it up" for the preview the page showed. */
export async function rolloverPost(e: Editor, id: string, f: URLSearchParams): Promise<Response> {
  const c: RolloverChoices = { ideaIds: f.getAll("idea") };
  if (f.get("step") !== "confirm") return view(e, id, c);
  const answer = await e.queue(async () => {
    if (!(await e.d.store.getUser(e.v.user.id))) return null;
    const meta: GiftWriteMeta = { ownerId: e.v.user.id, actor: e.v.user.id, source: "web", at: e.d.clock.now().toISOString() };
    return rollover(e.d.gifts, meta, id, { previewToken: f.get("token") ?? "", ...c });
  });
  if (answer === null) return htmlResponse(errorPage(e.v.base, "Not saved", NO_LONGER_LISTED), 403);
  if (answer.status === 201) {
    const made = (answer.body as { occasion: { id: string } }).occasion.id;
    return redirect(`${e.v.base}/gifts?${new URLSearchParams({ occasion: made, done: "rolled" }).toString()}`);
  }
  if (answer.status === 404) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  // The posted token names another preview -- most often the picks were ticked without "Update the
  // preview": nothing was written, so the review is shown again with those picks and a fresh token.
  if ((answer.body as { error: { code: string } }).error.code === "stale_preview") return view(e, id, c, "Check the preview with your picks, then press Set it up again.", 409);
  return view(e, id, c, (answer.body as { error: { message: string } }).error.message, answer.status);
}
