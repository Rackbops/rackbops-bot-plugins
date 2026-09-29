import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type SlashCommandBuilder,
  type User as DiscordUser,
} from "discord.js";
import type { PluginCommand, PluginInteractionHandler, PluginLog } from "../../../packages/api/contract.js";
import type { Membership, Need } from "./access.js";
import {
  allowPerson,
  answerLatest,
  clip,
  enter,
  listTasks,
  MAX_REMINDER_TEXT,
  registerPerson,
  remind,
  setHour,
  type Repeat,
  type TrackerDeps,
} from "./actions.js";
import { MAX_REPLY_TEXT, modalId, parseCustomId, REPLY_FIELD, replyButtonId } from "./buttons.js";
import { taskHistory } from "./history.js";
import { press, replyRefusal, shareTask, submitReply } from "./press.js";

/**
 * The Discord side of the tracker's commands and buttons (plan 5.5, E2): read the options, look up
 * membership, call actions.ts / press.ts / history.ts, render the answer. Every answer is
 * ephemeral, in a server and in DMs alike -- the commands register globally, so they work in the
 * bot's DMs too (plan 5.5, item 39), and a person's tasks are private by default (1.1).
 *
 * Interactions are handled one at a time (a promise chain): docket's "once per run" holds only when
 * a task's replies are handled one at a time (`Lanes.reply`). Membership lookups, which go to
 * Discord, run before a handler joins the queue, so a slow lookup does not hold up anyone else.
 */

export const STARTING = "The tracker is starting up; try again in a minute.";
export const FAILED = "Something went wrong on my side; try again in a minute.";

/** Discord's error codes for "no such member" and "no such user". */
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;

export interface SurfaceWiring {
  /** The live deps; null before `activate()` and after `dispose()`. */
  deps(): TrackerDeps | null;
  /** `TRACKER_GUILD_ID`; null = no membership gate. */
  guildId: string | null;
  log: PluginLog;
  /** Test seam; defaults to asking Discord through the interaction's client. */
  membership?: (interaction: Interactionish, discordId: string) => Promise<Membership>;
}

/** What a membership lookup reads off an interaction. */
export interface Interactionish {
  guildId: string | null;
  user: { id: string };
  client: { guilds: { fetch(id: string): Promise<{ members: { fetch(o: { user: string }): Promise<unknown> } }> } };
}

/**
 * Whether `discordId` is a member of `guildId`, asked of Discord through the interaction's client
 * (the host API has no member lookup; plan 5.5). A single-member fetch is a REST call and needs no
 * privileged intent. Discord's "unknown member" or "unknown user" is a no; anything else (the bot
 * left the server, an outage) is `unknown`, which refuses.
 */
export async function lookupMembership(interaction: Interactionish, guildId: string | null, discordId: string, log: PluginLog): Promise<Membership> {
  if (guildId === null) return "not-checked";
  if (interaction.guildId === guildId && interaction.user.id === discordId) return "member";
  try {
    const guild = await interaction.client.guilds.fetch(guildId);
    await guild.members.fetch({ user: discordId });
    return "member";
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === UNKNOWN_MEMBER || code === UNKNOWN_USER) return "not-member";
    log.warn(`could not check membership of ${guildId}: ${err instanceof Error ? err.message : String(err)}`);
    return "unknown";
  }
}

function serial() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
}

function displayName(user: DiscordUser): string {
  return user.globalName ?? user.username;
}

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const NO_MENTIONS = { allowedMentions: { parse: [] as never[] } };

