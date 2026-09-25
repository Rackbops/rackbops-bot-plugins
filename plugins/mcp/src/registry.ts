// Registration and pairing (Tooling#743 decisions 2-6). Pure functions over the registry shape --
// register/issueCode/unregister/redeemCode/generationOf/pruneRegistry -- plus a store wrapper
// binding them to host.storage's keyed mutator on one file, which is what makes every register,
// pair, unregister and redeem atomic and serialized against each other. Every lookup keyed by an
// externally-supplied id (a Discord user id) goes through Object.hasOwn, matching this codebase's
// own established rule against a bare obj[key] on an untrusted key (see routing/resolve.ts).
import { createHash, randomBytes, randomInt } from "node:crypto";
import { join } from "node:path";
import type { HostStorage } from "../../../packages/api/contract.js";

export interface PairingCode {
  hash: string;
  expiresAt: string; // ISO-8601
}

export interface RegistrationEntry {
  generation: string;
  displayName: string;
  registeredAt: string; // ISO-8601
  codes: PairingCode[];
}

export interface Registry {
  users: Record<string, RegistrationEntry>;
}

export function freshRegistry(): Registry {
  return { users: {} };
}

/** At most this many unexpired codes per user (decision 4); a 6th `pair` drops the oldest. */
const MAX_CODES = 5;
/** Decision 4. */
const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * `randomBytes(16).toString("base64url")` (decision 3, literally): 128 bits, 22 characters, no
 * padding -- base64url's own well-defined encoding, so no rounding/entropy question here.
 */
export function generateGeneration(): string {
  return randomBytes(16).toString("base64url");
}

/** Decision 4's alphabet, verbatim -- 30 symbols (A-Z minus I/L/O/U, plus 2-9), chosen for
 *  human-unambiguous reading over a voice/DM channel. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
/**
 * Decision 4 itself is internally over-specified: it says both "16 random bytes" (128 bits) AND
 * "this 30-symbol alphabet, fixed length 26" (also the wire contract's own `^[A-Z2-9]{26}$`) --
 * but no encoding of a full 128-bit space into 26 characters from a 30-symbol alphabet can exist
 * (30^26 < 2^128, ~127.6 bits by log2(30) * 26), and 30 isn't a power of 2, so there is no clean
 * fixed-width bit-packing (standard base32's own 32-symbol alphabet exists precisely because 32 is
 * one) to reconcile "16 bytes in" with "this alphabet out" either. Between the two, the alphabet
 * and the fixed length are the two figures ALSO pinned by the wire contract's own regex, so they
 * are taken as the controlling literal contract; "16 random bytes" is read as an approximate gloss
 * that doesn't survive contact with the other two. Implemented below as CODE_LENGTH independent,
 * rejection-sampled draws from CODE_ALPHABET -- not a bit-packing of a 16-byte buffer -- which is
 * both simpler and avoids the modulo bias a 30-into-256 packing would introduce. Named here rather
 * than silently picked.
 */
const CODE_LENGTH = 26;

/** One code, drawn via `randomInt` (rejection-sampled, unbiased) rather than a modulo of
 *  `randomBytes` -- avoids the small bias a 256-values-into-30-buckets modulo would introduce. */
export function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Decision 6: the registry stores only this, never the code itself. */
export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function entryOf(registry: Registry, userId: string): RegistrationEntry | undefined {
  return Object.hasOwn(registry.users, userId) ? registry.users[userId] : undefined;
}

/** Decision 4's "pruned inside every mutation": strips every expired code from every user. Returns
 *  the same object (not a copy) when nothing changed, so a caller can cheaply tell whether a write
 *  is actually needed. Never removes a user entry itself -- only unregisterUser does that. */
export function pruneRegistry(registry: Registry, now: Date): Registry {
  let changed = false;
  const users: Record<string, RegistrationEntry> = {};
  for (const userId of Object.keys(registry.users)) {
    const entry = registry.users[userId]!;
    const live = entry.codes.filter((c) => new Date(c.expiresAt).getTime() > now.getTime());
    if (live.length !== entry.codes.length) {
      changed = true;
      users[userId] = { ...entry, codes: live };
    } else {
      users[userId] = entry;
    }
  }
  return changed ? { ...registry, users } : registry;
}

export interface RegisterOutcome {
  changed: boolean;
  generation: string;
}

/** Decision 3: mints a generation only from the unregistered state; already-registered is a no-op
 *  that returns the EXISTING generation unchanged. `registry` is assumed already pruned. */
export function registerUser(registry: Registry, userId: string, displayName: string, now: Date): { registry: Registry; outcome: RegisterOutcome } {
  const existing = entryOf(registry, userId);
  if (existing !== undefined) return { registry, outcome: { changed: false, generation: existing.generation } };
  const entry: RegistrationEntry = { generation: generateGeneration(), displayName, registeredAt: now.toISOString(), codes: [] };
  return { registry: { ...registry, users: { ...registry.users, [userId]: entry } }, outcome: { changed: true, generation: entry.generation } };
}

export type IssueCodeOutcome = { ok: true; code: string } | { ok: false };

