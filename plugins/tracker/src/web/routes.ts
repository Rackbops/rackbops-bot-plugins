import type { TaskAction } from "./editor.js";
import { EDITOR_TYPES, type EditorType } from "./editor-pages.js";

/**
 * The web area's signed-in paths (rackbops-bot-plugins#80) and the methods each takes. A task id
 * comes from the path as typed; it names a task to look up, never whose it is.
 */

const TASK_PATH = /^\/tasks\/([^/]+)$/;
const TASK_ACTION = /^\/tasks\/([^/]+)\/(edit|pause|resume|delete)$/;
const NEW_PATH = /^\/new\/([a-z]+)$/;

export type Route =
  | { kind: "tasks" | "settings" | "logout" }
  | { kind: "task"; id: string }
  | { kind: "edit"; id: string }
  | { kind: "act"; id: string; action: TaskAction }
  | { kind: "new"; type: EditorType };

/** The signed-in routes; null = 404. An id that does not decode is an unknown id. */
export function route(path: string): Route | null {
  if (path === "/") return { kind: "tasks" };
  if (path === "/settings") return { kind: "settings" };
  if (path === "/logout") return { kind: "logout" };
  const created = NEW_PATH.exec(path);
  if (created) {
    const type = created[1] as EditorType;
    return EDITOR_TYPES.includes(type) ? { kind: "new", type } : null;
  }
  const one = TASK_PATH.exec(path) ?? TASK_ACTION.exec(path);
  if (!one) return null;
  let id: string;
  try {
    id = decodeURIComponent(one[1] ?? "");
  } catch {
    id = "";
  }
  const action = one[2];
  if (action === undefined) return { kind: "task", id };
  if (action === "edit") return { kind: "edit", id };
  return { kind: "act", id, action: action as TaskAction };
}

/** Which methods a route takes: forms answer GET, acts are POST only, pages GET only. */
export function methodsOf(r: Route): "GET" | "POST" | "GET, POST" {
  if (r.kind === "logout" || r.kind === "act") return "POST";
  if (r.kind === "settings" || r.kind === "edit" || r.kind === "new") return "GET, POST";
  return "GET";
}
