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
 * Whether `discordId` is a member of `guildId`, asked of Discord through the interaction's client
 * (the host API has no member lookup; plan 5.5). A single-member fetch is a REST call and needs no
 * privileged intent. Discord's "unknown member" or "unknown user" is a no; anything else (the bot
 * left the server, an outage) is `unknown`, which refuses.
 *
 * Always `force: true`: without it discord.js answers from its member cache and sends nothing, and
 * with only the Guilds intent the bot never hears that a member left, so a cached member would stay
 * a member forever. The in-server path above needs no lookup, so the REST call is only for a DM,
 * another person, or the web area.
 */
export async function lookupMembership(interaction: Interactionish, guildId: string | null, discordId: string, log: PluginLog): Promise<Membership> {
  if (guildId === null) return "not-checked";
  if (interaction.guildId === guildId && interaction.user.id === discordId) return "member";
  try {
    const guild = await interaction.client.guilds.fetch(guildId);
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
