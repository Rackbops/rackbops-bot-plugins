/// <reference lib="dom" />
// The WoW plugin's admin-panel tab (admin-UI contract, rackbops-discord-bot#123). It replaces the
// panel's old hardcoded realm chooser: a WOW_REGION select, a region-filtered WOW_REALM dropdown, and a
// DMF_TIMEZONE input with an IANA datalist — all saved through the panel's guarded env-set (scoped to
// this plugin's keys). The rich realm data (slug + display name per region) is EMBEDDED from realms.json
// (bun build inlines it into dist/admin.js), so the tab needs no network round-trip. The pure helpers
// (validate*, filter*, saveWowConfig, statusLine) are exported + unit-tested; mountAdmin is a thin DOM
// shell over them, verified with a fake-`document` test and in-browser (the panel runs it same-origin).
import type { AdminApi } from "../../../../packages/api/admin.js"; // path from src/admin/index.ts
import type { PluginStateEntry } from "../../../../packages/api/contract.js";
import realmData from "./realms.json" with { type: "json" };

export const adminApiVersion = 1;

export const REGIONS = ["us", "eu"] as const;
export type Region = (typeof REGIONS)[number];

export interface Realm {
  slug: string;
  name: string;
}

// Hand-duplicated mirror of the WOW_REALM manifest format (package.json botPlugin.env) — the accented
// Latin letters cover EU realms like chants-éternels / aggra-português. Client-side pre-validation only;
// the panel's env-set re-validates against this same manifest format on save. Moved verbatim from the
// panel's old chooser (rackbops-discord-bot@main:ops/admin/public/index.html:1290).
const REALM_SLUG_RE = /^[a-z0-9àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ-]{1,40}$/;

// Mirror of the DMF_TIMEZONE manifest format — a 1-to-3-segment IANA-shaped zone. A RegExp built from a
// string (not a literal) so the "/" needs no escaping, matching the panel's TZ_SHAPE_RE exactly.
const TZ_SHAPE_RE = new RegExp("^[A-Za-z0-9+_-]+(/[A-Za-z0-9+_-]+){0,2}$");

/** Null when `value` is a valid realm slug or blank; otherwise the reason to show the operator. */
export function validateRealmSlug(value: string): string | null {
  if (value === "" || REALM_SLUG_RE.test(value)) return null;
  return "Enter a realm slug (lowercase letters, digits and hyphens; accents allowed), or leave blank for no realm.";
}

/** Null when `value` is a validly-shaped IANA zone or blank; otherwise the reason to show the operator. */
export function validateTimezone(value: string): string | null {
  if (value === "" || TZ_SHAPE_RE.test(value)) return null;
  return "Enter an IANA time zone like America/Los_Angeles, or leave blank for the region default.";
}

/** The realms for `region` (us/eu), filtered to slugs the env-set would accept — the same "never offer a
 *  value the server rejects" rule the panel's chooser used. Region is only ever "us"/"eu" from the
 *  select; anything else yields an empty list. */
export function filterRealms(region: string): Realm[] {
  const list = region === "eu" ? realmData.regions.eu : region === "us" ? realmData.regions.us : [];
  return list.filter((r) => REALM_SLUG_RE.test(r.slug));
}

/** Filter a zone list to the shape env-set accepts (mirrors the panel's filterTimezones). */
export function filterTimezones(zones: string[]): string[] {
  return zones.filter((z) => TZ_SHAPE_RE.test(z));
}

/** The IANA zones the browser knows, filtered — empty on very old engines without supportedValuesOf. */
export function timezoneOptions(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  return filterTimezones(typeof supported === "function" ? supported("timeZone") : []);
}

/** The one-line status: the plugin's health (from getState) + whether a realm is being watched. Honest
 *  about what it can see — getEnv never returns the (secret) Blizzard creds, so this reports that a realm
 *  is *set*, not that the watch is fully wired. */
export function statusLine(state: PluginStateEntry | null, cfg: { region: string; realm: string }): string {
  if (!state) return "Not installed.";
  const version = state.installedVersion ? " (v" + state.installedVersion + ")" : "";
  const health = state.active ? "active" : state.error ? "failed to start: " + state.error : "not active";
  const watch = cfg.realm ? "watching " + cfg.realm + " (" + cfg.region + ")" : "no realm watch (WOW_REALM blank)";
  return "Plugin " + health + version + " — " + watch + ".";
}

