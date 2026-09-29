import { describe, expect, it } from "bun:test";
import type { Fetch, FetchResponse } from "@rackbops/docket-core";
import type { ChatInputCommandInteraction, MessageComponentInteraction } from "discord.js";
import type { HostApi, HostMessage, Plugin } from "../../../packages/api/contract.js";
import { makeFakeHost } from "../../../packages/testkit/index.js";
import { FetchRefusedError } from "./fetch.js";
import { createPlugin } from "./index.js";
import { FETCH_TYPES, takesType } from "./notify-lane.js";
import { MAX_PRICE_TASKS, nearPattern } from "./tracked.js";

/**
 * Renewals and the price tracker end to end (rackbops-bot-plugins#81), through the plugin's own
 * commands, buttons and ticks with fake interactions, a fake host and a fake page reader: a renewal
 * set by `/renewal` asks by DM before its date and records the answer and the amount; a price set
 * by `/price` is read on the `poll` tick (never on `notify`), and a drop DMs the owner.
 */

const ADMIN = "111111111111111111";
const LARRY = "222222222222222222";
// 2026-10-01 is a Thursday; 12:00 UTC is 08:00 in New York (EDT).
const START = "2026-10-01T12:00:00.000Z";
const SHOP = "https://shop.example/widget";

function clockAt(iso: string) {
  let now = new Date(iso);
  return { now: () => new Date(now), set: (s: string) => (now = new Date(s)) };
}

function page(price: number | null): string {
  if (price === null) return "<html><body>Out of stock</body></html>";
  const ld = { "@type": "Product", name: "Widget", offers: { "@type": "Offer", price: price.toFixed(2), priceCurrency: "USD" } };
  return `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>Widget</body></html>`;
}

function world() {
  const clock = clockAt(START);
  const sent: { userId: string; message: HostMessage }[] = [];
  let n = 0;
  const dm: NonNullable<HostApi["dm"]> = async (userId, message) => {
    sent.push({ userId, message });
    n++;
    return { guildId: null, channelId: `c${n}`, messageId: `m${n}` };
  };
  const shop = {
    price: 100 as number | null,
    status: 200,
    reads: [] as string[],
    refuse: null as string | null,
    onRead: null as (() => void) | null,
  };
  const fetch: Fetch = {
    async get(url: string): Promise<FetchResponse> {
      shop.reads.push(url);
      shop.onRead?.();
      if (shop.refuse) throw new FetchRefusedError(shop.refuse);
      return { status: shop.status, body: page(shop.price), headers: {} };
    },
  };
  const plugin = createPlugin(
    makeFakeHost({ name: "tracker", env: { TRACKER_ADMIN_DISCORD_IDS: ADMIN }, log: { info() {}, warn() {}, error() {} }, dm }),
    { clock, dbPath: ":memory:", fetch: () => fetch },
  );
  return { plugin, clock, sent, shop };
}

type Options = { sub?: string; strings?: Record<string, string>; ints?: Record<string, number>; numbers?: Record<string, number> };

async function slash(plugin: Plugin, name: string, userId: string, o: Options = {}): Promise<string> {
  const command = plugin.commands?.find((c) => c.name === name);
  if (!command) throw new Error(`no command ${name}`);
  const edits: { content: string }[] = [];
  const interaction = {
    commandName: name,
    guildId: null,
    user: { id: userId, username: `user${userId.slice(0, 3)}`, globalName: userId === LARRY ? "Larry" : null, bot: false },
    options: {
      getSubcommand: () => o.sub ?? "",
      getString: (k: string) => o.strings?.[k] ?? null,
      getInteger: (k: string) => o.ints?.[k] ?? null,
      getNumber: (k: string) => o.numbers?.[k] ?? null,
      getUser: () => null,
    },
    deferReply: async () => {},
    editReply: async (x: { content: string }) => void edits.push(x),
  };
  await command.handle(interaction as unknown as ChatInputCommandInteraction);
  expect(edits).toHaveLength(1);
  return edits[0]?.content ?? "";
}

