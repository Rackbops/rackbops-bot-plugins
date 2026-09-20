// The Discord-facing layer for /setlist and /spotify. The reply TEXT is built by pure exported
// functions (`formatBuildReply`, `formatNotConfigured`) so `commands.test.ts` asserts on wording and
// the 2000-character ceiling without a Discord client; the handlers themselves are thin plumbing.

import { MessageFlags, type ChatInputCommandInteraction, type SlashCommandBuilder } from "discord.js";
import type { PluginCommand } from "../../../packages/api/contract.js";
import type { SetlistConfig } from "./config.js";
import { parseSetlistUrl, type SetlistFmClient, type Setlist } from "./setlistfm.js";
import type { SpotifyClient } from "./spotify.js";
import { authorizeUrl } from "./spotify.js";
import { buildPlaylist, type BuildOutcome } from "./build.js";
import {
  beginPendingAuth,
  commit,
  generateStateToken,
  putConnection,
  removeConnection,
  setlistState,
} from "./store.js";

/** Discord rejects a message body over this; every formatter below clips to stay under it. */
const MAX_REPLY_LENGTH = 2000;
/** How many names to list before saying "and N more" -- a 30-song setlist must not wall-of-text. */
const MAX_LISTED = 8;

interface Wiring {
  config: SetlistConfig;
  setlistFm?: SetlistFmClient;
  spotify?: SpotifyClient;
  /** Whether the callback server actually bound its port -- minting a connect link that lands on
   *  nothing is worse than saying the feature is off. */
  serverRunning: () => boolean;
}

let wiring: Wiring | undefined;

/** Called from `createPlugin` (pure -- it only stashes already-built values). */
export function initCommands(value: Wiring): void {
  wiring = value;
}

function required(): Wiring {
  if (wiring === undefined) throw new Error("setlist commands used before initCommands()");
  return wiring;
}

// ---------------------------------------------------------------------------------------------------
// Pure formatting
// ---------------------------------------------------------------------------------------------------

export function formatNotConfigured(missing: readonly string[]): string {
  return (
    "This feature isn't set up yet. An admin still needs to set " +
    missing.map((k) => `\`${k}\``).join(", ") +
    " on the bot."
  );
}

function listNames(names: readonly string[]): string {
  if (names.length <= MAX_LISTED) return names.join(", ");
  return `${names.slice(0, MAX_LISTED).join(", ")} and ${names.length - MAX_LISTED} more`;
}

function describeShow(setlist: Setlist): string {
  const where = [setlist.venueName, setlist.cityName, setlist.countryName]
    .filter((p) => p !== undefined && p !== "")
    .join(", ");
  return where === "" ? setlist.artistName : `${setlist.artistName} - ${where}`;
}

/**
 * The success reply. Leads with the link (the thing the user wants), then the honest caveats:
 * what was skipped as walk-on tape, what wasn't found, and what matched but might be the wrong
 * recording. Clipped to Discord's limit by dropping the softest information first -- the link and
 * the counts always survive.
 */
export function formatBuildReply(setlist: Setlist, outcome: BuildOutcome): string {
  const head =
    `**${describeShow(setlist)}**\n` +
    `${outcome.playlistUrl}\n` +
    `Added ${outcome.added} of ${outcome.attempted} songs.`;

  const notes: string[] = [];
  if (setlist.tapeCount > 0) {
    notes.push(
      `Skipped ${setlist.tapeCount} played from tape (walk-on and interlude music, not performed).`,
    );
  }
  if (outcome.missing.length > 0) {
    notes.push(`Couldn't find on Spotify: ${listNames(outcome.missing)}.`);
  }
  if (outcome.uncertain.length > 0) {
    notes.push(
      `Worth a check, these matched loosely: ${listNames(
        outcome.uncertain.map((u) => `${u.song.name} -> ${u.match.track.name}`),
      )}.`,
    );
  }

  let reply = head;
  for (const note of notes) {
    if (reply.length + note.length + 2 > MAX_REPLY_LENGTH) break;
    reply += `\n${note}`;
  }
  return reply;
}

// ---------------------------------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------------------------------

/**
 * Trades the caller's stored refresh token for a usable access token, persisting a rotated refresh
 * token when Spotify issues one. A refresh that fails is almost always a revoked or superseded
 * grant, so the dead connection is DROPPED here -- leaving it in place would make every later
 * command fail the same way with no hint that reconnecting is the fix.
 */
async function accessTokenFor(
  spotify: SpotifyClient,
  discordUserId: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  const connection = setlistState().connections[discordUserId];
  if (connection === undefined) {
    return { ok: false, error: "You haven't connected Spotify yet -- run `/spotify connect` first." };
  }
  const refreshed = await spotify.refresh(connection.refreshToken);
  if (!refreshed.ok) {
    await commit(removeConnection(setlistState(), discordUserId));
    return {
      ok: false,
      error: `Your Spotify connection is no longer valid (${refreshed.error}). Run \`/spotify connect\` to reconnect.`,
    };
  }
  if (refreshed.value.refreshToken !== undefined) {
    await commit(putConnection(setlistState(), discordUserId, refreshed.value.refreshToken, Date.now()));
  }
  return { ok: true, accessToken: refreshed.value.accessToken };
}

