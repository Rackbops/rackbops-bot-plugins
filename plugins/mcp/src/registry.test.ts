import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeRealStorage } from "../../../packages/testkit/index.js";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  createRegistryStore,
  freshRegistry,
  generateCode,
  generateGeneration,
  generationOf,
  hashCode,
  issueCode,
  pruneRegistry,
  redeemCode,
  registerUser,
  unregisterUser,
  type RegistryStore,
} from "./registry.js";

const USER = "111111111111111111";
const OTHER_USER = "222222222222222222";
const NOW = new Date("2026-09-25T00:00:00.000Z");
const NAME = "Ash";

describe("generateGeneration", () => {
  test("128 bits, base64url, 22 characters, no padding", () => {
    const gen = generateGeneration();
    expect(gen).toHaveLength(22);
    expect(gen).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test("two calls never collide in a reasonable sample", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateGeneration()));
    expect(seen.size).toBe(1000);
  });
});

describe("generateCode", () => {
  test("exactly 27 characters, uppercase, from the declared alphabet", () => {
    const code = generateCode();
    expect(code).toHaveLength(27);
    for (const ch of code) expect(CODE_ALPHABET.includes(ch)).toBe(true);
    expect(code).toMatch(/^[A-Z2-9]{27}$/); // the wire contract's own validation regex
  });

  test("entropy is at least 128 bits (round-3 review: 26 characters fell ~0.42 bits short)", () => {
    expect(CODE_LENGTH * Math.log2(CODE_ALPHABET.length)).toBeGreaterThanOrEqual(128);
    const code = generateCode();
    expect(code).toHaveLength(27);
    expect(code).toMatch(/^[A-Z2-9]{27}$/);
  });

  test("never contains 0, 1, I, L, O or U -- the whole point of this alphabet", () => {
    const code = generateCode();
    for (const excluded of ["0", "1", "I", "L", "O", "U"]) expect(code).not.toContain(excluded);
  });

  test("two calls never collide in a reasonable sample", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateCode()));
    expect(seen.size).toBe(500);
  });
});

describe("hashCode", () => {
  test("deterministic, and never equal to the code itself", () => {
    const code = "ABCDEFGHJKMNPQRSTVWXYZ23456";
    const hash = hashCode(code);
    expect(hash).toBe(hashCode(code));
    expect(hash).not.toBe(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });
});

describe("registerUser", () => {
  test("mints a generation for a fresh user", () => {
    const { registry, outcome } = registerUser(freshRegistry(), USER, NAME, NOW);
    expect(outcome.changed).toBe(true);
    expect(outcome.generation).toHaveLength(22);
    expect(registry.users[USER]).toEqual({ generation: outcome.generation, displayName: NAME, registeredAt: NOW.toISOString(), codes: [] });
  });

  test("is a no-op when already registered, returning the EXISTING generation", () => {
    const first = registerUser(freshRegistry(), USER, NAME, NOW);
    const second = registerUser(first.registry, USER, "A different name", new Date(NOW.getTime() + 1000));
    expect(second.outcome).toEqual({ changed: false, generation: first.outcome.generation });
    // Nothing about the stored entry changes on the no-op path (not even displayName).
    expect(second.registry).toBe(first.registry);
  });

  test("registering two different users is independent", () => {
    const a = registerUser(freshRegistry(), USER, NAME, NOW);
    const b = registerUser(a.registry, OTHER_USER, "Bea", NOW);
    expect(b.registry.users[USER]!.generation).toBe(a.outcome.generation);
    expect(b.registry.users[OTHER_USER]!.generation).not.toBe(a.outcome.generation);
  });

  test("an inherited-property-shaped user id is never confused with a real entry", () => {
    const registry = freshRegistry();
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const { outcome } = registerUser(registry, id, NAME, NOW);
      expect(outcome.changed).toBe(true); // never silently "already registered" via an inherited key
    }
  });
});

