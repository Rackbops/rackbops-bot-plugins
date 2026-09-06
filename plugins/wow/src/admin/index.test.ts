import { describe, expect, test } from "bun:test";
import type { AdminApi } from "../../../../packages/api/admin.js";
import type { PluginStateEntry } from "../../../../packages/api/contract.js";
import {
  adminApiVersion,
  validateRealmSlug,
  validateTimezone,
  filterRealms,
  filterTimezones,
  timezoneOptions,
  statusLine,
  saveWowConfig,
  mountAdmin,
  REGIONS,
} from "./index.js";

const state = (over: Partial<PluginStateEntry> = {}): PluginStateEntry => ({
  name: "wow",
  enabled: true,
  configured: true,
  missingEnv: [],
  active: true,
  ...over,
});

function fakeApi(over: Partial<AdminApi> = {}): AdminApi {
  return {
    meta: { name: "wow", version: "1.0.0", adminApiVersion: 1 },
    getEnv: async () => ({}),
    setEnv: async () => ({ ok: true }),
    getState: async () => state(),
    proxyFetch: async () => new Response(""),
    ...over,
  };
}

describe("wow admin tab helpers (#123 realm chooser)", () => {
  test("adminApiVersion is 1 and REGIONS is us + eu", () => {
    expect(adminApiVersion).toBe(1);
    expect([...REGIONS]).toEqual(["us", "eu"]);
  });

  test("validateRealmSlug accepts a valid slug (accents included) or blank, rejects the rest", () => {
    expect(validateRealmSlug("argent-dawn")).toBeNull();
    expect(validateRealmSlug("chants-éternels")).toBeNull();
    expect(validateRealmSlug("")).toBeNull(); // blank = no realm
    expect(validateRealmSlug("Has Spaces")).not.toBeNull();
    expect(validateRealmSlug("UPPER")).not.toBeNull();
    expect(validateRealmSlug("x".repeat(41))).not.toBeNull();
  });

  test("validateTimezone accepts an IANA-shaped zone (up to 3 segments) or blank, rejects the rest", () => {
    expect(validateTimezone("America/Los_Angeles")).toBeNull();
    expect(validateTimezone("America/Indiana/Indianapolis")).toBeNull();
    expect(validateTimezone("UTC")).toBeNull();
    expect(validateTimezone("")).toBeNull();
    expect(validateTimezone("A/B/C/D")).not.toBeNull(); // 4 segments
    expect(validateTimezone("has space")).not.toBeNull();
  });

  test("filterRealms returns a region's realms and ignores an unknown region", () => {
    const us = filterRealms("us");
    const eu = filterRealms("eu");
    expect(us.length).toBeGreaterThan(0);
    expect(eu.length).toBeGreaterThan(0);
    // Mutation: ignoring the region argument would return the same list for both.
    expect(us.length).not.toBe(eu.length);
    expect(us.every((r) => validateRealmSlug(r.slug) === null)).toBe(true);
    expect(filterRealms("kr")).toEqual([]);
  });

  test("filterTimezones keeps only IANA-shaped zones", () => {
    expect(filterTimezones(["America/Los_Angeles", "bad zone", "UTC", "a/b/c/d"])).toEqual([
      "America/Los_Angeles",
      "UTC",
    ]);
  });

  test("timezoneOptions returns a filtered, non-empty list on this engine", () => {
    const zones = timezoneOptions();
    expect(zones.length).toBeGreaterThan(0);
    expect(zones.every((z) => validateTimezone(z) === null)).toBe(true);
  });

  test("statusLine reflects health and whether a realm is watched", () => {
    expect(statusLine(null, { region: "us", realm: "" })).toBe("Not installed.");
    expect(statusLine(state({ installedVersion: "1.0.0", active: true }), { region: "us", realm: "argent-dawn" })).toBe(
      "Plugin active (v1.0.0) — watching argent-dawn (us).",
    );
    expect(statusLine(state({ active: true }), { region: "us", realm: "" })).toContain("no realm watch");
    expect(statusLine(state({ active: false, error: "boom" }), { region: "us", realm: "x" })).toContain(
      "failed to start: boom",
    );
    expect(statusLine(state({ active: false, error: undefined }), { region: "us", realm: "x" })).toContain("not active");
  });

  test("saveWowConfig sends exactly the three WoW keys, and never on an invalid value", async () => {
    const calls: Record<string, string>[] = [];
    const api = fakeApi({
      setEnv: async (c) => {
        calls.push(c);
        return { ok: true };
      },
    });
    const ok = await saveWowConfig(api, { region: "eu", realm: "hyjal", timezone: "Europe/Paris" });
    expect(ok.ok).toBe(true);
    expect(calls).toEqual([{ WOW_REGION: "eu", WOW_REALM: "hyjal", DMF_TIMEZONE: "Europe/Paris" }]);
    // Invalid realm / timezone are caught client-side and never reach setEnv.
    expect((await saveWowConfig(api, { region: "us", realm: "Bad Realm", timezone: "" })).ok).toBe(false);
    expect((await saveWowConfig(api, { region: "us", realm: "", timezone: "no good" })).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("saveWowConfig surfaces a server-side save failure", async () => {
    const api = fakeApi({ setEnv: async () => ({ ok: false, error: "value invalid" }) });
    const r = await saveWowConfig(api, { region: "us", realm: "argent-dawn", timezone: "" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("value invalid");
  });
});

// A minimal fake `document`, so mountAdmin's DOM shell is unit-tested without a jsdom/happy-dom
// dependency — the same DI style warbandeer's admin test uses.
interface FakeEl {
  tagName: string;
  textContent: string;
  value: string;
  type: string;
  placeholder: string;
  className: string;
  id: string;
  disabled: boolean;
  innerHTML: string;
  children: FakeEl[];
  attributes: Record<string, string>;
  append(...kids: FakeEl[]): void;
  appendChild(kid: FakeEl): FakeEl;
  setAttribute(name: string, value: string): void;
  addEventListener(ev: string, fn: () => unknown): void;
  removeEventListener(ev: string, fn: () => unknown): void;
  fire(ev: string): void;
  listenerCount(ev: string): number;
}

function fakeElement(tag: string): FakeEl {
  const listeners: Record<string, Array<() => unknown>> = {};
  let html = "";
  const el: FakeEl = {
    tagName: tag,
    textContent: "",
    value: "",
    type: "",
    placeholder: "",
    className: "",
    id: "",
    disabled: false,
    children: [],
    attributes: {},
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
      if (v === "") el.children = [];
    },
    append(...kids) {
      el.children.push(...kids);
    },
    appendChild(kid) {
      el.children.push(kid);
      return kid;
    },
    setAttribute(name, value) {
      el.attributes[name] = value;
    },
    addEventListener(ev, fn) {
      (listeners[ev] ??= []).push(fn);
    },
    removeEventListener(ev, fn) {
      listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
    },
    fire(ev) {
      for (const fn of [...(listeners[ev] ?? [])]) fn();
    },
    listenerCount(ev) {
      return (listeners[ev] ?? []).length;
    },
  };
  return el;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("mountAdmin (fake-document DOM shell)", () => {
  test("renders region/realm/timezone from getEnv, repopulates realms on region change, saves the three keys, and cleans up", async () => {
    const prevDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { createElement: (t: string) => fakeElement(t) };
    try {
      const calls: Record<string, string>[] = [];
      const api = fakeApi({
        getEnv: async () => ({ WOW_REGION: "eu", WOW_REALM: "hyjal", DMF_TIMEZONE: "Europe/Paris" }),
        getState: async () => state({ installedVersion: "1.0.0", active: true }),
        setEnv: async (c: Record<string, string>) => {
          calls.push(c);
          return { ok: true };
        },
      });
      const root = fakeElement("div");
      const cleanup = mountAdmin(root as unknown as HTMLElement, api);
      await flush(); // let the fire-and-forget refresh() resolve

      const selects = root.children.filter((c) => c.tagName === "select");
      const region = selects[0]!;
      const realm = selects[1]!;
      const tz = root.children.find((c) => c.tagName === "input")!;
      const button = root.children.find((c) => c.tagName === "button")!;

      // Rendered FROM getEnv — mutation: dropping any of these leaves the field at its default.
      expect(region.value).toBe("eu");
      expect(realm.value).toBe("hyjal");
      expect(tz.value).toBe("Europe/Paris");

      // Changing the region repopulates the realm options (us and eu have different realm counts).
      expect(filterRealms("us").length).not.toBe(filterRealms("eu").length); // guard for the assertion below
      const euOptionCount = realm.children.length;
      region.value = "us";
      region.fire("change");
      expect(realm.children.length).not.toBe(euOptionCount);

      // Save sends exactly the three WoW keys.
      realm.value = "argent-dawn";
      tz.value = "America/Los_Angeles";
      button.fire("click");
      await flush();
      expect(calls).toEqual([{ WOW_REGION: "us", WOW_REALM: "argent-dawn", DMF_TIMEZONE: "America/Los_Angeles" }]);

      // Cleanup removes both listeners — mutation: a no-op cleanup leaves them at 1.
      expect(button.listenerCount("click")).toBe(1);
      expect(region.listenerCount("change")).toBe(1);
      cleanup();
      expect(button.listenerCount("click")).toBe(0);
      expect(region.listenerCount("change")).toBe(0);
    } finally {
      (globalThis as { document?: unknown }).document = prevDoc;
    }
  });
});
