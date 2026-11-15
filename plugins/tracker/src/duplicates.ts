import type { Task, User } from "@rackbops/docket-core";
import { nobleKnightProduct, parseBggThingId } from "@rackbops/docket-types";
import type { TrackerDeps } from "./actions.js";
import { WANT_TYPES, type WatchConfig, watchPlaces, watchSite } from "./want.js";

/**
 * A new task that repeats one the person already has (Rackbops/rackbops-bot-plugins#390). On
 * 2026-11-11 a setup prompt run a second time through the task API made six exact copies of
 * existing watches, and each copy's first run DMed every current listing again.
 *
 * A match is one of the person's own active or paused tasks of the same kind looking for the same
 * thing:
 *
 * - a want-list watch (plain or judged, both count) with the same source and the same search: an
 *   eBay or Shopify search's words, a BGG game's id, a page's address; an eBay or BGG watch on the
 *   inbox route counts as that site, compared by its words; a watch of several places matches
 *   when any one of its places matches any one of the new watch's;
 * - a news watch with the same subject;
 * - a price with the same page.
 *
 * Done and archived (deleted) tasks never count.
 *
 * Words are compared trimmed, lower-cased and with runs of space as one. A person may want two
 * watches on purpose (a plain one beside a judged one), so this is a warning the caller acts on, never
 * a rule of the type: the task API refuses a create that matches unless it says `allowDuplicate`.
 * It is read outside the write queue, as the caps' validate is: advice, not a reservation.
 */
export interface Duplicate {
  id: string;
  title: string;
  status: string;
  type: string;
}

/** What a task looks for, as one comparable key; null for a kind this does not compare. */
type Key = string | null;

function words(s: unknown): string {
  return typeof s === "string" ? s.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

/**
 * A want-list search as `<site>:<what>` for each place a create names: one, or several (0.61.0),
 * each with its own `target_<source>`; one place takes `target` too, as want.ts reads them.
 */
function wantKeysFromFields(form: URLSearchParams): Key[] {
  const named = form.getAll("source").join(",").split(",").map(words).filter((x) => x !== "");
  const sources = named.length > 0 ? [...new Set(named)] : ["page"];
  const several = sources.length > 1;
  return sources.map((source) => {
    const own = (form.get(`target_${source}`) ?? "").trim();
    return placeKeyFromFields(source, several ? own : own || (form.get("target") ?? "").trim(), form.get("name"));
  });
}

/** One place's key, from its source, its target and the watch's name. */
function placeKeyFromFields(source: string, target: string, name: string | null): Key {
  if (source === "ebay" || source === "shopify") {
    const w = words(target || name);
    return w ? `${source}:${w}` : null;
  }
  if (source === "bgg") {
    if (!target) {
      const w = words(name);
      return w ? `bgg-words:${w}` : null;
    }
    // A BGG inbox watch named by words in `target` keeps them as its `search` (want.ts).
    const id = parseBggThingId(target);
    return id === null ? `bgg-words:${words(target)}` : `bgg:${id}`;
  }
  if (source === "page") return target ? `page:${target}` : null;
  if (source === "nobleknight") {
    const product = nobleKnightProduct(target);
    return product ? `nobleknight:${product.id}` : null;
  }
  return null;
}

/** The same key for a stored watch. */
function wantKeyFromConfig(c: WatchConfig): Key {
  const site = watchSite(c);
  if (site === "ebay") return c.search ? `ebay:${words(c.search)}` : null;
  if (site === "bgg") return c.game ? `bgg:${c.game}` : c.search ? `bgg-words:${words(c.search)}` : null;
  if (c.source === "ebay" || c.source === "shopify") return `${c.source}:${words(c.target)}`;
  if (c.source === "bgg") return `bgg:${c.target}`;
  if (c.source === "page") return `page:${String(c.target).trim()}`;
  if (c.source === "nobleknight") {
    const product = nobleKnightProduct(String(c.target));
    return product ? `nobleknight:${product.id}` : null;
  }
  return null;
}

function keysFromFields(type: string, form: URLSearchParams): Key[] {
  return type === "wantlist" ? wantKeysFromFields(form) : [keyFromFields(type, form)];
}

function keysFromTask(task: Task): Key[] {
  if (WANT_TYPES.has(task.type)) return watchPlaces(task.config as WatchConfig).map(wantKeyFromConfig);
  return [keyFromTask(task)];
}

function keyFromFields(type: string, form: URLSearchParams): Key {
  if (type === "news") {
    const w = words(form.get("subject"));
    return w ? `news:${w}` : null;
  }
  if (type === "price") {
    const url = (form.get("url") ?? "").trim();
    return url ? `price:${url}` : null;
  }
  return null;
}

function keyFromTask(task: Task): Key {
  const c = task.config as Record<string, unknown>;
  if (WANT_TYPES.has(task.type)) return wantKeyFromConfig(c as unknown as WatchConfig);
  if (task.type === "news") {
    const w = words(c.subject);
    return w ? `news:${w}` : null;
  }
  if (task.type === "price") return typeof c.url === "string" ? `price:${c.url.trim()}` : null;
  return null;
}

/** The types a new task of `type` is compared with. */
function family(type: string): string[] {
  return type === "wantlist" ? [...WANT_TYPES] : [type];
}

/** The person's live tasks that look for what a create with these fields would look for. */
export async function findDuplicates(d: Pick<TrackerDeps, "store">, user: User, type: string, form: URLSearchParams): Promise<Duplicate[]> {
  const keys = new Set(keysFromFields(type, form).filter((k): k is string => k !== null));
  if (keys.size === 0) return [];
  const found: Duplicate[] = [];
  for (const t of family(type)) {
    for (const status of ["active", "paused"] as const) {
      for (const task of await d.store.listTasks({ ownerId: user.id, status, type: t })) {
        // A watch of several places repeats another when any one place does.
        if (keysFromTask(task).some((k) => k !== null && keys.has(k))) found.push({ id: task.id, title: task.title, status: task.status, type: task.type });
      }
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

/** The duplicates in one sentence: "You already have t16 "Arkham Drowned City" (wantlist, active)." */
export function duplicatesSentence(found: readonly Duplicate[]): string {
  const each = found.map((f) => `${f.id} "${f.title}" (${f.type}, ${f.status})`).join(", ");
  return `You already have ${found.length === 1 ? "a task" : "tasks"} looking for the same thing: ${each}.`;
}
