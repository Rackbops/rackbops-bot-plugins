// One file per request_id under dataDir/mcp/deliveries/ (Tooling#742 decisions 5-6). Reserve is the
// one operation that must be atomic per path (two concurrent POSTs of the same request_id must
// produce exactly one "pending" and one drain) -- it goes through host.storage's keyed mutator, which
// serializes read-modify-write per path; everything else (set/get/list/prune) is a plain read or
// write, since nothing else needs a check-and-set. Listing and pruning use node:fs directly --
// HostStorage has no directory-listing or delete primitive, and a plugin is free to use node:fs
// itself (a declared-dependency boundary, not a sandbox).
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { HostStorage, PluginLog } from "../../../packages/api/contract.js";
import type { DeliveryBody, DeliveryKind, DeliveryTarget, StoredDelivery } from "./protocol.js";

const NOOP_LOG: PluginLog = { info() {}, warn() {}, error() {} };

/** Thrown only by `recordEditSeq`'s own `fresh` callback, to distinguish "no record for this id" (a
 *  silent no-op) from a genuine I/O failure reading or writing an EXISTING record's file (which must
 *  still propagate, not be swallowed alongside it). */
class NoRecordForEditSeq extends Error {}

/** Decision 6: files older than this are pruned by the tick. Deliberately a day past #735's own
 *  7-day idempotency-store window, so the bridge's record never expires before the service's does. */
const PRUNE_AFTER_MS = 8 * 24 * 60 * 60 * 1000;

function deliveriesDir(dataDir: string): string {
  return join(dataDir, "mcp", "deliveries");
}

function deliveryPath(dataDir: string, requestId: string): string {
  return join(deliveriesDir(dataDir), `${requestId}.json`);
}

export interface DeliveryStore {
  /** Atomic check-and-set: an absent file is created as `pending` and returned with `existing:
   *  false`; a present file is returned UNCHANGED with `existing: true` -- reserve never overwrites
   *  an existing record, whatever state it is in. Two concurrent calls for the same `requestId`
   *  produce exactly one `pending` write. */
  reserve(
    requestId: string,
    kind: DeliveryKind,
    target: DeliveryTarget,
    body: DeliveryBody,
    now: () => Date,
  ): Promise<{ value: StoredDelivery; existing: boolean }>;
  /** Unconditional overwrite -- used after a drain attempt settles, and to reset a `failed`/`unknown`
   *  record back to `pending` on retry (decision 5). Never call this where two callers could race;
   *  only `reserve` is safe under concurrency. */
  set(requestId: string, value: StoredDelivery): Promise<void>;
  get(requestId: string): Promise<StoredDelivery | undefined>;
  /** Every `request_id` currently on disk, in no particular order. */
  list(): Promise<string[]>;
  /** activate() (decision 6): every `pending` record becomes `unknown` -- a restart mid-delivery
   *  left it in a state no caller retry, and no drain in flight, will ever resolve on its own. */
  markPendingUnknown(): Promise<void>;
  /** Tooling#746 decision 3/4: sets `lastEditSeq` on `requestId`'s record through the SAME keyed
   *  mutator `reserve` uses for this path, so it is serialized against any other write to that one
   *  file. A no-op (the record is left exactly as it was) when the current record is not `delivered`
   *  -- an edit's `EditQueue` turn only ever calls this after its own `get()` of the same id has
   *  already confirmed `state === "delivered"` in that same serialized turn, so the "current record is
   *  missing or not delivered" branch here is not expected to be reached in practice; it exists so a
   *  call that somehow arrives anyway leaves the store exactly as decision 3 says ("otherwise leaves
   *  the record unchanged") rather than corrupting it. */
  recordEditSeq(requestId: string, seq: number): Promise<void>;
  /** Removes every record whose `createdAt` is at least 8 days before `now()`. Returns the pruned
   *  request ids. */
  prune(now: () => Date): Promise<string[]>;
}

export function createDeliveryStore(dataDir: string, storage: HostStorage, log: PluginLog = NOOP_LOG): DeliveryStore {
  const mutator = storage.createKeyedJsonMutator<StoredDelivery | null>();

  async function get(requestId: string): Promise<StoredDelivery | undefined> {
    return storage.readJsonOrFresh<StoredDelivery | undefined>(deliveryPath(dataDir, requestId), () => undefined, "mcp-delivery");
  }

  async function set(requestId: string, value: StoredDelivery): Promise<void> {
    await storage.writeJsonAtomic(deliveryPath(dataDir, requestId), value);
  }

  async function list(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(deliveriesDir(dataDir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -".json".length));
  }

  return {
    async reserve(requestId, kind, target, body, now) {
      let existing = false;
      let result!: StoredDelivery;
      await mutator.update(
        deliveryPath(dataDir, requestId),
        () => null,
        (current) => {
          if (current !== null) {
            existing = true;
            result = current;
            return current;
          }
          existing = false;
          result = { state: "pending", kind, target, body, createdAt: now().toISOString() };
          return result;
        },
        "mcp-delivery",
      );
      return { value: result, existing };
    },
    set,
    get,
    list,
    // markPendingUnknown and prune each isolate one request_id's failure from the rest of the pass
    // (the same class of gap the tick's own redrive loop had -- see index.ts) -- a read/write
    // throwing for one id is logged and the pass moves on, rather than leaving every id after it in
    // list()'s snapshot unvisited. For markPendingUnknown specifically, a record it never reaches
    // stays "pending" forever: no caller retry and no drain in flight will ever resolve it, and the
    // tick only ever re-drives "unknown" -- so a silently-incomplete pass here reproduces the exact
    // stuck-forever shape #742's review already found and fixed once, in a different function.
    async markPendingUnknown() {
      for (const requestId of await list()) {
        try {
          const current = await get(requestId);
          if (current?.state === "pending") await set(requestId, { ...current, state: "unknown" });
        } catch (err) {
          log.error(`marking delivery ${requestId} unknown after restart failed`, err);
        }
      }
    },
    async recordEditSeq(requestId, seq) {
      try {
        await mutator.update(
          deliveryPath(dataDir, requestId),
          // Unlike reserve()'s `() => null` (which WANTS to create a fresh record for an absent
          // path), a missing record here must produce NO write at all -- writing `null` back would
          // create a phantom file that later reads as `null` instead of `undefined` from get(),
          // breaking every "is this id known" check downstream. Throwing makes readJsonOrFresh (and
          // so mutator.update as a whole) reject instead of ever reaching the write step; the catch
          // below turns ONLY this specific marker into the silent no-op decision 3 asks for, while
          // still letting a genuine I/O failure on an EXISTING record propagate as before.
          () => {
            throw new NoRecordForEditSeq();
          },
          (current) => (current !== null && current.state === "delivered" ? { ...current, lastEditSeq: seq } : current),
          "mcp-delivery",
        );
      } catch (err) {
        if (!(err instanceof NoRecordForEditSeq)) throw err;
      }
    },
    async prune(now) {
      const cutoff = now().getTime() - PRUNE_AFTER_MS;
      const pruned: string[] = [];
      for (const requestId of await list()) {
        try {
          const current = await get(requestId);
          if (current !== undefined && new Date(current.createdAt).getTime() <= cutoff) {
            await unlink(deliveryPath(dataDir, requestId));
            pruned.push(requestId);
          }
        } catch (err) {
          log.error(`pruning delivery ${requestId} failed`, err);
        }
      }
      return pruned;
    },
  };
}