/** Decision 4: refuses (no registry change) when the user has no entry. Refreshes `displayName`
 *  (decision 2: captured at register AND pair time). `registry` is assumed already pruned, so the
 *  cap-at-5 here only ever drops genuinely-live codes, never an already-expired one. */
export function issueCode(registry: Registry, userId: string, displayName: string, now: Date): { registry: Registry; outcome: IssueCodeOutcome } {
  const existing = entryOf(registry, userId);
  if (existing === undefined) return { registry, outcome: { ok: false } };
  const code = generateCode();
  const withNew = [...existing.codes, { hash: hashCode(code), expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString() }];
  const capped = withNew.length > MAX_CODES ? withNew.slice(withNew.length - MAX_CODES) : withNew;
  const entry: RegistrationEntry = { ...existing, displayName, codes: capped };
  return { registry: { ...registry, users: { ...registry.users, [userId]: entry } }, outcome: { ok: true, code } };
}

/** Decision 5: deletes the user's entry, and with it every code, in one write. */
export function unregisterUser(registry: Registry, userId: string): { registry: Registry; changed: boolean } {
  if (!Object.hasOwn(registry.users, userId)) return { registry, changed: false };
  const users = { ...registry.users };
  delete users[userId];
  return { registry: { ...registry, users }, changed: true };
}

export type RedeemOutcome = { ok: true; discordUserId: string; generation: string } | { ok: false };

/** Decision 6: hashes `code`, finds the user whose unexpired codes contain that hash, removes
 *  exactly that one code, and returns the user's id and current generation. `registry` is assumed
 *  already pruned (so "unexpired" here only needs the hash match, pruning already dropped the
 *  rest) -- a miss, for any reason (unknown, expired -- already gone via pruning -- wrong, or a code
 *  from before an unregister -- the whole entry is gone), answers the same `{ ok: false }`. */
export function redeemCode(registry: Registry, code: string, now: Date): { registry: Registry; outcome: RedeemOutcome } {
  void now; // pruning already removed anything expired; kept for a symmetric signature with the others
  const hash = hashCode(code);
  for (const userId of Object.keys(registry.users)) {
    const entry = registry.users[userId]!;
    const idx = entry.codes.findIndex((c) => c.hash === hash);
    if (idx === -1) continue;
    const codes = entry.codes.filter((_, i) => i !== idx);
    const updated: RegistrationEntry = { ...entry, codes };
    return { registry: { ...registry, users: { ...registry.users, [userId]: updated } }, outcome: { ok: true, discordUserId: userId, generation: entry.generation } };
  }
  return { registry, outcome: { ok: false } };
}

export function generationOf(registry: Registry, userId: string): string | undefined {
  return entryOf(registry, userId)?.generation;
}

export interface RegistryStore {
  register(userId: string, displayName: string, now: () => Date): Promise<RegisterOutcome>;
  pair(userId: string, displayName: string, now: () => Date): Promise<IssueCodeOutcome>;
  unregister(userId: string): Promise<{ changed: boolean }>;
  redeem(code: string, now: () => Date): Promise<RedeemOutcome>;
  generationOf(userId: string): Promise<string | undefined>;
}

function registryPath(dataDir: string): string {
  return join(dataDir, "mcp", "registry.json");
}

/** Binds the pure functions above to `host.storage`'s keyed mutator on the ONE registry file
 *  (decision 2) -- every register/pair/unregister/redeem is therefore serialized against every
 *  other, which is what makes "two concurrent register/redeem calls succeed exactly once" hold. */
export function createRegistryStore(dataDir: string, storage: HostStorage): RegistryStore {
  const mutator = storage.createKeyedJsonMutator<Registry>();
  const path = registryPath(dataDir);

  async function mutate<T>(op: (pruned: Registry) => { registry: Registry; result: T }): Promise<T> {
    let result!: T;
    await mutator.update(
      path,
      freshRegistry,
      (current) => {
        const pruned = pruneRegistry(current, new Date());
        const outcome = op(pruned);
        result = outcome.result;
        return outcome.registry;
      },
      "mcp-registry",
    );
    return result;
  }

  return {
    register: (userId, displayName, now) =>
      mutate((pruned) => {
        const { registry, outcome } = registerUser(pruned, userId, displayName, now());
        return { registry, result: outcome };
      }),
    pair: (userId, displayName, now) =>
      mutate((pruned) => {
        const { registry, outcome } = issueCode(pruned, userId, displayName, now());
        return { registry, result: outcome };
      }),
    unregister: (userId) =>
      mutate((pruned) => {
        const { registry, changed } = unregisterUser(pruned, userId);
        return { registry, result: { changed } };
      }),
    redeem: (code, now) =>
      mutate((pruned) => {
        const { registry, outcome } = redeemCode(pruned, code, now());
        return { registry, result: outcome };
      }),
    async generationOf(userId) {
      // No pruning needed here -- generation is unrelated to codes/expiry, so a plain read suffices.
      const current = await storage.readJsonOrFresh<Registry>(path, freshRegistry, "mcp-registry");
      return generationOf(current, userId);
    },
  };
}
