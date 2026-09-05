import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { HostStorage } from "../../../packages/api/contract.js";

/** A Link Code redeemable once, within its TTL, for a Device Token. */
export interface PendingLinkCode {
  code: string;
  discordUserId: string;
  expiresAt: number; // ms epoch
}

/** One WoW account a Discord User has linked — its Device Token hash and Account Label. The
 * Character Snapshot itself lives in `characters.ts`'s per-user file, not here (see ADR-0003):
 * `links.json` stays small and cheap to load even with many users, and a huge/corrupt character
 * payload can never risk this file. */
export interface LinkedAccount {
  accountLabel: string;
  tokenHash: string; // sha256 of the Device Token; the plaintext is never persisted
  linkedAt: number;
  updatedAt: number; // last successful character push
}

export interface LinksState {
  pending: PendingLinkCode[];
  accounts: Record<string, LinkedAccount[]>; // keyed by Discord User ID
}

const LINK_CODE_TTL_MS = 10 * 60 * 1000;

/** Enforced at the `POST /link` boundary in `server.ts`, not inside `upsertLinkedAccount` itself
 * (same layering as `characters.ts`'s `validateAccountLabel` — the pure state functions accept
 * whatever they're given; the one real caller validates first). Without a cap, `/unlink`'s
 * multi-account listing (each label already capped at 64 characters) can still overflow Discord's
 * 2000-character reply limit past roughly 30 accounts, and `links.json` is loaded whole at boot. */
export const MAX_LINKED_ACCOUNTS_PER_USER = 20;

/** A short, human-typeable code: 4 random bytes as 8 uppercase hex characters. */
export function generateLinkCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

/** A long-lived Device Token. URL-safe so it drops cleanly into a bearer header or a config file
 * with no escaping. */
export function generateDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare of two hash strings — a length mismatch is an immediate, safe `false`,
 * no byte scan. */
function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function verifyToken(token: string, hash: string): boolean {
  return hashesMatch(hashToken(token), hash);
}

/**
 * Mints a fresh Link Code for `discordUserId`, invalidating any prior unredeemed code for that
 * same user first — a stale floating code from an abandoned `/link` shouldn't still be
 * redeemable once a fresh one is minted. Pure: takes and returns state values, no I/O.
 *
 * Regenerates on the astronomically unlikely chance the new code collides with a DIFFERENT
 * user's still-pending code: `redeemLinkCode` matches by code alone, so a collision would hand
 * the redeemer the wrong user's identity and silently destroy that user's code — cheap enough to
 * close outright rather than accept given a 32-bit code space. `generateCode` defaults to
 * `generateLinkCode` and exists as a parameter purely so `links.test.ts` can force a collision
 * deterministically (real crypto randomness can't be steered into colliding on demand).
 */
export function mintLinkCode(
  state: LinksState,
  discordUserId: string,
  now: number,
  generateCode: () => string = generateLinkCode,
): { code: string; state: LinksState } {
  const others = state.pending.filter((p) => p.discordUserId !== discordUserId);
  let code = generateCode();
  while (others.some((p) => p.code === code)) {
    code = generateCode();
  }
  const pending = others.concat({ code, discordUserId, expiresAt: now + LINK_CODE_TTL_MS });
  return { code, state: { ...state, pending } };
}

export type RedeemFailure = "not-found" | "expired";

export type RedeemLinkCodeResult =
  | { ok: true; discordUserId: string; state: LinksState }
  | { ok: false; reason: RedeemFailure; state: LinksState };

/**
 * Redeems `code`, or reports why it couldn't. Burns the code — removes it from `pending` — on
 * ANY match attempt, including a failed redemption of an expired one: single-use applies even to
 * a code that's already stale, so a stale code can't be probed indefinitely.
 */
export function redeemLinkCode(state: LinksState, code: string, now: number): RedeemLinkCodeResult {
  const match = state.pending.find((p) => p.code === code);
  const nextState: LinksState = { ...state, pending: state.pending.filter((p) => p.code !== code) };
  if (!match) return { ok: false, reason: "not-found", state: nextState };
  if (match.expiresAt < now) return { ok: false, reason: "expired", state: nextState };
  return { ok: true, discordUserId: match.discordUserId, state: nextState };
}

/**
 * Adds or replaces a Linked Account under `discordUserId`. An existing entry with the same
 * `accountLabel` is REPLACED (re-linking the same WoW account — e.g. after a reinstall — rotates
 * the token rather than duplicating the entry); a new label is APPENDED. This is the multi-account
 * array from ADR-0003: one Discord User can hold several, one per WoW account.
 */
export function upsertLinkedAccount(
  state: LinksState,
  discordUserId: string,
  accountLabel: string,
  tokenHash: string,
  now: number,
): LinksState {
  const existing = state.accounts[discordUserId] ?? [];
  const current = existing.find((a) => a.accountLabel === accountLabel);
  const entry: LinkedAccount = current
    ? { ...current, tokenHash, updatedAt: now }
    : { accountLabel, tokenHash, linkedAt: now, updatedAt: now };
  const accounts = current
    ? existing.map((a) => (a.accountLabel === accountLabel ? entry : a))
    : [...existing, entry];
  return { ...state, accounts: { ...state.accounts, [discordUserId]: accounts } };
}

