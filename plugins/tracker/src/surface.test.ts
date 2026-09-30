import { describe, expect, it } from "bun:test";
import type { ChatInputCommandInteraction, MessageComponentInteraction, ModalSubmitInteraction } from "discord.js";
import type { HostApi, HostMessage, Plugin } from "../../../packages/api/contract.js";
import { makeFakeHost } from "../../../packages/testkit/index.js";
import { NOT_ADMIN, NOT_ADMITTED, NOT_MEMBER, NOT_REGISTERED, type Membership } from "./access.js";
import { PAUSE_AFTER } from "./delivery-health.js";
import { NO_SUCH_TASK } from "./actions.js";
import { lookupMembership, type Interactionish } from "./discord.js";
import { createPlugin } from "./index.js";
import { HOST_CANNOT_MESSAGE } from "./notifier.js";
import { CANNOT_SHARE } from "./press.js";

/**
 * The Discord surface end to end (rackbops-bot-plugins#79), through the plugin's own commands and
 * interactions handler with fake interactions and a fake host: the issue's "done when" -- a
 * reminder set by slash command arrives by DM at the chosen hour, is done or snoozed by button, and
 * shows in history -- plus the gates, consent, the Reply modal, and the pause after failed DMs.
 */

const ADMIN = "111111111111111111";
const LARRY = "222222222222222222";
const CURLY = "333333333333333333";
const STRANGER = "444444444444444444";
const GUILD = "999999999999999999";
const GUILD_B = "888888888888888888";
// 2026-10-01 is a Thursday; 12:00 UTC is 08:00 in New York (EDT).
const START = "2026-10-01T12:00:00.000Z";

function clockAt(iso: string) {
  let now = new Date(iso);
  return { now: () => new Date(now), set: (s: string) => (now = new Date(s)) };
}

interface Sent {
  userId: string;
  message: HostMessage;
}

function world(opts: { members?: Set<string>; unreachable?: Set<string> } = {}) {
  const clock = clockAt(START);
  const sent: Sent[] = [];
  const unreachable = opts.unreachable ?? new Set<string>();
  let n = 0;
  const dm: NonNullable<HostApi["dm"]> = async (userId, message) => {
    if (unreachable.has(userId)) throw new Error(HOST_CANNOT_MESSAGE);
    sent.push({ userId, message });
    n++;
    return { guildId: null, channelId: `c${n}`, messageId: `m${n}` };
  };
  const warnings: string[] = [];
  const members = opts.members;
  const plugin = createPlugin(
    makeFakeHost({
      name: "tracker",
      env: { TRACKER_ADMIN_DISCORD_IDS: ADMIN, ...(members ? { TRACKER_GUILD_ID: GUILD } : {}) },
      log: { info() {}, warn: (m) => void warnings.push(m), error() {} },
      dm,
    }),
    {
      clock,
      dbPath: ":memory:",
      ...(members ? { membership: async (_i: Interactionish, id: string): Promise<Membership> => (members.has(id) ? "member" : "not-member") } : {}),
    },
  );
  return { plugin, clock, sent, unreachable, warnings };
}

type Options = { sub?: string; strings?: Record<string, string>; ints?: Record<string, number>; users?: Record<string, string>; client?: unknown; guildId?: string };

/** Runs a slash command as `userId` and returns the ephemeral answer's text. */
async function slash(plugin: Plugin, name: string, userId: string, o: Options = {}): Promise<string> {
  const command = plugin.commands?.find((c) => c.name === name);
  if (!command) throw new Error(`no command ${name}`);
  const edits: { content: string }[] = [];
  let deferred: unknown = null;
  const interaction = {
    commandName: name,
    guildId: o.guildId ?? null,
    ...(o.client ? { client: o.client } : {}),
    user: { id: userId, username: `user${userId.slice(0, 3)}`, globalName: userId === LARRY ? "Larry" : null, bot: false },
    options: {
      getSubcommand: () => o.sub ?? "",
      getString: (k: string) => o.strings?.[k] ?? null,
      getInteger: (k: string) => o.ints?.[k] ?? null,
      getUser: (k: string) => (o.users?.[k] ? { id: o.users[k], bot: false } : null),
    },
    deferReply: async (x: unknown) => void (deferred = x),
    editReply: async (x: { content: string }) => void edits.push(x),
  };
  await command.handle(interaction as unknown as ChatInputCommandInteraction);
  expect(deferred).toMatchObject({ flags: 64 });
  expect(edits).toHaveLength(1);
  return edits[0]?.content ?? "";
}