async function replyEphemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------------------------------------------
// /setlist
// ---------------------------------------------------------------------------------------------------

/**
 * A `url` is parsed to an id locally first, so an obvious typo is answered instantly instead of
 * costing a setlist.fm round trip. An `artist` goes straight to search. The caller has already
 * checked that at least one of the two is present.
 */
async function resolveSetlist(
  setlistFm: SetlistFmClient,
  url: string | null,
  artist: string | null,
): Promise<{ ok: true; setlist: Setlist } | { ok: false; error: string }> {
  if (url !== null) {
    const id = parseSetlistUrl(url);
    if (id === undefined) {
      return { ok: false, error: "That doesn't look like a setlist.fm link. Paste the URL of a setlist page." };
    }
    return setlistFm.getSetlist(id);
  }
  return setlistFm.latestForArtist(artist ?? "");
}

async function handleSetlist(interaction: ChatInputCommandInteraction): Promise<void> {
  const { config, setlistFm, spotify } = required();
  if (setlistFm === undefined || spotify === undefined) {
    await replyEphemeral(interaction, formatNotConfigured(config.missing));
    return;
  }

  const url = interaction.options.getString("url");
  const artist = interaction.options.getString("artist");
  if (url === null && artist === null) {
    await replyEphemeral(interaction, "Give me either a setlist.fm `url` or an `artist` name.");
    return;
  }

  // Searching a 25-song setlist is up to 50 sequential Spotify calls, which is far past Discord's
  // 3-second initial-response window -- defer before any of it starts.
  await interaction.deferReply();

  const resolved = await resolveSetlist(setlistFm, url, artist);

  if (!resolved.ok) {
    await interaction.editReply({ content: resolved.error });
    return;
  }

  const token = await accessTokenFor(spotify, interaction.user.id);
  if (!token.ok) {
    await interaction.editReply({ content: token.error });
    return;
  }

  const built = await buildPlaylist(spotify, token.accessToken, resolved.setlist);
  if (!built.ok) {
    await interaction.editReply({ content: built.error });
    return;
  }
  await interaction.editReply({ content: formatBuildReply(resolved.setlist, built.outcome) });
}

// ---------------------------------------------------------------------------------------------------
// /spotify
// ---------------------------------------------------------------------------------------------------

async function handleSpotify(interaction: ChatInputCommandInteraction): Promise<void> {
  const { config, serverRunning } = required();
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "status") {
    const connection = setlistState().connections[interaction.user.id];
    await replyEphemeral(
      interaction,
      connection === undefined
        ? "Spotify isn't connected to your Discord account. Run `/spotify connect`."
        : `Spotify has been connected since <t:${Math.floor(connection.connectedAt / 1000)}:D>.`,
    );
    return;
  }

  if (subcommand === "disconnect") {
    if (setlistState().connections[interaction.user.id] === undefined) {
      await replyEphemeral(interaction, "Spotify wasn't connected to your Discord account.");
      return;
    }
    await commit(removeConnection(setlistState(), interaction.user.id));
    await replyEphemeral(
      interaction,
      "Disconnected. The bot has forgotten your Spotify token -- you can also revoke it at " +
        "<https://www.spotify.com/account/apps/>.",
    );
    return;
  }

  // connect
  if (config.spotify === undefined) {
    await replyEphemeral(interaction, formatNotConfigured(config.missing));
    return;
  }
  if (!serverRunning()) {
    await replyEphemeral(
      interaction,
      "The Spotify callback server isn't running, so a connect link would go nowhere. " +
        "An admin needs to check `SETLIST_CALLBACK_PORT` and the bot's logs.",
    );
    return;
  }

  const stateToken = generateStateToken();
  await commit(beginPendingAuth(setlistState(), stateToken, interaction.user.id, Date.now()));
  await replyEphemeral(
    interaction,
    `[Connect your Spotify account](${authorizeUrl(config.spotify, stateToken)})\n` +
      "The link is good for 10 minutes and only for you. Asking again replaces it.",
  );
}

// ---------------------------------------------------------------------------------------------------
// The command table
// ---------------------------------------------------------------------------------------------------

export function setlistCommands(): PluginCommand[] {
  return [
    {
      name: "setlist",
      build: (builder: SlashCommandBuilder) =>
        builder
          .setDescription("Turn a setlist.fm setlist into a Spotify playlist")
          .addStringOption((o) =>
            o.setName("url").setDescription("Link to the setlist.fm setlist page").setRequired(false),
          )
          .addStringOption((o) =>
            o
              .setName("artist")
              .setDescription("Artist name -- uses their most recent show with a filled-in setlist")
              .setRequired(false)
              .setMaxLength(100),
          ),
      handle: handleSetlist,
    },
    {
      name: "spotify",
      build: (builder: SlashCommandBuilder) =>
        builder
          .setDescription("Connect or disconnect your Spotify account")
          .addSubcommand((s) => s.setName("connect").setDescription("Link your Spotify account to the bot"))
          .addSubcommand((s) => s.setName("disconnect").setDescription("Remove the bot's access to your Spotify"))
          .addSubcommand((s) => s.setName("status").setDescription("Check whether your Spotify is connected")),
      handle: handleSpotify,
    },
  ];
}