/** Removes one Linked Account by label, or returns `undefined` if no such label exists under
 * this user — so `/unlink` can say "you don't have an account by that name" rather than a silent
 * no-op. Drops the user's own key entirely once their last account is removed. */
export function removeLinkedAccount(
  state: LinksState,
  discordUserId: string,
  accountLabel: string,
): { removed: LinkedAccount; state: LinksState } | undefined {
  const existing = state.accounts[discordUserId] ?? [];
  const removed = existing.find((a) => a.accountLabel === accountLabel);
  if (!removed) return undefined;
  const remaining = existing.filter((a) => a.accountLabel !== accountLabel);
  const accounts = { ...state.accounts };
  if (remaining.length > 0) accounts[discordUserId] = remaining;
  else delete accounts[discordUserId];
  return { removed, state: { ...state, accounts } };
}

/** Bumps `updatedAt` on a successful character push. A no-op (returns `state` unchanged) if the
 * account was unlinked between authenticating the request and this call — an unlikely but
 * possible race, and losing just the timestamp update is the right degrade, not an error. */
export function touchLinkedAccount(
  state: LinksState,
  discordUserId: string,
  accountLabel: string,
  now: number,
): LinksState {
  const existing = state.accounts[discordUserId];
  if (!existing) return state;
  const accounts = existing.map((a) => (a.accountLabel === accountLabel ? { ...a, updatedAt: now } : a));
  return { ...state, accounts: { ...state.accounts, [discordUserId]: accounts } };
}

/** The auth lookup `POST /characters` needs: hashes `token` once, then scans every Linked
 * Account for a matching hash. This file is expected to hold at most a few hundred entries, so a
 * scan (rather than a token->owner index) is the simplest thing that's fast enough. */
export function findAccountByToken(
  state: LinksState,
  token: string,
): { discordUserId: string; account: LinkedAccount } | undefined {
  const hash = hashToken(token);
  for (const [discordUserId, accounts] of Object.entries(state.accounts)) {
    const account = accounts.find((a) => hashesMatch(hash, a.tokenHash));
    if (account) return { discordUserId, account };
  }
  return undefined;
}

/**
 * A parsed `links.json` is trusted to be well-formed by `readJsonOrFresh` (it only distinguishes
 * absent/corrupt from present), so this guarantees both top-level fields have the right SHAPE,
 * not just that the keys exist. Nothing today writes a `links.json` missing either field or with
 * the wrong type, but every consumer (`mintLinkCode`, `findAccountByToken`, …) assumes `pending`
 * is an array and `accounts` is a plain object and would throw (`.filter is not a function`,
 * `.find is not a function`) otherwise — a hand-edited or partially-written file shouldn't be
 * able to do that; treated the same as "missing" rather than trusted as-is.
 */
function normalizeLinksState(raw: Partial<LinksState> | undefined): LinksState {
  const pending = Array.isArray(raw?.pending) ? raw.pending : [];
  const accountsRaw = raw?.accounts;
  const accounts =
    accountsRaw && typeof accountsRaw === "object" && !Array.isArray(accountsRaw)
      ? Object.fromEntries(Object.entries(accountsRaw).filter(([, v]) => Array.isArray(v)))
      : {};
  return { pending, accounts };
}

/** Path-parameterized load, mirroring the bot's `loadLinksFrom` — takes the injected `HostStorage`
 * instead of importing the primitives, so a test points it at a temp dir with a real storage. */
export async function loadLinksFrom(path: string, storage: HostStorage): Promise<LinksState> {
  const raw = await storage.readJsonOrFresh<Partial<LinksState>>(path, () => ({ pending: [], accounts: {} }), "links");
  return normalizeLinksState(raw);
}

/** The live singleton, mutated in place by callers (`link-command.ts`/`server.ts`) exactly as the
 * bot's `links` was. Empty until `loadLinks()` populates it in place during the plugin's
 * `activate()` — there is no top-level `await` here (nothing plugin-side may run before the host's
 * `takeOver()`), unlike the bot module this was ported from. */
export const links: LinksState = { pending: [], accounts: {} };

let linksWriter: { save: (data: LinksState) => Promise<void> } | undefined;

/** Called once from `createPlugin`'s `activate()`: binds the serialized writer to
 * `<dataDir>/links.json` and loads existing state into the `links` singleton in place, so every
 * importer of `links` sees the loaded data. */
export async function loadLinks(dataDir: string, storage: HostStorage): Promise<void> {
  const path = join(dataDir, "links.json");
  linksWriter = storage.createJsonWriter<LinksState>(path);
  const loaded = await loadLinksFrom(path, storage);
  links.pending = loaded.pending;
  links.accounts = loaded.accounts;
}

export function saveLinks(): Promise<void> {
  if (!linksWriter) throw new Error("warbandeer: saveLinks() called before loadLinks()");
  return linksWriter.save(links);
}
