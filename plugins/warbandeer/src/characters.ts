import { join } from "node:path";
import type { HostStorage } from "../../../packages/api/contract.js";

/**
 * A character field the desktop app's broker sends. Kept loosely typed (`unknown`, validated for
 * shape rather than pinned to a rigid interface): the desktop app's own `CharDb` (realm, guid,
 * classKey/classId/className, level, spec, professions, gear ilvl, currency, playtime,
 * reputations) grows fields over time, and this bot only stores and (eventually) redisplays them
 * — it doesn't compute on them.
 */
export type CharacterRecord = Record<string, unknown>;

/** The full character-data payload one push replaces its Linked Account's prior snapshot with —
 * never a diff or an append (see the bot's Character Snapshot glossary entry). */
export interface CharacterSnapshot {
  accountLabel: string;
  receivedAt: number;
  warband: { bankGold: number };
  characters: CharacterRecord[];
}

export interface StoredCharacters {
  /** One snapshot per Account Label this Discord User has linked. */
  snapshots: CharacterSnapshot[];
}

export const MAX_ACCOUNT_LABEL_LENGTH = 64;
export const MAX_CHARACTERS_PER_SNAPSHOT = 60;
export const MAX_STRING_FIELD_LENGTH = 256;

/**
 * Enforced at `POST /link` — before an Account Label ever reaches `links.json` or a Discord
 * reply — since `validateCharacterPayload` only runs later, on `POST /characters`, and by then
 * the label is already persisted. An oversized label would otherwise make `/unlink`'s reply
 * exceed Discord's 2000-character message cap and bloat `links.json`, which is loaded whole at
 * boot.
 *
 * Takes and returns the TRIMMED label — the caller must store/compare the trimmed value, not the
 * original, so `"Main "` and `"Main"` land as the same Account Label rather than two that can
 * never be typed the same way twice. Also rejects control characters (including newlines): a
 * label reaches `console.log` on every `/link` (`server.ts`) and every Discord reply that names
 * it, and an unauthenticated `POST /link` is the only gate in front of it.
 */
export function validateAccountLabel(accountLabel: string): { ok: true; accountLabel: string } | { ok: false; error: string } {
  const trimmed = accountLabel.trim();
  if (trimmed.length === 0) return { ok: false, error: "accountLabel must not be empty" };
  if (trimmed.length > MAX_ACCOUNT_LABEL_LENGTH) {
    return { ok: false, error: `accountLabel exceeds ${MAX_ACCOUNT_LABEL_LENGTH} characters` };
  }
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return { ok: false, error: "accountLabel must not contain control characters" };
  }
  return { ok: true, accountLabel: trimmed };
}
const MAX_SHAPE_DEPTH = 6;
const MAX_ARRAY_LENGTH = 200;
const MAX_OBJECT_KEYS = 100;

/**
 * Walks arbitrary JSON enforcing depth/array-length/object-key-count/string-length caps at every
 * level. Deliberately doesn't pin *which* fields exist — the desktop app's broker adds fields
 * over time — only that nothing in the tree can be pathologically large. Capping string length
 * once here means every future render site inherits the cap instead of re-deriving it.
 */
function checkBoundedShape(value: unknown, path: string, depth: number): string | undefined {
  if (depth > MAX_SHAPE_DEPTH) return `${path}: nested too deeply`;
  if (typeof value === "string") {
    return value.length > MAX_STRING_FIELD_LENGTH ? `${path}: exceeds ${MAX_STRING_FIELD_LENGTH} characters` : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return undefined;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) return `${path}: array exceeds ${MAX_ARRAY_LENGTH} entries`;
    for (const [i, item] of value.entries()) {
      const err = checkBoundedShape(item, `${path}[${i}]`, depth + 1);
      if (err) return err;
    }
    return undefined;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length > MAX_OBJECT_KEYS) return `${path}: object exceeds ${MAX_OBJECT_KEYS} keys`;
    for (const key of keys) {
      // Never echoes the raw key, same reason the string-value check above never echoes the value —
      // this error reaches both a log line and a raw HTTP reply, so an oversized key must not
      // become an oversized message in turn.
      if (key.length > MAX_STRING_FIELD_LENGTH) return `${path}: an object key exceeds ${MAX_STRING_FIELD_LENGTH} characters`;
      const err = checkBoundedShape(obj[key], `${path}.${key}`, depth + 1);
      if (err) return err;
    }
    return undefined;
  }
  return `${path}: unsupported value type`;
}

export type ValidatedCharacterPayload = { ok: true; snapshot: Omit<CharacterSnapshot, "receivedAt"> } | { ok: false; error: string };

/**
 * Validates a `POST /characters` body. `accountLabel` is passed in separately (from the
 * authenticated token's own Linked Account, not read from the body) — a client authenticated as
 * one account can't claim to be pushing for a different one. Rejects the whole payload with a
 * named field on any violation rather than silently truncating: a truncated character name is a
 * worse failure mode (quietly wrong data) than a clear 400.
 */
