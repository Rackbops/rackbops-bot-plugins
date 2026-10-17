import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { charactersDir, deleteCharacterSnapshotFrom } from "./characters.js";
import { type LinkedAccount, hashToken, links, mintLinkCode, removeLinkedAccount, saveLinks } from "./links.js";
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
  const minted = state.pending.find((p) => p.codeHash === hashToken(code));
  links.pending = state.pending;
  links.accounts = state.accounts;
  try {
    await saveLinks();
  } catch (err) {
    // Deferred, so the host's "something went wrong" safety net no longer applies. A code that was never
    // saved (and never shown) must not stay redeemable in memory. Only this code is taken back: whatever a
    // redeem or another /link changed while the save was pending is not ours to undo.
    links.pending = links.pending.filter((p) => p !== minted);
    await failReply(interaction, "/link", err);
    return;
  }
  // Saved, so the code stays valid even if this reply fails: the user never saw it, and it expires on its own.
  try {
    await interaction.editReply({ content: linkReply(code) });
  } catch (err) {
    console.error("[warbandeer] /link: the reply carrying the code failed", err);
  }
}

/** Logs and answers a handler that threw after `deferReply`; the answer itself failing is only logged. */
async function failReply(interaction: ChatInputCommandInteraction, command: string, err: unknown): Promise<void> {
  console.error(`[warbandeer] ${command} failed`, err);
  await interaction.editReply({ content: "Something went wrong on my side. Try again in a moment." }).catch((replyErr: unknown) => {
    console.error(`[warbandeer] ${command}: the failure reply also failed`, replyErr);
  });
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
      try {
        await saveLinks();
      } catch (err) {
        // Not saved, so not unlinked: put back this account alone (not a snapshot of everyone's, which would
        // undo a link or push-time update that landed while the save was pending), unless it was re-added.
        const mine = links.accounts[interaction.user.id] ?? [];
        if (!mine.some((a) => a.accountLabel === result.removed.accountLabel)) {
          links.accounts = { ...links.accounts, [interaction.user.id]: [...mine, result.removed] };
        }
        await failReply(interaction, "/unlink", err);
        return;
      }
      try {
        await deleteCharacterSnapshotFrom(charactersDir(), interaction.user.id, decision.remove);
      } catch (err) {
        // The account is gone and its token no longer verifies, so the reply must still say so; but the
        // snapshot stays on disk, and the user should not be told otherwise.
        console.error("[warbandeer] /unlink: deleting the character snapshot failed", err);
        await interaction
          .editReply({ content: `${decision.message}\n⚠️ Your stored character data could not be deleted just now; ask the bot's operator to remove it.` })
          .catch((replyErr: unknown) => console.error("[warbandeer] /unlink: the reply also failed", replyErr));
        return;
      }
    }
  }
  await interaction.editReply({ content: decision.message });
}
