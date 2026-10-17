// The bot's core command names, mirrored here so `generate-index` can refuse a plugin the bot would skip.
// The bot reserves each core command's bare name twice over: as a plugin NAME (its `<name>:` interaction
// prefix would collide, rackbops-discord-bot src/plugins/registry.ts) and as a plugin COMMAND (the plugin
// is skipped on a collision). A mirror can drift, so scripts/check-core-commands.ts compares it with the
// bot's `CORE_COMMANDS` table on `main` (Epic #269 decision 3, #136).
export const CORE_COMMAND_NAMES: readonly string[] = ["report", "update", "plugins"];

/**
 * The bare names of the rows in the `CORE_COMMANDS` array of the bot's src/commands.ts. Each row opens with
 * `  {` and its `name: "..."` on the next line at four spaces; options nested inside a row sit deeper, so
 * only that indentation counts. Throws when the array or any name is not found, so a reshaped upstream file
 * fails loudly instead of reading as an empty list.
 */
export function parseCoreCommandNames(source: string): string[] {
  const start = source.indexOf("export const CORE_COMMANDS");
  if (start === -1) throw new Error("CORE_COMMANDS not found in the bot's src/commands.ts");
  const end = source.indexOf("\n];", start);
  if (end === -1) throw new Error("the end of CORE_COMMANDS not found in the bot's src/commands.ts");
  const names = [...source.slice(start, end).matchAll(/^ {2}\{\n {4}name: "([^"]+)",$/gm)].map((m) => m[1] as string);
  if (names.length === 0) throw new Error("no command names found in CORE_COMMANDS");
  return names;
}
