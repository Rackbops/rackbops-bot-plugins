import { describe, expect, it } from "bun:test";
import { decideHealth, healthResponse, STALE_AFTER_MS } from "./health.js";

const T0 = new Date("2026-10-01T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("decideHealth", () => {
  it("is 503 inactive before activate()", () => {
    expect(decideHealth({ activatedAt: null, lastTickAt: null, blocked: null }, T0)).toEqual({ status: 503, body: { status: "inactive", lastTickAt: null } });
  });

  it("is 200 starting until the first tick, and 503 stale when none comes", () => {
    const state = { activatedAt: T0, lastTickAt: null, blocked: null };
    expect(decideHealth(state, at(STALE_AFTER_MS)).status).toBe(200);
    expect(decideHealth(state, at(STALE_AFTER_MS + 1))).toEqual({ status: 503, body: { status: "stale", lastTickAt: null } });
  });

  it("is 200 while the last tick is fresh and 503 once it is older than three minutes", () => {
    const state = { activatedAt: T0, lastTickAt: at(60_000), blocked: null };
    expect(decideHealth(state, at(60_000 + STALE_AFTER_MS))).toEqual({ status: 200, body: { status: "ok", lastTickAt: at(60_000).toISOString() } });
    expect(decideHealth(state, at(60_001 + STALE_AFTER_MS)).body.status).toBe("stale");
  });

  it("is 503 blocked, with the reason, when the lane cannot run at all", () => {
    expect(decideHealth({ activatedAt: T0, lastTickAt: null, blocked: "no dm" }, T0)).toEqual({ status: 503, body: { status: "blocked", lastTickAt: null, detail: "no dm" } });
  });

  it("answers JSON that is never cached", async () => {
    const res = healthResponse({ status: 503, body: { status: "stale", lastTickAt: null } });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "stale", lastTickAt: null });
  });
});
