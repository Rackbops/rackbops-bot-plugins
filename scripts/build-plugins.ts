// Builds each plugins/*/src/index.ts into plugins/*/dist/plugin.js. No-op today (plugins/
// is empty). Shells out to the exact `bun build` invocation plugin authoring documents, so
// this script needs no changes once a real plugin exists.
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);

async function pluginNames(): Promise<string[]> {
  try {
    const entries = await readdir(new URL("plugins/", ROOT), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

const names = await pluginNames();
if (names.length === 0) {
  console.log("No plugins to build.");
  process.exit(0);
}

for (const name of names) {
  // process.execPath, not the bare string "bun" -- see generate-index.test.ts for why.
  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      `plugins/${name}/src/index.ts`,
      "--target",
      "bun",
      "--external",
      "discord.js",
      "--outfile",
      `plugins/${name}/dist/plugin.js`,
    ],
    { cwd: ROOT_PATH, stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) process.exit(exitCode);
  console.log(`Built ${name}`);
}
