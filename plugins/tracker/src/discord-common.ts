import { MessageFlags } from "discord.js";
import type { PluginLog } from "../../../packages/api/contract.js";
import type { Membership } from "./access.js";
import type { TrackerDeps } from "./actions.js";

/**
 * What the command side (discord.ts) and the button side (interactions.ts) share: the answers for
 * "not up yet" and "that failed", the membership lookup, and the queue that handles interactions one
 * at a time. docket's "once per run" holds only when a task's replies are handled one at a time
 * (`Lanes.reply`), so every store write goes through the queue -- and nothing slow does: a Discord
 * lookup or a DM runs before or after its turn, never inside it, so one slow call cannot make every
 * other press miss Discord's three-second deadline.
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
 */
export async function lookupMembership(
  interaction: Interactionish,
  guildIds: readonly string[] | null,
  discordId: string,
  log: PluginLog,
): Promise<Membership> {
  if (guildIds === null) return "not-checked";
  if (interaction.guildId !== null && guildIds.includes(interaction.guildId) && interaction.user.id === discordId) return "member";
  const lookups = guildIds.map((guildId) => memberOf(interaction.client, guildId, discordId, log));
  // The first yes answers at once, so a slow or hung server cannot hold up a member of another.
  const firstYes = new Promise<"member">((resolve) => {
    for (const l of lookups) void l.then((a) => a === "member" && resolve("member"));
  });
  const all = Promise.all(lookups).then((answers) => (answers.includes("unknown") ? "unknown" : answers.includes("member") ? "member" : "not-member"));
  return Promise.race([firstYes, all]);
}

async function memberOf(client: Interactionish["client"], guildId: string, discordId: string, log: PluginLog): Promise<"member" | "not-member" | "unknown"> {
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.members.fetch({ user: discordId, force: true });
    return "member";
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
