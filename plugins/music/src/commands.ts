// The Discord-facing layer for /setlist and /spotify. The reply TEXT is built by pure exported
// functions (`formatBuildReply`, `formatNotConfigured`, `formatPickPrompt`) so `commands.test.ts`
// asserts on wording and the 2000-character ceiling without a Discord client; the handlers
// themselves are thin plumbing.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
import { authorizeUrl, hasScopes, PARTY_SCOPES } from "./spotify.js";
import { pickBestTrack } from "./matching.js";
import { buildPlaylist, type BuildOutcome } from "./build.js";
import { accessTokenFor } from "./tokens.js";
import {
  addMember,
  closeParty,
  commitParties,
  currentTrack,
  enqueue,
  getParty,
  openParty,
  partiesState,
  removeMember,
  type Party,
  type PartyTrack,
} from "./party.js";
import type { MemberOutcome, PartyRunner } from "./runner.js";
import { rememberClient } from "./notify.js";
import {
  beginPendingAuth,
  commit,
  generateStateToken,
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
  /** Built in `createPlugin` alongside the clients; absent only when Spotify isn't configured. */
  runner?: PartyRunner;
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
// /party
// ---------------------------------------------------------------------------------------------------

/** The Join button's custom id. The host routes every `music:` component to this plugin. */
export const PARTY_JOIN_ID = "music:party-join";

function joinRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(PARTY_JOIN_ID).setLabel("Join the party").setStyle(ButtonStyle.Primary),
  );
}

/**
 * Mints a connect link that asks for the PARTY scopes rather than the playlist ones.
 *
 * This is the incremental half of the scope decision: `/spotify connect` keeps asking for the
 * minimum a playlist needs, and only someone who actually wants a party is shown a consent screen
 * mentioning playback control.
 */
async function partyConnectLink(config: MusicConfig, discordUserId: string): Promise<string | undefined> {
  if (config.spotify === undefined) return undefined;
  const stateToken = generateStateToken();
  await commit(beginPendingAuth(musicState(), stateToken, discordUserId, Date.now(), PARTY_SCOPES));
  return authorizeUrl(config.spotify, stateToken, PARTY_SCOPES);
}

/**
 * Everything `/party` needs before it can touch someone's player: the feature configured, the
 * caller connected, and the playback scopes actually granted. A missing scope is answered with a
 * fresh link, never with the 403 it would otherwise become.
 */
async function requirePartyAccess(
  discordUserId: string,
): Promise<
  { ok: true; spotify: SpotifyClient; runner: PartyRunner; accessToken: string } | { ok: false; message: string }
> {
  const { config, spotify, runner, serverRunning } = required();
  if (spotify === undefined || runner === undefined) {
    return { ok: false, message: formatNotConfigured(config.missing) };
  }
  const token = await accessTokenFor(spotify, discordUserId);
  if (!token.ok) return { ok: false, message: token.error };
  if (!hasScopes(token.scopes, PARTY_SCOPES)) {
    if (!serverRunning()) {
      return {
        ok: false,
        message:
          "A party needs permission to control your Spotify, and the connect server isn't running " +
          "so a link would go nowhere. An admin needs to check `MUSIC_CALLBACK_PORT`.",
      };
    }
    const link = await partyConnectLink(config, discordUserId);
    return {
      ok: false,
      message:
        link === undefined
          ? formatNotConfigured(config.missing)
          : `Spotify needs one more permission before the bot can play to your player. ` +
            `[Grant it here](${link}) -- it takes one click, and it replaces your existing connection.`,
    };
  }
  return { ok: true, spotify, runner, accessToken: token.accessToken };
}

/** The reply after a play attempt: who it reached, and what each of the others should do. */
export function formatOutcomes(outcomes: readonly MemberOutcome[]): string {
  const played = outcomes.filter((o) => o.ok).length;
  const head = played === 1 ? "Playing for 1 person." : `Playing for ${played} people.`;
  const problems = outcomes
    .filter((o) => !o.ok)
    .map((o) => `<@${o.discordUserId}>: ${o.error ?? "their Spotify didn't take the command"}`);
  if (problems.length === 0) return head;
  return clip(`${head}\n${problems.join("\n")}`, MAX_REPLY_LENGTH);
}

