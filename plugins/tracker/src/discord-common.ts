import { MessageFlags } from "discord.js";
import type { PluginLog } from "../../../packages/api/contract.js";
import type { GuildRoles, Membership } from "./access.js";
import type { TrackerDeps } from "./actions.js";

/**
 * What the command side (discord.ts) and the button side (interactions.ts) share: the answers for
 * "not up yet" and "that failed", the membership lookup, and the queue that handles interactions one
 * at a time. docket's "once per run" holds only when a task's replies are handled one at a time
 * (`Lanes.reply`), so every store write goes through the queue -- and nothing slow does: a Discord
 * lookup or a DM runs before or after its turn, never inside it, so one slow call cannot make every
 * other press miss Discord's three-second deadline. A turn that answers or edits one task also takes
 * that task's lock (locks.ts), shared with the ticks, so it waits out a run of the same task in
 * flight -- the one wait a turn may have, bounded by one task's pass.
 */

export const STARTING = "The tracker is starting up; try again in a minute.";
export const FAILED = "Something went wrong on my side; try again in a minute.";
export const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
export const NO_MENTIONS = { allowedMentions: { parse: [] as never[] } };

/** Discord's error codes for "no such member" and "no such user". */
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;

/** What a membership lookup reads off an interaction. */
export interface Interactionish {
  guildId: string | null;
  user: { id: string };
  client: { guilds: { fetch(id: string): Promise<{ members: { fetch(o: { user: string; force?: boolean }): Promise<unknown> } }> } };
}

/** `TRACKER_GUILD_ROLES` and who skips it (lookupMembership). */
export interface RoleGate {
  roles: GuildRoles | null;
  exempt: ReadonlySet<string>;
}

/**
 * Whether `discordId` is a member of any of `guildIds`, asked of Discord through the interaction's
 * client (the host API has no member lookup; plan 5.5). A single-member fetch is a REST call and
 * needs no privileged intent. Discord's "unknown member" or "unknown user" is a no for that server;
 * anything else (the bot left the server, an outage) is `unknown` for it. A yes from any server is
 * `member`; otherwise one `unknown` makes the whole answer `unknown`, which refuses and never
 * revokes, so an outage on one server cannot sign a member of it out; only a no from every server
 * is `not-member`.
 *
 * Always `force: true`: without it discord.js answers from its member cache and sends nothing, and
 * with only the Guilds intent the bot never hears that a member left, so a cached member would stay
 * a member forever. The in-server path below needs no lookup, so the REST calls are only for a DM,
 * another person, the web area, or a listed server's member acting from a server not listed. The
 * servers are asked together and the first yes answers at once; a no or unknown waits for them all.
 *
 * The role check (`TRACKER_GUILD_ROLES`, plan 1.1 and 5.5): in a server `roles` names roles for, a
 * member counts only while they hold one of them, read off the member the same forced fetch returns
 * (its role ids; the Guilds intent keeps the server's roles cached, no privileged intent). Lacking
 * the role is a no for that server, exactly like not being in it -- so the web area and API tokens
 * treat it as leaving. The in-server shortcut is skipped in such a server, since the interaction
 * alone does not say which roles the person holds. `exempt` (the `TRACKER_ADMIN_DISCORD_IDS`
 * admins) skip the role, never the membership, so a role misconfigured or taken away cannot lock the
 * configured admins out. A member whose roles cannot be read is `unknown` for that server, and so is
 * everyone when none of the roles named for a server exists in it (a mistyped or deleted role id):
 * a configuration error refuses and is logged, it never signs anyone out of the web area.
 */
export async function lookupMembership(
  interaction: Interactionish,
  guildIds: readonly string[] | null,
  discordId: string,
  log: PluginLog,
  gate: RoleGate = { roles: null, exempt: new Set() },
): Promise<Membership> {
  if (guildIds === null) return "not-checked";
  const rolesFor = (guildId: string): readonly string[] | null =>
    gate.exempt.has(discordId) ? null : (gate.roles?.get(guildId) ?? null);
  const here = interaction.guildId;
  if (here !== null && guildIds.includes(here) && interaction.user.id === discordId && rolesFor(here) === null) return "member";
  const lookups = guildIds.map((guildId) => memberOf(interaction.client, guildId, discordId, rolesFor(guildId), log));
  // The first yes answers at once, so a slow or hung server cannot hold up a member of another.
  const firstYes = new Promise<"member">((resolve) => {
    for (const l of lookups) void l.then((a) => a === "member" && resolve("member"));
  });
  const all = Promise.all(lookups).then((answers) => (answers.includes("unknown") ? "unknown" : answers.includes("member") ? "member" : "not-member"));
  return Promise.race([firstYes, all]);
}

async function memberOf(
  client: Interactionish["client"],
  guildId: string,
  discordId: string,
  roleIds: readonly string[] | null,
  log: PluginLog,
): Promise<"member" | "not-member" | "unknown"> {
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch({ user: discordId, force: true });
    if (roleIds === null) return "member";
    const known = (guild as { roles?: { cache?: { has?: unknown } } }).roles?.cache;
    if (typeof known?.has === "function" && !roleIds.some((id) => (known.has as (id: string) => boolean).call(known, id))) {
      log.warn(`none of TRACKER_GUILD_ROLES's roles for ${guildId} exists in that server`);
      return "unknown";
    }
    const held = (member as { roles?: { cache?: { has?: unknown } } } | null)?.roles?.cache;
    if (typeof held?.has !== "function") {
      log.warn(`could not read the roles of a member of ${guildId}`);
      return "unknown";
    }
    const has = held.has as (id: string) => boolean;
    return roleIds.some((id) => has.call(held, id)) ? "member" : "not-member";
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === UNKNOWN_MEMBER || code === UNKNOWN_USER) return "not-member";
    log.warn(`could not check membership of ${guildId}: ${err instanceof Error ? err.message : String(err)}`);
    return "unknown";
  }
}

export type Queue = <T>(fn: () => Promise<T>) => Promise<T>;

export function serial(): Queue {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
}

export interface SurfaceContext {
  deps(): TrackerDeps | null;
  queue: Queue;
  membershipOf(interaction: Interactionish, discordId: string): Promise<Membership>;
  log: PluginLog;
}
