import { describe, expect, test } from "bun:test";
import type { PluginIndex } from "../packages/api/contract.js";
import { checkPublished, registryUrl, summarise, type PublishCheck } from "./check-published.js";

const entry = (name: string, version: string) => ({
  name,
  package: `@rackbops/plugin-${name}`,
  version,
  description: "d",
  hostApiVersion: 1,
  intents: [],
  commands: [name],
  env: [],
  releases: [],
});
const index: PluginIndex = { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", plugins: [entry("a", "1.0.0"), entry("b", "2.1.0")] };

describe("registryUrl", () => {
  test("encodes the scope slash and the version", () => {
    expect(registryUrl("@rackbops/plugin-a", "1.0.0")).toBe("https://registry.npmjs.org/@rackbops%2fplugin-a/1.0.0");
    expect(registryUrl("@rackbops/plugin-a", "1.0.0-rc.1", "http://x")).toBe("http://x/@rackbops%2fplugin-a/1.0.0-rc.1");
    expect(registryUrl("@rackbops/plugin-a", "a b", "http://x")).toBe("http://x/@rackbops%2fplugin-a/a%20b");
  });
});

describe("checkPublished", () => {
  const answer = (statuses: Record<string, number | Error>): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      const key = Object.keys(statuses).find((k) => url.includes(k))!;
      const s = statuses[key]!;
      if (s instanceof Error) throw s;
      return new Response("{}", { status: s });
    }) as typeof fetch;

  test("200 is published, 404 is missing", async () => {
    const r = await checkPublished(index, answer({ "plugin-a/1.0.0": 200, "plugin-b/2.1.0": 404 }));
    expect(r.map((x) => [x.name, x.state])).toEqual([["a", "published"], ["b", "missing"]]);
  });

  test("a server error, a rate limit and a thrown fetch are unreachable, never missing", async () => {
    const r = await checkPublished(index, answer({ "plugin-a/1.0.0": 503, "plugin-b/2.1.0": new Error("boom") }));
    expect(r.map((x) => x.state)).toEqual(["unreachable", "unreachable"]);
    expect(r[0]!.detail).toContain("503");
    expect(r[1]!.detail).toBe("boom");
    const limited = await checkPublished(index, answer({ "plugin-a/1.0.0": 429, "plugin-b/2.1.0": 429 }));
    expect(limited.every((x) => x.state === "unreachable")).toBe(true);
  });

  test("every request carries a timeout signal", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    await checkPublished(index, (async (_u: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s instanceof AbortSignal)).toBe(true);
  });
});

describe("summarise", () => {
  const r = (state: PublishCheck["state"], name = "a"): PublishCheck => ({ name, package: `@rackbops/plugin-${name}`, version: "1.0.0", state, detail: "why" });

  test("exit 0 only when everything is published", () => {
    expect(summarise([r("published"), r("published", "b")]).code).toBe(0);
  });

  test("a missing version is exit 1 and names the tag to push, even when another is unreachable", () => {
    const s = summarise([r("missing"), r("unreachable", "b")]);
    expect(s.code).toBe(1);
    expect(s.lines[0]).toContain("push the tag a-v1.0.0");
  });

  test("unreachable alone is exit 2 and says it is not a missing version", () => {
    const s = summarise([r("published"), r("unreachable", "b")]);
    expect(s.code).toBe(2);
    expect(s.lines[1]).toContain("not a missing version");
  });
});
