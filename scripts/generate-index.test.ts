import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildIndex, parseChangelogReleases, sameIgnoringGeneratedAt, sortByName } from "./generate-index.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PLUGINS_JSON = new URL("../plugins.json", import.meta.url);

interface PluginSpec {
  pkg?: unknown;
  changelog?: string;
}

// Lays out a temp plugins/ tree, runs `fn` against its file:// URL, and cleans up. buildIndex is
// pure over the directory it's handed, so the extraction and every validation path is exercised
// here without a subprocess or touching the repo's own plugins/.
async function withPlugins<T>(
  spec: Record<string, PluginSpec>,
  fn: (pluginsDir: URL) => Promise<T>,
): Promise<T> {
  const tmp = await mkdtemp(join(tmpdir(), "genidx-"));
  try {
    for (const [name, files] of Object.entries(spec)) {
      const dir = join(tmp, "plugins", name);
      await mkdir(dir, { recursive: true });
      if (files.pkg !== undefined) {
        await writeFile(join(dir, "package.json"), JSON.stringify(files.pkg, null, 2));
      }
      if (files.changelog !== undefined) await writeFile(join(dir, "CHANGELOG.md"), files.changelog);
    }
    const pluginsDir = new URL(pathToFileURL(join(tmp, "plugins")).href + "/");
    return await fn(pluginsDir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const pkg = (name: string, over: Record<string, unknown> = {}): unknown => ({
  name: `@rackbops/plugin-${name}`,
  version: "1.0.0",
  description: `The ${name} plugin`,
  botPlugin: { hostApiVersion: 1, commands: [name], env: [], ...over },
});

const changelog = (version = "1.0.0"): string => `# Changelog\n\n## [${version}] - 2026-01-02\n### Added\n- Initial release\n`;

const fixedNow = (): Date => new Date("2026-09-04T00:00:00.000Z");

describe("buildIndex", () => {
  test("extracts entries and sorts them by name", async () => {
    const index = await withPlugins(
      {
        beta: { pkg: pkg("beta", { intents: [1], env: [{ key: "BETA_URL", format: "^https?://.+$", description: "endpoint" }] }), changelog: changelog() },
        alpha: { pkg: pkg("alpha"), changelog: changelog() },
      },
      (dir) => buildIndex(dir, fixedNow),
    );

    expect(index.schemaVersion).toBe(1);
    expect(index.generatedAt).toBe("2026-09-04T00:00:00.000Z");
    // Sorted by name — mutation: dropping the sort would put beta first (dir order).
    expect(index.plugins.map((p) => p.name)).toEqual(["alpha", "beta"]);

    const beta = index.plugins[1];
    expect(beta).toMatchObject({
      name: "beta",
      package: "@rackbops/plugin-beta",
      version: "1.0.0",
      description: "The beta plugin",
      hostApiVersion: 1,
      intents: [1],
      commands: ["beta"],
      env: [{ key: "BETA_URL", format: "^https?://.+$", description: "endpoint" }],
    });
    expect(index.plugins[0].intents).toEqual([]); // defaulted when absent
  });

  test("rejects a directory name that isn't a valid plugin name", async () => {
    await expect(
      withPlugins({ Bad_Name: { pkg: pkg("bad"), changelog: changelog() } }, (dir) => buildIndex(dir, fixedNow)),
    ).rejects.toThrow(/must match/);
  });

  test("rejects a missing hostApiVersion", async () => {
    await expect(
      withPlugins(
        { alpha: { pkg: { name: "@rackbops/plugin-alpha", version: "1.0.0", description: "d", botPlugin: { commands: ["alpha"], env: [] } }, changelog: changelog() } },
        (dir) => buildIndex(dir, fixedNow),
      ),
    ).rejects.toThrow(/hostApiVersion must be a number/);
  });

  test("rejects a command declared by two plugins", async () => {
    await expect(
      withPlugins(
        {
          alpha: { pkg: pkg("alpha", { commands: ["shared"] }), changelog: changelog() },
          beta: { pkg: pkg("beta", { commands: ["shared"] }), changelog: changelog() },
        },
        (dir) => buildIndex(dir, fixedNow),
      ),
    ).rejects.toThrow(/command "shared" is declared by both "alpha" and "beta"/);
  });

  test("rejects a current version with no CHANGELOG section", async () => {
    await expect(
      withPlugins({ alpha: { pkg: pkg("alpha", {}), changelog: changelog("0.9.0") } }, (dir) => buildIndex(dir, fixedNow)),
    ).rejects.toThrow(/no "## \[1\.0\.0\]" section/);
  });

  test("an empty plugins/ yields the empty envelope", async () => {
    const index = await withPlugins({}, (dir) => buildIndex(dir, fixedNow));
    expect(index).toEqual({ schemaVersion: 1, generatedAt: "2026-09-04T00:00:00.000Z", plugins: [] });
  });
});

describe("parseChangelogReleases", () => {
  const body = `# Changelog

## [1.2.0] - 2026-03-01
### Added
- Newest thing

## [1.1.0] - 2026-02-01
### Fixed
- A bug

## [Unreleased]
- ignored, no date
`;

  test("returns releases newest-first with url, notes and ISO publishedAt", () => {
    const releases = parseChangelogReleases(body, "alpha", "1.2.0");
    expect(releases.map((r) => r.version)).toEqual(["1.2.0", "1.1.0"]); // newest first, Unreleased skipped
    expect(releases[0]).toEqual({
      version: "1.2.0",
      publishedAt: "2026-03-01T00:00:00.000Z",
      url: "https://github.com/Rackbops/rackbops-bot-plugins/releases/tag/alpha-v1.2.0",
      notes: "### Added\n- Newest thing",
    });
  });

  test("caps at 10, keeping the newest", () => {
    const many = ["1.11.0", "1.10.0", "1.9.0", "1.8.0", "1.7.0", "1.6.0", "1.5.0", "1.4.0", "1.3.0", "1.2.0", "1.1.0", "1.0.0"];
    const text = many.map((v, i) => `## [${v}] - 2026-01-${String(i + 1).padStart(2, "0")}\n- note ${v}`).join("\n\n");
    const releases = parseChangelogReleases(text, "alpha", "1.11.0");
    expect(releases).toHaveLength(10);
    expect(releases[0].version).toBe("1.11.0");
    expect(releases.at(-1)?.version).toBe("1.2.0");
  });

  test("throws when the current version has no section", () => {
    expect(() => parseChangelogReleases(body, "alpha", "9.9.9")).toThrow(/no "## \[9\.9\.9\]" section/);
  });

  test("rejects an impossible calendar date instead of rolling it over", () => {
    expect(() => parseChangelogReleases("## [1.0.0] - 2026-02-30\n- x", "alpha", "1.0.0")).toThrow(/invalid date "2026-02-30"/);
    expect(() => parseChangelogReleases("## [1.0.0] - 2026-13-45\n- x", "alpha", "1.0.0")).toThrow(/invalid date "2026-13-45"/);
  });

  test("parses a heading with a trailing [YANKED] marker", () => {
    const releases = parseChangelogReleases("## [1.0.0] - 2026-01-02 [YANKED]\n- pulled", "alpha", "1.0.0");
    expect(releases.map((r) => r.version)).toEqual(["1.0.0"]);
    expect(releases[0].publishedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  test("fails when the current version is sliced past the newest 10", () => {
    const versions = Array.from({ length: 11 }, (_, i) => `1.${11 - i}.0`); // newest first: 1.11.0 .. 1.1.0
    const text = versions.map((v, i) => `## [${v}] - 2026-01-${String(11 - i).padStart(2, "0")}\n- note`).join("\n\n");
    // current = the oldest (present in the file, but outside the newest 10)
    expect(() => parseChangelogReleases(text, "alpha", "1.1.0")).toThrow(/not among the 10 most recent/);
  });
});

describe("sortByName", () => {
  test("orders by name and does not mutate the input", () => {
    const input = [{ name: "beta" }, { name: "alpha" }, { name: "gamma" }];
    expect(sortByName(input).map((x) => x.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(input.map((x) => x.name)).toEqual(["beta", "alpha", "gamma"]); // input untouched
  });
});

describe("sameIgnoringGeneratedAt", () => {
  const base = { schemaVersion: 1 as const, generatedAt: "2026-01-01T00:00:00.000Z", plugins: [] };
  test("true when only generatedAt differs", () => {
    expect(sameIgnoringGeneratedAt(base, { ...base, generatedAt: "2026-09-09T00:00:00.000Z" })).toBe(true);
  });
  test("false when the plugin set differs", () => {
    expect(
      sameIgnoringGeneratedAt(base, {
        ...base,
        plugins: [{ name: "x", package: "@rackbops/plugin-x", version: "1.0.0", description: "d", hostApiVersion: 1, intents: [], commands: ["x"], env: [], releases: [] }],
      }),
    ).toBe(false);
  });
});

// The CLI's --check path against the repo's own committed plugins.json (empty envelope while no
// plugins are committed). process.execPath, never bare "bun": Bun.spawn's ENOENT on a bare command
// name is Windows-specific and won't reproduce on Linux CI.
describe("generate-index CLI --check", () => {
  async function run(args: string[]): Promise<{ exitCode: number; stdout: string }> {
    const proc = Bun.spawn([process.execPath, "run", "scripts/generate-index.ts", ...args], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { exitCode, stdout };
  }

  test("passes against the committed plugins.json", async () => {
    const { exitCode, stdout } = await run(["--check"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("up to date");
  });

  test("committed plugins.json has the empty-envelope shape", async () => {
    const written = JSON.parse(await Bun.file(PLUGINS_JSON).text());
    expect(written.schemaVersion).toBe(1);
    expect(written.plugins).toEqual([]);
    expect(typeof written.generatedAt).toBe("string");
  });
});
