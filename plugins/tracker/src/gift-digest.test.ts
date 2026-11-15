import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GiftLedger, type GiftWriteMeta, type OutgoingMessage } from "@rackbops/docket-core";
import { makeFakeDelivery, makeFakeHost } from "../../../packages/testkit/index.js";
import { Admissions } from "./admissions.js";
import { runGiftDigests } from "./gift-digest.js";
import { getDigestState, SqliteGiftStore } from "./gift-store.js";
import { createPlugin, DB_DIR, DB_FILE } from "./index.js";
import { admit } from "./people.js";
import { Roster } from "./roster.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";
import { removeDir } from "./test-dirs.js";

/**
 * The opt-in gift digest on the notify tick (docket#103, gift-digest.ts): due at the owner's hour,
 * once a day under its claim, never without the opt-in, its state kept (a quiet "nothing" too) and
 * erased by forget-me, and a text that names people and counts only. Every family here is made up.
 */

const AT = "2026-12-10T08:00:00.000Z";

async function setup(digest = true) {
  const db = openDatabase(":memory:");
  const store = new SqliteStore(db);
  const gifts = new GiftLedger(new SqliteGiftStore(db));
  const larry = await store.updateUser((await admit(store, "111111111111111111", new Date(AT))).id, { timeZone: "UTC", preferredHour: 9 });
  let n = 0;
  const meta = (): GiftWriteMeta => ({ ownerId: larry.id, actor: larry.id, source: "api", at: AT, idempotencyKey: `k${++n}` });
  const person = (displayName: string) => gifts.create("recipient", meta(), { displayName, kind: "person", memberIds: [], labels: [], interests: [], avoid: [], notes: null });
  const ann = await person("Ann");
  const bea = await person("Bea");
  const occasion = await gifts.create("occasion", meta(), {
    kind: "christmas",
    title: "Christmas 2026",
    date: "2026-12-25",
    timeZone: null,
    year: 2026,
    currency: "USD",
    budgetMinor: 90000,
    groupIds: [],
    includeIds: [],
    excludeIds: [],
    deadline: "2026-12-20",
    ...(digest ? { digest: true } : {}),
  });
  for (const r of [ann, bea]) await gifts.create("occasionRecipient", meta(), { occasionId: occasion.id, recipientId: r.id, target: null, budgetMinor: 4321, decision: "planning", skipReason: null });
  // Distinctive titles, notes and prices, none of which a digest may show.
  const item = await gifts.create("item", meta(), { title: "Zanzibar Teapot", url: null, productKey: null, variant: null, notes: "Secret: hide in the attic", source: { kind: "manual", ref: null }, planning: "selected", estimateMinor: 98765, currency: "USD" });
  const purchase = await gifts.create("purchase", meta(), {
    itemId: item.id, merchant: "Quokka Mart", currency: "USD", unitPriceMinor: 98765, ordered: 1, received: 0, cancelled: 0, returned: 0,
    taxMinor: null, shippingMinor: null, discountMinor: null, totalComplete: false, refundedMinor: 0, purchasedOn: "2026-12-01", reference: null,
  });
  await gifts.create("allocation", meta(), { itemId: item.id, occasionId: occasion.id, recipientIds: [ann.id], quantity: 1, shared: false, purchaseId: purchase.id, handoff: "none", givenOn: null });
  const sent: { to: string; message: OutgoingMessage }[] = [];
  const failing = { on: false };
  const deps = {
    db,
    store,
    gifts,
    log: { info() {}, warn() {}, error() {} },
    isRegistered: () => true,
    notifier: {
      sendDm: async (to: string, message: OutgoingMessage) => {
        if (failing.on) throw new Error("boom");
        sent.push({ to, message });
        return { messageId: "m" };
      },
    },
  };
  return { db, store, gifts, larry, occasion, ann, bea, item, sent, deps, failing, meta };
}

const at = (iso: string) => new Date(iso);