export function validateCharacterPayload(raw: unknown, accountLabel: string): ValidatedCharacterPayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "payload must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;

  const characters = obj.characters;
  if (!Array.isArray(characters)) {
    return { ok: false, error: "characters must be an array" };
  }
  if (characters.length > MAX_CHARACTERS_PER_SNAPSHOT) {
    return { ok: false, error: `characters exceeds ${MAX_CHARACTERS_PER_SNAPSHOT} entries` };
  }
  for (const [i, c] of characters.entries()) {
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      return { ok: false, error: `characters[${i}] must be an object` };
    }
  }

  const shapeError = checkBoundedShape(obj, "payload", 0);
  if (shapeError) return { ok: false, error: shapeError };

  const warband = obj.warband;
  const bankGold =
    warband && typeof warband === "object" && typeof (warband as Record<string, unknown>).bankGold === "number"
      ? ((warband as Record<string, unknown>).bankGold as number)
      : 0;

  return {
    ok: true,
    snapshot: { accountLabel, warband: { bankGold }, characters: characters as CharacterRecord[] },
  };
}

// ---------------------------------------------------------------------------------------------------
// Persistence — the host owns data/, and the storage primitives arrive via initCharacters (D7), so
// nothing here computes a data path from its own module location the way the bot's version did.
// ---------------------------------------------------------------------------------------------------

type CharactersMutator = {
  update: (path: string, fresh: () => StoredCharacters, mutate: (current: StoredCharacters) => StoredCharacters, label: string) => Promise<void>;
};

let charactersDirValue = "";
let storageRef: HostStorage | undefined;
// One module-wide keyed mutator (keyed internally by full file path, so different users'/tests'
// files never wait on each other) — see the host storage's createKeyedJsonMutator: createJsonWriter
// alone serializes only the write, not the read that precedes it, which a same-user double push
// (two labels, or a retry) would lose.
let charactersMutator: CharactersMutator | undefined;

/** Called once from `createPlugin`'s `activate()`: binds `<dataDir>/characters` and the injected
 * storage's keyed mutator. */
export function initCharacters(dataDir: string, storage: HostStorage): void {
  charactersDirValue = join(dataDir, "characters");
  storageRef = storage;
  charactersMutator = storage.createKeyedJsonMutator<StoredCharacters>();
}

/** The real characters directory once `initCharacters` has run — replaces the bot's `CHARACTERS_DIR`
 * const (which was `import.meta.dir`-relative). */
export function charactersDir(): string {
  return charactersDirValue;
}

function requireStorage(): HostStorage {
  if (!storageRef) throw new Error("warbandeer: characters storage used before initCharacters()");
  return storageRef;
}

function requireMutator(): CharactersMutator {
  if (!charactersMutator) throw new Error("warbandeer: characters storage used before initCharacters()");
  return charactersMutator;
}

/** Discord snowflakes are numeric strings — validated before touching a filesystem path, since
 * `discordUserId` ultimately arrives over HTTP (via the authenticated token's owner). */
function charactersFilePathIn(baseDir: string, discordUserId: string): string {
  if (!/^\d{1,25}$/.test(discordUserId)) {
    throw new Error(`refusing to build a characters path from a non-snowflake id: "${discordUserId}"`);
  }
  return join(baseDir, `${discordUserId}.json`);
}

/** Path-parameterized so tests point it at a temp dir — never the real `data/characters/`. */
export async function loadCharacterSnapshotsFrom(baseDir: string, discordUserId: string): Promise<StoredCharacters> {
  const path = charactersFilePathIn(baseDir, discordUserId);
  return requireStorage().readJsonOrFresh<StoredCharacters>(path, () => ({ snapshots: [] }), "characters");
}

/** Replaces the Account Label's prior snapshot wholesale — never a diff or a merge. One file per
 * Discord User (not one per account label), so a malformed or oversized push only ever risks that
 * one user's own file, never another user's data (ADR-0003). Serialized read-modify-write per file
 * path via the keyed mutator, so two pushes for the same user close together can't lose one. */
export async function saveCharacterSnapshotTo(
  baseDir: string,
  discordUserId: string,
  snapshot: Omit<CharacterSnapshot, "receivedAt">,
  now: number = Date.now(),
): Promise<void> {
  const path = charactersFilePathIn(baseDir, discordUserId);
  await requireMutator().update(
    path,
    () => ({ snapshots: [] }),
    (current) => {
      const withoutLabel = current.snapshots.filter((s) => s.accountLabel !== snapshot.accountLabel);
      return { snapshots: [...withoutLabel, { ...snapshot, receivedAt: now }] };
    },
    "characters",
  );
}

/** Removes one Account Label's Character Snapshot, if present — a no-op (not an error) when
 * there's nothing to remove. Called on `/unlink` so a snapshot for an Account Label with no live
 * Linked Account doesn't sit in `data/characters/<id>.json` forever. */
export async function deleteCharacterSnapshotFrom(
  baseDir: string,
  discordUserId: string,
  accountLabel: string,
): Promise<void> {
  const path = charactersFilePathIn(baseDir, discordUserId);
  await requireMutator().update(
    path,
    () => ({ snapshots: [] }),
    (current) => ({ snapshots: current.snapshots.filter((s) => s.accountLabel !== accountLabel) }),
    "characters",
  );
}

export async function loadCharacterSnapshots(discordUserId: string): Promise<StoredCharacters> {
  return loadCharacterSnapshotsFrom(charactersDirValue, discordUserId);
}

export function deleteCharacterSnapshot(discordUserId: string, accountLabel: string): Promise<void> {
  return deleteCharacterSnapshotFrom(charactersDirValue, discordUserId, accountLabel);
}

export function saveCharacterSnapshot(
  discordUserId: string,
  snapshot: Omit<CharacterSnapshot, "receivedAt">,
  now: number = Date.now(),
): Promise<void> {
  return saveCharacterSnapshotTo(charactersDirValue, discordUserId, snapshot, now);
}
