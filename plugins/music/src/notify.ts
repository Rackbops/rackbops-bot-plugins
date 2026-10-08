// How a party says something in its own channel.
//
// This is the one place the plugin steps outside the Host API. A plugin is given no way to post to
// an arbitrary channel -- `HostApi.announce` posts to the single `ANNOUNCE_CHANNEL_ID` -- and a
// party's messages belong in the channel it was started in, not in the bot's announcement channel.
// The contract calls `interaction.client` a boundary escape hatch rather than an API ("a
// declared-dependency boundary, not a sandbox"), so that is what this uses, deliberately and in one
// file instead of scattered through the command handlers.
//
// It is best-effort by construction: before any `/party` command has run in this process there is
// no client to borrow, so a party that survives a restart keeps PLAYING but goes quiet in chat
// until someone runs a command again. Playback never depends on this module.
//
// Stepping outside the Host API also steps outside `host.announce`'s mention-safe posting (the
// README's `announce` row says "mention-safe"), so this file sets the mentions itself rather than
// inherit whatever the borrowed client defaults to -- the host's is `{ parse: [] }` today
// (rackbops-discord-bot `src/client.ts`), but that is the host's choice, not this file's. A notice
// pings nobody unless the caller names the one member it is about. A message can carry text the bot
// did not write -- the runner's drop-out notice embeds Spotify's own error text -- so `@everyone`,
// `@here` and role mentions must never resolve.

import type { Client } from "discord.js";
import type { Party } from "./party.js";

let client: Client | undefined;

/** Called from the command layer with the live client the host owns. */
export function rememberClient(value: Client): void {
  client = value;
}

/** Test seam: forget the borrowed client between tests. */
export function resetClientForTest(): void {
  client = undefined;
}

/**
 * Posts to the party's channel. Never throws: a deleted channel, a missing permission or a bot with
 * no client yet must not take down the tick or the timer that called it. `mention` is the one
 * Discord user id the message may ping; with none, nobody is pinged.
 */
export async function notifyParty(party: Party, message: string, mention?: string): Promise<void> {
  if (client === undefined) return;
  try {
    const channel = await client.channels.fetch(party.channelId);
    if (channel === null || !channel.isTextBased() || !("send" in channel)) return;
    await channel.send({
      content: message,
      allowedMentions: mention === undefined ? { parse: [] } : { parse: [], users: [mention] },
    });
  } catch {
    // Deliberately silent: the caller is a timer or the host's tick, and neither has anywhere
    // useful to surface "couldn't post a message about the music that is playing fine".
  }
}
