import type { Task } from "@rackbops/docket-core";
import { sha256 } from "./secrets.js";

/**
 * A task's version for the task API's `If-Match` (rackbops-bot-plugins#369): the first 16 hex digits
 * of the SHA-256 of what its owner can change -- title, settings, schedule, status and capabilities.
 * A run's own state (`state`, `updatedAt` moved by a tick) leaves it alone, so a client's edit is not
 * refused only because the task ran in between -- unless the run finished the task, which changes its
 * status. An edit that puts every value back gives the old version again, which is the same task.
 */
export function taskVersion(task: Task): string {
  const owned = { title: task.title, config: task.config, schedule: task.schedule, status: task.status, capabilities: task.capabilities };
  return sha256(canonicalJson(owned)).slice(0, 16);
}

/** JSON with every object's keys sorted, so two equal values give one string whatever their key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The `ETag` value for a version: a strong tag, quoted. */
export function etag(version: string): string {
  return `"${version}"`;
}

/** The version an `If-Match` header names, or null when it names none this API makes (`*` included). */
export function ifMatchVersion(header: string | null): string | null {
  if (header === null) return null;
  const m = /^\s*"([0-9a-f]{16})"\s*$/.exec(header);
  return m?.[1] ?? null;
}

export const VERSION_MISMATCH = "That task has changed since you read it. Read it again (GET the task) and send its new version in If-Match.";