interface Pressed {
  edits: { content: string; components: unknown[] }[];
  followUps: string[];
  replies: string[];
  modals: unknown[];
}

/** Presses the button `customId` on a DM whose text is `content`, as `userId`. */
async function pressButton(plugin: Plugin, customId: string, userId: string, content = "the message"): Promise<Pressed> {
  const p: Pressed = { edits: [], followUps: [], replies: [], modals: [] };
  const interaction = {
    customId,
    guildId: null,
    user: { id: userId },
    message: { content },
    deferred: false,
    replied: false,
    isModalSubmit: () => false,
    isMessageComponent: () => true,
    deferUpdate: async () => {
      interaction.deferred = true;
    },
    editReply: async (x: { content: string; components: unknown[] }) => void p.edits.push(x),
    followUp: async (x: { content: string }) => void p.followUps.push(x.content),
    reply: async (x: { content: string }) => {
      interaction.replied = true;
      p.replies.push(x.content);
    },
    showModal: async (m: unknown) => void p.modals.push(m),
  };
  await plugin.interactions!(interaction as unknown as MessageComponentInteraction);
  return p;
}

async function submitModal(plugin: Plugin, customId: string, userId: string, text: string): Promise<string> {
  const edits: { content: string }[] = [];
  const interaction = {
    customId,
    guildId: null,
    user: { id: userId },
    deferred: false,
    replied: false,
    isModalSubmit: () => true,
    isMessageComponent: () => false,
    fields: { getTextInputValue: () => text },
    deferReply: async () => {
      interaction.deferred = true;
    },
    editReply: async (x: { content: string }) => void edits.push(x),
    followUp: async () => {},
    reply: async () => {},
  };
  await plugin.interactions!(interaction as unknown as ModalSubmitInteraction);
  return edits[0]?.content ?? "";
}

const tick = (plugin: Plugin) => plugin.ticks![0]!.run(new AbortController().signal);

function buttonIds(s: Sent | undefined): string[] {
  return (s?.message.buttons ?? []).map((b) => b.customId);
}

/** Admin allows Larry, Larry registers, and the plugin is running. */
async function withLarry(w: ReturnType<typeof world>) {
  await w.plugin.activate!();
  expect(await slash(w.plugin, "register", ADMIN)).toContain("You are registered.");
  expect(await slash(w.plugin, "allow", ADMIN, { users: { user: LARRY } })).toContain(`Allowed <@${LARRY}>`);
  const registered = await slash(w.plugin, "register", LARRY, { ints: { hour: 8 } });
  expect(registered).toContain("You are registered.");
  return registered;
}

