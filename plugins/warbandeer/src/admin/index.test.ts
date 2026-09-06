import { describe, expect, test } from "bun:test";
import type { AdminApi } from "../../../../packages/api/admin.js";
import type { PluginStateEntry } from "../../../../packages/api/contract.js";
import { adminApiVersion, validatePort, statusLine, savePort, mountAdmin } from "./index.js";

const state = (over: Partial<PluginStateEntry> = {}): PluginStateEntry => ({
  name: "warbandeer",
  enabled: true,
  configured: true,
  missingEnv: [],
  active: true,
  ...over,
});

function fakeApi(over: Partial<AdminApi> = {}): AdminApi {
  return {
    meta: { name: "warbandeer", version: "1.1.0", adminApiVersion: 1 },
    getEnv: async () => ({}),
    setEnv: async () => ({ ok: true }),
    getState: async () => state(),
    proxyFetch: async () => new Response(""),
    ...over,
  };
}

describe("warbandeer admin tab helpers (#123 child 3)", () => {
  test("adminApiVersion is 1", () => {
    expect(adminApiVersion).toBe(1);
  });

  test("validatePort accepts a valid port or blank, rejects out-of-range/non-numeric", () => {
    expect(validatePort("8082")).toBeNull();
    expect(validatePort("1")).toBeNull();
    expect(validatePort("65535")).toBeNull();
    expect(validatePort("")).toBeNull(); // blank disables the connector
    expect(validatePort("65536")).not.toBeNull();
    expect(validatePort("0")).not.toBeNull();
    expect(validatePort("abc")).not.toBeNull();
    expect(validatePort("80 80")).not.toBeNull();
  });

  test("statusLine reflects getState health + whether the connector is configured", () => {
    expect(statusLine(null, "")).toBe("Not installed.");
    expect(statusLine(state({ installedVersion: "1.1.0", active: true }), "8082")).toBe(
      "Plugin active (v1.1.0) — ingest connector configured (port 8082).",
    );
    // No port → off (mutation: hardcoding "configured" fails here).
    expect(statusLine(state({ installedVersion: "1.1.0", active: true }), "")).toContain("connector off (no port set)");
    // Not active. The "failed to start" branch is reached via a createPlugin throw (e.g. an invalid
    // port) → the host records the error + active:false. (A runtime bind failure is swallowed and stays
    // active — hence the connector clause says "configured", not "running".) Mutation: hardcoding
    // "active" fails here.
    expect(statusLine(state({ active: false, error: "WARBANDEER_INGEST_PORT must be a valid port" }), "8082")).toContain(
      "failed to start: WARBANDEER_INGEST_PORT must be a valid port",
    );
    expect(statusLine(state({ active: false, error: undefined }), "8082")).toContain("not active");
  });

  test("savePort sends ONLY WARBANDEER_INGEST_PORT, and never on an invalid value", async () => {
    const calls: Record<string, string>[] = [];
    const api = fakeApi({
      setEnv: async (c) => {
        calls.push(c);
        return { ok: true };
      },
    });
    const ok = await savePort(api, "8082");
    expect(ok.ok).toBe(true);
    expect(calls).toEqual([{ WARBANDEER_INGEST_PORT: "8082" }]); // only the port — mutation: extra keys fail
    // An invalid value validates client-side and never reaches setEnv.
    const bad = await savePort(api, "99999");
    expect(bad.ok).toBe(false);
    expect(calls).toHaveLength(1);
    // Blank clears the port (a valid save).
    await savePort(api, "");
    expect(calls[1]).toEqual({ WARBANDEER_INGEST_PORT: "" });
  });

  test("savePort surfaces a server-side save failure", async () => {
    const api = fakeApi({ setEnv: async () => ({ ok: false, error: "value invalid" }) });
    const r = await savePort(api, "8082");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("value invalid");
  });
});

// A minimal fake `document`, so mountAdmin's DOM shell (render-from-getEnv + listener cleanup) is
// unit-tested without a jsdom/happy-dom dependency — the same DI style the helper tests use for AdminApi.
interface FakeEl {
  tagName: string;
  textContent: string;
  value: string;
  type: string;
  placeholder: string;
  className: string;
  disabled: boolean;
  children: FakeEl[];
  append(...kids: FakeEl[]): void;
  appendChild(kid: FakeEl): FakeEl;
  addEventListener(ev: string, fn: () => unknown): void;
  removeEventListener(ev: string, fn: () => unknown): void;
  fire(ev: string): void;
  listenerCount(ev: string): number;
}
function fakeElement(tag: string): FakeEl {
  const listeners: Record<string, Array<() => unknown>> = {};
  const el: FakeEl = {
    tagName: tag,
    textContent: "",
    value: "",
    type: "",
    placeholder: "",
    className: "",
    disabled: false,
    children: [],
    append(...kids) {
      el.children.push(...kids);
    },
    appendChild(kid) {
      el.children.push(kid);
      return kid;
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
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("mountAdmin (fake-document DOM shell)", () => {
  test("populates the port from getEnv, saves via setEnv, and cleanup removes the listener", async () => {
    const prevDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { createElement: (t: string) => fakeElement(t) };
    try {
      const calls: Record<string, string>[] = [];
      const api = fakeApi({
        getEnv: async () => ({ WARBANDEER_INGEST_PORT: "8082" }),
        getState: async () => state({ installedVersion: "1.1.0", active: true }),
        setEnv: async (c: Record<string, string>) => {
          calls.push(c);
          return { ok: true };
        },
      });
      const root = fakeElement("div");
      const cleanup = mountAdmin(root as unknown as HTMLElement, api);
      await tick(); // let the fire-and-forget refresh() resolve
      const input = root.children.find((c) => c.tagName === "input")!;
      const button = root.children.find((c) => c.tagName === "button")!;
      // Rendered FROM getEnv — mutation: dropping `input.value = port` leaves this "".
      expect(input.value).toBe("8082");
      // Clicking Save sends only the port through setEnv.
      input.value = "9090";
      button.fire("click");
      await tick();
      expect(calls).toEqual([{ WARBANDEER_INGEST_PORT: "9090" }]);
      // Cleanup removes the click listener — mutation: a no-op cleanup leaves it at 1.
      expect(button.listenerCount("click")).toBe(1);
      cleanup();
      expect(button.listenerCount("click")).toBe(0);
    } finally {
      (globalThis as { document?: unknown }).document = prevDoc;
    }
  });
});
