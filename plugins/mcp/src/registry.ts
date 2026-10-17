// Registration and pairing (Tooling#743 decisions 2-6). Pure functions over the registry shape --
// register/issueCode/unregister/redeemCode/generationOf/pruneRegistry -- plus a store wrapper
// binding them to one keyed mutator (this store's own, separate from the delivery store's) on one file,
// which is what makes every register, pair, unregister and redeem that writes atomic and serialized against
// each other (in-process only; a redeem that finds no live code answers from a read and writes nothing). Every lookup keyed by an
// externally-supplied id (a Discord user id) goes through Object.hasOwn rather than a bare
// obj[key], matching the convention the host repo (rackbops-discord-bot, src/routing/resolve.ts)
// established for the same class of untrusted-key lookup -- not a file in this repo.
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEntry(value: unknown): value is RegistrationEntry {
  if (!isPlainObject(value)) return false;
  const { generation, displayName, registeredAt, codes } = value;
  return (
    typeof generation === "string" &&
    typeof displayName === "string" &&
    typeof registeredAt === "string" &&
    Array.isArray(codes) &&
    codes.every((c) => isPlainObject(c) && typeof c.hash === "string" && typeof c.expiresAt === "string")
  );
}

/**
 * The host's `readJsonOrFresh` recovers only from a file that does not parse, so a file that parses to
 * the wrong shape (`null`, `{}`, `{"users":null}`, an entry without `codes`) would otherwise make every
 * register/pair/unregister/redeem and `/recipients` throw until someone fixed the file by hand. A
 * wrong-shaped file reads as an empty registry; a wrong-shaped entry is dropped on its own, so one bad
 * entry does not unregister everybody. Only ever removes: a dropped entry has no generation (so
 * `/recipients` omits it and no code redeems for it) and the user registers again. That is a loss, not a
 * refusal: the correction reaches disk with the next mutation, and the dropped data is gone for good.
 */
export function normalizeRegistry(raw: unknown): Registry {
  if (!isPlainObject(raw) || !isPlainObject(raw.users)) return freshRegistry();
  // fromEntries defines own properties, so a user id of "__proto__" in a hand-edited file is kept, not
  // swallowed by the prototype setter.
  return { users: Object.fromEntries(Object.entries(raw.users).filter((pair): pair is [string, RegistrationEntry] => isEntry(pair[1]))) };
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
/** 27 * log2(30) ~= 132.5 bits, so ">= 128 bits" (decision 4 / the acceptance bullet's own figure)
 *  genuinely holds -- corrected from an earlier 26-character revision that fell ~0.42 bits short
 *  (round-3 review, Tooling#743). Each character is an independent, unbiased `randomInt(30)` draw,
 *  not a bit-packing of a byte buffer. */
export const CODE_LENGTH = 27;

/** One code, drawn via `randomInt` (rejection-sampled, unbiased) rather than a modulo of
 *  `randomBytes` -- avoids the small bias a 256-values-into-30-buckets modulo would introduce. */
export const defaultDraw: (max: number) => number = randomInt;

export function generateCode(draw: (max: number) => number = defaultDraw): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[draw(CODE_ALPHABET.length)];
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
export function redeemCode(registry: Registry, code: string): { registry: Registry; outcome: RedeemOutcome } {
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

export interface RecipientEntry {
  userId: string;
  displayName: string;
  registeredAt: string; // ISO-8601
}

export interface RegistryStore {
  register(userId: string, displayName: string, now: () => Date): Promise<RegisterOutcome>;
  pair(userId: string, displayName: string, now: () => Date): Promise<IssueCodeOutcome>;
  unregister(userId: string, now: () => Date): Promise<{ changed: boolean }>;
  redeem(code: string, now: () => Date): Promise<RedeemOutcome>;
  generationOf(userId: string): Promise<string | undefined>;
  /** Every registered user (Tooling#746, `GET /recipients`), in no particular order -- ordering and
   *  capping is `protocol.ts`'s `recipientsResponse`'s job, matching `generationOf`'s own split
   *  between a plain store read and the wire-shaping done elsewhere. */
  listRecipients(): Promise<RecipientEntry[]>;
}

function registryPath(dataDir: string): string {
  return join(dataDir, "mcp", "registry.json");
}

/** Binds the pure functions above to one keyed mutator (owned by this store, in-process) on the ONE
 *  registry file (decision 2) -- every register/pair/unregister and every redeem that hits is therefore
 *  serialized against every other, which is what makes "two concurrent register/redeem calls succeed exactly once" hold. */
export function createRegistryStore(dataDir: string, storage: HostStorage): RegistryStore {
  const mutator = storage.createKeyedJsonMutator<Registry>();
  const path = registryPath(dataDir);

  // `now` is threaded all the way into the prune step -- pruning MUST use the same clock as the
  // operation it runs alongside, or a caller with an injected/offset clock (every test in this repo,
  // and any future caller that isn't real-time) sees its own writes pruned against a DIFFERENT clock
  // than the one it reasoned about expiry with. Prune-then-mutate stays one atomic unit either way,
  // since both happen synchronously inside the same mutator callback with no `await` between them.
  async function mutate<T>(now: () => Date, op: (pruned: Registry) => { registry: Registry; result: T }): Promise<T> {
    let result!: T;
    await mutator.update(
      path,
      freshRegistry,
      (current) => {
        const pruned = pruneRegistry(normalizeRegistry(current), now());
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
      mutate(now, (pruned) => {
        const { registry, outcome } = registerUser(pruned, userId, displayName, now());
        return { registry, result: outcome };
      }),
    pair: (userId, displayName, now) =>
      mutate(now, (pruned) => {
        const { registry, outcome } = issueCode(pruned, userId, displayName, now());
        return { registry, result: outcome };
      }),
    unregister: (userId, now) =>
      mutate(now, (pruned) => {
        const { registry, changed } = unregisterUser(pruned, userId);
        return { registry, result: { changed } };
      }),
    async redeem(code, now) {
      // A wrong code changes nothing, but a mutation rewrites the whole file and holds the one registry
      // queue that the `agent` commands also wait on, and a wrong code costs the caller nothing. So
      // look first, unserialised (`writeJsonAtomic` is atomic, so a read sees a whole file): a code
      // that is not there cannot appear by waiting, and a hit is redone inside the queue.
      const current = pruneRegistry(normalizeRegistry(await storage.readJsonOrFresh<Registry>(path, freshRegistry, "mcp-registry")), now());
      if (!redeemCode(current, code).outcome.ok) return { ok: false };
      return mutate(now, (pruned) => {
        const { registry, outcome } = redeemCode(pruned, code);
        return { registry, result: outcome };
      });
    },
    async generationOf(userId) {
      // No pruning needed here -- generation is unrelated to codes/expiry, so a plain read suffices.
      const current = normalizeRegistry(await storage.readJsonOrFresh<Registry>(path, freshRegistry, "mcp-registry"));
      return generationOf(current, userId);
    },
    async listRecipients() {
      // Same reasoning as generationOf: displayName/registeredAt are unrelated to code expiry, so a
      // plain read (no pruning) suffices here too.
      const current = normalizeRegistry(await storage.readJsonOrFresh<Registry>(path, freshRegistry, "mcp-registry"));
      return Object.keys(current.users).map((userId) => {
        const entry = current.users[userId]!;
        return { userId, displayName: entry.displayName, registeredAt: entry.registeredAt };
      });
    },
  };
}