/** Validate then save all three WoW config keys through the panel's guarded env-set; returns a message. */
export async function saveWowConfig(
  api: AdminApi,
  values: { region: string; realm: string; timezone: string },
): Promise<{ ok: boolean; message: string }> {
  const badRealm = validateRealmSlug(values.realm);
  if (badRealm) return { ok: false, message: badRealm };
  const badTimezone = validateTimezone(values.timezone);
  if (badTimezone) return { ok: false, message: badTimezone };
  const result = await api.setEnv({
    WOW_REGION: values.region,
    WOW_REALM: values.realm,
    DMF_TIMEZONE: values.timezone,
  });
  if (result.ok) return { ok: true, message: "Saved — the bot restarts to apply the change." };
  return { ok: false, message: result.error || "Save failed." };
}

// Fill a WOW_REALM <select> with the realms for `region`, preserving `currentValue` — injected as its
// own option when it isn't in the (filtered) list, so a stored realm is never silently dropped (e.g.
// when the region is switched to one that doesn't contain it). Ported from the panel's populateRealmSelect.
function populateRealmSelect(select: HTMLSelectElement, region: string, currentValue: string): void {
  const list = filterRealms(region);
  select.innerHTML = "";
  const rows: Realm[] = [{ slug: "", name: "— default —" }, ...list];
  if (currentValue && !list.some((r) => r.slug === currentValue)) {
    rows.push({ slug: currentValue, name: currentValue + (region ? " (not in the " + region + " list)" : "") });
  }
  for (const { slug, name } of rows) {
    const o = document.createElement("option");
    o.value = slug;
    o.textContent = slug === "" ? "— default —" : name;
    select.appendChild(o);
  }
  select.value = currentValue;
}

export function mountAdmin(root: HTMLElement, api: AdminApi): () => void {
  root.textContent = "";

  const regionLabel = document.createElement("label");
  regionLabel.textContent = "Region";
  const region = document.createElement("select");
  for (const r of REGIONS) {
    const o = document.createElement("option");
    o.value = r;
    o.textContent = r;
    region.appendChild(o);
  }

  const realmLabel = document.createElement("label");
  realmLabel.textContent = "Realm";
  const realm = document.createElement("select");

  const tzLabel = document.createElement("label");
  tzLabel.textContent = "Darkmoon Faire timezone";
  const timezone = document.createElement("input");
  timezone.type = "text";
  timezone.placeholder = "e.g. America/Los_Angeles (blank = region default)";
  const zones = timezoneOptions();
  let datalist: HTMLDataListElement | null = null;
  if (zones.length) {
    datalist = document.createElement("datalist");
    datalist.id = "wow-tz-list";
    for (const tz of zones) {
      const o = document.createElement("option");
      o.value = tz;
      datalist.appendChild(o);
    }
    timezone.setAttribute("list", datalist.id);
  }

  const save = document.createElement("button");
  save.textContent = "Save";
  const status = document.createElement("div");
  status.className = "field-hint";

  const onRegionChange = (): void => populateRealmSelect(realm, region.value, realm.value);

  const refresh = async (): Promise<void> => {
    // The AdminApi is typed never to reject, but guard anyway — an unhandled rejection here would
    // leave the tab blank with no clue, and this runs fire-and-forget at mount.
    try {
      const [env, state] = await Promise.all([api.getEnv(), api.getState()]);
      const storedRegion = (env && env.WOW_REGION) || "us";
      region.value = (REGIONS as readonly string[]).includes(storedRegion) ? storedRegion : "us";
      const storedRealm = (env && env.WOW_REALM) || "";
      populateRealmSelect(realm, region.value, storedRealm);
      timezone.value = (env && env.DMF_TIMEZONE) || "";
      status.textContent = statusLine(state, { region: region.value, realm: storedRealm });
    } catch (err) {
      status.textContent = "Couldn't load settings: " + (err instanceof Error ? err.message : String(err));
    }
  };

  const onSave = async (): Promise<void> => {
    save.disabled = true;
    // `finally` re-enables Save even if a (contract-violating) rejection escapes saveWowConfig, so the
    // button can never get stuck disabled.
    try {
      const result = await saveWowConfig(api, {
        region: region.value,
        realm: realm.value,
        timezone: timezone.value.trim(),
      });
      status.textContent = result.message;
      if (result.ok) await refresh();
    } catch (err) {
      status.textContent = "Save failed: " + (err instanceof Error ? err.message : String(err));
    } finally {
      save.disabled = false;
    }
  };

  region.addEventListener("change", onRegionChange);
  save.addEventListener("click", onSave);
  void refresh();

  root.append(regionLabel, region, realmLabel, realm, tzLabel, timezone, save, status);
  if (datalist) root.append(datalist);
  return () => {
    region.removeEventListener("change", onRegionChange);
    save.removeEventListener("click", onSave);
    root.textContent = "";
  };
}
