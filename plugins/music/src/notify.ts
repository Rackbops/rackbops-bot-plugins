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
 * no client yet must not take down the tick or the timer that called it.
 */
export async function notifyParty(party: Party, message: string): Promise<void> {
  if (client === undefined) return;
  try {
    const channel = await client.channels.fetch(party.channelId);
    if (channel === null || !channel.isTextBased() || !("send" in channel)) return;
    await channel.send({ content: message });
  } catch {
    // Deliberately silent: the caller is a timer or the host's tick, and neither has anywhere
    // useful to surface "couldn't post a message about the music that is playing fine".
  }
}