export function formatPartyStatus(party: Party, now: number): string {
  const track = currentTrack(party);
  const members = party.members.map((id) => `<@${id}>`).join(", ");
  if (track === undefined || party.trackStartedAt === undefined) {
    return clip(
      `The party is open but nothing is playing. ${party.queue.length} track(s) queued.\nIn the party: ${members}`,
      MAX_REPLY_LENGTH,
    );
  }
  const elapsed = Math.floor((now - party.trackStartedAt) / 1000);
  const total = Math.floor(track.durationMs / 1000);
  const remaining = party.queue.length - party.index - 1;
  return clip(
    `**${track.name}** -- ${track.artist}\n` +
      `${formatClock(elapsed)} / ${formatClock(total)}, ${remaining} more queued\n` +
      `In the party: ${members}`,
    MAX_REPLY_LENGTH,
  );
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}


async function handlePartyStart(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  if (getParty(partiesState(), guildId) !== undefined) {
    await replyEphemeral(interaction, "There's already a party in this server. `/party status` shows it.");
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const access = await requirePartyAccess(interaction.user.id);
  if (!access.ok) {
    await interaction.editReply({ content: access.message });
    return;
  }
  const party: Party = {
    guildId,
    channelId: interaction.channelId,
    hostId: interaction.user.id,
    members: [interaction.user.id],
    queue: [],
    index: 0,
  };
  await commitParties(openParty(partiesState(), party));
  // Not ephemeral: the Join button has to be visible to everyone else in the channel.
  await interaction.editReply({ content: "Party started. Queue something with `/party add`." });
  await interaction.followUp({
    content:
      `<@${interaction.user.id}> started a listening party. Press Join and your own Spotify plays along ` +
      "-- you'll need Spotify Premium and `/spotify connect`.",
    components: [joinRow()],
  });
}

async function handlePartyAdd(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const party = getParty(partiesState(), guildId);
  if (party === undefined) {
    await replyEphemeral(interaction, "No party here yet -- `/party start` opens one.");
    return;
  }
  await interaction.deferReply();
  const access = await requirePartyAccess(interaction.user.id);
  if (!access.ok) {
    await interaction.editReply({ content: access.message });
    return;
  }
  const query = interaction.options.getString("query", true);
  // The access check already refreshed a token for this caller; searching with a second one would
  // be a pointless extra round trip to Spotify's token endpoint.
  const found = await access.spotify.searchTracks(access.accessToken, query);
  if (!found.ok) {
    await interaction.editReply({ content: `Spotify search failed: ${found.error}` });
    return;
  }
  // The same scorer `/setlist` uses, so "the wrong live version" is wrong in exactly one place.
  const match = pickBestTrack({ name: query, artist: "" }, found.value);
  if (match === undefined) {
    await interaction.editReply({ content: `Nothing on Spotify matched "${query}".` });
    return;
  }
  if (match.track.durationMs === undefined) {
    await interaction.editReply({
      content: "Spotify didn't say how long that track is, so the party can't time it. Try another version.",
    });
    return;
  }
  const track: PartyTrack = {
    uri: match.track.uri,
    name: match.track.name,
    artist: match.track.artistNames[0] ?? "Unknown artist",
    durationMs: match.track.durationMs,
  };
  await commitParties(enqueue(partiesState(), guildId, [track]));

  // The first track added to an idle party starts it -- otherwise "start" and "add" both look like
  // the thing that begins the music, and people run them in the wrong order.
  const idle = party.trackStartedAt === undefined && party.index >= party.queue.length;
  if (!idle) {
    await interaction.editReply({ content: `Queued **${track.name}** -- ${track.artist}.` });
    return;
  }
  const outcomes = await access.runner.start(guildId);
  await interaction.editReply({ content: `**${track.name}** -- ${track.artist}\n${formatOutcomes(outcomes)}` });
}

async function handlePartySkip(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const party = getParty(partiesState(), guildId);
  if (party === undefined) {
    await replyEphemeral(interaction, "No party here.");
    return;
  }
  if (!party.members.includes(interaction.user.id)) {
    await replyEphemeral(interaction, "Only people in the party can skip.");
    return;
  }
  const access = await requirePartyAccess(interaction.user.id);
  if (!access.ok) {
    await replyEphemeral(interaction, access.message);
    return;
  }
  await interaction.deferReply();
  const next = party.queue[party.index + 1];
  if (next === undefined) {
    await interaction.editReply({ content: "That was the last track. `/party add` something else." });
    return;
  }
  // A skip and a track ending naturally are the same transition, so both go through the runner's
  // one advance path -- there is no second place that decides what "next" means.
  const outcomes = await access.runner.skip(guildId);
  await interaction.editReply({ content: `Skipped to **${next.name}** -- ${next.artist}\n${formatOutcomes(outcomes)}` });
}

async function handlePartyLeave(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const party = getParty(partiesState(), guildId);
  if (party === undefined || !party.members.includes(interaction.user.id)) {
    await replyEphemeral(interaction, "You're not in a party here.");
    return;
  }
  const wasHost = party.hostId === interaction.user.id;
  await commitParties(removeMember(partiesState(), guildId, interaction.user.id));
  const { runner } = required();
  if (wasHost) runner?.stop(guildId);
  await replyEphemeral(
    interaction,
    wasHost
      ? "You started it, so leaving ended the party. Your Spotify keeps playing whatever it's on."
      : "Left the party. Your Spotify keeps playing whatever it's on.",
  );
}

async function handlePartyStop(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const party = getParty(partiesState(), guildId);
  if (party === undefined) {
    await replyEphemeral(interaction, "No party here.");
    return;
  }
  if (party.hostId !== interaction.user.id) {
    await replyEphemeral(interaction, "Only whoever started the party can stop it.");
    return;
  }
  const { runner } = required();
  runner?.stop(guildId);
  await commitParties(closeParty(partiesState(), guildId));
  // Nobody's playback is paused: the bot stops steering, and each player carries on. Silencing
  // everyone's phone from a Discord command is a worse surprise than the music continuing.
  await interaction.reply({ content: "Party over. Everyone's Spotify keeps playing where it is." });
}

async function handleParty(interaction: ChatInputCommandInteraction): Promise<void> {
  // Borrow the live client while we legitimately have one, so a later timer can post in the
  // party's channel -- see notify.ts for why this is the only way a plugin can do that.
  rememberClient(interaction.client);
  const guildId = interaction.guildId;
  if (guildId === null) {
    await replyEphemeral(interaction, "A listening party only makes sense in a server.");
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "start") return handlePartyStart(interaction, guildId);
  if (subcommand === "add") return handlePartyAdd(interaction, guildId);
  if (subcommand === "skip") return handlePartySkip(interaction, guildId);
  if (subcommand === "leave") return handlePartyLeave(interaction, guildId);
  if (subcommand === "stop") return handlePartyStop(interaction, guildId);

  const party = getParty(partiesState(), guildId);
  await replyEphemeral(
    interaction,
    party === undefined ? "No party here. `/party start` opens one." : formatPartyStatus(party, Date.now()),
  );
}

/** The Join button on a party's own message. */
async function handlePartyJoin(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
): Promise<void> {
  rememberClient(interaction.client);
  const guildId = interaction.guildId;
  if (guildId === null) {
    await interaction.reply({ content: "That button only works in a server.", flags: MessageFlags.Ephemeral });
    return;
  }
  const party = getParty(partiesState(), guildId);
  if (party === undefined) {
    await interaction.reply({ content: "That party has ended.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const access = await requirePartyAccess(interaction.user.id);
  if (!access.ok) {
    await interaction.editReply({ content: access.message });
    return;
  }
  await commitParties(addMember(partiesState(), guildId, interaction.user.id));
  // Mid-track joiners are dropped in at the right position rather than at 0:00.
  const outcome = await access.runner.syncMember(guildId, interaction.user.id);
  await interaction.editReply({
    content: outcome.ok
      ? "You're in. Your Spotify should be playing along."
      : `Joined, but your Spotify didn't take the command: ${outcome.error ?? "unknown reason"}`,
  });
}

/**
 * Every component interaction whose `customId` starts with `music:` arrives here -- the host routes
 * the prefix, not the individual control, so this plugin's one dispatcher has to tell its own
 * controls apart. The party's Join button is a fixed id; everything else falls through to the
 * `/setlist` picker, which answers an id it does not recognise rather than leaving Discord to show
 * "interaction failed".
 */
export async function musicInteractions(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
): Promise<void> {
  if (interaction.customId === PARTY_JOIN_ID) return handlePartyJoin(interaction);
  return handlePick(interaction);
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
    {
      name: "party",
      build: (builder: SlashCommandBuilder) =>
        builder
          .setDescription("Listen to the same thing at the same time, on everyone's own Spotify")
          .addSubcommand((s) => s.setName("start").setDescription("Open a listening party in this channel"))
          .addSubcommand((s) =>
            s
              .setName("add")
              .setDescription("Queue a track (and start the party if it isn't playing yet)")
              .addStringOption((o) =>
                o
                  .setName("query")
                  .setDescription("Track name, or track and artist")
                  .setRequired(true)
                  .setMaxLength(200),
              ),
          )
          .addSubcommand((s) => s.setName("skip").setDescription("Skip to the next queued track"))
          .addSubcommand((s) => s.setName("status").setDescription("What's playing and who's listening"))
          .addSubcommand((s) => s.setName("leave").setDescription("Leave the party"))
          .addSubcommand((s) => s.setName("stop").setDescription("End the party (whoever started it)")),
      handle: handleParty,
    },
  ];
}
