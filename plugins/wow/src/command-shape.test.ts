import { describe, expect, test } from "bun:test";
import { SlashCommandBuilder } from "discord.js";
import { createPlugin } from "./index.js";
import { makeFakeHost } from "./test-host.js";

// The plugin's /dmf /reset /status /transmog must build to the SAME command JSON the bot registered
// baked-in. The fixture transcribes the bot's own commandData (src/commands.ts:66-88, empty
// COMMAND_PREFIX; status's baseline no-WOW_REALM description "Realm status"). The host hands each
// command's build() an already-namespaced builder; here we stand in for that with a bare-named
// SlashCommandBuilder, matching the fixture's unprefixed names.
describe("command shape", () => {
  test("the four WoW commands build to the same JSON as the bot's baked-in commands", async () => {
    const fixture = await Bun.file(new URL("./fixtures/command-body.main.json", import.meta.url)).json();
    const plugin = createPlugin(makeFakeHost()); // empty env → no WOW_REALM → "Realm status"
    const built = (plugin.commands ?? []).map((c) => c.build(new SlashCommandBuilder().setName(c.name)).toJSON());
    expect(built).toEqual(fixture);
  });

  test("status carries the configured realm in its description when WOW_REALM is set", () => {
    const plugin = createPlugin(makeFakeHost({ env: { WOW_REALM: "argent-dawn" } }));
    const status = (plugin.commands ?? []).find((c) => c.name === "status")!;
    const body = status.build(new SlashCommandBuilder().setName("status")).toJSON();
    expect(body.description).toBe("Realm status for argent-dawn");
  });

  test("createPlugin throws on an invalid WOW_REGION (host then skips the plugin)", () => {
    expect(() => createPlugin(makeFakeHost({ env: { WOW_REGION: "xx" } }))).toThrow(
      `WOW_REGION must be "us" or "eu", got "xx"`,
    );
  });

  test("createPlugin throws on an invalid DMF_TIMEZONE", () => {
    expect(() => createPlugin(makeFakeHost({ env: { DMF_TIMEZONE: "Invalid/Zone" } }))).toThrow(
      /DMF_TIMEZONE is not a valid IANA time zone/,
    );
  });

  test("createPlugin accepts an unset env and a fully-set env", () => {
    expect(() => createPlugin(makeFakeHost({ env: {} }))).not.toThrow();
    expect(() =>
      createPlugin(
        makeFakeHost({
          env: {
            WOW_REGION: "eu",
            WOW_REALM: "hyjal",
            DMF_TIMEZONE: "Europe/Paris",
            BLIZZARD_CLIENT_ID: "id",
            BLIZZARD_CLIENT_SECRET: "s",
          },
        }),
      ),
    ).not.toThrow();
  });

  test("exposes the four command names and the three ticks, in order", () => {
    const plugin = createPlugin(makeFakeHost());
    expect((plugin.commands ?? []).map((c) => c.name)).toEqual(["dmf", "reset", "status", "transmog"]);
    expect((plugin.ticks ?? []).map((t) => t.name)).toEqual(["dmf", "weeklyReset", "realm"]);
  });
});
