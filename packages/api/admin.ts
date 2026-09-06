/// <reference lib="dom" />
// The admin-UI contract — a SEPARATE module from contract.ts on purpose. contract.ts is pinned to a
// single runtime const and stays DOM-free (it is read at boot before the discord.js Client exists);
// this module is browser/DOM-typed and only the admin panel + a plugin's admin bundle ever import it.
//
// A plugin OPTIONALLY ships a browser admin bundle (built to dist/admin.js) that exports `mountAdmin`
// and `adminApiVersion`. The bundle rides inside the published npm package; `generate-index` derives
// the plugin's manifest `adminUrl` (a jsDelivr URL) from it. The admin panel fetches that bundle,
// serves it same-origin, and calls `mountAdmin(div, api)` inside that plugin's own tab — the panel-side
// analog of the bot handing a plugin a `HostApi`. Design: Rackbops/rackbops-discord-bot#123.
import type { PluginStateEntry } from "./contract.js";

/**
 * Bumped when `AdminApi`/`mountAdmin` change incompatibly. INDEPENDENT of `HOST_API_VERSION`: a plugin
 * can revise its bot-side contract without touching its admin UI, and vice versa. The panel mounts a
 * bundle only when the plugin's declared `adminApiVersion` equals this — otherwise it shows a
 * version-mismatch note instead of running code built against a different shape.
 */
export const ADMIN_API_VERSION = 1;

/** The outcome of an `AdminApi.setEnv`, mirroring what the panel's guarded env-set route returns. */
export interface SaveResult {
  ok: boolean;
  /** Present when `ok` is false — the operator-facing reason (e.g. a bot-ops validation failure). */
  error?: string;
}

/**
 * What the panel hands a plugin's admin bundle — the panel-side analog of `HostApi`. The plugin owns
 * everything it renders into its mount element; the panel keeps AUTHORITY over every config write:
 * `setEnv` is routed through the same guarded path a manual edit uses (auth + bot-ops validation +
 * recreate) and is scoped by the panel to THIS plugin's declared keys, so a bundle can never touch a
 * key it doesn't own. A declared-capability boundary, not a sandbox.
 */
export interface AdminApi {
  /** This plugin's identity, from its Plugin Index entry. */
  readonly meta: { name: string; version: string; adminApiVersion: number };
  /** This plugin's declared, non-secret env keys and their current values — never the whole environment. */
  getEnv(): Promise<Record<string, string>>;
  /**
   * Request a config change. The panel filters `changes` to this plugin's declared keys, routes them
   * through the guarded env-set path (which validates each value against the plugin's manifest format
   * and recreates the bot), and resolves the bot-ops outcome as a `SaveResult`.
   */
  setEnv(changes: Record<string, string>): Promise<SaveResult>;
  /** This plugin's current `data/plugins/state.json` entry (installed version, active flag, …). */
  getState(): Promise<PluginStateEntry>;
  /**
   * GET a data asset PUBLISHED WITH THIS PLUGIN. `path` is resolved by the panel, server-side, against
   * this plugin's own npm package on the CDN (e.g. `dist/realms.json`) — never an arbitrary URL, so a
   * bundle can only ever read its own published files.
   */
  proxyFetch(path: string): Promise<Response>;
}

/**
 * A plugin's optional admin entry, built to `dist/admin.js` (browser target). The panel calls it with
 * a fresh mount element and the `AdminApi`; it returns a cleanup function the panel invokes on unmount.
 */
export type MountAdmin = (root: HTMLElement, api: AdminApi) => () => void;