async function press(plugin: Plugin, customId: string, userId: string) {
  const edits: string[] = [];
  const followUps: string[] = [];
  const interaction = {
    customId,
    guildId: null,
    user: { id: userId },
    message: { content: "the ask" },
    deferred: false,
    replied: false,
    isModalSubmit: () => false,
    isMessageComponent: () => true,
    deferUpdate: async () => {},
    editReply: async (x: { content: string }) => void edits.push(x.content),
    followUp: async (x: { content: string }) => void followUps.push(x.content),
    reply: async (x: { content: string }) => void followUps.push(x.content),
  };
  await plugin.interactions!(interaction as unknown as MessageComponentInteraction);
  return { edits, followUps };
}

const notifyTick = (p: Plugin) => p.ticks!.find((t) => t.name === "notify")!.run(new AbortController().signal);
const pollTick = (p: Plugin) => p.ticks!.find((t) => t.name === "poll")!.run(new AbortController().signal);

async function withLarry(w: ReturnType<typeof world>) {
  await w.plugin.activate!();
  await slash(w.plugin, "register", ADMIN);
  // `/allow` needs a user option; admit Larry through the admin's command with the user filled in.
  const allow = w.plugin.commands!.find((c) => c.name === "allow")!;
  await allow.handle({
    commandName: "allow",
    guildId: null,
    user: { id: ADMIN, username: "admin", globalName: null, bot: false },
    options: { getUser: () => ({ id: LARRY, bot: false }) },
    deferReply: async () => {},
    editReply: async () => {},
  } as unknown as ChatInputCommandInteraction);
  expect(await slash(w.plugin, "register", LARRY, { ints: { hour: 8 } })).toContain("You are registered.");
}

const renewalOptions = (renews: string, extra: Options = {}): Options => ({
  strings: { name: "Netflix", currency: "usd", renews, ...extra.strings },
  numbers: { amount: 15.99, ...extra.numbers },
  ...(extra.ints ? { ints: extra.ints } : {}),
});

describe("/renewal", () => {
  it("asks a week before the date at the preferred hour, with keep, cancel and renewed, and keeps what was paid", async () => {
    const w = world();
    await withLarry(w);
    const set = await slash(w.plugin, "renewal", LARRY, renewalOptions("2026-12-01"));
    expect(set).toContain("Renewal `t1` set: Netflix, 15.99 USD, every year from 2026-12-01, 7 days ahead.");
    expect(set).toContain("First ask: Tue Nov 24, 8:00");

    w.clock.set("2026-11-24T12:59:00.000Z"); // 07:59 EST: not yet
    await notifyTick(w.plugin);
    expect(w.sent).toHaveLength(0);
    w.clock.set("2026-11-24T13:00:00.000Z");
    await notifyTick(w.plugin);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]?.message.content).toContain("Netflix renews on 2026-12-01, in 7 days: 15.99 USD.");
    const labels = (w.sent[0]?.message.buttons ?? []).map((b) => b.label);
    expect(labels).toEqual(expect.arrayContaining(["keep", "cancel", "renewed"]));
    const renewed = (w.sent[0]?.message.buttons ?? []).find((b) => b.label === "renewed")!;

    const pressed = await press(w.plugin, renewed.customId, LARRY);
    expect(pressed.edits[0]).toContain("Recorded: renewed.");
    // The run is answered; a second answer with an amount is refused, not recorded twice.
    const again = await slash(w.plugin, "task", LARRY, { sub: "decide", strings: { task: "t1", choice: "renewed" }, numbers: { amount: 17 } });
    expect(again).toBe("That run has already been answered.");

    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" } });
    expect(history).toContain("`t1` Netflix -- renewal, active");
    expect(history).toContain("Paid: 1 period, 15.99 USD in all");
    expect(history).toContain("15.99 USD (renewed)");
    expect(history).toContain("Next: Wed Nov 24 2027, 8:00");
  });

  it("asks at once when the date is inside the lead, about that date; /task decide records a new amount", async () => {
    const w = world();
    await withLarry(w);
    const set = await slash(w.plugin, "renewal", LARRY, renewalOptions("2026-10-03"));
    expect(set).toContain("First ask: in the next minute (it renews in 2 days).");
    await notifyTick(w.plugin);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]?.message.content).toContain("Netflix renews on 2026-10-03, in 2 days: 15.99 USD.");

    const decided = await slash(w.plugin, "task", LARRY, { sub: "decide", strings: { task: "t1", choice: "renewed" }, numbers: { amount: 17.49 } });
    expect(decided).toBe("Recorded: renewed at 17.49 USD.");
    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" } });
    expect(history).toContain("Paid: 1 period, 17.49 USD in all");
    expect(history).toMatch(/Next: Sun Sep 26 2027, 8:00/);

    // Next year's ask carries the amount last paid.
    w.clock.set("2027-09-26T12:00:00.000Z");
    await notifyTick(w.plugin);
    expect(w.sent.at(-1)?.message.content).toContain("Netflix renews on 2027-10-03, in 7 days: 17.49 USD.");
    expect(w.sent.at(-1)?.message.content).toContain("So far: 1 period, 17.49 USD.");
  });

  it("a cancel ends the task", async () => {
    const w = world();
    await withLarry(w);
    await slash(w.plugin, "renewal", LARRY, renewalOptions("2026-10-03"));
    expect(await slash(w.plugin, "task", LARRY, { sub: "decide", strings: { task: "t1", choice: "cancel" } })).toBe(
      "That renewal has no ask waiting for an answer yet.",
    );
    await notifyTick(w.plugin);
    expect(await slash(w.plugin, "task", LARRY, { sub: "decide", strings: { task: "t1", choice: "cancel" } })).toBe(
      "Cancelled: `t1` Netflix will not ask again.",
    );
    expect(await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" } })).toContain("-- renewal, done");
  });

  it("refuses a past date, a bad date, a bad currency, and decide on a task that is not a renewal", async () => {
    const w = world();
    await withLarry(w);
    expect(await slash(w.plugin, "renewal", LARRY, renewalOptions("2026-09-30"))).toBe("That date has passed: give the next renewal or expiry date.");
    expect(await slash(w.plugin, "renewal", LARRY, renewalOptions("12/01/2026"))).toBe("Give the date as YYYY-MM-DD, for example 2026-12-01.");
    expect(await slash(w.plugin, "renewal", LARRY, renewalOptions("2026-02-30"))).toBe("Give the date as YYYY-MM-DD, for example 2026-12-01.");
    expect(await slash(w.plugin, "renewal", LARRY, renewalOptions("2026-12-01", { strings: { currency: "$$$" } }))).toBe(
      "The currency is a three-letter code, such as USD or EUR.",
    );
    await slash(w.plugin, "remind", LARRY, { strings: { text: "water the plants", when: "9am" } });
    expect(await slash(w.plugin, "task", LARRY, { sub: "decide", strings: { task: "t1", choice: "keep" } })).toBe(
      "`/task decide` answers a renewal; `t1` is a reminder.",
    );
  });
});

