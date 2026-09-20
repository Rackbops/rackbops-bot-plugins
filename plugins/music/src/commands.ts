// The Discord-facing layer for /setlist and /spotify. The reply TEXT is built by pure exported
// functions (`formatBuildReply`, `formatNotConfigured`, `formatPickPrompt`) so `commands.test.ts`
// asserts on wording and the 2000-character ceiling without a Discord client; the handlers
// themselves are thin plumbing.

import {
  ActionRowBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type SlashCommandBuilder,
} from "discord.js";
import type { PluginCommand } from "../../../packages/api/contract.js";
import type { MusicConfig } from "./config.js";
import { parseDateOption, parseSetlistUrl, type SetlistFmClient, type Setlist } from "./setlistfm.js";
import type { SpotifyClient } from "./spotify.js";
import { authorizeUrl } from "./spotify.js";
import { buildPlaylist } from "./build.js";
import type { BuildOutcome } from "./build.js";
import {
  beginPendingAuth,
  commit,
  generateStateToken,
  putConnection,
  removeConnection,
  musicState,
} from "./store.js";

/** Discord rejects a message body over this; every formatter below clips to stay under it. */
const MAX_REPLY_LENGTH = 2000;
/** How many names to list before saying "and N more" -- a 30-song setlist must not wall-of-text. */
const MAX_LISTED = 8;
/** Discord's own ceiling on a string select menu, and on an option's label and description. */
const MAX_CHOICES = 25;
const MAX_CHOICE_TEXT = 100;