describe("the gift digest (docket#103)", () => {
  it("is due at the preferred hour, names people and counts only, and goes once a day under its claim", async () => {
    const s = await setup();
    expect(await runGiftDigests(s.deps, at("2026-12-10T08:30:00.000Z"))).toEqual({ sent: 0, failed: 0 });
    expect(await runGiftDigests(s.deps, at("2026-12-10T09:05:00.000Z"))).toEqual({ sent: 1, failed: 0 });
    expect(s.sent).toHaveLength(1);
    const text = s.sent[0]?.message.text ?? "";
    expect(s.sent[0]?.to).toBe(s.larry.id);
    expect(text).toBe(["Gifts for Christmas 2026", "10 days to shop.", "Still needs a gift: Bea.", "1 gift awaiting arrival."].join("\n"));
    for (const secret of ["Zanzibar", "Teapot", "Secret", "attic", "Quokka", "987", "43.21", "900", "USD"]) expect(text).not.toContain(secret);
    // A second tick the same day, and a tick that lost its stored state, both send nothing more.
    expect(await runGiftDigests(s.deps, at("2026-12-10T15:00:00.000Z"))).toEqual({ sent: 0, failed: 0 });
    s.db.query("DELETE FROM gift_digest_state").run();
    expect(await runGiftDigests(s.deps, at("2026-12-10T16:00:00.000Z"))).toEqual({ sent: 0, failed: 0 });
    expect(s.sent).toHaveLength(1);
    expect(getDigestState(s.db, s.larry.id, s.occasion.id)?.sentOn).toBe("2026-12-10");
  });

  it("is never sent without the opt-in, and costs those people nothing", async () => {
    const s = await setup(false);
    expect(await runGiftDigests(s.deps, at("2026-12-10T09:05:00.000Z"))).toEqual({ sent: 0, failed: 0 });
    expect(s.sent).toEqual([]);
    expect(s.db.query("SELECT count(*) AS n FROM gift_digest_state").get()).toEqual({ n: 0 });
  });

  it("reads nothing of the ledger for a past-dated occasion, before the owner's hour, or once today's digest went", async () => {
    const s = await setup(false);
    await s.gifts.create("occasion", s.meta(), {
      kind: "birthday", title: "Ann 2026", date: "2026-12-01", timeZone: null, year: 2026, currency: "USD", budgetMinor: null,
      groupIds: [], includeIds: [], excludeIds: [], deadline: null, digest: true,
    });
    let reads = 0;
    const gifts = new Proxy(s.gifts, {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (key === "list" || key === "get") reads++;
          return v.apply(target, args);
        };
      },
    });
    const deps = { ...s.deps, gifts };
    expect(await runGiftDigests(deps, at("2026-12-10T09:05:00.000Z"))).toEqual({ sent: 0, failed: 0 });
    expect(reads).toBe(0);
    expect(s.sent).toEqual([]);
    expect(s.db.query("SELECT count(*) AS n FROM gift_digest_state").get()).toEqual({ n: 0 });
    // Christmas opted in: nothing read before 09:00, one pass at 09:05, then nothing more today.
    await s.gifts.update("occasion", s.occasion.id, s.meta(), s.occasion.revision, { digest: true });
    expect(await runGiftDigests(deps, at("2026-12-10T08:59:00.000Z"))).toEqual({ sent: 0, failed: 0 });
    expect(reads).toBe(0);
    expect(await runGiftDigests(deps, at("2026-12-10T09:05:00.000Z"))).toEqual({ sent: 1, failed: 0 });
    const after = reads;
    expect(after).toBeGreaterThan(0);
    expect(await runGiftDigests(deps, at("2026-12-10T15:00:00.000Z"))).toEqual({ sent: 0, failed: 0 });
    expect(reads).toBe(after);
    expect(s.sent).toHaveLength(1);
    // The next day it is read again.
    await runGiftDigests(deps, at("2026-12-11T09:05:00.000Z"));
    expect(reads).toBeGreaterThan(after);
  });

  it("stores the state of a quiet nothing, and a person not registered or paused is passed by", async () => {
    const s = await setup();
    // Everyone done: both skipped for this occasion.
    for (const row of await s.gifts.list("occasionRecipient", s.larry.id)) {
      await s.gifts.update("occasionRecipient", row.id, s.meta(), row.revision, { decision: "skipped", skipReason: "not this year" });
    }
    const allocation = (await s.gifts.list("allocation", s.larry.id))[0];
    if (allocation) await s.gifts.update("allocation", allocation.id, s.meta(), allocation.revision, { archived: true });
    expect(await runGiftDigests({ ...s.deps, isRegistered: () => false }, at("2026-12-10T09:05:00.000Z"))).toEqual({ sent: 0, failed: 0 });
    expect(getDigestState(s.db, s.larry.id, s.occasion.id)).toBeNull();
    expect(await runGiftDigests(s.deps, at("2026-12-10T09:05:00.000Z"))).toEqual({ sent: 0, failed: 0 });
    expect(s.sent).toEqual([]);
    expect(getDigestState(s.db, s.larry.id, s.occasion.id)).toMatchObject({ sentOn: null });
    expect(getDigestState(s.db, s.larry.id, s.occasion.id)?.fingerprint).toBeString();
  });

  it("a DM that fails after the claim is not resent", async () => {
    const s = await setup();
    s.failing.on = true;
    expect(await runGiftDigests(s.deps, at("2026-12-10T09:05:00.000Z"))).toEqual({ sent: 0, failed: 1 });
    s.failing.on = false;
    expect(await runGiftDigests(s.deps, at("2026-12-10T10:05:00.000Z"))).toEqual({ sent: 0, failed: 0 });
    expect(s.sent).toEqual([]);
  });

  it("forget-me erases the person's digest state", async () => {
    const s = await setup();
    await runGiftDigests(s.deps, at("2026-12-10T09:05:00.000Z"));
    expect(s.db.query("SELECT count(*) AS n FROM gift_digest_state WHERE owner_id = ?").get(s.larry.id)).toEqual({ n: 1 });
    const erased = new Roster(s.db).erase(s.larry.id);
    expect(erased.rows.gift_digest_state).toBe(1);
    expect(s.db.query("SELECT count(*) AS n FROM gift_digest_state").get()).toEqual({ n: 0 });
  });
});

