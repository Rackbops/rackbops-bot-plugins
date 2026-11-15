import type { GiftItem, GiftWriteMeta, Task } from "@rackbops/docket-core";
import { NO_LONGER_LISTED } from "../actions.js";
import { GIFT_IDEA_TYPES } from "../gift-scout.js";
import { watches } from "./api-gift-links.js";
import type { Editor } from "./editor.js";
import { alerts, checks, csrfField, money } from "./gift-pages.js";
import { html, htmlResponse, redirect } from "./html.js";
import { errorPage, framed, notFoundPage, type Viewer } from "./pages.js";

/**
 * A gift item's own page (docket#101): what it is, "From scout: <task>" for one saved from a scout
 * or news finding, the watches it follows (each linked to its task page) and the form that picks
 * them from the person's own price and want-list watches, posted through the task API's own code
 * (api-gift-links.ts `watches`, docket's `linkGiftWatches`) in the web's one write queue. Only the
 * item is written, never a task.
 */

const WATCH_TYPES = new Set(["price", "wantlist"]);
const taskHref = (v: Viewer, id: string) => `${v.base}/tasks/${encodeURIComponent(id)}`;

export interface ItemView {
  item: GiftItem;
  /** The scout or news task the item was saved from, when it is still the person's. */
  from: { taskId: string; title: string | null } | null;
  /** The person's watches it may follow (live ones, and any it follows already). */
  choices: Task[];
}

export function itemPage(v: Viewer, x: ItemView, s: { error?: string; problems?: string[]; notice?: string } = {}): string {
  const { item } = x;
  const linked = item.watchTaskIds ?? [];
  const title = (id: string) => x.choices.find((t) => t.id === id)?.title ?? id;
  return framed(
    v,
    item.title || "Gift",
    html`<section>
<p><a class="rb-link" href="${v.base}/gifts">Gifts</a></p>
<h1>${item.title || "(no title yet)"}${item.archived ? html` <span class="rb-badge">archived</span>` : null}</h1>
${alerts(s)}
<p>${item.planning === "idea" ? "An idea" : item.planning}${item.estimateMinor !== null && item.currency ? `, about ${money(item.estimateMinor, item.currency)}` : ""}.</p>
${item.url && /^https?:\/\//i.test(item.url) ? html`<p><a class="rb-link" href="${item.url}" rel="noopener noreferrer">${item.url}</a></p>` : null}
${item.notes ? html`<p class="rb-muted">${item.notes}</p>` : null}
${x.from ? html`<p>From scout: ${x.from.title === null ? html`a finding of a task that is gone` : html`<a class="rb-link" href="${taskHref(v, x.from.taskId)}">${x.from.title}</a>`}</p>` : null}
<h2>Watches it follows</h2>
${linked.length === 0 ? html`<p class="rb-muted">None.</p>` : html`<ul>${linked.map((id) => html`<li><a class="rb-link" href="${taskHref(v, id)}">${title(id)}</a></li>`)}</ul>`}
<form method="post" action="${v.base}/gifts/items/${encodeURIComponent(item.id)}" class="tr-stack">
${csrfField(v)}
<input type="hidden" name="revision" value="${String(item.revision)}">
${checks("watch", "Your price and want-list watches", x.choices.map((t) => [t.id, t.title] as const), linked)}
<p class="rb-muted">Linking a watch never changes it: it only shows here.</p>
<div><button class="rb-btn rb-btn--primary" type="submit">Save watches</button></div>
</form>
</section>`,
  );
}

async function view(e: Editor, id: string, s: { error?: string; problems?: string[]; notice?: string } = {}, status = 200): Promise<Response> {
  const item = await e.d.gifts.get("item", e.v.user.id, id);
  if (!item) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  const tasks = await e.d.store.listTasks({ ownerId: e.v.user.id });
  let from: ItemView["from"] = null;
  if (item.source.kind === "scout" && item.source.ref) {
    const taskId = item.source.ref.split("/")[0] ?? "";
    const task = tasks.find((t) => t.id === taskId && GIFT_IDEA_TYPES.has(t.type));
    from = { taskId, title: task && task.status !== "archived" ? task.title : null };
  }
  const linked = item.watchTaskIds ?? [];
  const choices = tasks.filter((t) => WATCH_TYPES.has(t.type) && (t.status !== "archived" || linked.includes(t.id)));
  return htmlResponse(itemPage(e.v, { item, from, choices }, s), status);
}

/** `GET /gifts/items/<id>`. */
export function itemGet(e: Editor, id: string, params: URLSearchParams): Promise<Response> {
  return view(e, id, params.get("done") === "watches" ? { notice: "Watches saved." } : {});
}

/** `POST /gifts/items/<id>`: the watches picked, at the revision the page showed. */
export async function itemPost(e: Editor, id: string, f: URLSearchParams): Promise<Response> {
  const answer = await e.queue(async () => {
    if (!(await e.d.store.getUser(e.v.user.id))) return null;
    const meta: GiftWriteMeta = { ownerId: e.v.user.id, actor: e.v.user.id, source: "web", at: e.d.clock.now().toISOString() };
    return watches(e.d, meta, id, { expectedRevision: Number(f.get("revision") ?? ""), watchTaskIds: f.getAll("watch") });
  });
  if (answer === null) return htmlResponse(errorPage(e.v.base, "Not saved", NO_LONGER_LISTED), 403);
  if (answer.status === 200) return redirect(`${e.v.base}/gifts/items/${encodeURIComponent(id)}?done=watches`);
  if (answer.status === 404) return htmlResponse(notFoundPage(e.v.base, e.v), 404);
  const err = (answer.body as { error: { code: string; message: string; problems?: string[] } }).error;
  const message = err.code === "revision_conflict" ? "It changed while you were editing. Pick again and save." : err.message;
  return view(e, id, { error: message, ...(err.problems ? { problems: err.problems } : {}) }, answer.status);
}
