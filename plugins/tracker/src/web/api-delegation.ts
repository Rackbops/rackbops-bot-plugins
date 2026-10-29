/**
 * The task API's second credential (rackbops-bot-plugins#370, for the ChatGPT client of #368): a usr
 * delegation token, which a service such as tracker-mcp gets from usr to call the task API for one
 * person, for a few minutes, for the operations its `scope` names (usr `docs/design/tokens.md`,
 * "Delegation token"). usr mints one only for a person with a service link to that service's API
 * key covering those operations; the tracker then checks it offline (usr-identity.ts
 * `verifyDelegation`) and takes it only from the services `TRACKER_API_DELEGATES` names.
 *
 * Every route answers one operation (`OPERATIONS`), and a token must carry `<app>:<operation>` for
 * it, so one minted to list tasks cannot delete one. The names are shipped once a service asks usr
 * for them: a rename is a change on both sides.
 */

export const DELEGATES_ENV = "TRACKER_API_DELEGATES";
/** usr API key ids, as usr's admin page shows them: digits, comma-separated. */
export const DELEGATES_FORMAT = "^[0-9]+(,[0-9]+)*$";

/**
 * The acting usr keys the task API takes a delegation token from, as the token's `act.sub` names
 * them (`key:<id>`). Empty while `TRACKER_API_DELEGATES` is unset: no delegation token is taken.
 * Refuses to load when it is set without the usr link, or malformed.
 */
export function parseDelegates(env: Readonly<Record<string, string | undefined>>, usrOn: boolean): ReadonlySet<string> {
  const raw = env[DELEGATES_ENV]?.trim();
  if (raw === undefined || raw === "") return new Set();
  if (!usrOn) throw new Error(`${DELEGATES_ENV} needs TRACKER_USR_URL: delegation tokens come from usr`);
  if (!new RegExp(DELEGATES_FORMAT).test(raw)) throw new Error(`${DELEGATES_ENV} is usr API key ids separated by commas, such as 12,31`);
  return new Set(raw.split(",").map((id) => `key:${Number(id)}`));
}

/** The route shapes `operationOf` reads (api.ts's `Route`). */
export type RouteKind =
  | { kind: "me" | "types" | "tasks" | "capabilities" | "validate" }
  | { kind: "task"; id: string }
  | { kind: "act"; id: string; action: "pause" | "resume" }
  | { kind: "listings" | "sources" | "ready"; id: string };

/** Every operation a delegation token can name, one per route and method. */
export const OPERATIONS = [
  "whoami",
  "list_task_types",
  "get_capabilities",
  "list_tasks",
  "create_task",
  "validate_task",
  "get_task",
  "update_task",
  "delete_task",
  "pause_task",
  "resume_task",
  "send_listings",
  "send_sources",
  "sources_ready",
] as const;
export type Operation = (typeof OPERATIONS)[number];

/** The operation a request is, by its route and method; null for a method the route does not take. */
export function operationOf(r: RouteKind, method: string): Operation | null {
  switch (r.kind) {
    case "me":
      return method === "GET" ? "whoami" : null;
    case "types":
      return method === "GET" ? "list_task_types" : null;
    case "capabilities":
      return method === "GET" ? "get_capabilities" : null;
    case "validate":
      return method === "POST" ? "validate_task" : null;
    case "tasks":
      return method === "GET" ? "list_tasks" : method === "POST" ? "create_task" : null;
    case "task":
      return method === "GET" ? "get_task" : method === "PATCH" ? "update_task" : method === "DELETE" ? "delete_task" : null;
    case "act":
      return method === "POST" ? (r.action === "pause" ? "pause_task" : "resume_task") : null;
    case "listings":
      return method === "POST" ? "send_listings" : null;
    case "sources":
      return method === "POST" ? "send_sources" : null;
    case "ready":
      return method === "POST" ? "sources_ready" : null;
  }
}
