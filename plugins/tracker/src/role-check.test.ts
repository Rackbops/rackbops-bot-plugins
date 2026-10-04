import { describe, expect, it } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import type { Plugin } from "../../../packages/api/contract.js";
import { makeFakeHost } from "../../../packages/testkit/index.js";
import { MEMBERSHIP_UNKNOWN, NOT_MEMBER, parseGuildRoles } from "./access.js";
import { type Interactionish, lookupMembership, type RoleGate } from "./discord-common.js";
import { createPlugin } from "./index.js";

/**
 * The Discord-role check (plan 1.1 and 5.5, `TRACKER_GUILD_ROLES`): in a server that names roles, a
 * member passes only while holding one; the configured admins skip the role, never the membership;
 * a role id the server does not have, or a member whose roles cannot be read, refuses as unknown.
 */

const ADMIN = "111111111111111111";
const LARRY = "222222222222222222";
const CURLY = "333333333333333333";
const GUILD = "999999999999999999";
const GUILD_B = "888888888888888888";
const ROLE = "777777777777777777";
const ROLE_2 = "666666666666666666";
const OTHER_ROLE = "555555555555555555";

const log = { info() {}, warn() {}, error() {} };
const unknownMember = () => Promise.reject(Object.assign(new Error("Unknown Member"), { code: 10007 }));

/** A set of role ids shaped like discord.js's role cache: only `has` is read. */
const cache = (ids: readonly string[]) => ({ cache: { has: (id: string) => ids.includes(id) } });

/**
 * A client whose servers hold `members` (Discord id -> role ids) and whose role caches hold `roles`.
 * `asked` records each member fetch, so a test can see whether the shortcut was taken.
 */
function client(servers: Record<string, { members: Record<string, string[]>; roles?: string[] }>, asked: string[] = []): Interactionish["client"] {
  return {
    guilds: {
      fetch: async (id: string) => {
        const s = servers[id];
        if (!s) throw Object.assign(new Error("Missing Access"), { code: 50001 });
        return {
          roles: cache(s.roles ?? [ROLE, ROLE_2, OTHER_ROLE]),
          members: {
            fetch: async (o: { user: string; force?: boolean }) => {
              asked.push(`${id}/${o.user}/${o.force === true}`);
              const held = s.members[o.user];
              return held ? { id: o.user, roles: cache(held) } : unknownMember();
            },
          },
        };
      },
    },
  };
}

const gate = (raw: string, guildIds: readonly string[], exempt: string[] = []): RoleGate => ({
  roles: parseGuildRoles(raw, guildIds),
  exempt: new Set(exempt),
});

describe("parseGuildRoles", () => {
  it("is null when unset or blank", () => {
    expect(parseGuildRoles(undefined, [GUILD])).toBeNull();
    expect(parseGuildRoles("  ", [GUILD])).toBeNull();
  });

  it("reads serverId:roleId pairs, spaces allowed, a server named twice taking either role, a repeat counted once", () => {
    const roles = parseGuildRoles(` ${GUILD} : ${ROLE} , ${GUILD}:${ROLE_2},${GUILD_B}:${ROLE},${GUILD}:${ROLE}`, [GUILD, GUILD_B]);
    expect(roles?.get(GUILD)).toEqual([ROLE, ROLE_2]);
    expect(roles?.get(GUILD_B)).toEqual([ROLE]);
  });

  it("refuses an entry that is not a pair of ids, naming it", () => {
    expect(() => parseGuildRoles(ROLE, [GUILD])).toThrow(`"${ROLE}" is not a serverId:roleId pair`);
    expect(() => parseGuildRoles(`${GUILD}:${ROLE},`, [GUILD])).toThrow('"" is not a serverId:roleId pair');
    expect(() => parseGuildRoles(`${GUILD}:${ROLE}:${ROLE_2}`, [GUILD])).toThrow("is not a serverId:roleId pair");
    expect(() => parseGuildRoles(`${GUILD}:admins`, [GUILD])).toThrow(`"${GUILD}:admins" is not a serverId:roleId pair`);
  });

  it("refuses the server's own id as its role: that is @everyone", () => {
    expect(() => parseGuildRoles(`${GUILD}:${GUILD}`, [GUILD])).toThrow("@everyone");
  });

  it("refuses a server the membership gate does not ask, or no membership gate at all", () => {
    expect(() => parseGuildRoles(`${GUILD_B}:${ROLE}`, [GUILD])).toThrow(`server ${GUILD_B} is not in TRACKER_GUILD_ID`);
    expect(() => parseGuildRoles(`${GUILD}:${ROLE}`, null)).toThrow(`server ${GUILD} is not in TRACKER_GUILD_ID`);
  });
});

