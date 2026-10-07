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

async function slash(plugin: Plugin, name: string, userId: string, o: { target?: string; guildId?: string | null; strings?: Record<string, string> } = {}): Promise<string> {
  const command = plugin.commands?.find((c) => c.name === name);
  if (!command) throw new Error(`no command ${name}`);
  const edits: { content: string }[] = [];
  const interaction = {
    commandName: name,
    guildId: o.guildId === undefined ? GUILD : o.guildId,
    user: { id: userId, username: `user${userId.slice(0, 3)}`, globalName: null, bot: false },
    options: {
      getSubcommand: () => "",
      getString: (k: string) => o.strings?.[k] ?? null,
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
const link = (t = "abc") => ({ status: 200, body: { url: `https://id.example.com/register/discord?t=${t}`, expires_at: "2026-10-07T12:15:00.000Z" } });
const registered = { status: 409, body: { error: "this Discord account is already registered \u2014 unlink it first" } };

/** The admin is registered (already signed up on usr, so no link) and the plugin running. */
async function started(w: ReturnType<typeof world>) {
  await w.plugin.activate!();
  w.usr.answers["/api/discord/register-link"]!.push(registered);
  expect(await slash(w.plugin, "register", ADMIN)).toContain("You are registered.");
  w.usr.calls.length = 0;
}

describe("/allow with the usr link on", () => {
  it("allows the person in usr as tracker:member, by the admin, in this server, and keeps the usr user id", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push(allowed(), allowed(undefined, SUBJECT));
    const answer = await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    expect(answer).toContain(`Allowed <@${LARRY}>`);
    expect(answer).toContain("Linked to usr: they can finish");
    expect(w.usr.calls).toEqual([
      {
        path: "/api/discord/allow",
        body: { discord_user_id: LARRY, guild_id: GUILD, invoker_discord_user_id: ADMIN, roles: ["tracker:member"], display_name: "Larry" },
      },
    ]);
    // usr's allow only adds, so a second /allow asks again and finds the same account.
    expect(await slash(w.plugin, "allow", ADMIN, { target: LARRY })).toBe(`<@${LARRY}> is already on the list.\n\nLinked to usr.`);
    expect(w.usr.calls).toHaveLength(2);
  });

  it("sends the role under TRACKER_USR_APP", async () => {
    const w = world({ TRACKER_USR_URL: "https://id.example.com", TRACKER_USR_KEY: "k", TRACKER_USR_APP: "clerk" });
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push(allowed(["clerk:member"]));
    expect(await slash(w.plugin, "allow", ADMIN, { target: LARRY })).toContain("Linked to usr");
    expect(w.usr.calls[0]!.body.roles).toEqual(["clerk:member"]);
  });

  it("keeps the tracker admission when usr refuses, and links on a later /allow", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push({ status: 500, body: { error: "internal" } }, allowed());
    const first = await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    expect(first).toContain(`Allowed <@${LARRY}>`);
    expect(first).toContain("Not linked to usr: usr answered HTTP 500: internal.");
    expect(await slash(w.plugin, "register", LARRY)).toContain("You are registered."); // admitted all the same
    const again = await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    expect(again).toContain("already on the list");
    expect(again).toContain("Linked to usr");
  });

  it("tells an admin not linked in usr how to get linked, in usr's own words for it", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push({ status: 403, body: { error: "the invoker is not linked to a usr account" } });
    const answer = await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    expect(answer).toContain("you are not linked to usr yourself yet. Run `/register` here");
    expect(answer).toContain("`tracker:register` and `tracker:member`");
    expect(answer).toContain("run `/allow` on yourself and on them");
  });

  it("tells an admin missing usr roles which ones", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push(
      { status: 403, body: { error: "the invoker lacks tracker:register" } },
      { status: 403, body: { error: "the invoker cannot grant roles they do not hold: member" } },
    );
    expect(await slash(w.plugin, "allow", ADMIN, { target: LARRY })).toContain("you need both `tracker:register` and `tracker:member` in usr");
    expect(await slash(w.plugin, "allow", ADMIN, { target: LARRY })).toContain("you need both `tracker:register` and `tracker:member` in usr");
  });

  it("says the apps differ when usr refuses the role as outside its app, and grants nothing", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push({ status: 403, body: { error: 'role "tracker:member" is outside the city-hall app' } });
    const answer = await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    expect(answer).toContain("set to another app than `tracker` (TRACKER_USR_APP)");
    expect(answer).toContain("nothing was granted");
  });

  it("does not link when usr answers with another app's role", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push(allowed(["city-hall:member"]));
    const answer = await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    expect(answer).toContain("usr did not give them `tracker:member`");
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

  it("relinks someone whose usr account changed", async () => {
    const w = world();
    await started(w);
    const other = "6f1c2a9e-0000-4000-8000-000000000002";
    w.usr.answers["/api/discord/allow"]!.push(allowed(), allowed(undefined, other));
    await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    expect(await slash(w.plugin, "allow", ADMIN, { target: LARRY })).toContain("Linked to usr: they can finish");
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
    w.usr.answers["/api/discord/register-link"]!.push(link(), registered);
    const first = await slash(w.plugin, "register", LARRY);
    expect(first).toContain("You are registered.");
    expect(first).toContain("Finish signing up on usr, where you will sign in to the web area: https://id.example.com/register/discord?t=abc");
    expect(first).not.toContain("/allow` on yourself");
    expect(w.usr.calls.at(-1)).toEqual({ path: "/api/discord/register-link", body: { discord_user_id: LARRY, guild_id: GUILD, policy: "allow" } });
    const second = await slash(w.plugin, "register", LARRY);
    expect(second).toContain("Your settings are updated.");
    expect(second).not.toContain("usr");
    // usr said they signed up: no more asks, so its rate limit never shows.
    expect(await slash(w.plugin, "register", LARRY)).not.toContain("usr");
    expect(w.usr.calls.filter((c) => c.path === "/api/discord/register-link")).toHaveLength(2);
  });

  it("gives a configured admin not yet linked usr's open sign-up link, and the steps after it", async () => {
    const w = world();
    await w.plugin.activate!();
    w.usr.answers["/api/discord/register-link"]!.push(link("first"));
    const answer = await slash(w.plugin, "register", ADMIN);
    expect(answer).toContain("https://id.example.com/register/discord?t=first");
    expect(answer).toContain("run `/allow` on yourself to link your tracker account");
    expect(w.usr.calls).toEqual([{ path: "/api/discord/register-link", body: { discord_user_id: ADMIN, guild_id: GUILD, policy: "open" } }]);
  });

  it("never asks for an open link for anyone but a configured admin not yet linked", async () => {
    const w = world();
    await started(w);
    // Larry is admitted but not linked (usr refused): /register asks usr for nothing at all.
    w.usr.answers["/api/discord/allow"]!.push({ status: 500, body: {} });
    await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    await slash(w.plugin, "register", LARRY);
    // Linked people get the allow policy; the only open ask was the configured admin's own.
    w.usr.answers["/api/discord/allow"]!.push(allowed(undefined, "6f1c2a9e-0000-4000-8000-000000000003"));
    await slash(w.plugin, "allow", ADMIN, { target: CURLY });
    w.usr.answers["/api/discord/register-link"]!.push(link());
    await slash(w.plugin, "register", CURLY);
    const asks = w.usr.calls.filter((c) => c.path === "/api/discord/register-link");
    expect(asks.map((c) => [c.body.discord_user_id, c.body.policy])).toEqual([[CURLY, "allow"]]);
  });

  it("tells a configured admin already signed up on usr to /allow themselves", async () => {
    const w = world();
    await w.plugin.activate!();
    w.usr.answers["/api/discord/register-link"]!.push(registered);
    expect(await slash(w.plugin, "register", ADMIN)).toContain("You are signed up on usr. Once a usr admin gives you `tracker:register` and `tracker:member`");
  });

  it("an admin's /allow on themselves links them", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push(allowed(["tracker:member", "tracker:register"]));
    expect(await slash(w.plugin, "allow", ADMIN, { target: ADMIN })).toContain("Linked to usr");
  });

  it("forgets the link when usr no longer knows them, so /allow relinks", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push(allowed(), allowed());
    await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    w.usr.answers["/api/discord/register-link"]!.push({ status: 403, body: { error: "not allowed yet \u2014 ask an admin to /allow you" } });
    expect(await slash(w.plugin, "register", LARRY)).toContain("usr no longer has you on its list: ask an admin to run `/allow` for you again.");
    // Unlinked: /register no longer asks usr, and /allow links them anew.
    expect(await slash(w.plugin, "register", LARRY)).not.toContain("usr");
    expect(await slash(w.plugin, "allow", ADMIN, { target: LARRY })).toContain("Linked to usr: they can finish");
  });

  it("keeps the link when usr's 403 is about the key, not the person", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push(allowed());
    await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    w.usr.answers["/api/discord/register-link"]!.push({ status: 403, body: { error: 'key "clerk" is not configured as a Discord service' } }, link());
    const answer = await slash(w.plugin, "register", LARRY);
    expect(answer).toContain("I could not get your usr sign-up link. Try `/register` again later.");
    expect(answer).not.toContain("no longer has you");
    expect(await slash(w.plugin, "register", LARRY)).toContain("https://id.example.com/register/discord?t=abc"); // still linked
  });

  it("still registers when usr fails, and shows a member no settings names", async () => {
    const w = world();
    await started(w);
    w.usr.answers["/api/discord/allow"]!.push(allowed());
    await slash(w.plugin, "allow", ADMIN, { target: LARRY });
    w.usr.answers["/api/discord/register-link"]!.push({ status: 429, body: { error: "rate limit exceeded" } }, { status: 401, body: {} });
    const answer = await slash(w.plugin, "register", LARRY);
    expect(answer).toContain("You are registered.");
    expect(answer).toContain("I could not get your usr sign-up link. Try `/register` again later.");
    const keyRefused = await slash(w.plugin, "register", LARRY);
    expect(keyRefused).not.toContain("TRACKER_USR_KEY");
  });

  it("shows an admin the detail when usr fails, never the key", async () => {
    const w = world({ TRACKER_USR_URL: "https://id.example.com", TRACKER_USR_KEY: "s3cret-key" });
    await w.plugin.activate!();
    w.usr.answers["/api/discord/register-link"]!.push({ status: 401, body: { error: "s3cret-key" } });
    const answer = await slash(w.plugin, "register", ADMIN);
    expect(answer).toContain("usr refused the tracker's key (HTTP 401): check TRACKER_USR_KEY");
    expect(answer).not.toContain("s3cret-key");
  });

  it("asks nothing of usr when the settings are refused", async () => {
    const w = world();
    await w.plugin.activate!();
    const answer = await slash(w.plugin, "register", ADMIN, { strings: { zone: "Not/AZone" } });
    expect(answer).not.toContain("You are registered.");
    expect(w.usr.calls).toEqual([]);
  });

  it("in a DM, says to run /register in the server for the link", async () => {
    const w = world();
    await w.plugin.activate!();
    expect(await slash(w.plugin, "register", ADMIN, { guildId: null })).toContain("Run `/register` in the server to get your usr sign-up link.");
    expect(w.usr.calls).toEqual([]);
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
