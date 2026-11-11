import type { Database } from "bun:sqlite";
import {
  GiftDuplicateError,
  GiftIdempotencyError,
  GiftNotFoundError,
  GiftRevisionError,
  giftRequestKey,
  type GiftBase,
  type GiftEvent,
  type GiftEventFilter,
  type GiftFieldsByKind,
  type GiftKind,
  type GiftListFilter,
  type GiftPatch,
  type GiftRecord,
  type GiftRequest,
  type GiftStore,
  type GiftWriteMeta,
} from "@rackbops/docket-core";

/**
 * docket's GiftStore port on `bun:sqlite` (plan item 158, Rackbops/docket#94, rackbops-bot-plugins#382).
 * docket's `MemoryGiftStore` is the reference and `GIFT_STORE_CONTRACT` the proof (gift-store.test.ts
 * runs every case on a fresh database). Every check-and-write is one `bun:sqlite` transaction with no
 * `await` inside, so a revision check, an idempotency key and the one-row-per-occasion-and-recipient
 * rule hold against a second write sent at once, and across connections too.
 *
 * The tables are not a numbered migration: `ensureGiftTables` makes them `IF NOT EXISTS` on every
 * open, and `PRAGMA user_version` stays at 13. So a tracker from before gifts (0.43.0 and older),
 * which refuses a database newer than it knows, still starts after a rollback; it never reads these
 * tables, and its forget-me does not erase them (the gift rows of a person forgotten while rolled back
 * stay until a gift-aware tracker forgets them again). Additive only: no existing table, index or row
 * is touched.
 *
 * One table holds every kind: the record's own fields as JSON, with the columns the store filters on
 * (`occasion_id`, `item_id`, `recipient_id`) copied out of them. Ids are docket's prefixes plus the
 * row's `seq` (`gr1`, `gor12`), which AUTOINCREMENT never reuses, so an id names one kind only.
 */

const PREFIX: Record<GiftKind, string> = {
  recipient: "gr",
  group: "gg",
  occasion: "go",
  occasionRecipient: "gor",
  item: "gi",
  purchase: "gp",
  allocation: "ga",
};

/** The gift tables, in the order forget-me deletes from them. */
export const GIFT_TABLES = ["gift_events", "gift_idempotency", "gift_records"] as const;

