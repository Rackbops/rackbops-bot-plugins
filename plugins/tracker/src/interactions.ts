import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { PluginInteractionHandler } from "../../../packages/api/contract.js";
import { decideAccess, NOT_ADMITTED } from "./access.js";
import { clip, enter, type TrackerDeps } from "./actions.js";
import { MAX_REPLY_TEXT, modalId, parseCustomId, REPLY_FIELD, replyButtonId } from "./buttons.js";
import { EPHEMERAL, FAILED, type Interactionish, NO_MENTIONS, STARTING, type SurfaceContext } from "./discord-common.js";
import { press, reducesContact, replyRefusal, submitReply } from "./press.js";

/**
 * The buttons and the Reply modal (plan 5.5): a press with one of docket's reply references, the
 * Reply button, and the modal it opens. Each answers within Discord's three seconds: a press defers
 * first; the Reply button answers with the modal itself, so it does only read-only checks before it
 * and writes nothing (a resume included) until the modal comes back with the membership checked.
 */

export function replyRow(occurrenceId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(replyButtonId(occurrenceId)).setLabel("Reply").setStyle(ButtonStyle.Secondary),
  );
}

export function replyModal(occurrenceId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(modalId(occurrenceId))
    .setTitle("Reply")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(REPLY_FIELD)
          .setLabel("Your reply")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(MAX_REPLY_TEXT),
      ),
    );
}

export function createInteractionHandler(c: SurfaceContext): PluginInteractionHandler {
  const membershipOf = (i: MessageComponentInteraction | ModalSubmitInteraction) => c.membershipOf(i as unknown as Interactionish, i.user.id);

  async function onButton(interaction: MessageComponentInteraction, d: TrackerDeps, ref: string) {
    await interaction.deferUpdate();
    const gated = !reducesContact(ref);
    const membership = gated ? await membershipOf(interaction) : "not-checked";
    const result = await c.queue(async () => {
      if (!gated) {
        // Declining and opting out always work (press.ts `reducesContact`); docket checks the rest.
        const person = await d.store.findUserByDiscordId(interaction.user.id);
        if (!person) return { notice: null, pressed: { ok: false as const, error: "That is not yours to answer." } };
        return { notice: null, pressed: await press(d, person, ref) };
      }
      const entry = await enter(d, interaction.user.id, membership, "registered");
      if (!entry.ok) return { notice: null, pressed: { ok: false as const, error: entry.content } };
      return { notice: entry.notice, pressed: await press(d, entry.user, ref) };
    });
    if (result.pressed.ok) {
      const { status, keepReplyFor } = result.pressed;
      await interaction.editReply({
        content: clip(`${interaction.message.content}\n\n-- ${status}`),
        components: keepReplyFor ? [replyRow(keepReplyFor)] : [],
        ...NO_MENTIONS,
      });
    } else {
      await interaction.followUp({ content: result.pressed.error, ...EPHEMERAL });
    }
    if (result.notice) await interaction.followUp({ content: result.notice, ...EPHEMERAL });
  }

  async function onReplyButton(interaction: MessageComponentInteraction, d: TrackerDeps, occurrenceId: string) {
    // Read-only, and outside the queue: a modal has to be the first answer, within three seconds.
    // Membership and the resume wait for the submit (onReplyModal), before anything is written.
    const person = await d.store.findUserByDiscordId(interaction.user.id);
    const registered = person ? d.admissions.isRegistered(person.id) : false;
    const refusal =
      decideAccess({ membership: "not-checked", person, registered, need: "registered" }) ??
      (person ? await replyRefusal(d, person, occurrenceId) : NOT_ADMITTED);
    if (refusal) {
      await interaction.reply({ content: refusal, ...EPHEMERAL });
      return;
    }
    await interaction.showModal(replyModal(occurrenceId));
  }

  async function onReplyModal(interaction: ModalSubmitInteraction, d: TrackerDeps, occurrenceId: string) {
    await interaction.deferReply(EPHEMERAL);
    const membership = await membershipOf(interaction);
    const text = interaction.fields.getTextInputValue(REPLY_FIELD);
    const content = await c.queue(async () => {
      const entry = await enter(d, interaction.user.id, membership, "registered");
      if (!entry.ok) return entry.content;
      const body = await submitReply(d, entry.user, occurrenceId, text);
      return entry.notice ? `${entry.notice}\n\n${body}` : body;
    });
    await interaction.editReply({ content: clip(content), ...NO_MENTIONS });
  }

  /**
   * The last-resort answer. An interaction already answered (deferred, replied, or given its modal:
   * discord.js marks `showModal` as replied) gets a follow-up, never a second `reply`; an expired
   * one throws on either, which is logged here, never thrown to the host.
   */
  async function failed(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content: FAILED, ...EPHEMERAL });
      else await interaction.reply({ content: FAILED, ...EPHEMERAL });
    } catch (err) {
      c.log.warn(`could not tell the presser of ${interaction.customId} that it failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return async (interaction) => {
    const parsed = parseCustomId(interaction.customId);
    const d = c.deps();
    if (!parsed || !d) {
      await interaction.reply({ content: d ? "That button is not one of mine." : STARTING, ...EPHEMERAL });
      return;
    }
    try {
      if (parsed.kind === "reply-modal" && interaction.isModalSubmit()) return await onReplyModal(interaction, d, parsed.occurrenceId);
      if (interaction.isMessageComponent() && parsed.kind === "reply-button") return await onReplyButton(interaction, d, parsed.occurrenceId);
      if (interaction.isMessageComponent() && parsed.kind === "ref") return await onButton(interaction, d, parsed.ref);
      await interaction.reply({ content: "That is not one of mine.", ...EPHEMERAL });
    } catch (err) {
      c.log.error(`interaction ${interaction.customId} failed`, err);
      await failed(interaction);
    }
  };
}
