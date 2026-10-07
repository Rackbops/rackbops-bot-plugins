import { describe, expect, it } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import type { Plugin } from "../../../packages/api/contract.js";
import { makeFakeHost } from "../../../packages/testkit/index.js";
import { createPlugin } from "./index.js";

/**
 * `/allow` and `/register` with the usr link on (usr.ts, usr-links.ts): `/allow` allows the person in
 * usr and keeps their usr user id, `/register` hands a linked person usr's sign-up link. usr is a
 * fake `fetch`; nothing here reaches a network.
 */

const ADMIN = "111111111111111111";
const LARRY = "222222222222222222";
const CURLY = "333333333333333333";
const GUILD = "999999999999999999";
const SUBJECT = "6f1c2a9e-0000-4000-8000-000000000001";

interface Call {
  path: string;
  body: Record<string, unknown>;
}

type Answer = { status: number; body: unknown } | "down";

function usrFake() {
  const calls: Call[] = [];
  const answers: Record<string, Answer[]> = { "/api/discord/allow": [], "/api/discord/register-link": [] };
  const usrFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
    const next = answers[path]?.shift();
    if (!next) throw new Error(`unexpected usr call ${path}`);
    if (next === "down") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, answers, usrFetch };
}

function world(env: Record<string, string> = { TRACKER_USR_URL: "https://id.example.com", TRACKER_USR_KEY: "k" }) {
  const usr = usrFake();
  const errors: string[] = [];
  const plugin = createPlugin(
    makeFakeHost({
      name: "tracker",
      env: { TRACKER_ADMIN_DISCORD_IDS: ADMIN, ...env },
      log: { info() {}, warn() {}, error: (m) => void errors.push(m) },
      dm: async () => ({ guildId: null, channelId: "c", messageId: "m" }),
    }),
    { clock: { now: () => new Date("2026-10-07T12:00:00.000Z") }, dbPath: ":memory:", digest: false, usrFetch: usr.usrFetch },
  );
  return { plugin, usr, errors };
}

async function slash(plugin: Plugin, name: string, userId: string, o: { target?: string; guildId?: string | null } = {}): Promise<string> {
  const command = plugin.commands?.find((c) => c.name === name);
  if (!command) throw new Error(`no command ${name}`);
  const edits: { content: string }[] = [];
  const interaction = {
    commandName: name,
    guildId: o.guildId === undefined ? GUILD : o.guildId,
    user: { id: userId, username: `user${userId.slice(0, 3)}`, globalName: null, bot: false },
    options: {
      getSubcommand: () => "",
      getString: () => null,
      getInteger: () => null,
      getUser: () => (o.target ? { id: o.target, username: "larry", globalName: "Larry", bot: false } : null),
    },
    deferReply: async () => {},
    editReply: async (x: { content: string }) => void edits.push(x),
  };
  await command.handle(interaction as unknown as ChatInputCommandInteraction);
  return edits[0]?.content ?? "";
}

const allowed = (roles = ["tracker:member"], userId = SUBJECT) => ({ status: 200, body: { user_id: userId, created: true, roles } });

/** The admin is registered and the plugin running; usr is told nothing yet. */
async function started(w: ReturnType<typeof world>) {
  await w.plugin.activate!();
  expect(await slash(w.plugin, "register", ADMIN)).toContain("You are registered.");
  expect(w.usr.calls).toEqual([]); // the admin is not linked, so no sign-up link is asked for
}

