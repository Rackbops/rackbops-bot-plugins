import type { ChatInputCommandInteraction, SlashCommandBuilder, SlashCommandSubcommandBuilder, User as DiscordUser } from "discord.js";
import type { User } from "@rackbops/docket-core";
import type { PluginCommand, PluginInteractionHandler, PluginLog } from "../../../packages/api/contract.js";
import type { Membership, Need } from "./access.js";
import {
  allowPerson,
  answerLatest,
  clip,
  enter,
  listTasks,
  registerPerson,
  said,
  setHour,
  type TrackerDeps,
} from "./actions.js";
import { resumeTask } from "./manage.js";
import { CURRENCY_LENGTH, DATE_LENGTH, MAX_NEAR, MAX_NOTE, MAX_REMINDER_TEXT, MAX_TASK_ID, MAX_TITLE, MAX_URL, MAX_WHEN, MAX_ZONE } from "./limits.js";
import { remind, type Repeat } from "./reminders.js";
import { MAX_CONTEXT_CHARS, MAX_QUESTION_CHARS, researchCommand } from "./research.js";
import { DEFAULT_BGG_HOURS, DEFAULT_PAGE_HOURS, MAX_WANT_HOURS, wantCommand } from "./want.js";
import { createScout, DEFAULT_SCOUT_EVERY, editScout, MAX_INTERESTS_TEXT, MAX_SCOUT_EVERY } from "./scout.js";
import { MAX_FOR_CHARS, MAX_SCOUT_NOTES } from "./scout-type.js";
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
import { createInteractionHandler } from "./interactions.js";
import { finishShare, prepareShare, sendShare } from "./press.js";
import { historyWithSeries } from "./series.js";
import { DEFAULT_POLL_HOURS, MAX_POLL_HOURS, trackPrice } from "./price.js";
import { addRenewal, decideRenewal, DEFAULT_LEAD_DAYS, MAX_EVERY, MAX_LEAD_DAYS, type PeriodUnit } from "./tracked.js";
import type { BaselineRule, RenewalDecision } from "@rackbops/docket-types";
import { type WebLocation, webLink } from "./web/command.js";

export { lookupMembership, type Interactionish, STARTING, FAILED } from "./discord-common.js";

