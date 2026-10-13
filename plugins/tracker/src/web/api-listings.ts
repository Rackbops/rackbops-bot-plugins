import type { User } from "@rackbops/docket-core";
import { BGG_HOST, isEbayHost, type Listing } from "@rackbops/docket-types";
import { acceptListing, type InboxSite, MAX_LISTINGS_PER_POST } from "../inbox.js";
import { ownLiveTask } from "../manage.js";
import { WANT_TYPES, type WatchConfig, watchSite } from "../want.js";
import { type ApiAnswer, NOT_FOUND_MESSAGE, problem } from "./api-tasks.js";
import type { Writer } from "./editor.js";

/**
 * The task API's listings route (tracker 0.19.0): `POST /tasks/<id>/listings`, how listings reach an
 * inbox watch (want.ts, inbox.ts). An inbox watch never opens eBay or BoardGameGeek (Rod, 2026-10-05):
 * the owner's own browser does -- Claude in Chrome searching eBay or BGG for the watch's `search`
 * words (`GET /tasks` shows them, with its top price) -- and posts what it found here. The next poll
 * of the watch reads them and DMs the new ones, as any watch DMs.
 *
 * The body is `{"listings": [{title, url, price?, currency?, condition?, seller?}, ...]}`, at most
 * `MAX_LISTINGS_PER_POST` of them. Each is checked by docket-types' own `submittedListing`
 * (inbox.ts's `acceptListing`): the valid ones are kept and the rest only counted, so one odd card
 * on a results page does not cost the others; a body with none valid is a 400. `price` may be a
 * number or text such as "$12.50"; `url` must be an absolute http(s) address on the watch's own
 * site -- eBay's for an eBay watch, boardgamegeek.com for a BGG one -- since the agent posting them
 * reads untrusted pages, and the watch's DM links each listing to its owner (#229).
 *
 * Only the token owner's own live watch (active or paused) whose source is an inbox: anyone else's,
 * an unknown id, or a deleted or finished one answers the API's same 404; a page or BGG-API watch
 * is a 409, since its listings are read, not sent. Written in the surface's one queue, against the
 * task as the store has it then.
 */

/** Whether a listing's address (already absolute http(s), `acceptListing`) is on the inbox watch's own site. */
export function onWatchSite(site: InboxSite | null, url: string): boolean {
  const host = new URL(url).hostname.replace(/\.$/, "").toLowerCase();
  if (site === "ebay") return isEbayHost(host);
  if (site === "bgg") return host === BGG_HOST || host.endsWith(`.${BGG_HOST}`);
  return true;
}

/** The listings route's answer to a body `body` for task `id`. */
export async function listingsAnswer(w: Writer, user: User, id: string, body: Record<string, unknown>): Promise<ApiAnswer> {
  const extra = Object.keys(body).find((k) => k !== "listings");
  if (extra !== undefined) return problem(400, "unknown_field", `\`${extra.slice(0, 40)}\` is not a field here: send {"listings": [...]}.`);
  const raw = body.listings;
  if (!Array.isArray(raw)) return problem(400, "invalid", '`listings` must be an array of listings: {"title", "url", "price", "currency", "condition", "seller"}.');
  if (raw.length === 0) return problem(400, "invalid", "`listings` is empty.");
  if (raw.length > MAX_LISTINGS_PER_POST) return problem(400, "too_many", `At most ${MAX_LISTINGS_PER_POST} listings a request; send the rest in another.`);
  const accepted: Listing[] = [];
  for (const item of raw) {
    const l = acceptListing(item);
    if (l) accepted.push(l);
  }
  if (accepted.length === 0) {
    return problem(400, "invalid", "None of those listings could be used: each needs a `title` and an absolute http(s) `url`.");
  }
  return w.queue(async (): Promise<ApiAnswer> => {
    const inbox = w.d.inbox;
    const task = await ownLiveTask(w.d, user, id);
    if (!task || !WANT_TYPES.has(task.type) || (task.status !== "active" && task.status !== "paused")) {
      return problem(404, "not_found", NOT_FOUND_MESSAGE);
    }
    const config = task.config as WatchConfig;
    if (config.source !== "inbox") {
      return problem(409, "conflict", "That watch reads its listings itself, from a page or BoardGameGeek: listings are sent in only to an eBay watch (or a BGG one made without BGG access).");
    }
    if (!inbox) return problem(503, "unavailable", "This bot cannot take listings just now; try again later.");
    // Only the watch's own site: its DMs link each listing, so an address elsewhere is never passed on (#229).
    const site = watchSite(config);
    const on = site === "ebay" ? " on eBay" : site === "bgg" ? " on BoardGameGeek" : "";
    const onSite = accepted.filter((l) => onWatchSite(site, l.url));
    if (onSite.length === 0) return problem(400, "invalid", `None of those listings could be used: each needs a \`title\` and an absolute http(s) \`url\`${on}.`);
    const left = raw.length - onSite.length;
    const stored = inbox.add(task.id, config.target, onSite, w.d.clock.now());
    const from = site === "ebay" ? " from eBay" : site === "bgg" ? " from BoardGameGeek" : "";
    const skipped = left > 0 ? ` ${left === 1 ? "1 was" : `${left} were`} left out: each needs a title and an absolute http(s) address${on}.` : "";
    const when = task.status === "paused" ? "The watch is paused: I read them once it is resumed." : "I read them at the watch's next look and DM you the new ones within your limits.";
    return {
      status: 200,
      body: {
        accepted: stored,
        rejected: left,
        message: `Took ${stored === 1 ? "1 listing" : `${stored} listings`}${from} for ${task.title}.${skipped} ${when}`,
      },
    };
  });
}
