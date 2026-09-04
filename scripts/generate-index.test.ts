import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PLUGINS_JSON = new URL("../plugins.json", import.meta.url);

async function run(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // process.execPath, not the bare string "bun" -- Bun.spawn's ENOENT on a bare command
  // name (no PATH search) is Windows-specific and won't reproduce on Linux CI, so it can't
  // be caught there. Always spawn the running Bun binary this way.
  const proc = Bun.spawn([process.execPath, "run", "scripts/generate-index.ts", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("generate-index", () => {
  test("--check passes against the committed plugins.json on an empty plugins/", async () => {
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