describe("/price", () => {
  it("reads the page at once, polls on its own tick, and DMs a drop of 10% or more from the first price", async () => {
    const w = world();
    await withLarry(w);
    const set = await slash(w.plugin, "price", LARRY, { strings: { url: SHOP, baseline: "first" } });
    expect(set).toContain("Tracking `t1`: shop.example/widget. I read 100.00 USD just now.");
    expect(set).toContain("I check every 12 hours");
    expect(w.shop.reads).toEqual([SHOP]);

    // The reminders' tick never reads a page; the poll tick does.
    await notifyTick(w.plugin);
    expect(w.shop.reads).toHaveLength(1);
    expect(w.sent).toHaveLength(0);
    await pollTick(w.plugin);
    expect(w.shop.reads).toHaveLength(2);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]?.message.content).toContain("Now tracking shop.example/widget at 100.00 USD.");

    w.shop.price = 95;
    w.clock.set("2026-10-02T00:00:00.000Z");
    await pollTick(w.plugin);
    expect(w.sent).toHaveLength(1); // 5% down: nothing to say

    w.shop.price = 85;
    w.clock.set("2026-10-02T12:00:00.000Z");
    await pollTick(w.plugin);
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]?.message.content).toContain("shop.example/widget: 85.00 USD, down 15% from 100.00 USD (first seen).");

    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" } });
    expect(history).toContain("-- price, active, every 12 hours");
    expect(history).toContain("Last check: alert: 85.00 USD, down 15% from 100.00 USD");
    expect(history).toContain("Prices: 3 read, low 85.00 USD, high 100.00 USD");

    expect(await slash(w.plugin, "task", LARRY, { sub: "done", strings: { task: "t1" } })).toBe("Marked done.");
    w.clock.set("2026-10-03T12:00:00.000Z");
    await pollTick(w.plugin);
    expect(w.shop.reads).toHaveLength(4);
  });

  it("creates nothing when the page has no price, answers an error, or is refused", async () => {
    const w = world();
    await withLarry(w);
    w.shop.price = null;
    expect(await slash(w.plugin, "price", LARRY, { strings: { url: SHOP } })).toContain("I found no price on that page.");
    w.shop.price = 10;
    w.shop.status = 404;
    expect(await slash(w.plugin, "price", LARRY, { strings: { url: SHOP } })).toBe("That page answered HTTP 404, so there is no price to track.");
    w.shop.status = 200;
    w.shop.refuse = "shop.example is not on the public internet";
    expect(await slash(w.plugin, "price", LARRY, { strings: { url: SHOP } })).toBe("I cannot read that page: shop.example is not on the public internet.");
    expect(await slash(w.plugin, "tasks", LARRY)).not.toContain("t1");
  });

  it("refuses a local address before reading anything, and caps how many one person tracks", async () => {
    const w = world();
    await withLarry(w);
    expect(await slash(w.plugin, "price", LARRY, { strings: { url: "http://localhost/admin" } })).toBe("Only public web pages can be tracked.");
    expect(await slash(w.plugin, "price", LARRY, { strings: { url: "http://192.168.1.10/" } })).toBe("Only public web pages can be tracked.");
    expect(await slash(w.plugin, "price", LARRY, { strings: { url: "https://shop.example:8443/x" } })).toBe(
      "Only pages on the standard web ports can be tracked.",
    );
    expect(await slash(w.plugin, "price", LARRY, { strings: { url: "file:///etc/passwd" } })).toBe("Only http and https pages can be tracked.");
    expect(w.shop.reads).toHaveLength(0);
    for (let i = 0; i < MAX_PRICE_TASKS; i++) {
      expect(await slash(w.plugin, "price", LARRY, { strings: { url: `${SHOP}/${i}` } })).toContain("Tracking");
    }
    expect(await slash(w.plugin, "price", LARRY, { strings: { url: SHOP } })).toContain(`You already track ${MAX_PRICE_TASKS} prices`);
  });

  it("near builds a pattern that finds the price after the owner's words", async () => {
    const w = world();
    await withLarry(w);
    const pattern = nearPattern("Our price (today):");
    expect(new RegExp(pattern, "i").exec("<b>Our price (today):</b> $1,299.99")?.[1]).toBe("1,299.99");
    w.shop.price = null; // no structured price: only `near` can find one, and here it does not
    expect(await slash(w.plugin, "price", LARRY, { strings: { url: SHOP, near: "Our price" } })).toContain("I found no price after that `near` text");
  });
});

