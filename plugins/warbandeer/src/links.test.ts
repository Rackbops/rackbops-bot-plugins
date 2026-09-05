import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findAccountByToken,
  generateDeviceToken,
  generateLinkCode,
  hashToken,
  loadLinksFrom,
  type LinksState,
  mintLinkCode,
  redeemLinkCode,
  removeLinkedAccount,
  touchLinkedAccount,
  upsertLinkedAccount,
  verifyToken,
} from "./links.js";
import { makeRealStorage } from "./test-host.js";

const empty = (): LinksState => ({ pending: [], accounts: {} });

describe("generateLinkCode / generateDeviceToken", () => {
  test("a link code is 8 uppercase hex characters", () => {
    expect(generateLinkCode()).toMatch(/^[0-9A-F]{8}$/);
  });

  test("two generated codes/tokens are (almost certainly) distinct", () => {
    expect(generateLinkCode()).not.toBe(generateLinkCode());
    expect(generateDeviceToken()).not.toBe(generateDeviceToken());
  });
});

describe("hashToken / verifyToken", () => {
  test("a token verifies against its own hash", () => {
    const token = generateDeviceToken();
    expect(verifyToken(token, hashToken(token))).toBe(true);
  });

  test("a different token does not verify", () => {
    const hash = hashToken(generateDeviceToken());
    expect(verifyToken(generateDeviceToken(), hash)).toBe(false);
  });

  test("hashing is deterministic", () => {
    const token = "same-token";
    expect(hashToken(token)).toBe(hashToken(token));
  });
});

describe("mintLinkCode", () => {
  test("mints a code expiring 10 minutes out", () => {
    const now = 1_000_000;
    const { code, state } = mintLinkCode(empty(), "user-1", now);
    expect(state.pending).toEqual([{ code, discordUserId: "user-1", expiresAt: now + 10 * 60 * 1000 }]);
  });

  test("minting a second code for the same user invalidates the first", () => {
    const now = 1_000_000;
    const first = mintLinkCode(empty(), "user-1", now);
    const second = mintLinkCode(first.state, "user-1", now + 1);
    expect(second.state.pending).toHaveLength(1);
    expect(second.state.pending[0]?.code).toBe(second.code);
    expect(second.code).not.toBe(first.code);
  });

  test("minting for one user never touches another user's pending code", () => {
    const now = 1_000_000;
    const a = mintLinkCode(empty(), "user-a", now);
    const b = mintLinkCode(a.state, "user-b", now);
    expect(b.state.pending).toHaveLength(2);
    expect(b.state.pending.map((p) => p.discordUserId).sort()).toEqual(["user-a", "user-b"]);
  });

  test("regenerates when the generator collides with another user's pending code", () => {
    const now = 1_000_000;
    const a = mintLinkCode(empty(), "user-a", now, () => "COLLIDE1");
    // Forced sequence: first call collides with user-a's code, second call is distinct.
    const calls = ["COLLIDE1", "UNIQUE01"];
    let i = 0;
    const b = mintLinkCode(a.state, "user-b", now, () => calls[i++] ?? "fallback");
    expect(b.code).toBe("UNIQUE01");
    expect(i).toBe(2); // proves the collision was actually detected and retried, not skipped
    expect(b.state.pending.map((p) => p.code).sort()).toEqual(["COLLIDE1", "UNIQUE01"]);
  });

  test("never regenerates when there's no collision (doesn't call the generator twice for nothing)", () => {
    const now = 1_000_000;
    let calls = 0;
    const generate = () => {
      calls += 1;
      return "ONLYCALL";
    };
    mintLinkCode(empty(), "user-a", now, generate);
    expect(calls).toBe(1);
  });
});

describe("redeemLinkCode", () => {
  test("redeems a valid, unexpired code", () => {
    const now = 1_000_000;
    const minted = mintLinkCode(empty(), "user-1", now);
    const result = redeemLinkCode(minted.state, minted.code, now + 1000);
    expect(result).toMatchObject({ ok: true, discordUserId: "user-1" });
    expect(result.state.pending).toEqual([]);
  });

  test("an unknown code fails not-found and leaves other pending codes untouched", () => {
    const now = 1_000_000;
    const minted = mintLinkCode(empty(), "user-1", now);
    const result = redeemLinkCode(minted.state, "NOTREAL1", now);
    expect(result).toMatchObject({ ok: false, reason: "not-found" });
    expect(result.state.pending).toHaveLength(1);
  });

  test("an expired code fails expired and is still burned (removed from pending)", () => {
    const now = 1_000_000;
    const minted = mintLinkCode(empty(), "user-1", now);
    const result = redeemLinkCode(minted.state, minted.code, now + 11 * 60 * 1000);
    expect(result).toMatchObject({ ok: false, reason: "expired" });
    expect(result.state.pending).toEqual([]);
  });

  test("redeeming the same code twice fails the second time (single-use)", () => {
    const now = 1_000_000;
    const minted = mintLinkCode(empty(), "user-1", now);
    const first = redeemLinkCode(minted.state, minted.code, now);
    const second = redeemLinkCode(first.state, minted.code, now);
    expect(second).toMatchObject({ ok: false, reason: "not-found" });
  });
});