describe("lookupMembership with roles", () => {
  const at = (guildId: string | null, c: Interactionish["client"], userId = LARRY): Interactionish => ({ guildId, user: { id: userId }, client: c });

  it("a member holding one of the server's roles passes; one holding neither, or another role, does not", async () => {
    const g = gate(`${GUILD}:${ROLE},${GUILD}:${ROLE_2}`, [GUILD]);
    const c = client({ [GUILD]: { members: { [LARRY]: [ROLE_2], [CURLY]: [OTHER_ROLE] } } });
    expect(await lookupMembership(at(null, c), [GUILD], LARRY, log, g)).toBe("member");
    expect(await lookupMembership(at(null, c), [GUILD], CURLY, log, g)).toBe("not-member");
  });

  it("inside a role-gated server, still asks Discord: the interaction alone does not say which roles", async () => {
    const asked: string[] = [];
    const c = client({ [GUILD]: { members: { [LARRY]: [] } } }, asked);
    expect(await lookupMembership(at(GUILD, c), [GUILD], LARRY, log, gate(`${GUILD}:${ROLE}`, [GUILD]))).toBe("not-member");
    expect(asked).toEqual([`${GUILD}/${LARRY}/true`]);
  });

  it("a server with no role named stays membership-only, shortcut included", async () => {
    const asked: string[] = [];
    const c = client({ [GUILD]: { members: { [LARRY]: [] } }, [GUILD_B]: { members: { [LARRY]: [] } } }, asked);
    const g = gate(`${GUILD}:${ROLE}`, [GUILD, GUILD_B]);
    // Lacks A's role but is a member of B, which asks for none.
    expect(await lookupMembership(at(null, c), [GUILD, GUILD_B], LARRY, log, g)).toBe("member");
    asked.length = 0;
    expect(await lookupMembership(at(GUILD_B, c), [GUILD, GUILD_B], LARRY, log, g)).toBe("member");
    expect(asked).toEqual([]);
  });

  it("a configured admin skips the role but not the membership", async () => {
    const asked: string[] = [];
    const c = client({ [GUILD]: { members: { [ADMIN]: [] } } }, asked);
    const g = gate(`${GUILD}:${ROLE}`, [GUILD], [ADMIN]);
    expect(await lookupMembership(at(null, c, ADMIN), [GUILD], ADMIN, log, g)).toBe("member");
    expect(await lookupMembership(at(GUILD, c, ADMIN), [GUILD], ADMIN, log, g)).toBe("member");
    expect(asked).toHaveLength(1);
    const notIn = client({ [GUILD]: { members: {} } });
    expect(await lookupMembership(at(null, notIn, ADMIN), [GUILD], ADMIN, log, g)).toBe("not-member");
  });

  it("no named role existing in the server is unknown for everyone, logged once, never a no", async () => {
    // A server id no other test uses: the configuration warnings are logged once per start.
    const S = "123456789012345678";
    const warnings: string[] = [];
    const warnLog = { ...log, warn: (m: string) => void warnings.push(m) };
    const c = client({ [S]: { members: { [LARRY]: [ROLE] }, roles: [OTHER_ROLE] } });
    const g = gate(`${S}:${ROLE}`, [S]);
    expect(await lookupMembership(at(null, c), [S], LARRY, warnLog, g)).toBe("unknown");
    expect(await lookupMembership(at(null, c), [S], LARRY, warnLog, g)).toBe("unknown");
    expect(warnings).toEqual([
      `TRACKER_GUILD_ROLES names role ${ROLE}, which ${S} does not have`,
      `none of TRACKER_GUILD_ROLES's roles for ${S} exists in that server`,
    ]);
  });

  it("one of two named roles missing: the other still decides, and the missing one is logged once", async () => {
    const S = "234567890123456789";
    const warnings: string[] = [];
    const warnLog = { ...log, warn: (m: string) => void warnings.push(m) };
    const c = client({ [S]: { members: { [LARRY]: [ROLE_2], [CURLY]: [] }, roles: [ROLE_2] } });
    const g = gate(`${S}:${ROLE},${S}:${ROLE_2}`, [S]);
    expect(await lookupMembership(at(null, c), [S], LARRY, warnLog, g)).toBe("member");
    expect(await lookupMembership(at(null, c), [S], CURLY, warnLog, g)).toBe("not-member");
    expect(warnings).toEqual([`TRACKER_GUILD_ROLES names role ${ROLE}, which ${S} does not have`]);
  });

  it("a member whose roles cannot be read is unknown, never a no", async () => {
    const c: Interactionish["client"] = {
      guilds: { fetch: async () => ({ members: { fetch: async (o: { user: string }) => ({ id: o.user }) } }) },
    };
    expect(await lookupMembership(at(null, c), [GUILD], LARRY, log, gate(`${GUILD}:${ROLE}`, [GUILD]))).toBe("unknown");
  });

  it("with no roles set, behaves as before", async () => {
    const c = client({ [GUILD]: { members: { [LARRY]: [] } } });
    expect(await lookupMembership(at(null, c), [GUILD], LARRY, log, { roles: null, exempt: new Set() })).toBe("member");
    expect(await lookupMembership(at(null, c), [GUILD], LARRY, log)).toBe("member");
  });
});

