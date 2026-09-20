import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginPendingAuth,
  commit,
  freshState,
  generateStateToken,
  initStore,
  PENDING_AUTH_TTL_MS,
  prunePending,
  putConnection,
  redeemPendingAuth,
  removeConnection,
  resetStoreForTest,
  musicState,
  type MusicState,
} from "./store.js";
import { makeFakeHost, makeRealStorage } from "./test-host.js";

const NOW = 1_700_000_000_000;

function withPending(token: string, discordUserId: string, expiresAt: number): MusicState {
  return { connections: {}, pending: { [token]: { discordUserId, expiresAt } } };
}

describe("pending handshakes", () => {
  test("a fresh handshake expires ten minutes out", () => {
    const state = beginPendingAuth(freshState(), "T", "user1", NOW);
    expect(state.pending.T).toEqual({ discordUserId: "user1", expiresAt: NOW + PENDING_AUTH_TTL_MS });
  });

  test("redeeming yields the Discord user who started it", () => {
    const state = beginPendingAuth(freshState(), "T", "user1", NOW);
    const redeemed = redeemPendingAuth(state, "T", NOW + 1000);
    expect(redeemed.ok && redeemed.discordUserId).toBe("user1");
  });

  test("a token is SINGLE-USE -- a leaked callback URL cannot be replayed", () => {
    const state = beginPendingAuth(freshState(), "T", "user1", NOW);
    const first = redeemPendingAuth(state, "T", NOW + 1000);
    expect(first.ok).toBe(true);
    const second = redeemPendingAuth(first.state, "T", NOW + 2000);
    expect(second).toMatchObject({ ok: false, reason: "unknown" });
  });

  test("an expired token is rejected as expired, and still consumed", () => {
    const state = withPending("T", "user1", NOW - 1);
    const redeemed = redeemPendingAuth(state, "T", NOW);
    expect(redeemed).toMatchObject({ ok: false, reason: "expired" });
    expect(redeemed.state.pending.T).toBeUndefined();
  });

  test("an unknown token is rejected without touching anyone else's handshake", () => {
    const state = beginPendingAuth(freshState(), "MINE", "user1", NOW);
    const redeemed = redeemPendingAuth(state, "THEIRS", NOW);
    expect(redeemed).toMatchObject({ ok: false, reason: "unknown" });
    expect(redeemed.state.pending.MINE).toBeDefined();
  });

  test("a second connect REPLACES the same user's earlier link, invalidating it", () => {
    const first = beginPendingAuth(freshState(), "T1", "user1", NOW);
    const second = beginPendingAuth(first, "T2", "user1", NOW + 1000);
    expect(second.pending.T1).toBeUndefined();
    expect(second.pending.T2).toBeDefined();
    expect(redeemPendingAuth(second, "T1", NOW + 2000)).toMatchObject({ ok: false });
  });

  test("one user's connect does not disturb another user's pending link", () => {
    const first = beginPendingAuth(freshState(), "T1", "user1", NOW);
    const second = beginPendingAuth(first, "T2", "user2", NOW + 1000);
    expect(second.pending.T1).toBeDefined();
    expect(second.pending.T2).toBeDefined();
  });

  test("pruning drops only what has actually expired", () => {
    const state: MusicState = {
      connections: {},
      pending: { dead: { discordUserId: "a", expiresAt: NOW - 1 }, alive: { discordUserId: "b", expiresAt: NOW + 1 } },
    };
    const pruned = prunePending(state, NOW);
    expect(Object.keys(pruned.pending)).toEqual(["alive"]);
  });
});

describe("connections", () => {
  test("a connection is stored and replaced by user id", () => {
    const first = putConnection(freshState(), "user1", "RT1", NOW);
    expect(first.connections.user1).toEqual({ refreshToken: "RT1", connectedAt: NOW });
    const rotated = putConnection(first, "user1", "RT2", NOW + 5);
    expect(rotated.connections.user1).toEqual({ refreshToken: "RT2", connectedAt: NOW + 5 });
  });

  test("removing one user's connection leaves the others alone", () => {
    let state = putConnection(freshState(), "user1", "RT1", NOW);
    state = putConnection(state, "user2", "RT2", NOW);
    const after = removeConnection(state, "user1");
    expect(after.connections.user1).toBeUndefined();
    expect(after.connections.user2).toBeDefined();
  });

  test("removing an absent connection is a no-op, not a throw", () => {
    expect(removeConnection(freshState(), "nobody").connections).toEqual({});
  });
});

describe("generateStateToken", () => {
  test("is URL-safe, long, and different every time", () => {
    const a = generateStateToken();
    const b = generateStateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(a)).toBe(a);
  });
});

describe("the host-backed singleton", () => {
  test("initStore reads an existing file and commit round-trips through real atomic writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "music-store-"));
    try {
      const storage = makeRealStorage();
      const host = makeFakeHost({ dataDir: dir, storage });
      await initStore(host);
      expect(musicState()).toEqual(freshState());

      await commit(putConnection(musicState(), "user1", "RT1", NOW));
      // A second init, as a restarted bot would do, must see the persisted connection.
      resetStoreForTest(freshState());
      await initStore(host);
      expect(musicState().connections.user1).toEqual({ refreshToken: "RT1", connectedAt: NOW });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a file missing its maps is repaired rather than throwing on first access", async () => {
    const dir = await mkdtemp(join(tmpdir(), "music-store-"));
    try {
      await Bun.write(join(dir, "music.json"), JSON.stringify({ connections: null }));
      await initStore(makeFakeHost({ dataDir: dir, storage: makeRealStorage() }));
      expect(musicState().connections).toEqual({});
      expect(musicState().pending).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("recorded scopes", () => {
  test("a rotation keeps the recorded scopes -- otherwise a refresh would demote the connection", () => {
    const granted = putConnection(freshState(), "user1", "RT1", NOW, "a b");
    const rotated = putConnection(granted, "user1", "RT2", NOW + 5);
    expect(rotated.connections.user1?.scopes).toBe("a b");
  });

  test("a new grant replaces the old one, so narrowing in Spotify's settings is noticed", () => {
    const granted = putConnection(freshState(), "user1", "RT1", NOW, "a b");
    const narrowed = putConnection(granted, "user1", "RT1", NOW + 5, "a");
    expect(narrowed.connections.user1?.scopes).toBe("a");
  });

  test("the scopes a handshake asked for survive to its redemption", () => {
    const state = beginPendingAuth(freshState(), "TOK", "user1", NOW, "a b");
    const redeemed = redeemPendingAuth(state, "TOK", NOW + 1);
    expect(redeemed.ok && redeemed.scopes).toBe("a b");
  });
});