/** The scout's `lens` option, on `/scout new` and `/scout edit` alike. */
function lensOption(s: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return s.addStringOption((o) =>
    o
      .setName("lens")
      .setDescription("The gift lens (default: general)")
      .addChoices(
        { name: "general", value: "general" },
        { name: "birthday: fun or a little grandiose", value: "birthday" },
        { name: "anniversary: a romantic angle", value: "anniversary" },
        { name: "christmas: tied to their interests", value: "christmas" },
      ),
  );
}

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
  /** `TRACKER_GUILD_ID`'s servers; null = no membership gate. */
  guildIds: readonly string[] | null;
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
      w.membership ? w.membership(interaction, discordId) : lookupMembership(interaction, w.guildIds, discordId, w.log),
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
          .addStringOption((o) => o.setName("zone").setDescription("Your time zone, e.g. America/New_York (the default)").setMaxLength(MAX_ZONE)),
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
            o.setName("when").setDescription('When: "in 20 minutes", "tomorrow 9am", "fri at 17:30"').setMaxLength(MAX_WHEN),
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
      name: "renewal",
      build: (b: SlashCommandBuilder) =>
        b
          .setDescription("Track a subscription, domain or warranty: I ask before each renewal")
          .addStringOption((o) => o.setName("name").setDescription("What renews, e.g. Netflix").setRequired(true).setMaxLength(MAX_TITLE))
          .addNumberOption((o) => o.setName("amount").setDescription("What one period costs").setRequired(true).setMinValue(0))
          .addStringOption((o) => o.setName("currency").setDescription("Currency code, e.g. USD").setRequired(true).setMinLength(CURRENCY_LENGTH).setMaxLength(CURRENCY_LENGTH))
          .addStringOption((o) => o.setName("renews").setDescription("The next renewal or expiry date, YYYY-MM-DD").setRequired(true).setMaxLength(DATE_LENGTH))
          .addStringOption((o) =>
            o
              .setName("unit")
              .setDescription("How it renews (default: yearly)")
              .addChoices({ name: "yearly", value: "year" }, { name: "monthly", value: "month" }, { name: "weekly", value: "week" }, { name: "daily", value: "day" }),
          )
          .addIntegerOption((o) => o.setName("every").setDescription("Every how many of those, e.g. 2 for every two years (default 1)").setMinValue(1).setMaxValue(MAX_EVERY))
          .addIntegerOption((o) =>
            o.setName("lead").setDescription(`Days before the date to ask (default ${DEFAULT_LEAD_DAYS})`).setMinValue(0).setMaxValue(MAX_LEAD_DAYS),
          )
          .addStringOption((o) => o.setName("note").setDescription("Carried on every ask: where to cancel, which account").setMaxLength(MAX_NOTE)),
      handle: (interaction) =>
        run(interaction, "registered", (d, user) => {
          const every = interaction.options.getInteger("every");
          const lead = interaction.options.getInteger("lead");
          const unit = interaction.options.getString("unit");
          const note = interaction.options.getString("note");
          return addRenewal(d, user, {
            name: interaction.options.getString("name", true),
            amount: interaction.options.getNumber("amount", true),
            currency: interaction.options.getString("currency", true),
            renews: interaction.options.getString("renews", true),
            ...(every !== null ? { every } : {}),
            ...(lead !== null ? { lead } : {}),
            ...(unit !== null ? { unit: unit as PeriodUnit } : {}),
            ...(note !== null ? { note } : {}),
          });
        }),
    },
    {
      name: "price",
      build: (b: SlashCommandBuilder) =>
        b
          .setDescription("Track a product's price: I DM you when it drops")
          .addStringOption((o) => o.setName("url").setDescription("The product page").setRequired(true).setMaxLength(MAX_URL))
          .addStringOption((o) => o.setName("name").setDescription("What to call it (default: the page address)").setMaxLength(MAX_TITLE))
          .addIntegerOption((o) =>
            o.setName("hours").setDescription(`Hours between checks (default ${DEFAULT_POLL_HOURS})`).setMinValue(1).setMaxValue(MAX_POLL_HOURS),
          )
          .addNumberOption((o) => o.setName("drop").setDescription("Alert on a drop of at least this percent (default 10)").setMinValue(1).setMaxValue(90))
          .addStringOption((o) =>
            o
              .setName("baseline")
              .setDescription("Measure the drop from which price seen (default: the last)")
              .addChoices({ name: "the last", value: "last" }, { name: "the first", value: "first" }, { name: "the highest", value: "peak" }),
          )
          .addStringOption((o) =>
            o.setName("near").setDescription("The words just before the price, if I cannot find it on my own").setMaxLength(MAX_NEAR),
          ),
      handle: (interaction) =>
        run(interaction, "registered", (d, user) => {
          const name = interaction.options.getString("name");
          const hours = interaction.options.getInteger("hours");
          const drop = interaction.options.getNumber("drop");
          const baseline = interaction.options.getString("baseline");
          const near = interaction.options.getString("near");
          return trackPrice(d, user, {
            url: interaction.options.getString("url", true),
            ...(name !== null ? { name } : {}),
            ...(hours !== null ? { hours } : {}),
            ...(drop !== null ? { drop } : {}),
            ...(baseline !== null ? { baseline: baseline as BaselineRule } : {}),
            ...(near !== null ? { near } : {}),
          });
        }),
    },
    {
      name: "research",
      build: (b: SlashCommandBuilder) =>
        b
          .setDescription("Ask me to look something up on the web and report back once, checked, by DM")
          .addStringOption((o) => o.setName("question").setDescription("What to look into").setRequired(true).setMaxLength(MAX_QUESTION_CHARS))
          .addStringOption((o) => o.setName("context").setDescription("Anything that helps: what you know already, what it is for").setMaxLength(MAX_CONTEXT_CHARS))
          .addStringOption((o) => o.setName("deadline").setDescription('When you need it by, e.g. "friday 5pm"; past it nothing is run').setMaxLength(MAX_WHEN))
          .addStringOption((o) => o.setName("at").setDescription('When to start, if not now, e.g. "tomorrow 9am"').setMaxLength(MAX_WHEN)),
      handle: (interaction) =>
        run(interaction, "registered", (d, user) => {
          const context = interaction.options.getString("context");
          const deadline = interaction.options.getString("deadline");
          const at = interaction.options.getString("at");
          return researchCommand(d, user, {
            question: interaction.options.getString("question", true),
            ...(context !== null ? { context } : {}),
            ...(deadline !== null ? { deadline } : {}),
            ...(at !== null ? { at } : {}),
          });
        }),
    },
    {
      name: "scout",
      build: (b: SlashCommandBuilder) =>
        b
          .setDescription("A scout that looks on the web every few days for things that fit someone's interests")
          .addSubcommand((s) =>
            lensOption(
              s
                .setName("new")
                .setDescription("Start a scout: it DMs you 5 to 10 new finds each run")
                .addStringOption((o) =>
                  o.setName("interests").setDescription("What they are into, separated by commas").setRequired(true).setMaxLength(MAX_INTERESTS_TEXT),
                ),
            )
              .addStringOption((o) => o.setName("for").setDescription("Who the ideas are for, if not you, e.g. Anne").setMaxLength(MAX_FOR_CHARS))
              .addStringOption((o) => o.setName("notes").setDescription("Anything else to weigh: budget, what they own already").setMaxLength(MAX_SCOUT_NOTES))
              .addIntegerOption((o) => o.setName("every").setDescription(`Days between runs (default ${DEFAULT_SCOUT_EVERY})`).setMinValue(1).setMaxValue(MAX_SCOUT_EVERY)),
          )
          .addSubcommand((s) =>
            lensOption(
              s
                .setName("edit")
                .setDescription("Change a scout's interests, lens, who it is for, notes or days between runs")
                .addStringOption((o) => o.setName("task").setDescription("The task id from /tasks, e.g. t3").setRequired(true).setMaxLength(MAX_TASK_ID))
                .addStringOption((o) => o.setName("interests").setDescription("The whole new list, separated by commas").setMaxLength(MAX_INTERESTS_TEXT)),
            )
              .addStringOption((o) => o.setName("for").setDescription("Who the ideas are for; - for you").setMaxLength(MAX_FOR_CHARS))
              .addStringOption((o) => o.setName("notes").setDescription("Anything else to weigh; - for none").setMaxLength(MAX_SCOUT_NOTES))
              .addIntegerOption((o) => o.setName("every").setDescription("Days between runs").setMinValue(1).setMaxValue(MAX_SCOUT_EVERY)),
          ),
      handle: (interaction) =>
        run(interaction, "registered", async (d, user) => {
          const sub = interaction.options.getSubcommand();
          const lens = interaction.options.getString("lens");
          const who = interaction.options.getString("for");
          const notes = interaction.options.getString("notes");
          const every = interaction.options.getInteger("every");
          const rest = {
            ...(lens !== null ? { lens } : {}),
            ...(who !== null ? { for: who } : {}),
            ...(notes !== null ? { notes } : {}),
            ...(every !== null ? { every } : {}),
          };
          if (sub === "new") return said(await createScout(d, user, { interests: interaction.options.getString("interests", true), ...rest }));
          const interests = interaction.options.getString("interests");
          return said(await editScout(d, user, interaction.options.getString("task", true), { ...(interests !== null ? { interests } : {}), ...rest }));
        }),
    },
    {
      name: "want",
      build: (b: SlashCommandBuilder) =>
        b
          .setDescription("Watch for something you want: I DM you new listings until you have it")
          .addStringOption((o) => o.setName("name").setDescription("What you want, e.g. Wingspan Oceania expansion").setRequired(true).setMaxLength(MAX_TITLE))
          .addStringOption((o) =>
            o
              .setName("source")
              .setDescription("Where to look")
              .setRequired(true)
              .addChoices(
                { name: "a listing page you paste", value: "page" },
                { name: "BoardGameGeek's marketplace", value: "bgg" },
                { name: "eBay (I give you a search to save on eBay)", value: "ebay" },
              ),
          )
          .addStringOption((o) =>
            o.setName("target").setDescription("The page's address, or the BGG game's address or id; for eBay, the words to search").setMaxLength(MAX_URL),
          )
          .addNumberOption((o) => o.setName("max").setDescription("Only listings at or under this price").setMinValue(0.01))
          .addStringOption((o) => o.setName("currency").setDescription("Only listings in this currency, e.g. USD").setMinLength(CURRENCY_LENGTH).setMaxLength(CURRENCY_LENGTH))
          .addIntegerOption((o) =>
            o
              .setName("hours")
              .setDescription(`Hours between looks (default ${DEFAULT_PAGE_HOURS} for a page, ${DEFAULT_BGG_HOURS} for BGG)`)
              .setMinValue(1)
              .setMaxValue(MAX_WANT_HOURS),
          )
          .addBooleanOption((o) => o.setName("judge").setDescription("Have the model check each new listing and its seller first (default: yes, when it can)")),
      handle: (interaction) =>
        run(interaction, "registered", (d, user) => {
          const target = interaction.options.getString("target");
          const judge = interaction.options.getBoolean("judge");
          const max = interaction.options.getNumber("max");
          const currency = interaction.options.getString("currency");
          const hours = interaction.options.getInteger("hours");
          return wantCommand(d, user, {
            name: interaction.options.getString("name", true),
            source: interaction.options.getString("source", true),
            ...(target !== null ? { target } : {}),
            ...(max !== null ? { max } : {}),
            ...(currency !== null ? { currency } : {}),
            ...(hours !== null ? { hours } : {}),
            ...(judge !== null ? { judge } : {}),
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
              .addStringOption((o) => o.setName("task").setDescription("The task id from /tasks, e.g. t3").setRequired(true).setMaxLength(MAX_TASK_ID)),
          )
          .addSubcommand((s) =>
            s
              .setName("snooze")
              .setDescription("Snooze the task's latest reminder (default: an hour)")
              .addStringOption((o) => o.setName("task").setDescription("The task id from /tasks, e.g. t3").setRequired(true).setMaxLength(MAX_TASK_ID))
              .addStringOption((o) => o.setName("until").setDescription('Until when: "in 2h", "tomorrow 9am"').setMaxLength(MAX_WHEN)),
          )
          .addSubcommand((s) =>
            s
              .setName("decide")
              .setDescription("Answer a renewal's latest ask, with what you paid if it changed")
              .addStringOption((o) => o.setName("task").setDescription("The task id from /tasks, e.g. t3").setRequired(true).setMaxLength(MAX_TASK_ID))
              .addStringOption((o) =>
                o
                  .setName("choice")
                  .setDescription("Keep it, cancel it, or it has renewed")
                  .setRequired(true)
                  .addChoices({ name: "keep", value: "keep" }, { name: "cancel", value: "cancel" }, { name: "renewed", value: "renewed" }),
              )
              .addNumberOption((o) => o.setName("amount").setDescription("What you paid this time, if not the usual").setMinValue(0)),
          )
          .addSubcommand((s) =>
            s
              .setName("history")
              .setDescription("Every run of the task, how it was answered, and its changes")
              .addStringOption((o) => o.setName("task").setDescription("The task id from /tasks, e.g. t3").setRequired(true).setMaxLength(MAX_TASK_ID)),
          )
          .addSubcommand((s) =>
            s
              .setName("resume")
              .setDescription("Resume a paused task; one paused for failed DMs goes on without them")
              .addStringOption((o) => o.setName("task").setDescription("The task id from /tasks, e.g. t3").setRequired(true).setMaxLength(MAX_TASK_ID)),
          )
          .addSubcommand((s) =>
            s
              .setName("share")
              .setDescription("Ask someone to receive this task's messages too")
              .addStringOption((o) => o.setName("task").setDescription("The task id from /tasks, e.g. t3").setRequired(true).setMaxLength(MAX_TASK_ID))
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
            case "decide": {
              const amount = interaction.options.getNumber("amount");
              return decideRenewal(d, user, {
                taskId,
                choice: interaction.options.getString("choice", true) as RenewalDecision,
                ...(amount !== null ? { amount } : {}),
              });
            }
            case "history":
              return historyWithSeries(d, user, taskId);
            case "resume":
              return said(await resumeTask(d, user, taskId));
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
