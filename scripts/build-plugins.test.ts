import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertNonEmptyBuildOutput, plannedBuilds, pluginBuildSpecs } from "./build-plugins.js";

// build-plugins guards its CLI behind `import.meta.main`, so importing it here runs no build —
// only the pure `plannedBuilds` decision is exercised.
describe("plannedBuilds", () => {
  test("a plugin without an admin bundle builds only the bun server bundle", () => {
    expect(plannedBuilds("wow", false)).toEqual([
      { entry: "plugins/wow/src/index.ts", outfile: "plugins/wow/dist/plugin.js", target: "bun", externals: ["discord.js"] },
    ]);
  });

  test("a plugin WITH an admin bundle also builds the browser admin bundle (no discord.js external)", () => {
    const builds = plannedBuilds("wow", true);
    // Mutation: dropping the admin build, or making it unconditional, fails one of these.
    expect(builds).toHaveLength(2);
    expect(builds[1]).toEqual({
      entry: "plugins/wow/src/admin/index.ts",
      outfile: "plugins/wow/dist/admin.js",
      target: "browser",
      externals: [],
    });
    // The server bundle is unchanged and still comes first.
    expect(builds[0].target).toBe("bun");
    expect(builds[0].externals).toEqual(["discord.js"]);
  });
});

// #28: the other half of the jsDelivr-404 failure mode -- generate-index's guards catch a missing
// admin *source*, but a `bun build` that exits 0 while writing nothing (or an empty file) would
// still leave a working-looking dist/admin.js absent. Exercised directly against real temp files,
// without spawning an actual `bun build`.
describe("assertNonEmptyBuildOutput", () => {
  test("resolves when the built file exists and is non-empty", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "assertbuild-"));
    try {
      await mkdir(join(tmp, "plugins", "wow", "dist"), { recursive: true });
      await writeFile(join(tmp, "plugins", "wow", "dist", "admin.js"), "console.log(1);\n");
      const root = new URL(pathToFileURL(tmp).href + "/");
      await expect(assertNonEmptyBuildOutput("plugins/wow/dist/admin.js", root)).resolves.toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("throws when the build produced an empty file", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "assertbuild-"));
    try {
      await mkdir(join(tmp, "plugins", "wow", "dist"), { recursive: true });
      await writeFile(join(tmp, "plugins", "wow", "dist", "admin.js"), "");
      const root = new URL(pathToFileURL(tmp).href + "/");
      // Mutation: dropping the `file.size === 0` half of the check turns this red.
      await expect(assertNonEmptyBuildOutput("plugins/wow/dist/admin.js", root)).rejects.toThrow(
        /admin build produced no output \(or an empty file\)/,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("throws when the build produced no file at all", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "assertbuild-"));
    try {
      const root = new URL(pathToFileURL(tmp).href + "/");
      // Mutation: dropping the `!(await file.exists())` half of the check turns this red.
      await expect(assertNonEmptyBuildOutput("plugins/wow/dist/admin.js", root)).rejects.toThrow(
        /admin build produced no output \(or an empty file\)/,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("pluginBuildSpecs (on-disk admin detection)", () => {
  test("adds the admin build only when src/admin/index.ts exists on disk", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "buildplugins-"));
    try {
      // `withadmin` ships an admin entry; `noadmin` does not.
      await mkdir(join(tmp, "plugins", "withadmin", "src", "admin"), { recursive: true });
      await writeFile(join(tmp, "plugins", "withadmin", "src", "admin", "index.ts"), "export function mountAdmin() { return () => {}; }\n");
      await mkdir(join(tmp, "plugins", "noadmin", "src"), { recursive: true });
      const root = new URL(pathToFileURL(tmp).href + "/");
      // Mutation: a broken hasAdmin probe (hardcoded true/false) diverges these two on-disk cases.
      expect(await pluginBuildSpecs("noadmin", root)).toHaveLength(1);
      const withAdmin = await pluginBuildSpecs("withadmin", root);
      expect(withAdmin).toHaveLength(2);
      expect(withAdmin[1].outfile).toBe("plugins/withadmin/dist/admin.js");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
