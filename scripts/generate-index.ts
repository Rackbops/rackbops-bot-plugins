// Generates plugins.json from plugins/*/package.json's "botPlugin" block + CHANGELOG.md.
// Deliberately minimal today: plugins/ is empty, so this only needs to produce the correct
// empty envelope and support --check. The full per-plugin extraction (CHANGELOG parsing,
// name/hostApiVersion validation, duplicate-command detection) is a separate, already-scoped
// follow-up issue's job — this refuses to run rather than half-implement that.
import { readdir } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const PLUGINS_DIR = new URL("plugins/", ROOT);
const OUTPUT_PATH = new URL("plugins.json", ROOT);

async function pluginNames(): Promise<string[]> {
  try {
    const entries = await readdir(PLUGINS_DIR, { withFileTypes: true });
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
if (names.length > 0) {
  throw new Error(
    `generate-index.ts is still the minimal empty-plugins version -- ${names.length} plugin(s) ` +
      `found (${names.join(", ")}). Build out the real per-plugin extraction before adding plugins.`,
  );
}

const index = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  plugins: [] as unknown[],
};

const checkMode = process.argv.includes("--check");

if (checkMode) {
  const existing = JSON.parse(await Bun.file(OUTPUT_PATH).text());
  const { generatedAt: _existingGeneratedAt, ...existingRest } = existing;
  const { generatedAt: _newGeneratedAt, ...newRest } = index;
  if (JSON.stringify(existingRest) !== JSON.stringify(newRest)) {
    console.error("plugins.json is out of date. Run `bun run generate-index` and commit the result.");
    process.exit(1);
  }
  console.log("plugins.json is up to date.");
} else {
  await Bun.write(OUTPUT_PATH, JSON.stringify(index, null, 2) + "\n");
  console.log(`Wrote ${OUTPUT_PATH.pathname}`);
}