interface Wiring {
  config: MusicConfig;
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

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function whereOf(setlist: Setlist): string {
  return [setlist.venueName, setlist.cityName, setlist.countryName]
    .filter((p) => p !== undefined && p !== "")
    .join(", ");
}

function describeShow(setlist: Setlist): string {
  const where = whereOf(setlist);
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
// Choosing between same-day shows
// ---------------------------------------------------------------------------------------------------

/**
 * The select menu's `customId`. The host routes any component id starting with `music:` to this
 * plugin, so the prefix is load-bearing rather than decorative.
 *
 * The invoking user's id is carried in it because the `/setlist` reply is PUBLIC -- anyone in the
 * channel can see the menu and click it. The playlist is built on the clicker's behalf, with the
 * clicker's Spotify grant, so a stranger clicking would either build a playlist in their account
 * they never asked for or, far more often, be told to connect Spotify by a command they never ran.
 * Binding the menu to its owner answers both.
 */
const PICKER_PREFIX = "music:setlist-pick";

export function pickerCustomId(discordUserId: string): string {
  return `${PICKER_PREFIX}:${discordUserId}`;
}

/** The owning user id, or `undefined` if this isn't one of our pickers at all. */
export function parsePickerCustomId(customId: string): string | undefined {
  if (!customId.startsWith(`${PICKER_PREFIX}:`)) return undefined;
  const owner = customId.slice(PICKER_PREFIX.length + 1);
  return owner === "" ? undefined : owner;
}

/**
 * One menu row for one candidate show. The LABEL is the venue and city, because that is the only
 * thing that actually distinguishes a festival slot from the club show the same night -- the artist
 * and the date are identical across every option by construction, so repeating them there would
 * make all of them look the same. The description carries the song count and the tour, which is
 * what separates two genuine duplicate entries for one gig.
 */
export function choiceFor(setlist: Setlist): { label: string; description: string; value: string } {
  const where = whereOf(setlist);
  const songs = `${setlist.songs.length} song${setlist.songs.length === 1 ? "" : "s"}`;
  return {
    label: clip(where === "" ? setlist.artistName : where, MAX_CHOICE_TEXT),
    description: clip(setlist.tourName === undefined ? songs : `${songs} - ${setlist.tourName}`, MAX_CHOICE_TEXT),
    value: setlist.id,
  };
}

/**
 * The prompt above the menu. `total` is how many shows setlist.fm actually returned, so a day with
 * more candidates than Discord will show in one menu says so rather than quietly dropping the rest.
 */
export function formatPickPrompt(artistName: string, shown: number, total: number): string {
  const head = `setlist.fm has ${total} ${artistName} shows on that date. Pick the one you were at:`;
  return total > shown ? `${head}\n(Showing the first ${shown}.)` : head;
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
  const connection = musicState().connections[discordUserId];
  if (connection === undefined) {
    return { ok: false, error: "You haven't connected Spotify yet -- run `/spotify connect` first." };
  }
  const refreshed = await spotify.refresh(connection.refreshToken);
  if (!refreshed.ok) {
    await commit(removeConnection(musicState(), discordUserId));
    return {
      ok: false,
      error: `Your Spotify connection is no longer valid (${refreshed.error}). Run \`/spotify connect\` to reconnect.`,
    };
  }
  if (refreshed.value.refreshToken !== undefined) {
    await commit(putConnection(musicState(), discordUserId, refreshed.value.refreshToken, Date.now()));
  }
  return { ok: true, accessToken: refreshed.value.accessToken };
}

async function replyEphemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/**
 * Searches, creates and fills the playlist, reporting each failure through `edit` rather than
 * throwing. Shared by the slash command and the picker: both arrive here with a resolved setlist
 * and an already-open (deferred or updated) Discord response to write into.
 */
async function buildInto(
  setlist: Setlist,
  discordUserId: string,
  edit: (content: string) => Promise<void>,
): Promise<void> {
  const { config, spotify } = required();
  if (spotify === undefined) {
    await edit(formatNotConfigured(config.missing));
    return;
  }
  const token = await accessTokenFor(spotify, discordUserId);
  if (!token.ok) {
    await edit(token.error);
    return;
  }
  const built = await buildPlaylist(spotify, token.accessToken, setlist);
  if (!built.ok) {
    await edit(built.error);
    return;
  }
  await edit(formatBuildReply(setlist, built.outcome));
}

// ---------------------------------------------------------------------------------------------------
// /setlist
// ---------------------------------------------------------------------------------------------------

/** Either we know which show to build, or the user has to say, or we have a sentence for them. */
type Resolution =
  | { kind: "one"; setlist: Setlist }
  | { kind: "choose"; artistName: string; setlists: Setlist[]; total: number }
  | { kind: "error"; error: string };

/**
 * An artist and a date, where more than one answer is normal (a festival slot and a club show the
 * same night; setlist.fm's own duplicate entries for one gig). Shows with no song list are dropped
 * before the menu rather than offered -- picking one could only produce an empty playlist -- but
 * they are still COUNTED, so "there are shows, just no setlists on them yet" reads differently from
 * "there is no such show".
 */
async function resolveByDate(
  setlistFm: SetlistFmClient,
  artist: string,
  date: string,
): Promise<Resolution> {
  const apiDate = parseDateOption(date);
  if (apiDate === undefined) {
    return {
      kind: "error",
      error: "I couldn't read that date. Write it as `2026-09-08` or `08-09-2026`.",
    };
  }

  const found = await setlistFm.showsOn(artist, apiDate);
  if (!found.ok) return { kind: "error", error: found.error };

  if (found.setlists.length === 0) {
    return { kind: "error", error: `setlist.fm has no "${artist}" show on ${apiDate}.` };
  }
  const withSongs = found.setlists.filter((s) => s.songs.length > 0);
  if (withSongs.length === 0) {
    const count = found.setlists.length;
    return {
      kind: "error",
      error:
        `setlist.fm has ${count} "${artist}" show${count === 1 ? "" : "s"} on ${apiDate}, but ` +
        "none with a song list filled in yet.",
    };
  }
  if (withSongs.length === 1) return { kind: "one", setlist: withSongs[0]! };
  return {
    kind: "choose",
    artistName: withSongs[0]!.artistName,
    setlists: withSongs.slice(0, MAX_CHOICES),
    total: withSongs.length,
  };
}

/**
 * A `url` is parsed to an id locally first, so an obvious typo is answered instantly instead of
 * costing a setlist.fm round trip -- and it wins over the other two, since a link names exactly one
 * show and leaves nothing to search for. An `artist` with a `date` searches that day; an `artist`
 * alone falls back to their latest filled-in show. The caller has already checked that at least one
 * usable combination is present.
 */
async function resolveSetlist(
  setlistFm: SetlistFmClient,
  url: string | null,
  artist: string | null,
  date: string | null,
): Promise<Resolution> {
  if (url !== null) {
    const id = parseSetlistUrl(url);
    if (id === undefined) {
      return { kind: "error", error: "That doesn't look like a setlist.fm link. Paste the URL of a setlist page." };
    }
    const one = await setlistFm.getSetlist(id);
    return one.ok ? { kind: "one", setlist: one.setlist } : { kind: "error", error: one.error };
  }

  if (date !== null) return resolveByDate(setlistFm, artist ?? "", date);

  const latest = await setlistFm.latestForArtist(artist ?? "");
  return latest.ok ? { kind: "one", setlist: latest.setlist } : { kind: "error", error: latest.error };
}

function pickerRow(discordUserId: string, setlists: readonly Setlist[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(pickerCustomId(discordUserId))
    .setPlaceholder("Which show?")
    .addOptions(setlists.map(choiceFor));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

async function handleSetlist(interaction: ChatInputCommandInteraction): Promise<void> {
  const { config, setlistFm, spotify } = required();
  if (setlistFm === undefined || spotify === undefined) {
    await replyEphemeral(interaction, formatNotConfigured(config.missing));
    return;
  }

  const url = interaction.options.getString("url");
  const artist = interaction.options.getString("artist");
  const date = interaction.options.getString("date");
  if (url === null && artist === null) {
    // A lone `date` gets the specific diagnosis rather than the generic one: the user asked for
    // something reasonable, it just isn't a search setlist.fm can run.
    await replyEphemeral(
      interaction,
      date === null
        ? "Give me either a setlist.fm `url` or an `artist` name."
        : "A `date` needs an `artist` to go with it -- setlist.fm can't search a day on its own.",
    );
    return;
  }

  // Searching a 25-song setlist is up to 50 sequential Spotify calls, which is far past Discord's
  // 3-second initial-response window -- defer before any of it starts.
  await interaction.deferReply();

  const resolved = await resolveSetlist(setlistFm, url, artist, date);

  if (resolved.kind === "error") {
    await interaction.editReply({ content: resolved.error });
    return;
  }

  if (resolved.kind === "choose") {
    await interaction.editReply({
      content: formatPickPrompt(resolved.artistName, resolved.setlists.length, resolved.total),
      components: [pickerRow(interaction.user.id, resolved.setlists)],
    });
    return;
  }

  await buildInto(resolved.setlist, interaction.user.id, async (content) => {
    await interaction.editReply({ content });
  });
}

/**
 * The picker's other half. The chosen show is re-fetched by id rather than held in memory between
 * the two interactions: the menu can be clicked minutes later, across a redeploy or a self-update,
 * and a cache that empties on restart would turn that into an unexplained failure. One extra
 * setlist.fm call is the cheaper side of that trade.
 */
async function handlePick(interaction: MessageComponentInteraction | ModalSubmitInteraction): Promise<void> {
  const owner = parsePickerCustomId(interaction.customId);
  if (owner === undefined || !interaction.isStringSelectMenu()) {
    // Something else under the `music:` prefix -- a control from an older version of the plugin
    // still sitting in a channel. Say so rather than letting Discord show "interaction failed".
    await interaction.reply({
      content: "That control is from an older version of the bot. Run `/setlist` again for a fresh one.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.user.id !== owner) {
    await interaction.reply({
      content: "That menu belongs to whoever ran the command. Run `/setlist` yourself to build your own playlist.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { config, setlistFm } = required();
  if (setlistFm === undefined) {
    await interaction.reply({ content: formatNotConfigured(config.missing), flags: MessageFlags.Ephemeral });
    return;
  }

  const chosen = interaction.values[0];
  if (chosen === undefined) {
    await interaction.reply({ content: "Nothing was picked.", flags: MessageFlags.Ephemeral });
    return;
  }

  // `update` both answers Discord inside its 3-second window and takes the menu away, so the show
  // can't be picked a second time while the first build is still running.
  await interaction.update({ content: "Building the playlist...", components: [] });

  const one = await setlistFm.getSetlist(chosen);
  if (!one.ok) {
    await interaction.editReply({ content: one.error });
    return;
  }
  await buildInto(one.setlist, interaction.user.id, async (content) => {
    await interaction.editReply({ content });
  });
}

export const musicInteractions = handlePick;

// ---------------------------------------------------------------------------------------------------
// /spotify
// ---------------------------------------------------------------------------------------------------

async function handleSpotify(interaction: ChatInputCommandInteraction): Promise<void> {
  const { config, serverRunning } = required();
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "status") {
    const connection = musicState().connections[interaction.user.id];
    await replyEphemeral(
      interaction,
      connection === undefined
        ? "Spotify isn't connected to your Discord account. Run `/spotify connect`."
        : `Spotify has been connected since <t:${Math.floor(connection.connectedAt / 1000)}:D>.`,
    );
    return;
  }

  if (subcommand === "disconnect") {
    if (musicState().connections[interaction.user.id] === undefined) {
      await replyEphemeral(interaction, "Spotify wasn't connected to your Discord account.");
      return;
    }
    await commit(removeConnection(musicState(), interaction.user.id));
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
        "An admin needs to check `MUSIC_CALLBACK_PORT` and the bot's logs.",
    );
    return;
  }

  const stateToken = generateStateToken();
  await commit(beginPendingAuth(musicState(), stateToken, interaction.user.id, Date.now()));
  await replyEphemeral(
    interaction,
    `[Connect your Spotify account](${authorizeUrl(config.spotify, stateToken)})\n` +
      "The link is good for 10 minutes and only for you. Asking again replaces it.",
  );
}

// ---------------------------------------------------------------------------------------------------
// The command table
// ---------------------------------------------------------------------------------------------------

export function musicCommands(): PluginCommand[] {
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
          )
          .addStringOption((o) =>
            o
              .setName("date")
              .setDescription("With an artist: the night you were there, as 2026-09-08 or 08-09-2026")
              .setRequired(false)
              .setMaxLength(10),
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
