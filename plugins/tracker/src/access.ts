import type { User } from "@rackbops/docket-core";

/**
 * The two gates every command and every button passes (plan 5.5 "Membership gate", 5.8
 * "Admission"), decided purely over what the handler looked up:
 *
 * - **Membership**: the person is a member of one of the configured servers (`TRACKER_GUILD_ID`, one
 *   id or a comma-separated list) and, in a server `TRACKER_GUILD_ROLES` names roles for, holds one
 *   of them (plan 1.1, 5.5). The host API has no member lookup; the handler asks Discord
 *   through the interaction's client (discord-common.ts). Unset = no membership gate. A lookup that
 *   fails for another reason refuses (fails closed) rather than guessing.
 * - **Admission**: the person is in the tracker's store -- an admin `/allow`ed them, or the
 *   configuration made them an admin. A person nobody admitted is told to ask an admin.
 *
 * Then what the action needs: `/register` needs admission only; `/allow` needs an admin; everything
 * else needs a registered person.
 */

export type Membership = "member" | "not-member" | "unknown" | "not-checked";

export type Need = "admitted" | "registered" | "admin";

export const NOT_MEMBER = "This tracker is only for members of its server (with its role, where it asks for one).";
export const MEMBERSHIP_UNKNOWN = "I could not check that you are a member of this tracker's server. Try again in a minute.";
export const NOT_ADMITTED = "You are not on this tracker's list yet: ask an admin to `/allow` you.";
export const NOT_REGISTERED = "Run `/register` first: it sets when your reminders reach you.";
export const NOT_ADMIN = "Only a tracker admin can do that.";

export interface AccessInput {
  membership: Membership;
  /** The person's row, or null when nobody admitted them. */
  person: User | null;
  registered: boolean;
  need: Need;
}

/** Null when the person may go ahead, else the reason to show them. */
export function decideAccess(input: AccessInput): string | null {
  if (input.membership === "not-member") return NOT_MEMBER;
  if (input.membership === "unknown") return MEMBERSHIP_UNKNOWN;
  if (!input.person) return NOT_ADMITTED;
  if (input.need === "admin") return input.person.admin ? null : NOT_ADMIN;
  if (input.need === "registered" && !input.registered) return NOT_REGISTERED;
  return null;
}

/**
 * `TRACKER_GUILD_ID`: one Discord server id or a comma-separated list of them (a member of any one
 * passes), or unset for no membership gate. Spaces around an id are ignored and a repeated id counts
 * once; an empty entry or anything that is not a server id refuses to load, naming it.
 */
export function parseGuildIds(raw: string | undefined): readonly string[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  const ids: string[] = [];
  for (const entry of raw.split(",")) {
    const id = entry.trim();
    if (!/^[0-9]{17,20}$/.test(id)) throw new Error(`TRACKER_GUILD_ID: "${id}" is not a Discord server id`);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** `TRACKER_GUILD_ROLES`, parsed: per server, the roles any one of which lets a member in. */
export type GuildRoles = ReadonlyMap<string, readonly string[]>;

/**
 * `TRACKER_GUILD_ROLES`: comma-separated `serverId:roleId` pairs, or unset for no role check. A
 * member of a server named here passes only while they hold one of the roles named for it (a server
 * named twice takes either role); a server in `TRACKER_GUILD_ID` that is not named here stays
 * membership-only. Every server named must be in `TRACKER_GUILD_ID` -- a role check without the
 * membership gate, or for a server that gate does not ask, would silently check nothing -- and
 * anything else (the server's own id as its role, which is @everyone) refuses to load, naming the entry. Spaces around an entry or a colon are ignored.
 */
export function parseGuildRoles(raw: string | undefined, guildIds: readonly string[] | null): GuildRoles | null {
  if (raw === undefined || raw.trim() === "") return null;
  const roles = new Map<string, string[]>();
  for (const entry of raw.split(",")) {
    const parts = entry.split(":").map((p) => p.trim());
    const [guildId, roleId] = parts;
    if (parts.length !== 2 || !guildId || !roleId || !/^[0-9]{17,20}$/.test(guildId) || !/^[0-9]{17,20}$/.test(roleId)) {
      throw new Error(`TRACKER_GUILD_ROLES: "${entry.trim()}" is not a serverId:roleId pair`);
    }
    // A server's own id is its @everyone role, which every member holds: it would check nothing.
    if (roleId === guildId) throw new Error(`TRACKER_GUILD_ROLES: "${entry.trim()}" names the server's @everyone role, which every member has`);
    if (!guildIds?.includes(guildId)) throw new Error(`TRACKER_GUILD_ROLES: server ${guildId} is not in TRACKER_GUILD_ID`);
    const list = roles.get(guildId) ?? [];
    if (!list.includes(roleId)) list.push(roleId);
    roles.set(guildId, list);
  }
  return roles;
}
