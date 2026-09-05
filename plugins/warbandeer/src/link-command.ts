import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { charactersDir, deleteCharacterSnapshotFrom } from "./characters.js";
import { type LinkedAccount, links, mintLinkCode, removeLinkedAccount, saveLinks } from "./links.js";
import { warbandeerConnectorConfigured, warbandeerServerRunning } from "./server.js";

const LINK_CODE_TTL_MINUTES = 10; // keep in sync with links.ts's LINK_CODE_TTL_MS

/** Pure — unit-tested. */
export function linkReply(code: string): string {
  return (
    `🔗 Your link code is **${code}**. Enter it in the Warbandeer desktop app within ` +
    `${LINK_CODE_TTL_MINUTES} minutes to connect your character data to this Discord account.`
  );
}

/**
 * Whether `/link` should proceed, and what to say if not — split out as a pure function (unlike
 * `warbandeerConnectorConfigured()`/`warbandeerServerRunning()` themselves, which read live state
 * and can't be unit-tested without starting a real server) so this decision is mutation-tested:
 * deleting either check here, or swapping which message goes with which case, fails a test.
 * `configured` and `running` are deliberately distinct — `configured` means
 * `WARBANDEER_INGEST_PORT` is set, `running` means the HTTP server actually bound it, and they
 * can disagree (a bad port value, one already in use) so the message names the right cause.
 */
export function linkAvailability(configured: boolean, running: boolean): { available: true } | { available: false; message: string } {
  if (!configured) {
    return {
      available: false,
      message: "Character linking isn't configured on this bot — set `WARBANDEER_INGEST_PORT` to enable it.",
    };
  }
  if (!running) {
    return {
      available: false,
      message: "Character linking is configured but the connector failed to start — check the bot's logs (see `WARBANDEER_INGEST_PORT`).",
    };
  }
  return { available: true };
}

/**
 * Self-service — no admin/role gate. A user only ever creates a link for themselves
 * (`interaction.user.id`), so there's nothing here for a role check to protect. Deferred before
 * the disk write: `saveLinks()` queues behind whatever `links.json` write is already in flight
 * (another user's `/link`, an in-progress character push), which can outrun Discord's 3-second
 * ack window under load — same reasoning `/status`/`/transmog` already give for deferring.
 */
export async function handleLinkCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const availability = linkAvailability(warbandeerConnectorConfigured(), warbandeerServerRunning());
  if (!availability.available) {
    await interaction.reply({ content: availability.message, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { code, state } = mintLinkCode(links, interaction.user.id, Date.now());
  links.pending = state.pending;
  links.accounts = state.accounts;
  await saveLinks();
  await interaction.editReply({ content: linkReply(code) });
}

/**
 * Decides what `/unlink` should say and, if it should remove something, which Account Label.
 * Pure — unit-tested directly, covering the zero/one/many-accounts branches without touching
 * Discord or disk.
 */
export function unlinkReply(
  accounts: LinkedAccount[],
  accountLabel: string | undefined,
): { message: string; remove?: string } {
  if (accounts.length === 0) {
    return { message: "You don't have any linked accounts." };
  }
  if (!accountLabel) {
    const only = accounts[0];
    if (accounts.length === 1 && only) {
      return { message: `🔓 Unlinked \`${only.accountLabel}\`.`, remove: only.accountLabel };
    }
    const labels = accounts.map((a) => `\`${a.accountLabel}\``).join(", ");
    return { message: `You have multiple linked accounts (${labels}) — specify which one with \`account_label\`.` };
  }
  if (!accounts.some((a) => a.accountLabel === accountLabel)) {
    return { message: `You don't have an account named \`${accountLabel}\`.` };
  }
  return { message: `🔓 Unlinked \`${accountLabel}\`.`, remove: accountLabel };
}

/** Deferred for the same reason `/link` is — a removal's `saveLinks()` can queue behind another
 * in-flight `links.json` write. Also deletes the Account Label's Character Snapshot: without
 * this, `data/characters/<id>.json` would keep holding data for an account with no live Linked
 * Account and no way to ever update it again — "disconnects it" (README) should mean the bot
 * stops holding the data too, not just stops accepting new pushes for it. */
export async function handleUnlinkCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const accountLabel = interaction.options.getString("account_label") ?? undefined;
  const accounts = links.accounts[interaction.user.id] ?? [];
  const decision = unlinkReply(accounts, accountLabel);
  if (decision.remove) {
    const result = removeLinkedAccount(links, interaction.user.id, decision.remove);
    if (result) {
      links.accounts = result.state.accounts;
      await saveLinks();
      await deleteCharacterSnapshotFrom(charactersDir(), interaction.user.id, decision.remove);
    }
  }
  await interaction.editReply({ content: decision.message });
}