describe("the first slice: a reminder by slash command, by DM, answered by button, in history", () => {
  it("arrives at the chosen hour, is marked done by button, and shows in history", async () => {
    const w = world();
    const registered = await withLarry(w);
    expect(registered).toContain("An admin of this tracker can see every task and its history, including yours.");
    expect(registered).toContain("08:00, America/New_York time");

    const set = await slash(w.plugin, "remind", LARRY, { strings: { text: "water the plants", when: "9am" } });
    expect(set).toContain("Reminder `t1` set: water the plants");
    expect(set).toContain("Next: Thu Oct 1, 9:00");

    w.clock.set("2026-10-01T12:59:00.000Z"); // 08:59 local: not yet
    await tick(w.plugin);
    expect(w.sent).toHaveLength(0);

    w.clock.set("2026-10-01T13:00:00.000Z"); // 09:00 local
    await tick(w.plugin);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]?.userId).toBe(LARRY);
    expect(w.sent[0]?.message.content).toBe("water the plants");
    const [done, snooze, reply] = buttonIds(w.sent[0]);
    expect(done).toBe("tracker:d.o.o1");
    expect(snooze).toBe("tracker:s.o.o1");
    expect(reply).toBe("tracker:r.o.o1");

    // Someone else's press is refused by docket, and changes nothing.
    await slash(w.plugin, "allow", ADMIN, { users: { user: CURLY } });
    await slash(w.plugin, "register", CURLY);
    const stolen = await pressButton(w.plugin, done as string, CURLY);
    expect(stolen.edits).toHaveLength(0);
    expect(stolen.followUps).toEqual(["That is not yours to answer."]);

    const pressed = await pressButton(w.plugin, done as string, LARRY, "water the plants");
    expect(pressed.edits).toHaveLength(1);
    expect(pressed.edits[0]?.content).toBe("water the plants\n\n-- Marked done.");
    expect(pressed.edits[0]?.components).toHaveLength(1); // only the Reply button is left

    const again = await pressButton(w.plugin, done as string, LARRY);
    expect(again.followUps).toEqual(["That run has already been answered."]);

    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" } });
    expect(history).toContain("`t1` water the plants -- reminder, active, once, Thu Oct 1, 9:00");
    expect(history).toContain("- Thu Oct 1, 9:00 -- done; Larry done");
    expect(history).toContain("created");
    // Admin sees it too (plan 5.10); a stranger to the task does not.
    expect(await slash(w.plugin, "task", ADMIN, { sub: "history", strings: { task: "t1" } })).toContain("Larry done");
    expect(await slash(w.plugin, "task", CURLY, { sub: "history", strings: { task: "t1" } })).toBe(NO_SUCH_TASK);
  });

  it("a daily reminder is snoozed by button, re-asked at the snooze, and the next day still comes", async () => {
    const w = world();
    await withLarry(w);
    const set = await slash(w.plugin, "remind", LARRY, { strings: { text: "stretch", repeat: "day" } });
    expect(set).toContain("daily at 8:00");
    w.clock.set("2026-10-02T12:00:00.000Z"); // Fri 08:00 local (Thu 08:00 had passed at creation)
    await tick(w.plugin);
    expect(w.sent).toHaveLength(1);
    const pressed = await pressButton(w.plugin, buttonIds(w.sent[0])[1] as string, LARRY, "stretch");
    expect(pressed.edits[0]?.content).toBe("stretch\n\n-- Snoozed until Fri Oct 2, 9:00.");

    w.clock.set("2026-10-02T13:00:00.000Z");
    await tick(w.plugin);
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]?.message.content).toBe("stretch");
    const list = await slash(w.plugin, "tasks", LARRY);
    expect(list).toContain("`t1` stretch -- next Sat Oct 3, 8:00, daily at 8:00");
    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" } });
    expect(history).toContain("-- snoozed; Larry snooze");
  });

  it("/task done and /task snooze answer the latest fired run by command", async () => {
    const w = world();
    await withLarry(w);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "call mum", when: "in 5 minutes" } });
    expect(await slash(w.plugin, "task", LARRY, { sub: "done", strings: { task: "t1" } })).toBe(
      "That task has not reminded you yet, so there is nothing to answer.",
    );
    w.clock.set("2026-10-01T12:05:00.000Z");
    await tick(w.plugin);
    expect(await slash(w.plugin, "task", LARRY, { sub: "snooze", strings: { task: "t1", until: "in 2h" } })).toBe(
      "Snoozed until Thu Oct 1, 10:05.",
    );
    w.clock.set("2026-10-01T14:05:00.000Z");
    await tick(w.plugin);
    expect(w.sent).toHaveLength(2);
    expect(await slash(w.plugin, "task", LARRY, { sub: "done", strings: { task: "t1" } })).toBe("Marked done.");
    expect(await slash(w.plugin, "task", LARRY, { sub: "done", strings: { task: "t9" } })).toBe(NO_SUCH_TASK);
  });

  it("/settings hour moves a recurring reminder that has no time of its own", async () => {
    const w = world();
    await withLarry(w);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "journal", repeat: "day" } });
    expect(await slash(w.plugin, "settings", LARRY, { sub: "hour", ints: { hour: 21 } })).toBe(
      "Your preferred hour is now 21:00, America/New_York time. 1 recurring reminder(s) moved to it.",
    );
    expect(await slash(w.plugin, "tasks", LARRY)).toContain("next Thu Oct 1, 21:00, daily at 21:00");
  });

  it("refuses a /remind it cannot read, naming why", async () => {
    const w = world();
    await withLarry(w);
    expect(await slash(w.plugin, "remind", LARRY, { strings: { text: "x" } })).toContain("Say when");
    expect(await slash(w.plugin, "remind", LARRY, { strings: { text: "x", when: "whenever" } })).not.toContain("set:");
    expect(await slash(w.plugin, "register", LARRY, { strings: { zone: "Mars/Olympus" } })).toContain("is not a time zone");
  });
});

