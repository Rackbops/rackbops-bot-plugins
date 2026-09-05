// Generates plugins.json (the Plugin Index) from every plugins/<name>/package.json "botPlugin"
// block + CHANGELOG.md. The published manifest is bot-agnostic and never hand-edited: publish.yml
// (after a real publish) and a manual `bun run generate-index` are its only writers. The entry
// shape is the vendored contract's PluginIndexEntry (packages/api/contract.d.ts) minus the fields
// this generator derives (package/version come from package.json, releases from the CHANGELOG).
//
// buildIndex/parseChangelogReleases are exported and pure over an injected plugins directory so the
// extraction and validation are unit-tested without a subprocess; the CLI below is a thin wrapper.
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PluginIndex, PluginIndexEntry, PluginEnvKey, PluginRelease } from "../packages/api/contract.js";

const ROOT = new URL("../", import.meta.url);
const DEFAULT_PLUGINS_DIR = new URL("plugins/", ROOT);
const OUTPUT_PATH = new URL("plugins.json", ROOT);

// The `PLUGINS=` token, the `[name]` log prefix, and the data/plugins/<name> directory on the bot's
// host all resolve by this name — see contract.d.ts's PluginIndexEntry.name.
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const RELEASE_HEADING_RE = /^## \[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/;
const MAX_RELEASES = 10;

// The subset of a plugin's package.json this generator reads. Typed loosely because it is untrusted
// on-disk JSON — every field is validated before it reaches a PluginIndexEntry.
interface PluginPackageJson {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  botPlugin?: {
    hostApiVersion?: unknown;
    intents?: unknown;
    commands?: unknown;
    env?: unknown;
  };
}

async function pluginDirNames(pluginsDir: URL): Promise<string[]> {
  try {
    const entries = await readdir(pluginsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Sorts by name into a new array. The Plugin Index must be deterministic — `readdir` order is not
 * portable (NTFS returns it sorted, ext4 does not), so sorting here is what keeps a plugins.json
 * generated on one machine byte-identical to CI's `--check` regeneration on another.
 */
export function sortByName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

function parseEnv(value: unknown, pluginName: string): PluginEnvKey[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${pluginName}: botPlugin.env must be an array`);
  return value.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`${pluginName}: botPlugin.env[${i}] must be an object`);
    }
    const e = raw as Record<string, unknown>;
    const key: PluginEnvKey = {
      key: requireString(e.key, `${pluginName}: botPlugin.env[${i}].key`),
      format: requireString(e.format, `${pluginName}: botPlugin.env[${i}].format`),
      description: requireString(e.description, `${pluginName}: botPlugin.env[${i}].description`),
    };
    if (e.required !== undefined) {
      if (typeof e.required !== "boolean") throw new Error(`${pluginName}: botPlugin.env[${i}].required must be a boolean`);
      key.required = e.required;
    }
    if (e.secret !== undefined) {
      if (typeof e.secret !== "boolean") throw new Error(`${pluginName}: botPlugin.env[${i}].secret must be a boolean`);
      key.secret = e.secret;
    }
    return key;
  });
}

function parseIntents(value: unknown, pluginName: string): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "number")) {
    throw new Error(`${pluginName}: botPlugin.intents must be an array of numbers`);
  }
  return value as number[];
}

/**
 * Keep-a-Changelog: "## [x.y.z] - YYYY-MM-DD" headings, in file order (the convention is
 * reverse-chronological, so newest first), capped at MAX_RELEASES. A heading with no date (e.g.
 * "## [Unreleased]") is skipped. Throws when `currentVersion` has no section — a published version
 * the update notification can't show release notes for is a release we refuse to index.
 */
export function parseChangelogReleases(
  changelog: string,
  pluginName: string,
  currentVersion: string,
): PluginRelease[] {
  const releases: PluginRelease[] = [];
  let current: { version: string; date: string; notes: string[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    releases.push({
      version: current.version,
      publishedAt: new Date(`${current.date}T00:00:00Z`).toISOString(),
      url: `https://github.com/Rackbops/rackbops-bot-plugins/releases/tag/${pluginName}-v${current.version}`,
      notes: current.notes.join("\n").trim(),
    });
    current = null;
  };
  for (const line of changelog.split(/\r?\n/)) {
    const heading = RELEASE_HEADING_RE.exec(line);
    if (heading) {
      flush();
      current = { version: heading[1], date: heading[2], notes: [] };
    } else if (current) {
      current.notes.push(line);
    }
  }
  flush();
  if (!releases.some((r) => r.version === currentVersion)) {
    throw new Error(
      `${pluginName}: CHANGELOG.md has no "## [${currentVersion}]" section for the current package version`,
    );
  }
  return releases.slice(0, MAX_RELEASES);
}

