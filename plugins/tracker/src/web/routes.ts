import type { TaskAction } from "./editor.js";
import { NEW_TYPES, type NewType } from "./editor-pages.js";

/**
 * The web area's signed-in paths (rackbops-bot-plugins#80) and the methods each takes. A task id
 * comes from the path as typed; it names a task to look up, never whose it is.
 */

const TASK_PATH = /^\/tasks\/([^/]+)$/;
const TASK_ACTION = /^\/tasks\/([^/]+)\/(edit|pause|resume|delete)$/;
const NEW_PATH = /^\/new\/([a-z]+)$/;
const PERSON_PATH = /^\/admin\/people\/([^/]+)$/;
const PERSON_ACTION = /^\/admin\/people\/([^/]+)\/(grant|revoke|resume-delivery|forget)$/;
const PERSON_CEILING = /^\/admin\/people\/([^/]+)\/ceiling$/;
const BLOCK_LIFT = /^\/admin\/blocks\/([^/]+)\/lift$/;
const TOKEN_REVOKE = /^\/tokens\/([^/]+)\/revoke$/;
const ADMIN_TOKEN_REVOKE = /^\/admin\/tokens\/([^/]+)\/revoke$/;

/** What an admin does to a person from their page (admin.ts). */
export type PersonAction = "grant" | "revoke" | "resume-delivery" | "forget";

export type Route =
  | { kind: "tasks" | "settings" | "logout" }
  | { kind: "task"; id: string }
  | { kind: "edit"; id: string }
  | { kind: "act"; id: string; action: TaskAction }
  | { kind: "new"; type: NewType }
  | { kind: "forget" }
  | { kind: "tokens" }
  | { kind: "token-revoke"; id: string }
  | { kind: "admin-token-revoke"; id: string }
  | { kind: "admin" | "admin-tasks" | "admin-deliveries" | "admin-allow" }
  | { kind: "admin-person"; id: string }
  | { kind: "admin-act"; id: string; action: PersonAction }
  | { kind: "admin-ceiling"; id: string }
  | { kind: "admin-lift"; id: string };

/** The admin view's routes: each answers a signed-in person who is not an admin with the unknown page's 404. */
export function isAdminRoute(r: Route): boolean {
  return r.kind.startsWith("admin");
}

/** A path segment as an id; one that does not decode is an unknown id. */
function segment(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? "");
  } catch {
    return "";
  }
}

/** The signed-in routes; null = 404. An id that does not decode is an unknown id. */
export function route(path: string): Route | null {
  if (path === "/") return { kind: "tasks" };
  if (path === "/settings") return { kind: "settings" };
  if (path === "/logout") return { kind: "logout" };
  if (path === "/forget") return { kind: "forget" };
  if (path === "/tokens") return { kind: "tokens" };
  const revoke = TOKEN_REVOKE.exec(path);
  if (revoke) return { kind: "token-revoke", id: segment(revoke[1]) };
  const adminRevoke = ADMIN_TOKEN_REVOKE.exec(path);
  if (adminRevoke) return { kind: "admin-token-revoke", id: segment(adminRevoke[1]) };
  if (path === "/admin") return { kind: "admin" };
  if (path === "/admin/tasks") return { kind: "admin-tasks" };
  if (path === "/admin/deliveries") return { kind: "admin-deliveries" };
  if (path === "/admin/allow") return { kind: "admin-allow" };
  const ceiling = PERSON_CEILING.exec(path);
  if (ceiling) return { kind: "admin-ceiling", id: segment(ceiling[1]) };
  const personAct = PERSON_ACTION.exec(path);
  if (personAct) return { kind: "admin-act", id: segment(personAct[1]), action: personAct[2] as PersonAction };
  const onePerson = PERSON_PATH.exec(path);
  if (onePerson) return { kind: "admin-person", id: segment(onePerson[1]) };
  const lift = BLOCK_LIFT.exec(path);
  if (lift) return { kind: "admin-lift", id: segment(lift[1]) };
  const created = NEW_PATH.exec(path);
  if (created) {
    const type = created[1] as NewType;
    return NEW_TYPES.includes(type) ? { kind: "new", type } : null;
  }
  const one = TASK_PATH.exec(path) ?? TASK_ACTION.exec(path);
  if (!one) return null;
  const id = segment(one[1]);
  const action = one[2];
  if (action === undefined) return { kind: "task", id };
  if (action === "edit") return { kind: "edit", id };
  return { kind: "act", id, action: action as TaskAction };
}

/** Which methods a route takes: forms answer GET, acts are POST only, pages GET only. */
export function methodsOf(r: Route): "GET" | "POST" | "GET, POST" {
  if (
    r.kind === "logout" ||
    r.kind === "act" ||
    r.kind === "admin-allow" ||
    r.kind === "admin-act" ||
    r.kind === "admin-ceiling" ||
    r.kind === "admin-lift" ||
    r.kind === "token-revoke" ||
    r.kind === "admin-token-revoke"
  ) {
    return "POST";
  }
  if (r.kind === "settings" || r.kind === "edit" || r.kind === "new" || r.kind === "forget" || r.kind === "tokens") return "GET, POST";
  return "GET";
}