describe("the gates", () => {
  it("admission: nobody admitted gets told to ask; /register needs admission, the rest registration; /allow needs an admin", async () => {
    const w = world();
    await w.plugin.activate!();
    expect(await slash(w.plugin, "register", STRANGER)).toBe(NOT_ADMITTED);
    expect(await slash(w.plugin, "tasks", STRANGER)).toBe(NOT_ADMITTED);
    expect((await pressButton(w.plugin, "tracker:d.o.o1", STRANGER)).followUps).toEqual([NOT_ADMITTED]);
    await slash(w.plugin, "allow", ADMIN, { users: { user: LARRY } });
    expect(await slash(w.plugin, "remind", LARRY, { strings: { text: "x", when: "9am" } })).toBe(NOT_REGISTERED);
    expect(await slash(w.plugin, "allow", LARRY, { users: { user: CURLY } })).toBe(NOT_ADMIN);
    expect(await slash(w.plugin, "allow", ADMIN, { users: { user: LARRY } })).toBe(`<@${LARRY}> is already on the list.`);
    // The bootstrap admin registers without an /allow.
    expect(await slash(w.plugin, "register", ADMIN)).toContain("You are registered.");
  });

  it("membership: with TRACKER_GUILD_ID set, a non-member is refused even when admitted, and cannot be allowed", async () => {
    const w = world({ members: new Set([ADMIN, LARRY]) });
    await w.plugin.activate!();
    expect(await slash(w.plugin, "allow", ADMIN, { users: { user: CURLY } })).toBe(`<@${CURLY}> is not a member of this tracker's server.`);
    expect(await slash(w.plugin, "allow", ADMIN, { users: { user: LARRY } })).toContain("Allowed");
    expect(await slash(w.plugin, "register", LARRY)).toContain("You are registered.");
    expect(await slash(w.plugin, "register", STRANGER)).toBe(NOT_MEMBER);
  });

  it("answers 'starting' before activate", async () => {
    const w = world();
    expect(await slash(w.plugin, "tasks", LARRY)).toBe("The tracker is starting up; try again in a minute.");
  });
});