describe("the gift digest on the plugin's notify tick", () => {
  /** The plugin on a real data file and a second connection to it, with one opted-in occasion. */
  async function tick(digest: boolean | undefined, run: (r: { dms: () => string[]; at: (iso: string) => Promise<void> }) => Promise<void>) {
    const dataDir = mkdtempSync(join(tmpdir(), "tracker-gift-digest-"));
    let plugin: ReturnType<typeof createPlugin> | null = null;
    let db: Database | null = null;
    try {
      let now = new Date(AT);
      const clock = { now: () => new Date(now) };
      const delivery = makeFakeDelivery();
      const host = makeFakeHost({ name: "tracker", dataDir, env: { TRACKER_ADMIN_DISCORD_IDS: "111111111111111111" }, ...delivery });
      plugin = createPlugin(host, { clock, ...(digest !== undefined ? { digest } : {}) });
      await plugin.activate!();
      db = openDatabase(join(dataDir, DB_DIR, DB_FILE));
      const store = new SqliteStore(db);
      const larry = await store.updateUser((await admit(store, "111111111111111111", new Date(AT))).id, { timeZone: "UTC", preferredHour: 9 });
      new Admissions(db).markRegistered(larry.id, AT);
      const gifts = new GiftLedger(new SqliteGiftStore(db));
      const meta = (k: string): GiftWriteMeta => ({ ownerId: larry.id, actor: larry.id, source: "api", at: AT, idempotencyKey: k });
      const bea = await gifts.create("recipient", meta("k1"), { displayName: "Bea", kind: "person", memberIds: [], labels: [], interests: [], avoid: [], notes: null });
      const occasion = await gifts.create("occasion", meta("k2"), {
        kind: "christmas", title: "Christmas 2026", date: "2026-12-25", timeZone: null, year: 2026, currency: "USD", budgetMinor: null,
        groupIds: [], includeIds: [], excludeIds: [], deadline: "2026-12-20", digest: true,
      });
      await gifts.create("occasionRecipient", meta("k3"), { occasionId: occasion.id, recipientId: bea.id, target: null, budgetMinor: null, decision: "planning", skipReason: null });
      const p = plugin;
      await run({
        dms: () => delivery.calls.dm.map((c) => c.message.content ?? "").filter((t) => t.startsWith("Gifts for")),
        at: async (iso) => {
          now = new Date(iso);
          await p.ticks![0]!.run(new AbortController().signal);
        },
      });
    } finally {
      await plugin?.dispose?.();
      db?.close();
      removeDir(dataDir);
    }
  }

  it("sends the opted-in digest once, at the owner's hour, through the real wiring", async () => {
    await tick(undefined, async ({ dms, at }) => {
      await at("2026-12-10T08:30:00.000Z");
      expect(dms()).toEqual([]);
      await at("2026-12-10T09:05:00.000Z");
      expect(dms()).toEqual([["Gifts for Christmas 2026", "10 days to shop.", "Still needs a gift: Bea."].join("\n")]);
      await at("2026-12-10T10:05:00.000Z");
      expect(dms()).toHaveLength(1);
    });
  });

  it("is off whenever the daily digest is (options.digest: false)", async () => {
    await tick(false, async ({ dms, at }) => {
      await at("2026-12-10T09:05:00.000Z");
      expect(dms()).toEqual([]);
    });
  });
});
