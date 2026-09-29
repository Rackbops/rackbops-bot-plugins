import type { User } from "@rackbops/docket-core";
import type { TrackerDeps } from "../actions.js";
import { LINK_TTL_MS } from "./signin-link.js";

/** `/web` when `TRACKER_WEB_URL` is unset. */
export const WEB_NOT_CONFIGURED = "The web area is not set up on this bot.";

export interface WebLocation {
  /** `TRACKER_WEB_URL`'s origin. */
  origin: string;
  /** The plugin's name: its path prefix. */
  name: string;
}

/**
 * `/web` (rackbops-bot-plugins#80): a one-time sign-in link, answered ephemerally, so only the
 * person sees it. The link is wrapped in `<...>` so Discord shows no preview of it (a preview only
 * opens the page, which never uses the link up, but there is nothing to preview).
 */
export function webLink(d: Pick<TrackerDeps, "logins" | "clock">, user: User, web: WebLocation | null): string {
  if (!web) return WEB_NOT_CONFIGURED;
  const token = d.logins.issue(user.id, d.clock.now());
  const minutes = LINK_TTL_MS / 60_000;
  return [
    `Your sign-in link for the tracker's web area. It works once, within ${minutes} minutes; do not share it.`,
    `<${web.origin}/${web.name}/login?t=${token}>`,
  ].join("\n");
}