describe("lookupMembership", () => {
  const log = { info() {}, warn() {}, error() {} };
  const client = (fetchMember: () => Promise<unknown>) => ({
    guilds: { fetch: async () => ({ members: { fetch: fetchMember } }) },
  });
  const at = (guildId: string | null, fetchMember: () => Promise<unknown>): Interactionish => ({ guildId, user: { id: LARRY }, client: client(fetchMember) });
  const unknownMember = () => Promise.reject(Object.assign(new Error("Unknown Member"), { code: 10007 }));
  const missingAccess = () => Promise.reject(Object.assign(new Error("Missing Access"), { code: 50001 }));

  it("is not checked without a guild, a yes inside the guild, and asks Discord from a DM", async () => {
    expect(await lookupMembership(at(null, async () => ({})), null, LARRY, log)).toBe("not-checked");
    expect(await lookupMembership(at(GUILD, async () => Promise.reject(new Error("unused"))), [GUILD], LARRY, log)).toBe("member");
    expect(await lookupMembership(at(null, async () => ({})), [GUILD], LARRY, log)).toBe("member");
    expect(await lookupMembership(at(null, unknownMember), [GUILD], LARRY, log)).toBe("not-member");
    expect(await lookupMembership(at(null, missingAccess), [GUILD], LARRY, log)).toBe("unknown");
  });

  /** A client whose servers answer per id: "yes", "no" (unknown member) or "down" (any other error). */
  const perServer = (answers: Record<string, "yes" | "no" | "down">, asked: string[] = []) => ({
    guilds: {
      fetch: async (id: string) => ({
        members: {
          fetch: async (o: { user: string; force?: boolean }) => {
            asked.push(`${id}/${o.user}/${o.force === true}`);
            const a = answers[id];
            if (a === "yes") return { id: o.user };
            return a === "no" ? unknownMember() : missingAccess();
          },
        },
      }),
    },
  });
  const from = (guildId: string | null, c: Interactionish["client"]): Interactionish => ({ guildId, user: { id: LARRY }, client: c });

  it("with two servers: a member of either passes; a no from both is not-member; a no and a failure is unknown", async () => {
    const both = [GUILD, GUILD_B];
    const asked: string[] = [];
    expect(await lookupMembership(from(null, perServer({ [GUILD]: "no", [GUILD_B]: "yes" }, asked)), both, LARRY, log)).toBe("member");
    expect(asked.sort()).toEqual([`${GUILD_B}/${LARRY}/true`, `${GUILD}/${LARRY}/true`]);
    expect(await lookupMembership(from(null, perServer({ [GUILD]: "yes", [GUILD_B]: "down" })), both, LARRY, log)).toBe("member");
    expect(await lookupMembership(from(null, perServer({ [GUILD]: "no", [GUILD_B]: "no" })), both, LARRY, log)).toBe("not-member");
    expect(await lookupMembership(from(null, perServer({ [GUILD]: "no", [GUILD_B]: "down" })), both, LARRY, log)).toBe("unknown");
    expect(await lookupMembership(from(null, perServer({ [GUILD]: "down", [GUILD_B]: "down" })), both, LARRY, log)).toBe("unknown");
  });

  it("with two servers: inside either listed one is a yes with no lookup; inside an unlisted one still asks", async () => {
    const asked: string[] = [];
    const c = perServer({ [GUILD]: "no", [GUILD_B]: "no" }, asked);
    expect(await lookupMembership(from(GUILD_B, c), [GUILD, GUILD_B], LARRY, log)).toBe("member");
    expect(asked).toEqual([]);
    expect(await lookupMembership(from("777777777777777777", c), [GUILD, GUILD_B], LARRY, log)).toBe("not-member");
    expect(asked).toHaveLength(2);
    // Inside a listed server, but asking about someone else: a lookup.
    expect(await lookupMembership(from(GUILD, c), [GUILD, GUILD_B], CURLY, log)).toBe("not-member");
  });

  it("end to end, TRACKER_GUILD_ID=A,B: a member of only B uses every command; a member of neither is refused as today", async () => {
    const plugin = createPlugin(
      makeFakeHost({
        name: "tracker",
        env: { TRACKER_ADMIN_DISCORD_IDS: ADMIN, TRACKER_GUILD_ID: `${GUILD}, ${GUILD_B}` },
        log,
        dm: async () => ({ guildId: null, channelId: "c", messageId: "m" }),
      }),
      { clock: clockAt(START), dbPath: ":memory:" },
    );
    await plugin.activate!();
    const members: Record<string, Set<string>> = { [GUILD]: new Set([ADMIN]), [GUILD_B]: new Set([LARRY]) };
    const c = {
      guilds: {
        fetch: async (id: string) => ({
          members: {
            fetch: async (o: { user: string }) => (members[id]?.has(o.user) ? { id: o.user } : unknownMember()),
          },
        }),
      },
    };
    expect(await slash(plugin, "register", ADMIN, { client: c })).toContain("You are registered.");
    expect(await slash(plugin, "allow", ADMIN, { client: c, users: { user: LARRY } })).toContain("Allowed");
    expect(await slash(plugin, "allow", ADMIN, { client: c, users: { user: CURLY } })).toBe(`<@${CURLY}> is not a member of this tracker's server.`);
    expect(await slash(plugin, "register", LARRY, { client: c })).toContain("You are registered.");
    expect(await slash(plugin, "tasks", LARRY, { client: c })).toBe("You have no active tasks.");
    // From inside server B itself, no lookup is needed.
    expect(await slash(plugin, "tasks", LARRY, { client: perServer({}), guildId: GUILD_B })).toBe("You have no active tasks.");
    expect(await slash(plugin, "register", STRANGER, { client: c })).toBe(NOT_MEMBER);
    // Larry leaves B: now a member of neither, and refused.
    members[GUILD_B]?.delete(LARRY);
    expect(await slash(plugin, "tasks", LARRY, { client: c })).toBe(NOT_MEMBER);
  });
});

