import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakeHost } from "../../../packages/testkit/index.js";
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
  await initWowStore(makeFakeHost({ name: "wow", dataDir: dir })); // fresh install → wowState() === {}
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

describe("checkRealm", () => {
  test("seeds silently, announces only on a transition, and persists the status so it never re-announces", async () => {
    const announced: string[] = [];
    const host = makeFakeHost({ name: "wow", dataDir: dir, announce: async (m) => void announced.push(m) });

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

  test("a run the host has aborted announces and persists nothing", async () => {
    const announced: string[] = [];
    const host = makeFakeHost({ name: "wow", dataDir: dir, announce: async (m) => void announced.push(m) });
    mockRealm("UP");
    await checkRealm(host); // seed UP
    _resetRealmPollThrottle();
    mockRealm("DOWN");
    await checkRealm(host, AbortSignal.abort());
    expect(announced).toEqual([]);
    expect(wowState().realmStatus).toBe("UP");
  });

  test("the poll throttle skips a second call within the gap before any fetch", async () => {
    const host = makeFakeHost({ name: "wow", dataDir: dir });
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
    await expect(checkRealm(makeFakeHost({ name: "wow", dataDir: dir }))).resolves.toBeUndefined();
  });
});

describe("checkDmf", () => {
  test("announces the open Faire at a fixed instant and persists the key so it never re-announces", async () => {
    const announced: string[] = [];
    const host = makeFakeHost({ name: "wow", dataDir: dir, announce: async (m) => void announced.push(m) });
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
    const host = makeFakeHost({ name: "wow", dataDir: dir, announce: async (m) => void announced.push(m) });
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
    const host = makeFakeHost({ name: "wow", dataDir: dir, announce: async (m) => void announced.push(m) });
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

  test("at a hand-written instant the dedup key is the literal Tuesday reset (the expectation is not derived from the code)", async () => {
    const host = makeFakeHost({ name: "wow", dataDir: dir, announce: async () => {} });
    await checkWeeklyReset(host, new Date("2026-09-15T15:05:00Z")); // 2026-09-15 is a Tuesday
    expect(wowState().weeklyAnnouncedFor).toBe("2026-09-15T15:00:00.000Z");
  });

  test("stays silent well outside the 10-minute post-reset window", async () => {
    const announced: string[] = [];
    const host = makeFakeHost({ name: "wow", dataDir: dir, announce: async (m) => void announced.push(m) });
    const last = lastWeeklyReset(new Date("2026-09-16T20:00:00Z"));
    const wellAfter = new Date(last.getTime() + 30 * 60 * 1000); // 30 min > RESET_ANNOUNCE_WINDOW_MS
    await checkWeeklyReset(host, wellAfter);
    expect(announced).toEqual([]);
  });
});

// The dedup key is written BEFORE host.announce (README: "Write your dedup key before you announce"), so a
// stop that outlasts the grace while a post is in flight cannot re-announce after the restart (#200 wow-1).
describe("the dedup key is written before the announcement", () => {
  const onDisk = () => JSON.parse(readFileSync(join(dir, "wow.json"), "utf8")) as Record<string, unknown>;
  const during = () => {
    const w = dmfWindow(2026, 8, "America/Los_Angeles");
    return new Date(w.start.getTime() + 24 * 60 * 60 * 1000);
  };
  const justAfterReset = () => new Date(lastWeeklyReset(new Date("2026-09-16T20:00:00Z")).getTime() + 5 * 60 * 1000);

  test("checkDmf: when announce runs, the key is already in memory and in wow.json", async () => {
    let seen: { memory?: string; disk?: unknown } = {};
    const host = makeFakeHost({
      name: "wow",
      dataDir: dir,
      announce: async () => {
        seen = { memory: wowState().dmfAnnouncedFor, disk: onDisk().dmfAnnouncedFor };
      },
    });
    const key = decideDmfAnnouncement(during(), undefined, "America/Los_Angeles")!.key;
    await checkDmf(host, during());
    expect(seen).toEqual({ memory: key, disk: key }); // mutation: announcing first leaves both undefined
  });

  test("checkDmf: a rejected announce puts the key back, in memory and on disk, and the next tick retries", async () => {
    let fail = true;
    const announced: string[] = [];
    const host = makeFakeHost({
      name: "wow",
      dataDir: dir,
      announce: async (m) => {
        if (fail) throw new Error("discord down");
        announced.push(m);
      },
    });
    await expect(checkDmf(host, during())).rejects.toThrow("discord down");
    expect(wowState().dmfAnnouncedFor).toBeUndefined();
    expect(onDisk().dmfAnnouncedFor).toBeUndefined();
    fail = false;
    await checkDmf(host, during());
    expect(announced).toHaveLength(1);
  });

  test("checkWeeklyReset: key first, and a rejected announce restores the previous key", async () => {
    const previous = "2026-09-08T15:00:00.000Z";
    wowState().weeklyAnnouncedFor = previous;
    const expected = lastWeeklyReset(justAfterReset()).toISOString();
    let seen: unknown;
    let fail = false;
    const host = makeFakeHost({
      name: "wow",
      dataDir: dir,
      announce: async () => {
        seen = onDisk().weeklyAnnouncedFor;
        if (fail) throw new Error("discord down");
      },
    });
    await checkWeeklyReset(host, justAfterReset());
    expect(seen).toBe(expected);

    wowState().weeklyAnnouncedFor = previous;
    fail = true;
    await expect(checkWeeklyReset(host, justAfterReset())).rejects.toThrow("discord down");
    expect(wowState().weeklyAnnouncedFor).toBe(previous); // mutation: no rollback leaves the new key, silencing the retry
    expect(onDisk().weeklyAnnouncedFor).toBe(previous);
  });

  test("checkRealm: status first, and a rejected announce restores the previous status", async () => {
    let seen: unknown;
    let fail = false;
    const host = makeFakeHost({
      name: "wow",
      dataDir: dir,
      announce: async () => {
        seen = onDisk().realmStatus;
        if (fail) throw new Error("discord down");
      },
    });
    mockRealm("UP");
    await checkRealm(host); // seed
    _resetRealmPollThrottle();
    mockRealm("DOWN");
    await checkRealm(host);
    expect(seen).toBe("DOWN");

    _resetRealmPollThrottle();
    mockRealm("UP");
    fail = true;
    await expect(checkRealm(host)).rejects.toThrow("discord down");
    expect(wowState().realmStatus).toBe("DOWN"); // the up-announcement is retried on the next poll
    expect(onDisk().realmStatus).toBe("DOWN");
    expect(wowState().realmKey).toBe("us/argent-dawn");
  });

  test("a save that fails before the announce restores the key and surfaces that error", async () => {
    const real = makeFakeHost({ name: "wow", dataDir: dir });
    let failSaves = false;
    _resetWowStore();
    await initWowStore({
      ...real,
      storage: {
        ...real.storage,
        createJsonWriter: <T,>(path: string) => {
          const w = real.storage.createJsonWriter<T>(path);
          return { ...w, save: async (d: T) => (failSaves ? Promise.reject(new Error("disk full")) : w.save(d)) };
        },
      },
    });
    let announces = 0;
    const host = makeFakeHost({ name: "wow", dataDir: dir, announce: async () => void announces++ });
    failSaves = true;
    await expect(checkWeeklyReset(host, justAfterReset())).rejects.toThrow("disk full");
    expect(announces).toBe(0);
    expect(wowState().weeklyAnnouncedFor).toBeUndefined(); // mutation: a key left in memory skips the post for the process
    failSaves = false;
    await checkWeeklyReset(host, justAfterReset());
    expect(announces).toBe(1);
  });
});

// wow.json used to hold one realmStatus with no realm or region (#200 wow-5).
describe("a stored realm status belongs to the realm it was read for", () => {
  const onDisk = () => JSON.parse(readFileSync(join(dir, "wow.json"), "utf8")) as Record<string, unknown>;
  test("switching realms seeds silently instead of announcing a phantom transition", async () => {
    const announced: string[] = [];
    const host = makeFakeHost({ name: "wow", dataDir: dir, announce: async (m) => void announced.push(m) });
    mockRealm("UP");
    await checkRealm(host); // argent-dawn seeded UP
    expect(wowState().realmKey).toBe("us/argent-dawn");

    initWowConfig({ WOW_REGION: "us", WOW_REALM: "area-52", BLIZZARD_CLIENT_ID: "id", BLIZZARD_CLIENT_SECRET: "secret" });
    _resetRealmPollThrottle();
    mockRealm("DOWN");
    await checkRealm(host);
    expect(announced).toEqual([]); // mutation: ignoring the key announces "area-52 is down"
    expect(wowState()).toMatchObject({ realmStatus: "DOWN", realmKey: "us/area-52" });
    expect(onDisk()).toMatchObject({ realmStatus: "DOWN", realmKey: "us/area-52" }); // the silent branch saves

    _resetRealmPollThrottle();
    mockRealm("UP");
    await checkRealm(host);
    expect(announced).toEqual(["🟢 **area-52** is back up — servers are live!"]); // and it tracks the new realm from here
  });

  test("switching realms to one with the same status still records the new key", async () => {
    const announced: string[] = [];
    const host = makeFakeHost({ name: "wow", dataDir: dir, announce: async (m) => void announced.push(m) });
    mockRealm("UP");
    await checkRealm(host);
    initWowConfig({ WOW_REGION: "us", WOW_REALM: "area-52", BLIZZARD_CLIENT_ID: "id", BLIZZARD_CLIENT_SECRET: "secret" });
    _resetRealmPollThrottle();
    await checkRealm(host); // area-52 is UP too: no status change, but the key must move
    expect(onDisk().realmKey).toBe("us/area-52");
    _resetRealmPollThrottle();
    mockRealm("DOWN");
    await checkRealm(host);
    expect(announced).toEqual(["🔴 **area-52** is down — servers are offline."]); // mutation: a stale key swallows this
  });

  test("switching region counts the same", async () => {
    const announced: string[] = [];
    const host = makeFakeHost({ name: "wow", dataDir: dir, announce: async (m) => void announced.push(m) });
    mockRealm("UP");
    await checkRealm(host);
    initWowConfig({ WOW_REGION: "eu", WOW_REALM: "argent-dawn", BLIZZARD_CLIENT_ID: "id", BLIZZARD_CLIENT_SECRET: "secret" });
    _resetRealmPollThrottle();
    mockRealm("DOWN");
    await checkRealm(host);
    expect(announced).toEqual([]);
    expect(wowState().realmKey).toBe("eu/argent-dawn");
  });

  test("a status stored before the key existed is read as the realm configured now", async () => {
    const announced: string[] = [];
    const host = makeFakeHost({ name: "wow", dataDir: dir, announce: async (m) => void announced.push(m) });
    wowState().realmStatus = "UP"; // as seeded from an older wow.json or the bot's state.json: no realmKey
    mockRealm("DOWN");
    await checkRealm(host);
    expect(announced).toEqual(["🔴 **argent-dawn** is down — servers are offline."]);
    expect(wowState().realmKey).toBe("us/argent-dawn");
  });
});
