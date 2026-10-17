import { describe, expect, test } from "bun:test";
import { CORE_COMMAND_NAMES, parseCoreCommandNames } from "./core-commands.js";

// Shaped like rackbops-discord-bot's src/commands.ts: rows at two spaces, `name` at four, options deeper.
const upstream = `import x from "y";
export const CORE_COMMANDS: readonly CoreCommand[] = [
  {
    name: "report",
    build: (builder) =>
      builder.addStringOption((o) =>
        o
          .setName("project")
          .addChoices({ name: "a", value: "a" }),
      ),
    handle: async () => {},
  },
  {
    name: "update",
    build: (builder) => builder,
    handle: async () => {},
  },
];

export const commandData = [];
`;

describe("parseCoreCommandNames", () => {
  test("reads each row's name and ignores names nested in options", () => {
    expect(parseCoreCommandNames(upstream)).toEqual(["report", "update"]);
  });

  test("throws when the array, its end or every name is missing", () => {
    expect(() => parseCoreCommandNames("const x = 1;")).toThrow(/CORE_COMMANDS not found/);
    expect(() => parseCoreCommandNames("export const CORE_COMMANDS = [")).toThrow(/end of CORE_COMMANDS/);
    expect(() => parseCoreCommandNames("export const CORE_COMMANDS = [\n  {\n    title: 1,\n  },\n];")).toThrow(/no command names/);
  });
});

test("the mirrored list is the three core commands the bot ships today", () => {
  expect([...CORE_COMMAND_NAMES].sort()).toEqual(["plugins", "report", "update"]);
});