describe("consent, the opt-out, and the Reply modal", () => {
  it("shares a task: the consent DM discloses and asks; accept puts them on it with an opt-out; the owner alone answers", async () => {
    const w = world();
    await withLarry(w);
    await slash(w.plugin, "allow", ADMIN, { users: { user: CURLY } });
    expect(await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } })).toBe(NO_SUCH_TASK);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "bins out", when: "9am", repeat: "week" } });
    expect(await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } })).toContain("registered");
    await slash(w.plugin, "register", CURLY);
    expect(await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } })).toContain("Invited");

    const invite = w.sent.at(-1);
    expect(invite?.userId).toBe(CURLY);
    expect(invite?.message.content).toContain('Larry wants you to be notified about "bins out", which runs weekly on Thu at 9:00.');
    expect(invite?.message.content).toContain("An admin of this tracker can see every task and its history, including yours.");
    expect(buttonIds(invite)).toEqual(["tracker:a.t.t1", "tracker:x.t.t1"]);
    // Only the invitee's press counts.
    expect((await pressButton(w.plugin, "tracker:a.t.t1", LARRY)).followUps).toEqual(["That is not yours to answer."]);
    const accepted = await pressButton(w.plugin, "tracker:a.t.t1", CURLY, invite?.message.content);
    expect(accepted.edits[0]?.content).toContain("-- Accepted");
    expect(accepted.edits[0]?.components).toEqual([]);

    w.clock.set("2026-10-01T13:00:00.000Z");
    await tick(w.plugin);
    const [owners, curlys] = w.sent.slice(-2);
    expect(owners?.userId).toBe(LARRY);
    expect(buttonIds(owners)).toEqual(["tracker:d.o.o1", "tracker:s.o.o1", "tracker:r.o.o1"]);
    expect(curlys?.userId).toBe(CURLY);
    expect(buttonIds(curlys)).toEqual(["tracker:q.o.o1", "tracker:r.o.o1"]);

    // The Reply button opens a modal; its text is kept on the task.
    const opened = await pressButton(w.plugin, "tracker:r.o.o1", CURLY);
    expect(opened.modals).toHaveLength(1);
    expect(await submitModal(w.plugin, "tracker:m.o.o1", CURLY, "done it already")).toBe("Reply kept with the task's history.");
    expect(await submitModal(w.plugin, "tracker:m.o.o1", STRANGER, "hi")).toBe(NOT_ADMITTED);
    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" } });
    expect(history).toContain('replied "done it already"');

    const optedOut = await pressButton(w.plugin, "tracker:q.o.o1", CURLY, "bins out");
    expect(optedOut.edits[0]?.content).toContain("-- You will not get this task's messages any more.");
    expect((await pressButton(w.plugin, "tracker:r.o.o1", CURLY)).replies).toEqual(["That is not yours to reply to."]);
  });

  it("a decline blocks the owner's next invitation", async () => {
    const w = world();
    await withLarry(w);
    await slash(w.plugin, "allow", ADMIN, { users: { user: CURLY } });
    await slash(w.plugin, "register", CURLY);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "bins out", when: "9am", repeat: "week" } });
    await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } });
    const declined = await pressButton(w.plugin, "tracker:x.t.t1", CURLY);
    expect(declined.edits[0]?.content).toContain("-- Declined.");
    expect(await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } })).toContain(
      "declined an earlier invitation from you",
    );
  });

  it("an invitation that cannot be delivered is withdrawn and the owner is told", async () => {
    const w = world({ unreachable: new Set([CURLY]) });
    await withLarry(w);
    await slash(w.plugin, "allow", ADMIN, { users: { user: CURLY } });
    await slash(w.plugin, "register", CURLY);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "bins out", when: "9am", repeat: "week" } });
    expect(await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } })).toContain(
      "so the invitation is withdrawn",
    );
    w.unreachable.clear();
    expect(await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } })).toContain("Invited");
  });
});

