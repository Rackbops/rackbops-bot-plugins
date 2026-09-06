import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { PluginCommand } from "../../../packages/api/contract.js";
import { config } from "./config.js";
import { currentOrNextDmf } from "./dmf.js";
import { nextDailyReset, nextWeeklyReset } from "./reset.js";
import { realmStatus, realmWatchConfigured } from "./realm.js";
import { blizzardConfigured } from "./blizzard.js";
import { fetchTransmog, formatTransmogReply, realmSlug, TransmogLookupError } from "./transmog.js";

// Discord timestamp markers — the same `ts`/`when` helpers the bot's commands.ts used (src/commands.ts:37-38).
const ts = (d: Date, style: "F" | "R" = "F") => `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;
const when = (d: Date) => `${ts(d)} (${ts(d, "R")})`;

// The four handlers are ported verbatim from the bot's handleCommand cases (src/commands.ts:138-234):
// same replies, same ephemeral "not configured" guards, same deferred-reply convention.

async function handleDmf(interaction: ChatInputCommandInteraction): Promise<void> {
  const { active, window } = currentOrNextDmf();
  await interaction.reply(
    active
      ? `🎪 The Darkmoon Faire is **open**! It closes ${when(window.end)}.`
      : `🎪 The Darkmoon Faire opens ${when(window.start)}.`,
  );
}

async function handleReset(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply(
    `🕒 Daily reset: ${when(nextDailyReset())}\n📅 Weekly reset: ${when(nextWeeklyReset())}`,
  );
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!realmWatchConfigured()) {
    await interaction.reply({
      content:
        "Realm status is not configured — set `WOW_REALM`, `BLIZZARD_CLIENT_ID`, and `BLIZZARD_CLIENT_SECRET`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply();
  try {
    const status = await realmStatus();
    await interaction.editReply(
      status === "UP" ? `🟢 **${config.realmSlug}** is up.` : `🔴 **${config.realmSlug}** is down.`,
    );
  } catch (err) {
    await interaction.editReply(`⚠️ Could not query realm status: ${(err as Error).message}`);
  }
}

async function handleTransmog(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!blizzardConfigured()) {
    await interaction.reply({
      content:
        "Transmog lookup is not configured — set `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const character = interaction.options.getString("character", true);
  const realm = interaction.options.getString("realm", true);
  // Deferred: a token refresh plus the profile call can outrun Discord's 3s reply window.
  await interaction.deferReply();
  try {
    const result = await fetchTransmog(character, realm);
    await interaction.editReply(formatTransmogReply(character, realmSlug(realm), result));
  } catch (err) {
    // A lookup error is the user's to act on (wrong name/realm), so it carries its own wording;
    // anything else is ours and gets the generic shape.
    await interaction.editReply(
      err instanceof TransmogLookupError
        ? `⚠️ ${err.message}`
        : `⚠️ Transmog lookup failed: ${(err as Error).message}`,
    );
  }
}

/**
 * The four WoW slash commands. The host hands `build` an already-namespaced builder (COMMAND_PREFIX
 * applied host-side), so the descriptions and options here mirror the bot's `commandData` byte-for-byte.
 * `status`'s description carries the configured realm when `WOW_REALM` is set, exactly as the bot did.
 */
export function wowCommands(): PluginCommand[] {
  return [
    {
      name: "dmf",
      build: (b) => b.setDescription("Darkmoon Faire schedule"),
      handle: handleDmf,
    },
    {
      name: "reset",
      build: (b) => b.setDescription("Next daily and weekly reset times"),
      handle: handleReset,
    },
    {
      name: "status",
      build: (b) => b.setDescription(`Realm status${config.realmSlug ? ` for ${config.realmSlug}` : ""}`),
      handle: handleStatus,
    },
    {
      name: "transmog",
      build: (b) =>
        b
          .setDescription("Get a /customset import string for a character's transmog")
          .addStringOption((o) => o.setName("character").setDescription("Character name").setRequired(true))
          .addStringOption((o) => o.setName("realm").setDescription('Realm, e.g. "Argent Dawn"').setRequired(true)),
      handle: handleTransmog,
    },
  ];
}
