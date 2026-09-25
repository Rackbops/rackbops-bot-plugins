// The `agent` slash command: register/pair/unregister (Tooling#743 decision 1). Every handler does
// local storage work only -- no network call on the reply path -- so every reply lands well inside
// Discord's 3s window, and every reply is ephemeral (decision 1). Reply texts for the no-op/refusal
// paths are the plan's own literal wording; the two success messages (register, pair) are this
// module's own composition where the plan left them open, kept in the same tone.
import { MessageFlags, type ChatInputCommandInteraction, type SlashCommandBuilder } from "discord.js";
import type { PluginCommand } from "../../../packages/api/contract.js";
import type { RegistryStore } from "./registry.js";

async function replyEphemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** Decision 2: `displayName` is `globalName ?? username`, captured at register AND pair time. */
function displayNameOf(interaction: ChatInputCommandInteraction): string {
  return interaction.user.globalName ?? interaction.user.username;
}

async function handleRegister(interaction: ChatInputCommandInteraction, store: RegistryStore): Promise<void> {
  const outcome = await store.register(interaction.user.id, displayNameOf(interaction), () => new Date());
  if (!outcome.changed) {
    await replyEphemeral(interaction, "Already registered — nothing changed.");
    return;
  }
  await replyEphemeral(interaction, "Registered. Run `/agent pair` to generate a pairing code for your agent.");
}

async function handlePair(interaction: ChatInputCommandInteraction, store: RegistryStore): Promise<void> {
  const outcome = await store.pair(interaction.user.id, displayNameOf(interaction), () => new Date());
  if (!outcome.ok) {
    await replyEphemeral(interaction, "Run `register` first.");
    return;
  }
  await replyEphemeral(
    interaction,
    `Your pairing code: **${outcome.code}**\n\n` +
      "Valid 10 minutes, single use. Enter it only in `discord-mcp pair` or your connector's authorization page — never paste it anywhere else.",
  );
}

async function handleUnregister(interaction: ChatInputCommandInteraction, store: RegistryStore): Promise<void> {
  const { changed } = await store.unregister(interaction.user.id);
  await replyEphemeral(interaction, changed ? "Unregistered: your agents' tokens and DMs are revoked." : "You weren't registered.");
}

/** `store` is built once in index.ts (over host.dataDir/host.storage) and closed over here, the
 *  same shape as http.ts's deps -- this command never constructs its own store. */
export function agentCommand(store: RegistryStore): PluginCommand {
  return {
    name: "agent",
    build: (builder: SlashCommandBuilder) =>
      builder
        .setDescription("Manage your Discord MCP agent access")
        .addSubcommand((s) => s.setName("register").setDescription("Register this Discord account for agent access"))
        .addSubcommand((s) => s.setName("pair").setDescription("Generate a one-time pairing code for your agent"))
        .addSubcommand((s) => s.setName("unregister").setDescription("Revoke your agent access")),
    async handle(interaction) {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === "register") return handleRegister(interaction, store);
      if (subcommand === "pair") return handlePair(interaction, store);
      if (subcommand === "unregister") return handleUnregister(interaction, store);
    },
  };
}