describe("pause after repeated failed DMs", () => {
  it(`pauses a person's tasks after ${PAUSE_AFTER} undeliverable DMs, and resumes them on their next command, telling them`, async () => {
    const w = world({ unreachable: new Set([LARRY]) });
    await withLarry(w);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "pills", repeat: "day" } });
    await slash(w.plugin, "remind", LARRY, { strings: { text: "walk", repeat: "day", when: "9am" } });

    // Created Thu 08:00 local: walk is due Thu 9:00, pills Fri 8:00.
    w.clock.set("2026-10-02T12:00:00.000Z"); // Fri 08:00
    await tick(w.plugin); // walk (Thu, late) fails: 1; pills (Fri) fails: 2
    expect(w.warnings.some((m) => m.includes("paused delivery"))).toBe(false);
    w.clock.set("2026-10-02T13:00:00.000Z"); // Fri 09:00
    await tick(w.plugin); // walk (Fri) fails: 3, and delivery pauses
    expect(w.warnings.some((m) => m.includes(`paused delivery to u2: ${PAUSE_AFTER} DMs in a row`))).toBe(true);
    const walk = await slash(w.plugin, "task", ADMIN, { sub: "history", strings: { task: "t2" } });
    expect(walk).toContain("`t2` walk -- reminder, paused, daily at 9:00");
    expect(walk).toContain("paused: delivery paused: 3 DMs in a row could not be delivered");

    // Pills' Saturday run was queued before the pause; a paused task's run is not run.
    w.clock.set("2026-10-04T12:00:00.000Z"); // Sun 08:00
    await tick(w.plugin);
    const pills = await slash(w.plugin, "task", ADMIN, { sub: "history", strings: { task: "t1" } });
    expect(pills).toContain("- Sat Oct 3, 8:00 -- queued");

    w.unreachable.clear();
    const back = await slash(w.plugin, "tasks", LARRY);
    expect(back).toContain(`I could not DM you ${PAUSE_AFTER} times in a row, so your reminders were paused. 2 task(s) are back on.`);
    expect(back).toContain("`t1` pills");
    expect(back).not.toContain("Paused:");
    await tick(w.plugin); // Saturday's pills fires, late; walk is next due Sun 9:00
    expect(w.sent.map((s) => s.message.content)).toEqual(["pills"]);
    expect(await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t2" } })).toContain("Next: Sun Oct 4, 9:00");
    expect(await slash(w.plugin, "tasks", LARRY)).not.toContain("I could not DM you");
  });
});