describe("an aborted poll tick", () => {
  it("requeues the page read it cut short instead of counting a miss, and runs it on the next tick", async () => {
    const w = world();
    await withLarry(w);
    expect(await slash(w.plugin, "price", LARRY, { strings: { url: SHOP } })).toContain("Tracking `t1`");
    const controller = new AbortController();
    // The host aborts the tick (a restart) while the read is in flight, and the read fails.
    w.shop.onRead = () => {
      controller.abort();
      throw new Error("The operation was aborted.");
    };
    await w.plugin.ticks!.find((t) => t.name === "poll")!.run(controller.signal);
    expect(w.shop.reads).toHaveLength(2); // the preview, and the read the abort cut short
    expect(w.sent).toHaveLength(0);
    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" } });
    expect(history).not.toContain("no price");
    expect(history).toContain("-- queued");

    // The next tick runs it as if nothing happened.
    w.shop.onRead = null;
    await pollTick(w.plugin);
    expect(w.sent.at(-1)?.message.content).toContain("Now tracking shop.example/widget at 100.00 USD.");
  });
});

describe("the two notify ticks", () => {
  it("split the notify-lane types between them, the page readers on poll", () => {
    expect([...FETCH_TYPES]).toEqual(["price"]);
    expect(takesType("notify", "reminder")).toBe(true);
    expect(takesType("notify", "renewal")).toBe(true);
    expect(takesType("notify", "price")).toBe(false);
    expect(takesType("poll", "price")).toBe(true);
    expect(takesType("poll", "reminder")).toBe(false);
  });
});
