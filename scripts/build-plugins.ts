// Builds each plugins/*/src/index.ts into plugins/*/dist/plugin.js, plus a plugins/*/dist/admin.js
// when the plugin ships a browser admin bundle (src/admin/index.ts — its admin-panel tab; see the
// admin-UI contract epic, rackbops-discord-bot#123). Shells out to the exact `bun build` invocations
// plugin authoring documents. `plannedBuilds` is pure so the "which builds for this plugin" decision
// is unit-tested without spawning a build; the CLI runs only under `import.meta.main`.
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

export interface BuildSpec {
  entry: string;
  outfile: string;
  target: "bun" | "browser";
  externals: string[];
}

/**
 * The ordered `bun build` invocations for one plugin: always its server bundle (`dist/plugin.js`, bun
 * target, discord.js external), plus its admin bundle (`dist/admin.js`, browser target, NO discord.js
 * external — the admin UI uses the admin contract, never the gateway) WHEN it ships one. Pure, with
 * `hasAdmin` injected, so the decision is unit-tested without spawning a build.
 */
export function plannedBuilds(name: string, hasAdmin: boolean): BuildSpec[] {
  const builds: BuildSpec[] = [
    { entry: `plugins/${name}/src/index.ts`, outfile: `plugins/${name}/dist/plugin.js`, target: "bun", externals: ["discord.js"] },
  ];
  if (hasAdmin) {
    builds.push({ entry: `plugins/${name}/src/admin/index.ts`, outfile: `plugins/${name}/dist/admin.js`, target: "browser", externals: [] });
  }
  return builds;
}

/**
 * A `bun build` that exits 0 but writes nothing (or an empty file) is the other half of the #28
 * jsDelivr-404 failure mode -- generate-index's guards catch a *missing* admin source, but a build
 * that silently produces nothing would still emit a working-looking `adminUrl`. Only the browser
 * (admin) build is checked: it's the one the panel actually fetches by URL and has no other
 * consumer to notice an empty file; the bun-target server bundle fails loudly at `import` time
 * either way. Pure over an injected root so it's unit-tested against a real temp file without
 * spawning a build.
 */
export async function assertNonEmptyBuildOutput(outfile: string, root: URL): Promise<void> {
  const file = Bun.file(new URL(outfile, root));
  if (!(await file.exists()) || file.size === 0) {
    throw new Error(`${outfile}: admin build produced no output (or an empty file) -- refusing to ship a broken bundle`);
  }
}

// process.execPath, not the bare string "bun" -- see generate-index.test.ts for why. Exits the
// process on a non-zero build (fail-fast), so a broken plugin never ships a stale dist.
async function runBuild(spec: BuildSpec): Promise<void> {
  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      spec.entry,
      "--target",
      spec.target,
      ...spec.externals.flatMap((e) => ["--external", e]),
      "--outfile",
      spec.outfile,
    ],
    { cwd: ROOT_PATH, stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) process.exit(exitCode);
  if (spec.target === "browser") await assertNonEmptyBuildOutput(spec.outfile, ROOT);
}

/** The build specs for one plugin, reading whether it ships an admin bundle from `root`. Separated
 *  from `main`/`runBuild` so the on-disk `src/admin/index.ts` detection is unit-tested against a real
 *  temp tree without spawning a build. */
export async function pluginBuildSpecs(name: string, root: URL): Promise<BuildSpec[]> {
  const hasAdmin = await Bun.file(new URL(`plugins/${name}/src/admin/index.ts`, root)).exists();
  return plannedBuilds(name, hasAdmin);
}

async function main(): Promise<void> {
  const names = await pluginNames();
  if (names.length === 0) {
    console.log("No plugins to build.");
    return;
  }
  for (const name of names) {
    for (const spec of await pluginBuildSpecs(name, ROOT)) await runBuild(spec);
    console.log(`Built ${name}`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