describe("review fixes (#79)", () => {
  it("/register and /settings hour keep a pending snooze, and change nothing when nothing changed", async () => {
    const w = world();
    await withLarry(w);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "stretch", repeat: "day" } });
    w.clock.set("2026-10-02T12:00:00.000Z");
    await tick(w.plugin);
    await pressButton(w.plugin, buttonIds(w.sent[0])[1] as string, LARRY, "stretch"); // snoozed to 09:00
    expect(await slash(w.plugin, "settings", LARRY, { sub: "hour", ints: { hour: 8 } })).toBe("Your preferred hour is already 08:00, America/New_York time.");
    expect(await slash(w.plugin, "register", LARRY)).toContain("Your settings are updated.");
    expect(await slash(w.plugin, "settings", LARRY, { sub: "hour", ints: { hour: 7 } })).toContain("1 recurring reminder(s) moved");
    w.clock.set("2026-10-02T13:00:00.000Z"); // the snooze, still there
    await tick(w.plugin);
    expect(w.sent).toHaveLength(2);
    const history = await slash(w.plugin, "task", LARRY, { sub: "history", strings: { task: "t1" } });
    expect(history).toContain("Next: Sat Oct 3, 7:00");
  });

  it("declining and opting out work for someone no longer in the server or registered", async () => {
    const members = new Set([ADMIN, LARRY, CURLY]);
    const w = world({ members });
    await withLarry(w);
    await slash(w.plugin, "allow", ADMIN, { users: { user: CURLY } });
    await slash(w.plugin, "register", CURLY);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "bins out", when: "9am", repeat: "week" } });
    await slash(w.plugin, "remind", LARRY, { strings: { text: "recycling", when: "9am", repeat: "week" } });
    await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } });
    await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t2" }, users: { user: CURLY } });
    await pressButton(w.plugin, "tracker:a.t.t2", CURLY);
    members.delete(CURLY);
    expect((await pressButton(w.plugin, "tracker:a.t.t1", CURLY)).followUps).toEqual([NOT_MEMBER]);
    expect((await pressButton(w.plugin, "tracker:x.t.t1", CURLY)).edits[0]?.content).toContain("-- Declined.");
    w.clock.set("2026-10-01T13:00:00.000Z");
    await tick(w.plugin);
    const optOut = buttonIds(w.sent.find((s) => s.userId === CURLY && s.message.content === "recycling"))[0] as string;
    expect((await pressButton(w.plugin, optOut, CURLY)).edits[0]?.content).toContain("-- You will not get this task's messages any more.");
    expect((await pressButton(w.plugin, "tracker:q.o.o1", STRANGER)).followUps).toEqual(["That is not yours to answer."]);
  });

  it("/task share checks membership and does not say which gate refused", async () => {
    const w = world({ members: new Set([ADMIN, LARRY]) });
    await withLarry(w);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "bins out", when: "9am", repeat: "week" } });
    const nonMember = await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } });
    const unknown = await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: STRANGER } });
    expect(nonMember).toBe(`<@${CURLY}> ${CANNOT_SHARE}`);
    expect(unknown).toBe(`<@${STRANGER}> ${CANNOT_SHARE}`);
  });

  it("the Reply button resumes and writes nothing before its modal comes back", async () => {
    const w = world({ unreachable: new Set([LARRY]) });
    await withLarry(w);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "pills", repeat: "day" } });
    for (const at of ["2026-10-02T12:00:00.000Z", "2026-10-03T12:00:00.000Z", "2026-10-04T12:00:00.000Z"]) {
      w.clock.set(at);
      await tick(w.plugin);
    }
    expect(await slash(w.plugin, "tasks", ADMIN)).toBe("You have no active tasks.");
    w.unreachable.clear();
    const opened = await pressButton(w.plugin, "tracker:r.o.o1", LARRY);
    expect(opened.modals).toHaveLength(1);
    const history = await slash(w.plugin, "task", ADMIN, { sub: "history", strings: { task: "t1" } });
    expect(history).toContain("reminder, paused");
    expect(await submitModal(w.plugin, "tracker:m.o.o1", LARRY, "sorry, DMs were off")).toContain("so your reminders were paused");
    expect(await slash(w.plugin, "task", ADMIN, { sub: "history", strings: { task: "t1" } })).toContain("reminder, active");
  });

  it("a recipient who cannot be DMed pauses the task; the owner is told, sees it in /tasks, and can go on without them", async () => {
    const w = world();
    await withLarry(w);
    await slash(w.plugin, "allow", ADMIN, { users: { user: CURLY } });
    await slash(w.plugin, "register", CURLY);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "bins out", when: "9am", repeat: "day" } });
    await slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: CURLY } });
    await pressButton(w.plugin, "tracker:a.t.t1", CURLY);
    w.unreachable.add(CURLY);
    for (const day of ["01", "02", "03", "04"]) {
      w.clock.set(`2026-10-${day}T13:00:00.000Z`);
      await tick(w.plugin);
    }
    const told = w.sent.filter((s) => s.userId === LARRY && s.message.content.startsWith("Your task"));
    expect(told).toHaveLength(1);
    expect(told[0]?.message.content).toContain("I could not DM user333 3 times in a row");
    expect(await slash(w.plugin, "tasks", LARRY)).toContain("Paused: `t1` bins out -- I could not DM user333; `/task resume t1` goes on without them.");
    expect(await slash(w.plugin, "task", LARRY, { sub: "resume", strings: { task: "t1" } })).toBe("Resumed `t1`, without user333.");
    expect(await slash(w.plugin, "tasks", LARRY)).toContain("`t1` bins out -- next");
  });
});

describe("share refusals", () => {
  it("read the same whatever docket's reason, except a block the target chose", async () => {
    const w = world();
    await withLarry(w);
    await slash(w.plugin, "allow", ADMIN, { users: { user: CURLY } });
    await slash(w.plugin, "register", CURLY);
    await slash(w.plugin, "remind", LARRY, { strings: { text: "bins out", when: "9am", repeat: "week" } });
    const share = (who: string) => slash(w.plugin, "task", LARRY, { sub: "share", strings: { task: "t1" }, users: { user: who } });
    expect(await share(CURLY)).toContain("Invited");
    expect(await share(CURLY)).toBe(`<@${CURLY}> ${CANNOT_SHARE}`); // already invited
    expect(await share(LARRY)).toBe(`<@${LARRY}> ${CANNOT_SHARE}`); // themself
    await pressButton(w.plugin, "tracker:x.t.t1", CURLY);
    expect(await share(CURLY)).toContain("declined an earlier invitation from you");
  });
});
