import { describe, expect, test } from "bun:test";
import { SlashCommandBuilder } from "discord.js";
import { createPlugin } from "./index.js";
import { makeFakeHost } from "./test-host.js";

// The plugin's /link and /unlink must build to the SAME command JSON the bot registered baked-in.
// The fixture is the bot's own `commandData` link/unlink entries, captured from
// rackbops-discord-bot @ b5ea76c (src/commands.ts, default empty COMMAND_PREFIX) — see bp#2. The
// host hands each command's build() an already-namespaced builder; here we stand in for that with a
// bare-named SlashCommandBuilder, matching the fixture's unprefixed names.
describe("command shape", () => {
  test("link/unlink build to the same JSON as the bot's baked-in commands", async () => {
    const fixture = await Bun.file(new URL("./fixtures/command-body.main.json", import.meta.url)).json();
    const plugin = createPlugin(makeFakeHost());
    const built = (plugin.commands ?? []).map((c) => c.build(new SlashCommandBuilder().setName(c.name)).toJSON());
    expect(built).toEqual(fixture);
  });

  test("createPlugin throws on an invalid WARBANDEER_INGEST_PORT (host then skips the plugin)", () => {
    expect(() => createPlugin(makeFakeHost({ env: { WARBANDEER_INGEST_PORT: "0" } }))).toThrow(
      /WARBANDEER_INGEST_PORT must be a valid port number, got "0"/,
    );
    expect(() => createPlugin(makeFakeHost({ env: { WARBANDEER_INGEST_PORT: "notaport" } }))).toThrow(
      /must be a valid port number/,
    );
    expect(() => createPlugin(makeFakeHost({ env: { WARBANDEER_INGEST_PORT: "70000" } }))).toThrow(
      /must be a valid port number/,
    );
  });

  test("createPlugin accepts a valid port and an unset port", () => {
    expect(() => createPlugin(makeFakeHost({ env: { WARBANDEER_INGEST_PORT: "8787" } }))).not.toThrow();
    expect(() => createPlugin(makeFakeHost({ env: {} }))).not.toThrow();
  });
});
