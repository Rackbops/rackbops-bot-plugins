// Manifest <-> code drift check: a built bundle's createPlugin() must contribute exactly the
// commands its package.json "botPlugin.commands" declares. The generator reads the declaration
// (into plugins.json) and the bot registers what the code returns, so a mismatch would register
// a command the manifest never announced (or fail to register one it did). Runs against every real
// plugins/* (none while the repo is empty) plus two in-repo fixtures that pin the check itself.
//
// Builds each bundle inside the test with process.execPath (never bare "bun" — the ENOENT that
// causes is Windows-specific and wouldn't reproduce on Linux CI), because the CI `test` job has no
// prior `bun run build` step.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface LoadedModule {
  createPlugin: (host: unknown) => { commands?: ReadonlyArray<{ name: string }> };
}

async function buildBundle(pluginDir: string): Promise<string> {
  const outfile = join(pluginDir, "dist", "plugin.js");
  const proc = Bun.spawn(
    [process.execPath, "build", join(pluginDir, "src", "index.ts"), "--target", "bun", "--external", "discord.js", "--outfile", outfile],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`build failed for ${pluginDir}: ${stderr}`);
  return outfile;
}

async function builtCommandNames(pluginDir: string): Promise<string[]> {
  const outfile = await buildBundle(pluginDir);
  // Cache-bust the import: two fixtures build to the same relative dist path across temp dirs, but
  // the absolute temp paths differ, so a fresh URL is enough; the query param guards a repeat run.
  const mod = (await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)) as LoadedModule;
  const plugin = mod.createPlugin({});
  return (plugin.commands ?? []).map((c) => c.name);
}

async function declaredCommands(pluginDir: string): Promise<string[]> {
  const pkg = JSON.parse(await Bun.file(join(pluginDir, "package.json")).text());
  return pkg.botPlugin?.commands ?? [];
}

// A minimal plugin whose src returns `commands` names — no discord.js import needed, since the
// check only reads command names. `build`/`handle` are stubs to satisfy the shape.
function pluginSource(names: string[]): string {
  const entries = names.map((n) => `{ name: ${JSON.stringify(n)}, build: (b) => b, handle: async () => {} }`).join(", ");
  return `export function createPlugin() { return { commands: [${entries}] }; }\n`;
}

async function withFixture<T>(codeCommands: string[], declared: string[], fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "drift-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "index.ts"), pluginSource(codeCommands));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "@rackbops/plugin-fixture", version: "0.0.1", botPlugin: { hostApiVersion: 1, commands: declared, env: [] } }),
    );
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("command drift", () => {
  test("passes when built commands match the declaration", async () => {
    await withFixture(["hello"], ["hello"], async (dir) => {
      expect(await builtCommandNames(dir)).toEqual(await declaredCommands(dir));
    });
  });

  test("detects a declared command the code never contributes", async () => {
    await withFixture(["hello"], ["hello", "bye"], async (dir) => {
      const built = await builtCommandNames(dir);
      const declared = await declaredCommands(dir);
      expect(built).not.toEqual(declared);
      expect(declared.filter((c) => !built.includes(c))).toEqual(["bye"]);
    });
  });

  // Real plugins, once any exist: every committed plugin's built commands must match its manifest.
  test("every committed plugin's built commands match its manifest", async () => {
    const pluginsDir = join(import.meta.dir, "..", "plugins");
    let names: string[] = [];
    try {
      names = (await readdir(pluginsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      names = [];
    }
    for (const name of names) {
      const dir = join(pluginsDir, name);
      expect(await builtCommandNames(dir)).toEqual(await declaredCommands(dir));
    }
    expect(names).toBeDefined();
  });
});