describe("upsertLinkedAccount", () => {
  test("appends a new account label", () => {
    const state = upsertLinkedAccount(empty(), "user-1", "Main", "hash-1", 100);
    expect(state.accounts["user-1"]).toEqual([
      { accountLabel: "Main", tokenHash: "hash-1", linkedAt: 100, updatedAt: 100 },
    ]);
  });

  test("a second distinct label appends rather than replaces", () => {
    let state = upsertLinkedAccount(empty(), "user-1", "Main", "hash-1", 100);
    state = upsertLinkedAccount(state, "user-1", "Alts", "hash-2", 200);
    expect(state.accounts["user-1"]?.map((a) => a.accountLabel)).toEqual(["Main", "Alts"]);
  });

  test("re-linking the same label rotates the token and updatedAt, keeps linkedAt", () => {
    let state = upsertLinkedAccount(empty(), "user-1", "Main", "hash-1", 100);
    state = upsertLinkedAccount(state, "user-1", "Main", "hash-2", 200);
    expect(state.accounts["user-1"]).toEqual([
      { accountLabel: "Main", tokenHash: "hash-2", linkedAt: 100, updatedAt: 200 },
    ]);
  });
});

describe("removeLinkedAccount", () => {
  test("removes a matching account", () => {
    const linked = upsertLinkedAccount(empty(), "user-1", "Main", "hash-1", 100);
    const result = removeLinkedAccount(linked, "user-1", "Main");
    expect(result?.removed.accountLabel).toBe("Main");
    expect(result?.state.accounts["user-1"]).toBeUndefined();
  });

  test("drops only the matched label, keeping the others", () => {
    let linked = upsertLinkedAccount(empty(), "user-1", "Main", "hash-1", 100);
    linked = upsertLinkedAccount(linked, "user-1", "Alts", "hash-2", 200);
    const result = removeLinkedAccount(linked, "user-1", "Main");
    expect(result?.state.accounts["user-1"]?.map((a) => a.accountLabel)).toEqual(["Alts"]);
  });

  test("an unknown label returns undefined, state unchanged", () => {
    const linked = upsertLinkedAccount(empty(), "user-1", "Main", "hash-1", 100);
    expect(removeLinkedAccount(linked, "user-1", "Nope")).toBeUndefined();
  });

  test("an unknown user returns undefined", () => {
    expect(removeLinkedAccount(empty(), "nobody", "Main")).toBeUndefined();
  });
});

describe("touchLinkedAccount", () => {
  test("bumps updatedAt on the matching account only", () => {
    let state = upsertLinkedAccount(empty(), "user-1", "Main", "hash-1", 100);
    state = upsertLinkedAccount(state, "user-1", "Alts", "hash-2", 100);
    const touched = touchLinkedAccount(state, "user-1", "Main", 999);
    expect(touched.accounts["user-1"]?.find((a) => a.accountLabel === "Main")?.updatedAt).toBe(999);
    expect(touched.accounts["user-1"]?.find((a) => a.accountLabel === "Alts")?.updatedAt).toBe(100);
  });

  test("a since-unlinked account is a no-op, not a throw", () => {
    const result = touchLinkedAccount(empty(), "user-1", "Main", 999);
    expect(result).toEqual(empty());
  });
});

describe("findAccountByToken", () => {
  test("finds the owning user across multiple users", () => {
    const tokenA = "token-a";
    const tokenB = "token-b";
    let state = upsertLinkedAccount(empty(), "user-a", "Main", hashToken(tokenA), 100);
    state = upsertLinkedAccount(state, "user-b", "Main", hashToken(tokenB), 100);
    expect(findAccountByToken(state, tokenB)).toMatchObject({ discordUserId: "user-b" });
  });

  test("resolves the correct account among several the SAME user holds, not just the first", () => {
    const tokenMain = "token-main";
    const tokenAlts = "token-alts";
    let state = upsertLinkedAccount(empty(), "user-a", "Main", hashToken(tokenMain), 100);
    state = upsertLinkedAccount(state, "user-a", "Alts", hashToken(tokenAlts), 100);
    expect(findAccountByToken(state, tokenAlts)).toMatchObject({
      discordUserId: "user-a",
      account: { accountLabel: "Alts" },
    });
    expect(findAccountByToken(state, tokenMain)).toMatchObject({
      discordUserId: "user-a",
      account: { accountLabel: "Main" },
    });
  });

  test("an unknown token resolves undefined", () => {
    const state = upsertLinkedAccount(empty(), "user-a", "Main", hashToken("real-token"), 100);
    expect(findAccountByToken(state, "wrong-token")).toBeUndefined();
  });
});

describe("loadLinksFrom", () => {
  test("an absent file resolves fresh state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "links-test-"));
    try {
      expect(await loadLinksFrom(join(dir, "links.json"), makeRealStorage())).toEqual(empty());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file missing pending/accounts (partial or hand-edited) degrades to fresh state, not a throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "links-test-"));
    try {
      const file = join(dir, "links.json");
      await Bun.write(file, JSON.stringify({ accounts: { "user-1": [] } })); // no "pending" key
      const result = await loadLinksFrom(file, makeRealStorage());
      expect(result).toEqual({ pending: [], accounts: { "user-1": [] } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
