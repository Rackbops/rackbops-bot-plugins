import type { ChatInputCommandInteraction, SlashCommandBuilder, User as DiscordUser } from "discord.js";
import type { User } from "@rackbops/docket-core";
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
  resumeTask,
  setHour,
  type Repeat,
  type TrackerDeps,
} from "./actions.js";
import {
  EPHEMERAL,
  FAILED,
  type Interactionish,
  lookupMembership,
  NO_MENTIONS,
  type Queue,
  serial,
  STARTING,
  type SurfaceContext,
} from "./discord-common.js";
import { taskHistory } from "./history.js";
import { createInteractionHandler } from "./interactions.js";
import { finishShare, prepareShare, sendShare } from "./press.js";
import { type WebLocation, webLink } from "./web/command.js";

export { lookupMembership, type Interactionish, STARTING, FAILED } from "./discord-common.js";

/**
 * The slash commands (plan 5.5, E2): read the options, look up membership, call actions.ts /
 * press.ts / history.ts, render the answer; the buttons and the Reply modal are interactions.ts.
 * Every answer is ephemeral, in a server and in DMs alike -- the commands register globally, so
 * they work in the bot's DMs too (plan 5.5, item 39), and a person's tasks are private by default
 * (1.1). Store writes go through the one queue (discord-common.ts); a Discord lookup runs before a
 * command's turn and a DM after it.
 */

export interface SurfaceWiring {
  /** The live deps; null before `activate()` and after `dispose()`. */
  deps(): TrackerDeps | null;
  /** `TRACKER_GUILD_ID`; null = no membership gate. */
  guildId: string | null;
  log: PluginLog;
  /** Test seam; defaults to asking Discord through the interaction's client. */
  membership?: (interaction: Interactionish, discordId: string) => Promise<Membership>;
  /** Where the web area is (`TRACKER_WEB_URL`); null = not set up, and `/web` says so. */
  web: WebLocation | null;
  /** The one queue for store writes, shared with the web area; a fresh one when absent. */
  queue?: Queue;
}

/** What an action answers: the text, or a DM to send outside the queue and a last step back in it. */
export type Step = string | { outside: () => Promise<unknown>; finish: (result: unknown) => Promise<string> };

function displayName(user: DiscordUser): string {
  return user.globalName ?? user.username;
}

export function createSurface(w: SurfaceWiring): { commands: PluginCommand[]; interactions: PluginInteractionHandler } {
  const ctx: SurfaceContext = {
    deps: w.deps,
    queue: w.queue ?? serial(),
    membershipOf: (interaction, discordId) =>
      w.membership ? w.membership(interaction, discordId) : lookupMembership(interaction, w.guildId, discordId, w.log),
    log: w.log,
  };
  const membershipOf = (interaction: ChatInputCommandInteraction, discordId: string) =>
    ctx.membershipOf(interaction as unknown as Interactionish, discordId);

  /**
   * Gate, resume, act, answer: the one path every command takes. `pre` runs before the command's
   * turn in the queue (a Discord lookup); a Step's `outside` runs after it (a DM), and its `finish`
   * takes one more turn. (Not `then`: an object with one would be awaited as a promise.)
   */
  async function run<P>(
    interaction: ChatInputCommandInteraction,
    need: Need,
    act: (d: TrackerDeps, user: User, pre: P) => Promise<Step>,
    pre: () => Promise<P> = async () => undefined as P,
  ) {
    await interaction.deferReply(EPHEMERAL);
    let content: string;
    try {
      const d = w.deps();
      if (!d) content = STARTING;
      else {
        const membership = await membershipOf(interaction, interaction.user.id);
        const before = await pre();
        const first = await ctx.queue(async () => {
          const entry = await enter(d, interaction.user.id, membership, need);
          if (!entry.ok) return { notice: null, step: entry.content as Step };
          return { notice: entry.notice, step: await act(d, entry.user, before) };
        });
        let body: string;
        if (typeof first.step === "string") body = first.step;
        else {
          const { outside, finish } = first.step;
          const result = await outside();
          body = await ctx.queue(() => finish(result));
        }
        content = clip(first.notice ? `${first.notice}\n\n${body}` : body);
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
      handle: (interaction) => {
        const target = interaction.options.getUser("user", true);
        return run(
          interaction,
          "admin",
          (d, admin, membership: Membership) => allowPerson(d, admin, { discordId: target.id, bot: target.bot, membership }),
          () => membershipOf(interaction, target.id),
        );
      },
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
              .setName("resume")
              .setDescription("Resume a task paused because someone could not be DMed, without them")
              .addStringOption((o) => o.setName("task").setDescription("The task id from /tasks, e.g. t3").setRequired(true).setMaxLength(24)),
          )
          .addSubcommand((s) =>
            s
              .setName("share")
              .setDescription("Ask someone to receive this task's messages too")
              .addStringOption((o) => o.setName("task").setDescription("The task id from /tasks, e.g. t3").setRequired(true).setMaxLength(24))
              .addUserOption((o) => o.setName("user").setDescription("Who to invite").setRequired(true)),
          ),
      handle: (interaction) => {
        const sub = interaction.options.getSubcommand();
        const taskId = interaction.options.getString("task", true);
        const shareWith = sub === "share" ? interaction.options.getUser("user", true) : null;
        return run(
          interaction,
          "registered",
          async (d, user, membership: Membership | null): Promise<Step> => {
            switch (sub) {
            case "done":
              return answerLatest(d, user, { taskId, kind: "done" });
            case "snooze": {
              const until = interaction.options.getString("until");
              return answerLatest(d, user, { taskId, kind: "snooze", ...(until !== null ? { until } : {}) });
            }
            case "history":
              return taskHistory(d, user, taskId);
            case "resume":
              return resumeTask(d, user, taskId);
            case "share": {
              const pending = await prepareShare(d, user, taskId, { discordId: shareWith?.id ?? "", membership: membership ?? "unknown" });
              if (typeof pending === "string") return pending;
              return { outside: () => sendShare(d, pending), finish: (err) => finishShare(d, pending, err) };
            }
            default:
              return "Unknown subcommand.";
            }
          },
          async () => (shareWith ? membershipOf(interaction, shareWith.id) : null),
        );
      },
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
    {
      name: "web",
      build: (b: SlashCommandBuilder) => b.setDescription("Get a one-time link to sign in to the tracker's web area"),
      handle: (interaction) => run(interaction, "registered", async (d, user) => webLink(d, user, w.web)),
    },
  ];

  return { commands, interactions: createInteractionHandler(ctx) };
}