describe("/allow with the usr link on", () => {
  it("allows the person in usr as tracker:member, by the admin, in this server, and keeps the usr user id", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push(allowed());
    const answer = await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    expect(answer).toContain(`Allowed <@${LARRY}>`);
    expect(answer).toContain("Linked to usr");
    expect(w.usr.calls).toEqual([
      {
        path: "/api/discord/allow",
        body: { discord_user_id: LARRY, guild_id: GUILD, invoker_discord_user_id: ADMIN, roles: ["member"], display_name: "Larry" },
      },
    ]);
    // Linked: a second /allow does not ask usr again.
    expect(await slash(w.plugin, "allow", ADMIN, { target: LARRY })).toBe(`<@${LARRY}> is already on the list.`);
    expect(w.usr.calls).toHaveLength(1);
  });

  it("keeps the tracker admission when usr refuses, and links on a later /allow", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push({ status: 403, body: { error: "invoker is not linked" } }, allowed());
    const first = await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    expect(first).toContain(`Allowed <@${LARRY}>`);
    expect(first).toContain("Not linked to usr: usr answered HTTP 403: invoker is not linked.");
    expect(await slash(w.plugin, "register", LARRY)).toContain("You are registered."); // admitted all the same
    const again = await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    expect(again).toContain("already on the list");
    expect(again).toContain("Linked to usr");
  });

  it("does not link when usr grants another app's role (the key's service row names another app)", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push(allowed(["city-hall:member"]));
    const answer = await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    expect(answer).toContain("usr did not give them `tracker:member`");
    expect(answer).toContain("TRACKER_USR_APP");
    // Not linked, so /register asks usr for nothing.
    expect(await slash(w.plugin, "register", LARRY)).toContain("You are registered.");
    expect(w.usr.calls).toHaveLength(1);
  });

  it("never links two people to one usr account", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push(allowed(), allowed());
    expect(await slash(w.plugin, "allow", ADMIN, { target: LARRY })).toContain("Linked to usr");
    expect(await slash(w.plugin, "allow", ADMIN, { target: CURLY })).toContain("already linked to someone else here");
  });

  it("says usr could not be reached, and asks for a server when run in a DM", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push("down");
    expect(await slash(w.plugin, "allow", ADMIN, { target: LARRY })).toContain("Not linked to usr: usr could not be reached.");
    const inDm = await slash(w.plugin, "allow", ADMIN, { target: CURLY, guildId: null });
    expect(inDm).toContain(`Allowed <@${CURLY}>`);
    expect(inDm).toContain("run `/allow` in the server to link them");
    expect(w.usr.calls).toHaveLength(1);
  });
});

describe("/register with the usr link on", () => {
  it("hands a linked person usr's one-time sign-up link, and nothing once usr says they signed up", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push(allowed());
    await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    w.usr.answers["/api/discord/register-link"]!.push(
      { status: 200, body: { url: "https://id.example.com/register/discord?t=abc", expires_at: "2026-10-07T12:15:00.000Z" } },
      { status: 409, body: { error: "already registered" } },
    );
    const first = await slash(w.plugin, "register", LARRY);
    expect(first).toContain("You are registered.");
    expect(first).toContain("Finish signing up on usr, where you will sign in to the web area: https://id.example.com/register/discord?t=abc");
    expect(w.usr.calls.at(-1)).toEqual({ path: "/api/discord/register-link", body: { discord_user_id: LARRY, guild_id: GUILD, policy: "allow" } });
    const second = await slash(w.plugin, "register", LARRY);
    expect(second).toContain("Your settings are updated.");
    expect(second).not.toContain("usr");
    // usr said they signed up: no more asks, so its rate limit never shows.
    expect(await slash(w.plugin, "register", LARRY)).not.toContain("usr");
    expect(w.usr.calls.filter((c) => c.path === "/api/discord/register-link")).toHaveLength(2);
  });

  it("still registers when usr fails, and says to try again", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push(allowed());
    await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    w.usr.answers["/api/discord/register-link"]!.push({ status: 429, body: { error: "rate limit exceeded" } });
    const answer = await slash(w.plugin, "register", LARRY);
    expect(answer).toContain("You are registered.");
    expect(answer).toContain("I could not get your usr sign-up link (usr answered HTTP 429: rate limit exceeded)");
  });
});

describe("with the usr link off", () => {
  it("/allow and /register never call usr", async () => {
    const w = world({});
    await w.plugin.activate!();
    await slash(w.plugin, "register", ADMIN);
    expect(await slash(w.plugin, "allow", ADMIN, { target: LARRY })).toBe(`Allowed <@${LARRY}>: they can now use \`/register\`.`);
    expect(await slash(w.plugin, "register", LARRY)).toContain("You are registered.");
    expect(w.usr.calls).toEqual([]);
  });
});
