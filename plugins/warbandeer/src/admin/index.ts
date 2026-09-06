/// <reference lib="dom" />
// Warbandeer's admin-panel tab (admin-UI contract, rackbops-discord-bot#123, child 3). v1 scope: the
// ingest-port field + a "is the connector running?" status readout. NO linked-account data (privacy).
// The pure/impure helpers (validatePort, statusLine, savePort) are exported + unit-tested; mountAdmin
// is a thin DOM shell over them, verified in-browser (the panel runs it same-origin via the contract).
import type { AdminApi } from "../../../../packages/api/admin.js"; // path from src/admin/index.ts
import type { PluginStateEntry } from "../../../../packages/api/contract.js";

export const adminApiVersion = 1;

// Mirror of the WARBANDEER_INGEST_PORT format in package.json's botPlugin.env — a TCP port 1-65535.
// Client-side pre-validation only; the panel's env-set re-validates against this same manifest format
// on save. Blank clears the port (disables the ingest connector), which env-set allows (not required).
const PORT_RE = /^([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/;

/** Null when `value` is a valid port or blank; otherwise the reason to show the operator. */
export function validatePort(value: string): string | null {
  if (value === "" || PORT_RE.test(value)) return null;
  return "Enter a port between 1 and 65535, or leave blank to disable the connector.";
}

/** The one-line status: the plugin's health (from getState) + whether the ingest connector is
 *  CONFIGURED (a port is set). Deliberately "configured", not "running": the plugin swallows a
 *  bind failure and stays active, and `getState` (a PluginStateEntry) carries no live listening flag,
 *  so the tab can only report that a port is set, not that the socket bound. `port` is the current
 *  WARBANDEER_INGEST_PORT (from getEnv); "" = connector off. */
export function statusLine(state: PluginStateEntry | null, port: string): string {
  if (!state) return "Not installed.";
  const version = state.installedVersion ? " (v" + state.installedVersion + ")" : "";
  const health = state.active ? "active" : state.error ? "failed to start: " + state.error : "not active";
  const connector = port ? "ingest connector configured (port " + port + ")" : "ingest connector off (no port set)";
  return "Plugin " + health + version + " — " + connector + ".";
}

/** Validate then save (or clear) the port through the panel's guarded env-set; returns a message. */
export async function savePort(api: AdminApi, value: string): Promise<{ ok: boolean; message: string }> {
  const invalid = validatePort(value);
  if (invalid) return { ok: false, message: invalid };
  const result = await api.setEnv({ WARBANDEER_INGEST_PORT: value });
  if (result.ok) return { ok: true, message: value ? "Saved — the bot restarts on port " + value + "." : "Saved — connector disabled." };
  return { ok: false, message: result.error || "Save failed." };
}

export function mountAdmin(root: HTMLElement, api: AdminApi): () => void {
  root.textContent = "";
  const label = document.createElement("label");
  label.textContent = "Ingest port";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "e.g. 8082 (blank = off)";
  const save = document.createElement("button");
  save.textContent = "Save port";
  const status = document.createElement("div");
  status.className = "field-hint";

  const refresh = async (): Promise<void> => {
    // The AdminApi is typed never to reject, but guard anyway — an unhandled rejection here would
    // leave the status blank with no clue, and this runs fire-and-forget at mount.
    try {
      const [env, state] = await Promise.all([api.getEnv(), api.getState()]);
      const port = (env && env.WARBANDEER_INGEST_PORT) || "";
      input.value = port;
      status.textContent = statusLine(state, port);
    } catch (err) {
      status.textContent = "Couldn't load settings: " + (err instanceof Error ? err.message : String(err));
    }
  };
  const onSave = async (): Promise<void> => {
    save.disabled = true;
    // `finally` re-enables Save even if a (contract-violating) rejection escapes savePort, so the
    // button can never get stuck disabled.
    try {
      const result = await savePort(api, input.value.trim());
      status.textContent = result.message;
      if (result.ok) await refresh();
    } catch (err) {
      status.textContent = "Save failed: " + (err instanceof Error ? err.message : String(err));
    } finally {
      save.disabled = false;
    }
  };
  save.addEventListener("click", onSave);
  void refresh();

  root.append(label, input, save, status);
  return () => {
    save.removeEventListener("click", onSave);
    root.textContent = "";
  };
}
