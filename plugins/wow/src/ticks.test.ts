import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakeHost } from "./test-host.js";
import { initWowConfig } from "./config.js";
import { initWowStore, wowState, _resetWowStore } from "./store.js";
import { checkRealm, checkDmf, checkWeeklyReset, _resetRealmPollThrottle } from "./ticks.js";
import { currentOrNextDmf, dmfKey, dmfWindow, decideDmfAnnouncement } from "./dmf.js";
import { lastWeeklyReset } from "./reset.js";
import { _resetBlizzardToken } from "./blizzard.js";

const originalFetch = globalThis.fetch;

// Return the OAuth token, then the chosen realm status, so realmStatus() resolves deterministically.
function mockRealm(status: "UP" | "DOWN"): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("oauth.battle.net/token")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("/data/wow/search/connected-realm")) {
      return new Response(JSON.stringify({ results: [{ data: { status: { type: status } } }] }), { status: 200 });
    }
    throw new Error(`unmocked fetch: ${url}`);
  }) as typeof fetch;
}

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wow-ticks-"));
  _resetWowStore();
  _resetRealmPollThrottle();
  _resetBlizzardToken();
  initWowConfig({
    WOW_REGION: "us",
    WOW_REALM: "argent-dawn",
    BLIZZARD_CLIENT_ID: "id",
    BLIZZARD_CLIENT_SECRET: "secret",
  });
  await initWowStore(makeFakeHost({ dataDir: dir })); // fresh install → wowState() === {}
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

describe("checkRealm", () => {
  test("seeds silently, announces only on a transition, and persists the status so it never re-announces", async () => {
    const announced: string[] = [];
    const host = makeFakeHost({ dataDir: dir, announce: async (m) => void announced.push(m) });

    mockRealm("UP");
    await checkRealm(host);
    expect(announced).toEqual([]); // first observation seeds silently
    expect(wowState().realmStatus).toBe("UP"); // mutation: dropping `state.realmStatus = status` leaves this undefined

    _resetRealmPollThrottle();
    mockRealm("UP");
    await checkRealm(host);
    expect(announced).toEqual([]); // unchanged → no announcement

    _resetRealmPollThrottle();
    mockRealm("DOWN");
    await checkRealm(host);
    expect(announced).toEqual(["🔴 **argent-dawn** is down — servers are offline."]);
    expect(wowState().realmStatus).toBe("DOWN");

    _resetRealmPollThrottle();
    mockRealm("DOWN");
    await checkRealm(host);
    // Still one message: without the persisted status this line would re-announce the same DOWN.
    expect(announced).toHaveLength(1);

    _resetRealmPollThrottle();
    mockRealm("UP");
    await checkRealm(host);
    expect(announced).toEqual([
      "🔴 **argent-dawn** is down — servers are offline.",
      "🟢 **argent-dawn** is back up — servers are live!",
    ]);
  });

  test("the poll throttle skips a second call within the gap before any fetch", async () => {
    const host = makeFakeHost({ dataDir: dir });
    mockRealm("UP");
    await checkRealm(host);
    // No throttle reset — the next call must return early without touching fetch.
    globalThis.fetch = (async () => {
      throw new Error("should not fetch while throttled");
    }) as unknown as typeof fetch;
    await expect(checkRealm(host)).resolves.toBeUndefined();
  });

  test("does nothing when the realm watch isn't configured", async () => {
    initWowConfig({ WOW_REGION: "us" }); // no WOW_REALM, no creds → realmWatchConfigured() is false
    _resetRealmPollThrottle();
    globalThis.fetch = (async () => {
      throw new Error("should not fetch when unconfigured");
    }) as unknown as typeof fetch;
    await expect(checkRealm(makeFakeHost({ dataDir: dir }))).resolves.toBeUndefined();
  });
});

describe("checkDmf", () => {
  test("announces the open Faire at a fixed instant and persists the key so it never re-announces", async () => {
    const announced: string[] = [];
    const host = makeFakeHost({ dataDir: dir, announce: async (m) => void announced.push(m) });
    // config.dmfTimezone is America/Los_Angeles (the us default from beforeEach). One day into
    // September 2026's Faire window is guaranteed active, regardless of DST.
    const w = dmfWindow(2026, 8, "America/Los_Angeles");
    const during = new Date(w.start.getTime() + 24 * 60 * 60 * 1000);
    const decision = decideDmfAnnouncement(during, undefined, "America/Los_Angeles");
    expect(decision).not.toBeNull(); // guard: `during` really is inside a Faire window

    await checkDmf(host, during);
    const closes = Math.floor(w.end.getTime() / 1000);
    // Exact tick announcement text (mutation: any typo in the message → red).
    expect(announced).toEqual([`🎪 The **Darkmoon Faire** is open! It runs until <t:${closes}:F>.`]);
    // The dedup key is persisted (mutation: dropping `state.dmfAnnouncedFor = decision.key` → undefined).
    expect(wowState().dmfAnnouncedFor).toBe(decision!.key);

    // A second pass at the same instant must NOT re-announce — proving the persisted key dedups it
    // (mutation: dropping the key write makes this re-announce → length 2 → red).
    await checkDmf(host, during);
    expect(announced).toHaveLength(1);
  });

  test("does not re-announce a Faire whose key is already stored (dedup)", async () => {
    const announced: string[] = [];
    const host = makeFakeHost({ dataDir: dir, announce: async (m) => void announced.push(m) });
    // Store the CURRENT window's key so decideDmfAnnouncement returns null whether or not a Faire is
    // open right now — deterministic across every run date.
    wowState().dmfAnnouncedFor = dmfKey(currentOrNextDmf().window);
    await checkDmf(host);
    expect(announced).toEqual([]);
  });
});

describe("checkWeeklyReset", () => {
  test("announces the weekly reset inside the 10-minute window and persists the key so it never re-announces", async () => {
    const announced: string[] = [];
    const host = makeFakeHost({ dataDir: dir, announce: async (m) => void announced.push(m) });
    // config.region is "us" (beforeEach) → weekly reset Tuesday 15:00 UTC. Anchor to the most recent
    // reset and step 5 minutes past it — inside the announce window — derived, so no hand-computed day.
    const last = lastWeeklyReset(new Date("2026-09-16T20:00:00Z"));
    const justAfter = new Date(last.getTime() + 5 * 60 * 1000);

    await checkWeeklyReset(host, justAfter);
    // Exact tick announcement text (mutation: any typo → red).
    expect(announced).toEqual(["📅 **Weekly reset!** Vault, lockouts, and quests have rolled over."]);
    // The dedup key is persisted (mutation: dropping `state.weeklyAnnouncedFor = key` → unset).
    expect(wowState().weeklyAnnouncedFor).toBe(last.toISOString());

    await checkWeeklyReset(host, justAfter);
    expect(announced).toHaveLength(1); // persisted key dedups it (mutation: dropping the write → 2)
  });

  test("stays silent well outside the 10-minute post-reset window", async () => {
    const announced: string[] = [];
    const host = makeFakeHost({ dataDir: dir, announce: async (m) => void announced.push(m) });
    const last = lastWeeklyReset(new Date("2026-09-16T20:00:00Z"));
    const wellAfter = new Date(last.getTime() + 30 * 60 * 1000); // 30 min > RESET_ANNOUNCE_WINDOW_MS
    await checkWeeklyReset(host, wellAfter);
    expect(announced).toEqual([]);
  });
});