async function slash(plugin: Plugin, name: string, userId: string, o: { client: Interactionish["client"]; guildId?: string; target?: string }): Promise<string> {
  const command = plugin.commands?.find((c) => c.name === name);
  if (!command) throw new Error(`no command ${name}`);
  const edits: { content: string }[] = [];
  const interaction = {
    commandName: name,
    guildId: o.guildId ?? null,
    client: o.client,
    user: { id: userId, username: `user${userId.slice(0, 3)}`, globalName: null, bot: false },
    options: {
      getSubcommand: () => "",
      getString: () => null,
      getInteger: () => null,
      getUser: () => (o.target ? { id: o.target, bot: false } : null),
    },
    deferReply: async () => {},
    editReply: async (x: { content: string }) => void edits.push(x),
  };
  await command.handle(interaction as unknown as ChatInputCommandInteraction);
  return edits[0]?.content ?? "";
}

describe("TRACKER_GUILD_ROLES end to end", () => {
  const make = (env: Record<string, string>) =>
    createPlugin(
      makeFakeHost({ name: "tracker", env: { TRACKER_ADMIN_DISCORD_IDS: ADMIN, ...env }, log, dm: async () => ({ guildId: null, channelId: "c", messageId: "m" }) }),
      { clock: { now: () => new Date("2026-10-01T12:00:00.000Z") }, dbPath: ":memory:" },
    );

  it("refuses to load with a role for a server outside TRACKER_GUILD_ID", () => {
    expect(() => make({ TRACKER_GUILD_ID: GUILD, TRACKER_GUILD_ROLES: `${GUILD_B}:${ROLE}` })).toThrow("is not in TRACKER_GUILD_ID");
  });

  it("the role gates every command, in the server too; an admin without it still works; losing it refuses; a broken role id refuses as unknown", async () => {
    const plugin = make({ TRACKER_GUILD_ID: GUILD, TRACKER_GUILD_ROLES: `${GUILD}:${ROLE}` });
    await plugin.activate!();
    const servers = { [GUILD]: { members: { [ADMIN]: [] as string[], [LARRY]: [ROLE], [CURLY]: [] as string[] } } };
    const c = client(servers);
    expect(await slash(plugin, "register", ADMIN, { client: c, guildId: GUILD })).toContain("You are registered.");
    expect(await slash(plugin, "allow", ADMIN, { client: c, target: LARRY })).toContain("Allowed");
    expect(await slash(plugin, "allow", ADMIN, { client: c, target: CURLY })).toBe(
      `<@${CURLY}> is not a member of this tracker's server, or lacks the role it asks for.`,
    );
    expect(await slash(plugin, "register", LARRY, { client: c, guildId: GUILD })).toContain("You are registered.");
    expect(await slash(plugin, "tasks", LARRY, { client: c })).toBe("You have no active tasks.");
    expect(await slash(plugin, "register", CURLY, { client: c, guildId: GUILD })).toBe(NOT_MEMBER);
    // Larry loses the role: refused, from inside the server too.
    servers[GUILD].members[LARRY] = [];
    expect(await slash(plugin, "tasks", LARRY, { client: c, guildId: GUILD })).toBe(NOT_MEMBER);
    // The role is deleted from the server: unknown, not a no.
    servers[GUILD].members[LARRY] = [ROLE];
    expect(await slash(plugin, "tasks", LARRY, { client: client({ [GUILD]: { ...servers[GUILD], roles: [] } }) })).toBe(MEMBERSHIP_UNKNOWN);
    expect(await slash(plugin, "tasks", ADMIN, { client: c })).toBe("You have no active tasks.");
    await plugin.dispose?.();
  });
});