describe("issueCode", () => {
  test("refuses when the user has no entry, with no registry change", () => {
    const registry = freshRegistry();
    const { registry: next, outcome } = issueCode(registry, USER, NAME, NOW);
    expect(outcome).toEqual({ ok: false });
    expect(next).toBe(registry);
  });

  test("issues a code, storing only its hash, with a 10-minute expiry", () => {
    const registered = registerUser(freshRegistry(), USER, NAME, NOW).registry;
    const { registry, outcome } = issueCode(registered, USER, NAME, NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    const stored = registry.users[USER]!.codes;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.hash).toBe(hashCode(outcome.code));
    expect(JSON.stringify(registry)).not.toContain(outcome.code); // the raw code is never persisted
    expect(new Date(stored[0]!.expiresAt).getTime() - NOW.getTime()).toBe(10 * 60 * 1000);
  });

  test("refreshes displayName (decision 2: captured at register AND pair time)", () => {
    const registered = registerUser(freshRegistry(), USER, "Old Name", NOW).registry;
    const { registry } = issueCode(registered, USER, "New Name", NOW);
    expect(registry.users[USER]!.displayName).toBe("New Name");
  });

  test("a 6th code drops the oldest, keeping at most 5", () => {
    let registry = registerUser(freshRegistry(), USER, NAME, NOW).registry;
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const result = issueCode(registry, USER, NAME, new Date(NOW.getTime() + i));
      registry = result.registry;
      if (result.outcome.ok) codes.push(result.outcome.code);
    }
    expect(registry.users[USER]!.codes).toHaveLength(5);
    // The first-issued code's hash is gone; the other five remain.
    const remainingHashes = registry.users[USER]!.codes.map((c) => c.hash);
    expect(remainingHashes).not.toContain(hashCode(codes[0]!));
    for (const code of codes.slice(1)) expect(remainingHashes).toContain(hashCode(code));
  });
});

describe("pruneRegistry", () => {
  test("strips expired codes, keeps live ones, never removes the user entry itself", () => {
    const registered = registerUser(freshRegistry(), USER, NAME, NOW).registry;
    const withCode = issueCode(registered, USER, NAME, NOW).registry;
    const stillLive = pruneRegistry(withCode, new Date(NOW.getTime() + 5 * 60 * 1000));
    expect(stillLive.users[USER]!.codes).toHaveLength(1);

    const afterExpiry = pruneRegistry(withCode, new Date(NOW.getTime() + 11 * 60 * 1000));
    expect(afterExpiry.users[USER]!.codes).toHaveLength(0);
    expect(afterExpiry.users[USER]).toBeDefined(); // the registration itself survives
  });

  test("returns the same object (no-op) when nothing needed pruning", () => {
    const registry = registerUser(freshRegistry(), USER, NAME, NOW).registry;
    expect(pruneRegistry(registry, NOW)).toBe(registry);
  });
});

describe("unregisterUser", () => {
  test("deletes the entry and every code in one shot", () => {
    const registered = registerUser(freshRegistry(), USER, NAME, NOW).registry;
    const withCode = issueCode(registered, USER, NAME, NOW).registry;
    const { registry, changed } = unregisterUser(withCode, USER);
    expect(changed).toBe(true);
    expect(Object.hasOwn(registry.users, USER)).toBe(false);
  });

  test("is a no-op, changed: false, for a user who was never registered", () => {
    const registry = freshRegistry();
    const result = unregisterUser(registry, USER);
    expect(result.changed).toBe(false);
    expect(result.registry).toBe(registry);
  });
});

describe("redeemCode", () => {
  test("succeeds once: returns the user id and generation, and removes exactly that code", () => {
    const registered = registerUser(freshRegistry(), USER, NAME, NOW);
    const issued = issueCode(registered.registry, USER, NAME, NOW);
    if (!issued.outcome.ok) throw new Error("unreachable");

    const { registry, outcome } = redeemCode(issued.registry, issued.outcome.code, NOW);
    expect(outcome).toEqual({ ok: true, discordUserId: USER, generation: registered.outcome.generation });
    expect(registry.users[USER]!.codes).toHaveLength(0);
  });

  test("a second redeem of the same code fails -- single use", () => {
    const registered = registerUser(freshRegistry(), USER, NAME, NOW).registry;
    const issued = issueCode(registered, USER, NAME, NOW);
    if (!issued.outcome.ok) throw new Error("unreachable");
    const first = redeemCode(issued.registry, issued.outcome.code, NOW);
    const second = redeemCode(first.registry, issued.outcome.code, NOW);
    expect(second.outcome).toEqual({ ok: false });
  });

  test("an unknown code fails", () => {
    const { outcome } = redeemCode(freshRegistry(), "NOTAREALCODEXXXXXXXXXXXXXX", NOW);
    expect(outcome).toEqual({ ok: false });
  });

  test("an expired code fails (via pruning -- redeemCode itself assumes an already-pruned registry)", () => {
    const registered = registerUser(freshRegistry(), USER, NAME, NOW).registry;
    const issued = issueCode(registered, USER, NAME, NOW);
    if (!issued.outcome.ok) throw new Error("unreachable");
    const pruned = pruneRegistry(issued.registry, new Date(NOW.getTime() + 11 * 60 * 1000));
    const { outcome } = redeemCode(pruned, issued.outcome.code, new Date(NOW.getTime() + 11 * 60 * 1000));
    expect(outcome).toEqual({ ok: false });
  });

  test("a code issued before an unregister fails -- the whole entry, and its codes, are gone", () => {
    const registered = registerUser(freshRegistry(), USER, NAME, NOW).registry;
    const issued = issueCode(registered, USER, NAME, NOW);
    if (!issued.outcome.ok) throw new Error("unreachable");
    const unregistered = unregisterUser(issued.registry, USER).registry;
    const { outcome } = redeemCode(unregistered, issued.outcome.code, NOW);
    expect(outcome).toEqual({ ok: false });
  });
});