export function createSurface(w: SurfaceWiring): { commands: PluginCommand[]; interactions: PluginInteractionHandler } {
  const queue = serial();
  const membershipOf = (interaction: Interactionish, discordId: string) =>
    w.membership ? w.membership(interaction, discordId) : lookupMembership(interaction, w.guildId, discordId, w.log);

  /** Gate, resume, act, answer: the one path every command takes. */
  async function run(interaction: ChatInputCommandInteraction, need: Need, act: (d: TrackerDeps, user: import("@rackbops/docket-core").User) => Promise<string>) {
    await interaction.deferReply(EPHEMERAL);
    let content: string;
    try {
      const d = w.deps();
      if (!d) content = STARTING;
      else {
        const membership = await membershipOf(interaction as unknown as Interactionish, interaction.user.id);
        content = await queue(async () => {
          const entry = await enter(d, interaction.user.id, membership, need);
          if (!entry.ok) return entry.content;
          const body = await act(d, entry.user);
          return clip(entry.notice ? `${entry.notice}\n\n${body}` : body);
        });
      }
    } catch (err) {
      w.log.error(`/${interaction.commandName} failed`, err);
      content = FAILED;
    }
    await interaction.editReply({ content, ...NO_MENTIONS });
  }

  const commands: PluginCommand[] = [
    {
      name: "allow",
      build: (b: SlashCommandBuilder) =>
        b
          .setDescription("Admin: let a person use the tracker")
          .addUserOption((o) => o.setName("user").setDescription("Who to let in").setRequired(true)),
      handle: (interaction) =>
        run(interaction, "admin", async (d, admin) => {
          const target = interaction.options.getUser("user", true);
          const membership = await membershipOf(interaction as unknown as Interactionish, target.id);
          return allowPerson(d, admin, { discordId: target.id, bot: target.bot, membership });
        }),
    },
    {
      name: "register",
      build: (b: SlashCommandBuilder) =>
        b
          .setDescription("Sign up for reminders, or change your hour and time zone")
          .addIntegerOption((o) =>
            o.setName("hour").setDescription("Hour (0-23) a reminder without a time arrives; default 9").setMinValue(0).setMaxValue(23),
          )
          .addStringOption((o) => o.setName("zone").setDescription("Your time zone, e.g. America/New_York (the default)").setMaxLength(64)),
      handle: (interaction) =>
        run(interaction, "admitted", (d, user) => {
          const hour = interaction.options.getInteger("hour");
          const zone = interaction.options.getString("zone");
          return registerPerson(d, user, {
            displayName: displayName(interaction.user),
            ...(hour !== null ? { hour } : {}),
            ...(zone !== null ? { zone: zone.trim() } : {}),
          });
        }),
    },
    {
      name: "remind",
      build: (b: SlashCommandBuilder) =>
        b
          .setDescription("Set a reminder, sent to you by DM")
          .addStringOption((o) => o.setName("text").setDescription("What to remind you of").setRequired(true).setMaxLength(MAX_REMINDER_TEXT))
          .addStringOption((o) =>
            o.setName("when").setDescription('When: "in 20 minutes", "tomorrow 9am", "fri at 17:30"').setMaxLength(100),
          )
          .addStringOption((o) =>
            o
              .setName("repeat")
              .setDescription("Repeat it (default: once)")
              .addChoices(
                { name: "once", value: "none" },
                { name: "daily", value: "day" },
                { name: "weekly", value: "week" },
                { name: "monthly", value: "month" },
              ),
          ),
      handle: (interaction) =>
        run(interaction, "registered", (d, user) => {
          const when = interaction.options.getString("when");
          return remind(d, user, {
            text: interaction.options.getString("text", true),
            ...(when !== null ? { when } : {}),
            repeat: (interaction.options.getString("repeat") ?? "none") as Repeat,
          });
        }),
    },
    {
      name: "tasks",
      build: (b: SlashCommandBuilder) => b.setDescription("List your tasks and when each is next due"),
      handle: (interaction) => run(interaction, "registered", (d, user) => listTasks(d, user)),
    },
    {
      name: "task",
      build: (b: SlashCommandBuilder) =>
        b
          .setDescription("Answer, look back at, or share one of your tasks")
          .addSubcommand((s) =>
            s
              .setName("done")
              .setDescription("Mark the task's latest reminder done")
              .addStringOption((o) => o.setName("task").setDescription("The task id from /tasks, e.g. t3").setRequired(true).setMaxLength(24)),
          )
          .addSubcommand((s) =>
            s
              .setName("snooze")
              .setDescription("Snooze the task's latest reminder (default: an hour)")
              .addStringOption((o) => o.setName("task").setDescription("The task id from /tasks, e.g. t3").setRequired(true).setMaxLength(24))
              .addStringOption((o) => o.setName("until").setDescription('Until when: "in 2h", "tomorrow 9am"').setMaxLength(100)),
          )
          .addSubcommand((s) =>
            s
              .setName("history")
              .setDescription("Every run of the task, how it was answered, and its changes")
              .addStringOption((o) => o.setName("task").setDescription("The task id from /tasks, e.g. t3").setRequired(true).setMaxLength(24)),
          )
          .addSubcommand((s) =>
            s
              .setName("share")
              .setDescription("Ask someone to receive this task's messages too")
              .addStringOption((o) => o.setName("task").setDescription("The task id from /tasks, e.g. t3").setRequired(true).setMaxLength(24))
              .addUserOption((o) => o.setName("user").setDescription("Who to invite").setRequired(true)),
          ),
      handle: (interaction) =>
        run(interaction, "registered", (d, user) => {
          const taskId = interaction.options.getString("task", true);
          switch (interaction.options.getSubcommand()) {
            case "done":
              return answerLatest(d, user, { taskId, kind: "done" });
            case "snooze": {
              const until = interaction.options.getString("until");
              return answerLatest(d, user, { taskId, kind: "snooze", ...(until !== null ? { until } : {}) });
            }
            case "history":
              return taskHistory(d, user, taskId);
            case "share":
              return shareTask(d, user, taskId, interaction.options.getUser("user", true).id);
            default:
              return Promise.resolve("Unknown subcommand.");
          }
        }),
    },
    {
      name: "settings",
      build: (b: SlashCommandBuilder) =>
        b
          .setDescription("Your tracker settings")
          .addSubcommand((s) =>
            s
              .setName("hour")
              .setDescription("The hour (0-23) a reminder without a time reaches you")
              .addIntegerOption((o) => o.setName("hour").setDescription("0-23, in your time zone").setRequired(true).setMinValue(0).setMaxValue(23)),
          ),
      handle: (interaction) => run(interaction, "registered", (d, user) => setHour(d, user, interaction.options.getInteger("hour", true))),
    },
  ];

  async function onButton(interaction: MessageComponentInteraction, d: TrackerDeps, ref: string) {
    await interaction.deferUpdate();
    const membership = await membershipOf(interaction as unknown as Interactionish, interaction.user.id);
    const result = await queue(async () => {
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
    // A modal has to be the first answer, so only the store is asked here; membership is checked
    // when the modal comes back, before anything is written.
    const refusal = await queue(async () => {
      const entry = await enter(d, interaction.user.id, "not-checked", "registered");
      if (!entry.ok) return entry.content;
      return replyRefusal(d, entry.user, occurrenceId);
    });
    if (refusal) {
      await interaction.reply({ content: refusal, ...EPHEMERAL });
      return;
    }
    await interaction.showModal(replyModal(occurrenceId));
  }

  async function onReplyModal(interaction: ModalSubmitInteraction, d: TrackerDeps, occurrenceId: string) {
    await interaction.deferReply(EPHEMERAL);
    const membership = await membershipOf(interaction as unknown as Interactionish, interaction.user.id);
    const text = interaction.fields.getTextInputValue(REPLY_FIELD);
    const content = await queue(async () => {
      const entry = await enter(d, interaction.user.id, membership, "registered");
      if (!entry.ok) return entry.content;
      const body = await submitReply(d, entry.user, occurrenceId, text);
      return entry.notice ? `${entry.notice}\n\n${body}` : body;
    });
    await interaction.editReply({ content: clip(content), ...NO_MENTIONS });
  }

  const interactions: PluginInteractionHandler = async (interaction) => {
    const parsed = parseCustomId(interaction.customId);
    const d = w.deps();
    if (!parsed || !d) {
      await interaction.reply({ content: d ? "That button is not one of mine." : STARTING, ...EPHEMERAL });
      return;
    }
    try {
      if (parsed.kind === "reply-modal" && interaction.isModalSubmit()) return await onReplyModal(interaction, d, parsed.occurrenceId);
      if (!interaction.isMessageComponent()) {
        await interaction.reply({ content: "That is not one of mine.", ...EPHEMERAL });
        return;
      }
      if (parsed.kind === "reply-button") return await onReplyButton(interaction, d, parsed.occurrenceId);
      if (parsed.kind === "ref") return await onButton(interaction, d, parsed.ref);
      await interaction.reply({ content: "That is not one of mine.", ...EPHEMERAL });
    } catch (err) {
      w.log.error(`interaction ${interaction.customId} failed`, err);
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content: FAILED, ...EPHEMERAL });
      else await interaction.reply({ content: FAILED, ...EPHEMERAL });
    }
  };

  return { commands, interactions };
}

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
