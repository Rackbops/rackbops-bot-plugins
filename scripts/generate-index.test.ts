import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildIndex, filesAllowlistCoversAdminBundle, parseChangelogReleases, sameIgnoringGeneratedAt, sortByName } from "./generate-index.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PLUGINS_JSON = new URL("../plugins.json", import.meta.url);

interface PluginSpec {
  pkg?: unknown;
  changelog?: string;
  /** Create a `src/admin/index.ts` so a plugin that declares `adminApiVersion` has a real bundle source. */
  adminEntry?: boolean;
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
      if (files.adminEntry) {
        await mkdir(join(dir, "src", "admin"), { recursive: true });
        await writeFile(join(dir, "src", "admin", "index.ts"), "export const adminApiVersion = 1;\nexport function mountAdmin() { return () => {}; }\n");
      }
    }
    const pluginsDir = new URL(pathToFileURL(join(tmp, "plugins")).href + "/");
    return await fn(pluginsDir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const pkg = (name: string, over: Record<string, unknown> = {}, files?: string[]): unknown => ({
  name: `@rackbops/plugin-${name}`,
  version: "1.0.0",
  description: `The ${name} plugin`,
  ...(files !== undefined ? { files } : {}),
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

  test("emits adminApiVersion + a DERIVED adminUrl only when a plugin advertises admin support", async () => {
    const index = await withPlugins(
      {
        withadmin: { pkg: pkg("withadmin", { adminApiVersion: 1 }), changelog: changelog(), adminEntry: true },
        noadmin: { pkg: pkg("noadmin"), changelog: changelog() },
      },
      (dir) => buildIndex(dir, fixedNow),
    );
    const withAdmin = index.plugins.find((p) => p.name === "withadmin")!;
    const noAdmin = index.plugins.find((p) => p.name === "noadmin")!;
    // Derived from package@version — mutation: a wrong template/host/path fails here.
    expect(withAdmin.adminUrl).toBe("https://cdn.jsdelivr.net/npm/@rackbops/plugin-withadmin@1.0.0/dist/admin.js");
    expect(withAdmin.adminApiVersion).toBe(1);
    // Not declared → NEITHER field is present (absent key, not an undefined value — JSON stability).
    // Mutation: emitting unconditionally fails both of these.
    expect("adminUrl" in noAdmin).toBe(false);
    expect("adminApiVersion" in noAdmin).toBe(false);
  });

  test("admin fields sit between env and releases (fixed key order for --check)", async () => {
    const index = await withPlugins(
      { wow: { pkg: pkg("wow", { adminApiVersion: 1 }), changelog: changelog(), adminEntry: true } },
      (dir) => buildIndex(dir, fixedNow),
    );
    // Mutation: moving the `...parseAdmin` spread out from between env and releases reorders these.
    expect(Object.keys(index.plugins[0])).toEqual([
      "name", "package", "version", "description", "hostApiVersion",
      "intents", "commands", "env", "adminUrl", "adminApiVersion", "releases",
    ]);
  });

  test("rejects a non-number adminApiVersion", async () => {
    await expect(
      withPlugins({ wow: { pkg: pkg("wow", { adminApiVersion: "1" }), changelog: changelog() } }, (dir) => buildIndex(dir, fixedNow)),
    ).rejects.toThrow(/adminApiVersion must be a number/);
  });

  test("rejects adminApiVersion declared without a src/admin/index.ts bundle (no 404-ing adminUrl)", async () => {
    // No `adminEntry: true`, so the source is missing. Mutation: dropping the hasAdminEntry guard lets
    // this emit an adminUrl for a bundle that never builds instead of failing at generate time.
    await expect(
      withPlugins({ wow: { pkg: pkg("wow", { adminApiVersion: 1 }), changelog: changelog() } }, (dir) => buildIndex(dir, fixedNow)),
    ).rejects.toThrow(/adminApiVersion is declared but src\/admin\/index\.ts is missing/);
  });

  // #28: a plugin can pass the src/admin/index.ts check above and still publish a tarball that
  // never carries dist/admin.js, if package.json's own `files` allowlist excludes it.
  test("rejects adminApiVersion declared with a files allowlist the published tarball wouldn't carry the bundle in", async () => {
    await expect(
      withPlugins(
        { wow: { pkg: pkg("wow", { adminApiVersion: 1 }, ["dist/plugin.js"]), changelog: changelog(), adminEntry: true } },
        (dir) => buildIndex(dir, fixedNow),
      ),
      // Mutation: dropping the filesAllowlistCoversAdminBundle guard emits an adminUrl anyway.
    ).rejects.toThrow(/wow: botPlugin\.adminApiVersion is declared but package\.json's "files" allowlist does not include/);
  });

  test("accepts adminApiVersion when files covers dist, or when files is absent entirely", async () => {
    const index = await withPlugins(
      {
        withdist: { pkg: pkg("withdist", { adminApiVersion: 1 }, ["dist"]), changelog: changelog(), adminEntry: true },
        nofiles: { pkg: pkg("nofiles", { adminApiVersion: 1 }), changelog: changelog(), adminEntry: true },
      },
      (dir) => buildIndex(dir, fixedNow),
    );
    expect(index.plugins.find((p) => p.name === "withdist")?.adminUrl).toBe(
      "https://cdn.jsdelivr.net/npm/@rackbops/plugin-withdist@1.0.0/dist/admin.js",
    );
    expect(index.plugins.find((p) => p.name === "nofiles")?.adminUrl).toBe(
      "https://cdn.jsdelivr.net/npm/@rackbops/plugin-nofiles@1.0.0/dist/admin.js",
    );
  });
});

describe("filesAllowlistCoversAdminBundle", () => {
  test('["dist"] -> true', () => {
    expect(filesAllowlistCoversAdminBundle(["dist"])).toBe(true);
  });
  test('["./dist/"] -> true (normalises leading ./ and trailing /)', () => {
    expect(filesAllowlistCoversAdminBundle(["./dist/"])).toBe(true);
  });
  test('["dist/admin.js"] -> true (bundle listed specifically)', () => {
    expect(filesAllowlistCoversAdminBundle(["dist/admin.js"])).toBe(true);
  });
  test("undefined -> true (npm's own default includes everything)", () => {
    expect(filesAllowlistCoversAdminBundle(undefined)).toBe(true);
  });
  test('["dist/plugin.js"] -> false (server bundle listed, not the admin one or the whole dir)', () => {
    // Mutation: loosening the check (e.g. matching any "dist/*" prefix) turns this true.
    expect(filesAllowlistCoversAdminBundle(["dist/plugin.js"])).toBe(false);
  });
  test('["lib"] -> false', () => {
    expect(filesAllowlistCoversAdminBundle(["lib"])).toBe(false);
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

  test("committed plugins.json is a well-formed envelope", async () => {
    // Shape only -- NOT emptiness: a real plugin (or the throwaway hello) legitimately populates
    // plugins[]. The "--check" test above already pins that the committed file matches disk.
    const written = JSON.parse(await Bun.file(PLUGINS_JSON).text());
    expect(written.schemaVersion).toBe(1);
    expect(Array.isArray(written.plugins)).toBe(true);
    expect(typeof written.generatedAt).toBe("string");
  });
});