/**
 * Builds the Plugin Index from a plugins directory. Deterministic: plugins sorted by name, entry
 * keys in a fixed order, and `generatedAt` from the injected clock. Throws on the first invalid
 * plugin (bad name, missing hostApiVersion, missing CHANGELOG section, or a command name declared
 * by two plugins) rather than emitting a wrong manifest.
 */
export async function buildIndex(
  pluginsDir: URL = DEFAULT_PLUGINS_DIR,
  now: () => Date = () => new Date(),
): Promise<PluginIndex> {
  const names = await pluginDirNames(pluginsDir);
  const plugins: PluginIndexEntry[] = [];
  const commandOwner = new Map<string, string>();

  for (const name of names) {
    if (!NAME_RE.test(name)) {
      throw new Error(`${name}: plugin directory name must match ${NAME_RE.source}`);
    }
    const dir = new URL(`${name}/`, pluginsDir);
    const pkg = JSON.parse(await Bun.file(new URL("package.json", dir)).text()) as PluginPackageJson;
    const bp = pkg.botPlugin;
    if (typeof bp !== "object" || bp === null) {
      throw new Error(`${name}: package.json has no "botPlugin" block`);
    }
    if (typeof bp.hostApiVersion !== "number") {
      throw new Error(`${name}: botPlugin.hostApiVersion must be a number`);
    }

    const version = requireString(pkg.version, `${name}: package.json version`);
    const commands = requireStringArray(bp.commands, `${name}: botPlugin.commands`);
    for (const command of commands) {
      const owner = commandOwner.get(command);
      if (owner) throw new Error(`command "${command}" is declared by both "${owner}" and "${name}"`);
      commandOwner.set(command, name);
    }

    const changelog = await Bun.file(new URL("CHANGELOG.md", dir)).text();

    // Fixed key order so `--check`'s JSON comparison is stable across runs.
    plugins.push({
      name,
      package: requireString(pkg.name, `${name}: package.json name`),
      version,
      description: requireString(pkg.description, `${name}: package.json description`),
      hostApiVersion: bp.hostApiVersion,
      intents: parseIntents(bp.intents, name),
      commands,
      env: parseEnv(bp.env, name),
      releases: parseChangelogReleases(changelog, name, version),
    });
  }

  return { schemaVersion: 1, generatedAt: now().toISOString(), plugins: sortByName(plugins) };
}

/** Two indexes are equivalent for `--check` when they differ only in `generatedAt`. */
export function sameIgnoringGeneratedAt(a: PluginIndex, b: PluginIndex): boolean {
  const strip = ({ generatedAt: _drop, ...rest }: PluginIndex): Omit<PluginIndex, "generatedAt"> => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

async function main(): Promise<void> {
  const index = await buildIndex();
  if (process.argv.includes("--check")) {
    const existing = JSON.parse(await Bun.file(OUTPUT_PATH).text()) as PluginIndex;
    if (!sameIgnoringGeneratedAt(existing, index)) {
      console.error("plugins.json is out of date. Run `bun run generate-index` and commit the result.");
      process.exit(1);
    }
    console.log("plugins.json is up to date.");
  } else {
    await Bun.write(OUTPUT_PATH, JSON.stringify(index, null, 2) + "\n");
    console.log(`Wrote ${fileURLToPath(OUTPUT_PATH)}`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
