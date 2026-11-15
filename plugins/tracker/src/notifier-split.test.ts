import { describe, expect, it } from "bun:test";
import { DeliveryFailedError, type Clock } from "@rackbops/docket-core";
import type { HostMessage } from "../../../packages/api/contract.js";
import { DeliveryHealth } from "./delivery-health.js";
import { createDmNotifier, HOST_CANNOT_MESSAGE, MAX_CONTENT, MAX_PARTS, toHostMessages, wrapBareUrls } from "./notifier.js";
import { admit } from "./people.js";
import { openDatabase } from "./schema.js";
import { SqliteStore } from "./store.js";

/** docket#152: a DM longer than one Discord message goes as several, split between lines. */

const clock: Clock = { now: () => new Date("2026-11-15T12:00:00.000Z") };

/** A judged want DM like t36's of 2026-11-15: twenty listings, each a line and a note. */
function longDm(listings = 20): string {
  const lines = ["Arkham Edge of the Earth (judged): 20 new listings worth a look."];
  for (let i = 0; i < listings; i++) {
    lines.push(`- Edge of the Earth ${i} -- 175.00 USD -- New -- sold by seller${i} <https://www.ebay.com/itm/${168860000000 + i}> (via eBay)`);
    lines.push(`  looks right: complete box ${i}. ${"z".repeat(300)}`);
  }
  lines.push("Press Done once you have it, and I stop looking.");
  return lines.join("\n");
}

async function setup() {
  const db = openDatabase(":memory:");
  const store = new SqliteStore(db);
  const owner = await admit(store, "111111111111111111", clock.now());
  return { db, store, owner, health: new DeliveryHealth(db, store) };
}

describe("toHostMessages", () => {
  it("keeps a message that fits as one, unchanged", () => {
    expect(toHostMessages({ text: "hi\nthere" })).toEqual([{ content: "hi\nthere" }]);
    expect(toHostMessages({ text: "  " })).toEqual([]);
  });

  it("splits a long DM between lines, every part fitting, every listing whole, nothing lost", () => {
    const text = longDm();
    const parts = toHostMessages({ text });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(wrapBareUrls(p.content).length).toBeLessThanOrEqual(MAX_CONTENT);
    // Each part after the first starts on a listing, so its note never lands apart from it.
    for (const p of parts.slice(1)) expect(p.content.startsWith("- ")).toBe(true);
    expect(parts.map((p) => p.content).join("\n")).toBe(text);
    expect(parts[parts.length - 1]?.content.endsWith("Press Done once you have it, and I stop looking.")).toBe(true);
  });

  it("cuts a single line too long for a message, and stops at MAX_PARTS", () => {
    const one = toHostMessages({ text: `short\n${"a".repeat(MAX_CONTENT + 500)}\nend` });
    for (const p of one) expect(wrapBareUrls(p.content).length).toBeLessThanOrEqual(MAX_CONTENT);
    expect(one.map((p) => p.content)).toContain("end");
    const huge = toHostMessages({ text: Array.from({ length: 60 }, (_, i) => `- ${i} ${"b".repeat(1500)}`).join("\n") });
    expect(huge).toHaveLength(MAX_PARTS);
    for (const p of huge) expect(wrapBareUrls(p.content).length).toBeLessThanOrEqual(MAX_CONTENT);
  });
});

describe("a split DM through the notifier", () => {
  it("sends every part in order, the buttons on the last only, and returns the last part's id", async () => {
    const s = await setup();
    const sent: HostMessage[] = [];
    const notifier = createDmNotifier({
      store: s.store,
      dm: async (_id, m) => {
        sent.push(m);
        return { guildId: null, channelId: "c", messageId: `m${sent.length}` };
      },
      clock,
      log: { info() {}, warn() {}, error() {} },
    });
    const out = await notifier.sendDm(s.owner.id, { text: longDm(), actions: ["done"], ref: { taskId: "t36", occurrenceId: "o1155" } });
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.slice(0, -1).every((m) => m.buttons === undefined)).toBe(true);
    expect(sent[sent.length - 1]?.buttons?.length).toBeGreaterThan(0);
    expect(out).toEqual({ messageId: `m${sent.length}` });
    expect(sent.map((m) => m.content).join("\n")).toBe(longDm());
  });

  it("reads a refused first part as before: closed DMs fail for good and count, nothing went out", async () => {
    const s = await setup();
    let calls = 0;
    const notifier = createDmNotifier({
      store: s.store,
      dm: async () => {
        calls++;
        throw new Error(HOST_CANNOT_MESSAGE);
      },
      clock,
      log: { info() {}, warn() {}, error() {} },
      health: s.health,
    });
    await expect(notifier.sendDm(s.owner.id, { text: longDm() })).rejects.toMatchObject({ unreachable: true });
    expect(calls).toBe(1);
    expect(s.health.get(s.owner.id)?.failures).toBe(1);
  });

  it("after a part went out, a later failure (even a host refusal) is never a DeliveryFailedError, so it is not resent", async () => {
    for (const failAt of [2, 99]) {
      const s = await setup();
      let calls = 0;
      const warned: string[] = [];
      const notifier = createDmNotifier({
        store: s.store,
        dm: async () => {
          calls++;
          if (calls === failAt || (failAt === 99 && calls > 1 && calls === toHostMessages({ text: longDm() }).length)) {
            throw new Error("content is empty");
          }
          return { guildId: null, channelId: "c", messageId: `m${calls}` };
        },
        clock,
        log: { info() {}, warn: (m: string) => void warned.push(m), error() {} },
        health: s.health,
      });
      const err = await notifier.sendDm(s.owner.id, { text: longDm() }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(DeliveryFailedError);
      expect(warned.some((m) => m.includes("will not be resent"))).toBe(true);
      expect(s.health.get(s.owner.id)?.failures ?? 0).toBe(0);
    }
  });
});