/** Makes the gift tables when absent. Idempotent; run on every open (schema.ts `openDatabase`). */
export function ensureGiftTables(db: Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS gift_records (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    archived INTEGER NOT NULL,
    occasion_id TEXT,
    item_id TEXT,
    recipient_id TEXT,
    fields TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS gift_records_owner ON gift_records (owner_id, kind, seq);
  CREATE UNIQUE INDEX IF NOT EXISTS gift_records_roster ON gift_records (owner_id, occasion_id, recipient_id) WHERE kind = 'occasionRecipient';

  CREATE TABLE IF NOT EXISTS gift_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    source TEXT NOT NULL,
    at TEXT NOT NULL,
    prior TEXT,
    next TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS gift_events_owner ON gift_events (owner_id, seq);

  CREATE TABLE IF NOT EXISTS gift_idempotency (
    owner_id TEXT NOT NULL,
    key TEXT NOT NULL,
    request TEXT NOT NULL,
    result TEXT NOT NULL,
    PRIMARY KEY (owner_id, key)
  );
  `);
}

/**
 * Erases every gift record, event and idempotency key of one owner; returns the records and events
 * erased (docket's `forgetOwner` count). Synchronous, so forget-me (roster.ts) runs it inside its own
 * transaction.
 */
export function deleteGiftsOf(db: Database, ownerId: string): number {
  const events = db.query("DELETE FROM gift_events WHERE owner_id = ?").run(ownerId).changes;
  db.query("DELETE FROM gift_idempotency WHERE owner_id = ?").run(ownerId);
  const records = db.query("DELETE FROM gift_records WHERE owner_id = ?").run(ownerId).changes;
  return records + events;
}

type Row = {
  seq: number;
  kind: GiftKind;
  owner_id: string;
  revision: number;
  archived: number;
  fields: string;
  created_at: string;
  updated_at: string;
};

const BASE_KEYS = ["id", "ownerId", "revision", "archived", "createdAt", "updatedAt"] as const;

/** The row number behind an id of `kind`, or null when the id is not one of that kind's. */
function seqOf(kind: GiftKind, id: string): number | null {
  const prefix = PREFIX[kind];
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  return /^[1-9][0-9]*$/.test(rest) ? Number(rest) : null;
}

function recordOf<K extends GiftKind>(row: Row): GiftRecord<K> {
  return {
    ...(JSON.parse(row.fields) as GiftFieldsByKind[K]),
    id: `${PREFIX[row.kind]}${row.seq}`,
    ownerId: row.owner_id,
    revision: row.revision,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as GiftRecord<K>;
}

/** The record's own fields, without the base ones, for the `fields` column. */
function ownFields(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!(BASE_KEYS as readonly string[]).includes(key) && value !== undefined) out[key] = value;
  }
  return out;
}

/** The filter columns a record's fields carry. */
function columnsOf(fields: Record<string, unknown>): [string | null, string | null, string | null] {
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return [text(fields.occasionId), text(fields.itemId), text(fields.recipientId)];
}

export class SqliteGiftStore implements GiftStore {
  constructor(private readonly db: Database) {
    ensureGiftTables(db);
  }

  /** The remembered result for a key, or undefined; throws when the key named another request. */
  private replayed(meta: GiftWriteMeta, request: string): GiftBase | undefined {
    if (meta.idempotencyKey === undefined) return undefined;
    const seen = this.db
      .query("SELECT request, result FROM gift_idempotency WHERE owner_id = ? AND key = ?")
      .get(meta.ownerId, meta.idempotencyKey) as { request: string; result: string } | null;
    if (seen === null) return undefined;
    if (seen.request !== request) throw new GiftIdempotencyError("idempotency key reused for another request");
    return JSON.parse(seen.result) as GiftBase;
  }

  private remember(meta: GiftWriteMeta, request: string, result: GiftBase): void {
    if (meta.idempotencyKey === undefined) return;
    this.db
      .query("INSERT INTO gift_idempotency (owner_id, key, request, result) VALUES (?, ?, ?, ?)")
      .run(meta.ownerId, meta.idempotencyKey, request, JSON.stringify(result));
  }

  private checkPair(ownerId: string, fields: Record<string, unknown>, selfSeq: number | null): void {
    const clash = this.db
      .query(
        "SELECT 1 FROM gift_records WHERE kind = 'occasionRecipient' AND owner_id = ? AND occasion_id IS ? AND recipient_id IS ? AND seq IS NOT ?",
      )
      .get(ownerId, columnsOf(fields)[0], columnsOf(fields)[2], selfSeq);
    if (clash !== null) throw new GiftDuplicateError("that recipient is already on this occasion");
  }

  private log(kind: GiftKind, meta: GiftWriteMeta, prior: GiftBase | null, next: GiftBase): void {
    this.db
      .query("INSERT INTO gift_events (owner_id, kind, entity_id, actor, source, at, prior, next) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(meta.ownerId, kind, next.id, meta.actor, meta.source, meta.at, prior === null ? null : JSON.stringify(prior), JSON.stringify(next));
  }

  private row(kind: GiftKind, ownerId: string, id: string): Row | null {
    const seq = seqOf(kind, id);
    if (seq === null) return null;
    return (this.db.query("SELECT * FROM gift_records WHERE seq = ? AND kind = ? AND owner_id = ?").get(seq, kind, ownerId) as Row | null) ?? null;
  }

  async create<K extends GiftKind>(kind: K, meta: GiftWriteMeta, fields: GiftFieldsByKind[K]): Promise<GiftRecord<K>> {
    const request = giftRequestKey({ op: "create", kind, fields });
    return this.db.transaction((): GiftRecord<K> => {
      const replayed = this.replayed(meta, request);
      if (replayed !== undefined) return replayed as GiftRecord<K>;
      const own = ownFields(fields as unknown as Record<string, unknown>);
      if (kind === "occasionRecipient") this.checkPair(meta.ownerId, own, null);
      const [occasionId, itemId, recipientId] = columnsOf(own);
      const { lastInsertRowid } = this.db
        .query(
          "INSERT INTO gift_records (kind, owner_id, revision, archived, occasion_id, item_id, recipient_id, fields, created_at, updated_at) VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?, ?)",
        )
        .run(kind, meta.ownerId, occasionId, itemId, recipientId, JSON.stringify(own), meta.at, meta.at);
      const record = recordOf<K>(this.db.query("SELECT * FROM gift_records WHERE seq = ?").get(Number(lastInsertRowid)) as Row);
      this.log(kind, meta, null, record);
      this.remember(meta, request, record);
      return record;
    })();
  }

  async update<K extends GiftKind>(
    kind: K,
    id: string,
    meta: GiftWriteMeta,
    expectedRevision: number,
    patch: GiftPatch<K>,
  ): Promise<GiftRecord<K>> {
    const request = giftRequestKey({ op: "update", kind, id, expectedRevision, patch });
    return this.db.transaction((): GiftRecord<K> => {
      const replayed = this.replayed(meta, request);
      if (replayed !== undefined) return replayed as GiftRecord<K>;
      const found = this.row(kind, meta.ownerId, id);
      if (found === null) throw new GiftNotFoundError(`no ${kind} ${id}`);
      const prior = recordOf<K>(found);
      if (prior.revision !== expectedRevision) {
        throw new GiftRevisionError(`${kind} ${id} is at revision ${prior.revision}, not ${expectedRevision}`, prior.revision);
      }
      const changes = patch as Record<string, unknown>;
      const own = { ...ownFields(prior as unknown as Record<string, unknown>), ...ownFields(changes) };
      const archived = typeof changes.archived === "boolean" ? changes.archived : prior.archived;
      if (kind === "occasionRecipient") this.checkPair(meta.ownerId, own, found.seq);
      const [occasionId, itemId, recipientId] = columnsOf(own);
      this.db
        .query(
          "UPDATE gift_records SET revision = ?, archived = ?, occasion_id = ?, item_id = ?, recipient_id = ?, fields = ?, updated_at = ? WHERE seq = ?",
        )
        .run(prior.revision + 1, archived ? 1 : 0, occasionId, itemId, recipientId, JSON.stringify(own), meta.at, found.seq);
      const next = recordOf<K>(this.db.query("SELECT * FROM gift_records WHERE seq = ?").get(found.seq) as Row);
      this.log(kind, meta, prior, next);
      this.remember(meta, request, next);
      return next;
    })();
  }

  async get<K extends GiftKind>(kind: K, ownerId: string, id: string): Promise<GiftRecord<K> | null> {
    const found = this.row(kind, ownerId, id);
    return found === null ? null : recordOf<K>(found);
  }

  async list<K extends GiftKind>(kind: K, ownerId: string, filter: GiftListFilter = {}): Promise<GiftRecord<K>[]> {
    const where = ["kind = ?", "owner_id = ?"];
    const params: (string | number)[] = [kind, ownerId];
    if (filter.includeArchived !== true) where.push("archived = 0");
    if (filter.occasionId !== undefined) {
      where.push("occasion_id = ?");
      params.push(filter.occasionId);
    }
    if (filter.itemId !== undefined) {
      where.push("item_id = ?");
      params.push(filter.itemId);
    }
    const rows = this.db.query(`SELECT * FROM gift_records WHERE ${where.join(" AND ")} ORDER BY seq`).all(...params) as Row[];
    return rows.map((r) => recordOf<K>(r));
  }

  async replay(meta: GiftWriteMeta, request: GiftRequest): Promise<GiftBase | null> {
    return this.replayed(meta, giftRequestKey(request)) ?? null;
  }

  async listEvents(ownerId: string, filter: GiftEventFilter = {}): Promise<GiftEvent[]> {
    const where = ["owner_id = ?"];
    const params: string[] = [ownerId];
    if (filter.kind !== undefined) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.entityId !== undefined) {
      where.push("entity_id = ?");
      params.push(filter.entityId);
    }
    const rows = this.db.query(`SELECT * FROM gift_events WHERE ${where.join(" AND ")} ORDER BY seq`).all(...params) as {
      seq: number;
      owner_id: string;
      kind: GiftKind;
      entity_id: string;
      actor: string;
      source: GiftEvent["source"];
      at: string;
      prior: string | null;
      next: string;
    }[];
    return rows.map((r) => ({
      id: `gev${r.seq}`,
      ownerId: r.owner_id,
      kind: r.kind,
      entityId: r.entity_id,
      actor: r.actor,
      source: r.source,
      at: r.at,
      prior: r.prior === null ? null : (JSON.parse(r.prior) as GiftBase),
      next: JSON.parse(r.next) as GiftBase,
    }));
  }

  async forgetOwner(ownerId: string): Promise<number> {
    return this.db.transaction(() => deleteGiftsOf(this.db, ownerId))();
  }
}
