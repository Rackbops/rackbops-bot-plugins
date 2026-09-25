import { describe, expect, test } from "bun:test";
import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { agentCommand } from "./commands.js";
import type { RegistryStore } from "./registry.js";

const USER = "111111111111111111";

function fakeInteraction(subcommand: string, globalName: string | null = "Ash", username = "ash123") {
  const replies: { content?: string; flags?: unknown }[] = [];
  const interaction = {
    user: { id: USER, globalName, username },
    options: { getSubcommand: () => subcommand },
    reply: async (opts: { content?: string; flags?: unknown }) => {
      replies.push(opts);
    },
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, replies };
}

/** A RegistryStore whose every method throws unless overridden -- forces each test to state exactly
 *  which calls it expects, so an unexpected extra call fails loudly rather than silently no-opting. */
function fakeStore(overrides: Partial<RegistryStore> = {}): { store: RegistryStore; calls: string[] } {
  const calls: string[] = [];
  const unexpected = (method: string) => () => {
    throw new Error(`unexpected call to store.${method}`);
  };
  const store: RegistryStore = {
    register: overrides.register ?? unexpected("register"),
    pair: overrides.pair ?? unexpected("pair"),
    unregister: overrides.unregister ?? unexpected("unregister"),
    redeem: overrides.redeem ?? unexpected("redeem"),
    generationOf: overrides.generationOf ?? unexpected("generationOf"),
  };
  for (const method of ["register", "pair", "unregister", "redeem", "generationOf"] as const) {
    const original = store[method] as (...args: unknown[]) => unknown;
    (store as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      calls.push(method);
      return original(...args);
    };
  }
  return { store, calls };
}

describe("agentCommand: build", () => {
  test("builds exactly three subcommands, register/pair/unregister, with no top-level options", () => {
    const { store } = fakeStore();
    const built = agentCommand(store).build(new SlashCommandBuilder().setName("agent")).toJSON();
    expect(built.options?.map((o) => o.name)).toEqual(["register", "pair", "unregister"]);
    // Every option under the command is itself a subcommand (type 1), never a plain string/etc option
    // sitting alongside them -- the command takes no arguments of its own.
    for (const option of built.options ?? []) expect(option.type).toBe(1);
  });
});

describe("agentCommand: register", () => {
  test("a fresh registration replies with the success message, ephemeral, using globalName", async () => {
    const { store, calls } = fakeStore({ register: async (userId, displayName) => (expect(userId).toBe(USER), expect(displayName).toBe("Ash"), { changed: true, generation: "gen-1" }) });
    const { interaction, replies } = fakeInteraction("register");
    await agentCommand(store).handle(interaction);
    expect(calls).toEqual(["register"]);
    expect(replies).toEqual([{ content: "Registered. Run `/agent pair` to generate a pairing code for your agent.", flags: MessageFlags.Ephemeral }]);
  });

  test("falls back to username when globalName is null", async () => {
    const { store } = fakeStore({ register: async (_userId, displayName) => (expect(displayName).toBe("ash123"), { changed: true, generation: "gen-1" }) });
    const { interaction } = fakeInteraction("register", null, "ash123");
    await agentCommand(store).handle(interaction);
  });

  test("already registered replies with the literal no-op message", async () => {
    const { store } = fakeStore({ register: async () => ({ changed: false, generation: "gen-1" }) });
    const { interaction, replies } = fakeInteraction("register");
    await agentCommand(store).handle(interaction);
    expect(replies).toEqual([{ content: "Already registered — nothing changed.", flags: MessageFlags.Ephemeral }]);
  });
});

describe("agentCommand: pair", () => {
  test("issues a code and shows it once, with the literal warning", async () => {
    const { store } = fakeStore({ pair: async () => ({ ok: true, code: "ABCDEFGHJKMNPQRSTVWXYZ2345" }) });
    const { interaction, replies } = fakeInteraction("pair");
    await agentCommand(store).handle(interaction);
    expect(replies).toEqual([
      {
        content:
          "Your pairing code: **ABCDEFGHJKMNPQRSTVWXYZ2345**\n\n" +
          "Valid 10 minutes, single use. Enter it only in `discord-mcp pair` or your connector's authorization page — never paste it anywhere else.",
        flags: MessageFlags.Ephemeral,
      },
    ]);
  });

  test("refuses with the literal message when not registered", async () => {
    const { store } = fakeStore({ pair: async () => ({ ok: false }) });
    const { interaction, replies } = fakeInteraction("pair");
    await agentCommand(store).handle(interaction);
    expect(replies).toEqual([{ content: "Run `register` first.", flags: MessageFlags.Ephemeral }]);
  });
});

describe("agentCommand: unregister", () => {
  test("replies with the literal revocation message when it changed something", async () => {
    const { store } = fakeStore({ unregister: async () => ({ changed: true }) });
    const { interaction, replies } = fakeInteraction("unregister");
    await agentCommand(store).handle(interaction);
    expect(replies).toEqual([{ content: "Unregistered: your agents' tokens and DMs are revoked.", flags: MessageFlags.Ephemeral }]);
  });

  test("replies with the literal not-registered message otherwise", async () => {
    const { store } = fakeStore({ unregister: async () => ({ changed: false }) });
    const { interaction, replies } = fakeInteraction("unregister");
    await agentCommand(store).handle(interaction);
    expect(replies).toEqual([{ content: "You weren't registered.", flags: MessageFlags.Ephemeral }]);
  });
});

describe("agentCommand: every reply is ephemeral, and only the addressed subcommand's store method is called", () => {
  test("register never touches pair/unregister/redeem/generationOf", async () => {
    const { store, calls } = fakeStore({ register: async () => ({ changed: true, generation: "g" }) });
    const { interaction } = fakeInteraction("register");
    await agentCommand(store).handle(interaction);
    expect(calls).toEqual(["register"]);
  });

  test("pair never touches register/unregister/redeem/generationOf", async () => {
    const { store, calls } = fakeStore({ pair: async () => ({ ok: true, code: "X".repeat(26) }) });
    const { interaction } = fakeInteraction("pair");
    await agentCommand(store).handle(interaction);
    expect(calls).toEqual(["pair"]);
  });

  test("unregister never touches register/pair/redeem/generationOf", async () => {
    const { store, calls } = fakeStore({ unregister: async () => ({ changed: true }) });
    const { interaction } = fakeInteraction("unregister");
    await agentCommand(store).handle(interaction);
    expect(calls).toEqual(["unregister"]);
  });
});