describe("generationOf", () => {
  test("returns the generation for a registered user, undefined otherwise", () => {
    const registry = registerUser(freshRegistry(), USER, NAME, NOW).registry;
    expect(generationOf(registry, USER)).toBe(registry.users[USER]!.generation);
    expect(generationOf(registry, OTHER_USER)).toBeUndefined();
  });
});

describe("createRegistryStore: concurrency, over real storage", () => {
  let dir: string;
  let store: RegistryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-registry-"));
    store = createRegistryStore(dir, makeRealStorage());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("two concurrent register calls for one user mint exactly one generation", async () => {
    const now = () => new Date();
    const [a, b] = await Promise.all([store.register(USER, NAME, now), store.register(USER, NAME, now)]);
    expect(a.generation).toBe(b.generation);
    expect([a.changed, b.changed].filter(Boolean)).toHaveLength(1); // exactly one of them actually minted it
  });

  test("two concurrent redeems of ONE code succeed exactly once", async () => {
    const now = () => new Date();
    await store.register(USER, NAME, now);
    const paired = await store.pair(USER, NAME, now);
    if (!paired.ok) throw new Error("unreachable");

    const [a, b] = await Promise.all([store.redeem(paired.code, now), store.redeem(paired.code, now)]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });

  test("register -> pair -> redeem -> generationOf round-trips through real storage", async () => {
    const now = () => new Date();
    await store.register(USER, NAME, now);
    const paired = await store.pair(USER, NAME, now);
    if (!paired.ok) throw new Error("unreachable");
    const redeemed = await store.redeem(paired.code, now);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) throw new Error("unreachable");
    expect(await store.generationOf(USER)).toBe(redeemed.generation);
  });

  test("unregister then pair refuses -- the codes and the registration are really gone", async () => {
    const now = () => new Date();
    await store.register(USER, NAME, now);
    await store.unregister(USER, now);
    const result = await store.pair(USER, NAME, now);
    expect(result).toEqual({ ok: false });
    expect(await store.generationOf(USER)).toBeUndefined();
  });

  test("listRecipients: empty when nothing is registered", async () => {
    expect(await store.listRecipients()).toEqual([]);
  });

  test("listRecipients: every registered user, with userId/displayName/registeredAt", async () => {
    const now = () => new Date("2026-09-25T00:00:00.000Z");
    await store.register(USER, NAME, now);
    await store.register(OTHER_USER, "Bee", now);
    const recipients = await store.listRecipients();
    expect(recipients).toHaveLength(2);
    expect(recipients).toEqual(
      expect.arrayContaining([
        { userId: USER, displayName: NAME, registeredAt: now().toISOString() },
        { userId: OTHER_USER, displayName: "Bee", registeredAt: now().toISOString() },
      ]),
    );
  });

  test("listRecipients: an unregistered user disappears", async () => {
    const now = () => new Date();
    await store.register(USER, NAME, now);
    await store.unregister(USER, now);
    expect(await store.listRecipients()).toEqual([]);
  });
});

describe("createRegistryStore: pruning uses the caller's own injected clock, not wall-clock time", () => {
  let dir: string;
  let store: RegistryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-registry-"));
    store = createRegistryStore(dir, makeRealStorage());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a code paired on a clock a day behind real time still redeems 5 minutes later on that SAME clock", async () => {
    // round-3 review: mutate() used to prune with `new Date()` regardless of the caller's own `now`.
    // Real time is ~1 day ahead of `virtualNow` here, so the OLD code would see this code as
    // already-expired the moment redeem's own prune step ran -- even though, from this caller's own
    // consistent clock, only 5 minutes have passed and the 10-minute TTL hasn't come close to firing.
    // This is exactly the mutation that restores `new Date()` in mutate(): it makes this test fail.
    const oneDayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
    const virtualNow = () => new Date(oneDayAgoMs);
    const fiveMinutesLater = () => new Date(oneDayAgoMs + 5 * 60 * 1000);

    await store.register(USER, NAME, virtualNow);
    const paired = await store.pair(USER, NAME, virtualNow);
    if (!paired.ok) throw new Error("unreachable");

    const redeemed = await store.redeem(paired.code, fiveMinutesLater);
    expect(redeemed.ok).toBe(true);
  });
});
