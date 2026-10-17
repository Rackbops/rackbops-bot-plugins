// #179 / #178: publish.yml's shell steps run for real, in a throwaway directory, with the environment
// GitHub gives them -- so deleting an `exit 1`, flipping a comparison or changing a grep target fails
// here, where the substring checks in publish-workflow.test.ts would stay green. Each `run:` script is
// pulled out of the workflow by its step name and executed with `bash -e`, the shell GitHub uses when a
// step names none. Only the tools the steps themselves call are needed (bash, git, tar, awk, node, npm);
// `npm publish` is replaced by a recording stub on PATH. Skipped on Windows, where CI never runs it.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLISH_YML = fileURLToPath(new URL("../.github/workflows/publish.yml", import.meta.url));
// `npm pack` twice on a cold runner can outlast the 5 s default.
setDefaultTimeout(30_000);
const posix = process.platform !== "win32";
const hasNpm = Bun.which("npm") !== null;

/** The `run:` script (a `|` block or a one-line command) of the step whose `- name:` is `name`, from the named job of the workflow text. */
function stepScript(workflow: string, job: "verify" | "publish", name: string): string {
  const lines = workflow.split("\n");
  const jobStart = lines.indexOf(`  ${job}:`);
  if (jobStart === -1) throw new Error(`job ${job} not found`);
  let jobEnd = lines.findIndex((l, i) => i > jobStart && /^ {2}\S/.test(l));
  if (jobEnd === -1) jobEnd = lines.length;
  const body = lines.slice(jobStart + 1, jobEnd);
  const start = body.findIndex((l) => l.trim() === `- name: ${name}`);
  if (start === -1) throw new Error(`step "${name}" not found in job ${job}`);
  const next = body.findIndex((l, i) => i > start && /^ {6}- /.test(l));
  const step = body.slice(start + 1, next === -1 ? body.length : next);
  const run = step.findIndex((l) => /^ {8}run: /.test(l));
  if (run === -1) throw new Error(`step "${name}" has no run: of its own`);
  const inline = /^ {8}run: (.*)$/.exec(step[run]!)![1]!;
  if (inline !== "|") return inline;
  const script: string[] = [];
  for (const l of step.slice(run + 1)) {
    if (l.trim() !== "" && !l.startsWith(" ".repeat(10))) break;
    script.push(l.slice(10));
  }
  return script.join("\n");
}

let dir: string;
let workflow: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "publish-steps-"));
  workflow = await Bun.file(PUBLISH_YML).text();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(script: string, env: Record<string, string>, cwd = dir): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", "-e", "-c", script], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: dir, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  // Isolated from the developer's own git config (signing, hooks, templates), which would change the fixture.
  const proc = Bun.spawn(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out.trim();
}

describe.skipIf(!posix)("verify: the tagged commit must be on main", () => {
  const NAME = "Verify the tagged commit is on main";

  /** A clone whose `origin` has main at one commit; a second commit exists only locally. Shaped like an Actions checkout of a tag. */
  async function repo(): Promise<{ clone: string; onMain: string; offMain: string }> {
    const origin = join(dir, "origin.git");
    const clone = join(dir, "clone");
    await mkdir(origin);
    await git(origin, "init", "--bare", "-q");
    await mkdir(clone);
    await git(clone, "init", "-q");
    await git(clone, "remote", "add", "origin", origin);
    await writeFile(join(clone, "a"), "1");
    await git(clone, "add", "a");
    await git(clone, "commit", "-q", "-m", "on main");
    const onMain = await git(clone, "rev-parse", "HEAD");
    await git(clone, "push", "-q", "origin", "main");
    await git(clone, "checkout", "-q", "-b", "branch");
    await writeFile(join(clone, "b"), "2");
    await git(clone, "add", "b");
    await git(clone, "commit", "-q", "-m", "off main");
    const offMain = await git(clone, "rev-parse", "HEAD");
    // Like actions/checkout of a tag: a detached HEAD, no local branches, no remote-tracking ref for main.
    // The step has to fetch origin/main itself.
    await git(clone, "checkout", "-q", "--detach", offMain);
    await git(clone, "branch", "-D", "main", "branch");
    await git(clone, "update-ref", "-d", "refs/remotes/origin/main");
    return { clone, onMain, offMain };
  }

  test("a commit reachable from origin/main passes", async () => {
    const { clone, onMain } = await repo();
    const r = await run(stepScript(workflow, "verify", NAME), { GITHUB_SHA: onMain }, clone);
    expect(r.code).toBe(0);
  });

  test("a commit that is only on a branch fails the step and says why", async () => {
    const { clone, offMain } = await repo();
    const r = await run(stepScript(workflow, "verify", NAME), { GITHUB_SHA: offMain }, clone);
    expect(r.code).toBe(1); // mutation: dropping `exit 1` or the `!` exits 0
    expect(r.stderr).toContain(`Tagged commit ${offMain} is not reachable from main`);
  });
});

describe.skipIf(!posix)("verify: the tag is resolved into a plugin name and version", () => {
  const NAME = "Resolve plugin name and version from the tag";

  async function resolve(tag: string): Promise<{ code: number; stderr: string; env: string; out: string }> {
    const envFile = join(dir, "github_env");
    const outFile = join(dir, "github_output");
    await writeFile(envFile, "");
    await writeFile(outFile, "");
    const r = await run(stepScript(workflow, "verify", NAME), { GITHUB_REF_NAME: tag, GITHUB_ENV: envFile, GITHUB_OUTPUT: outFile });
    return { code: r.code, stderr: r.stderr, env: await readFile(envFile, "utf8"), out: await readFile(outFile, "utf8") };
  }

  test("a plain tag sets the environment and the job outputs", async () => {
    const r = await resolve("wow-v1.0.3");
    expect(r.code).toBe(0);
    expect(r.env).toBe("PLUGIN_NAME=wow\nPLUGIN_VERSION=1.0.3\n");
    expect(r.out).toBe("name=wow\nversion=1.0.3\n");
  });

  test("a hyphenated name and a prerelease version are accepted", async () => {
    const r = await resolve("my-plugin-v2.10.0-rc.1");
    expect(r.code).toBe(0);
    expect(r.out).toBe("name=my-plugin\nversion=2.10.0-rc.1\n");
  });

  test("a name that itself contains -v is split on the LAST -v", async () => {
    const r = await resolve("my-vim-v1.0.0");
    expect(r.code).toBe(0);
    expect(r.out).toBe("name=my-vim\nversion=1.0.0\n");
  });

  for (const tag of ["wow-v1.0", "wow-v1", "Wow-v1.0.0", "1wow-v1.0.0", "wow-v1.0.0;id", "wow-v$(id).0.0", "-v1.0.0", "wow_v1.0.0"]) {
    test(`${JSON.stringify(tag)} is refused with nothing written`, async () => {
      const r = await resolve(tag);
      expect(r.code).toBe(1); // mutation: loosening either regex or dropping `exit 1` lets it through
      expect(r.stderr).toContain("is not <name>-v<semver>");
      expect(r.env).toBe("");
      expect(r.out).toBe("");
    });
  }
});

describe.skipIf(!posix)("verify: the tag must match the package and the CHANGELOG", () => {
  async function plugin(version: string, changelog: string): Promise<void> {
    await mkdir(join(dir, "plugins", "wow"), { recursive: true });
    await writeFile(join(dir, "plugins", "wow", "package.json"), JSON.stringify({ name: "@rackbops/plugin-wow", version }));
    await writeFile(join(dir, "plugins", "wow", "CHANGELOG.md"), changelog);
  }

  test("the tag version must equal package.json's version", async () => {
    await plugin("1.0.3", "# Changelog\n");
    const script = stepScript(workflow, "verify", "Verify the tag matches the package version");
    expect((await run(script, { PLUGIN_NAME: "wow", PLUGIN_VERSION: "1.0.3" })).code).toBe(0);
    const bad = await run(script, { PLUGIN_NAME: "wow", PLUGIN_VERSION: "1.0.4" });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Tag version 1.0.4 != package.json version 1.0.3");
  });

  test("the CHANGELOG must carry a section for exactly this version", async () => {
    await plugin("1.0.1", "# Changelog\n\n## [1.0.10] - 2026-01-02\n- x\n");
    const script = stepScript(workflow, "verify", "Verify the CHANGELOG has a section for this version");
    // mutation: matching "## [1.0.1" as a prefix would accept the 1.0.10 section
    expect((await run(script, { PLUGIN_NAME: "wow", PLUGIN_VERSION: "1.0.1" })).code).not.toBe(0);
    expect((await run(script, { PLUGIN_NAME: "wow", PLUGIN_VERSION: "1.0.10" })).code).toBe(0);
  });
});

describe.skipIf(!posix)("verify: the release notes are the version's own CHANGELOG section", () => {
  test("the section body only: stops at the next heading and at the link-reference block", async () => {
    await mkdir(join(dir, "plugins", "wow"), { recursive: true });
    await mkdir(join(dir, "release"));
    await writeFile(
      join(dir, "plugins", "wow", "CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "- not yet",
        "",
        "## [1.0.3] - 2026-10-17",
        "",
        "### Fixed",
        "- the fix",
        "",
        "## [1.0.2] - 2026-10-14",
        "- older",
        "",
        "[1.0.3]: https://example.com/1.0.3",
        "",
      ].join("\n"),
    );
    const script = stepScript(workflow, "verify", "Extract the CHANGELOG section for the release body");
    const r = await run(script, { PLUGIN_NAME: "wow", PLUGIN_VERSION: "1.0.3" });
    expect(r.code).toBe(0);
    expect(await readFile(join(dir, "release", "release-notes.md"), "utf8")).toBe("\n### Fixed\n- the fix\n\n");

    // The oldest release is followed by the link-reference block, which must not become its notes.
    const oldest = await run(script, { PLUGIN_NAME: "wow", PLUGIN_VERSION: "1.0.2" });
    expect(oldest.code).toBe(0);
    expect(await readFile(join(dir, "release", "release-notes.md"), "utf8")).toBe("- older\n\n");
  });
});

describe.skipIf(!posix || !hasNpm)("verify: the packed tarball is checked before it leaves the job", () => {
  const NAME = "Pack the tarball and verify what it carries";

  async function plugin(over: { name?: string; version?: string; admin?: boolean; withAdminFile?: boolean; mapOnly?: boolean } = {}): Promise<Record<string, string>> {
    const pdir = join(dir, "plugins", "wow");
    await mkdir(join(pdir, "dist"), { recursive: true });
    await writeFile(join(pdir, "dist", "plugin.js"), "export {}");
    if (over.withAdminFile) await writeFile(join(pdir, "dist", "admin.js"), "export {}");
    if (over.mapOnly) await writeFile(join(pdir, "dist", "admin.js.map"), "{}");
    await writeFile(
      join(pdir, "package.json"),
      JSON.stringify({
        name: over.name ?? "@rackbops/plugin-wow",
        version: over.version ?? "1.0.3",
        files: ["dist"],
        botPlugin: over.admin ? { adminApiVersion: 1 } : {},
      }),
    );
    const outFile = join(dir, "github_output");
    await writeFile(outFile, "");
    return { GITHUB_WORKSPACE: dir, GITHUB_OUTPUT: outFile, PLUGIN_NAME: "wow", PLUGIN_VERSION: "1.0.3", npm_config_cache: join(dir, ".npm") };
  }

  test("a good plugin packs one tarball and names it in the job output", async () => {
    const env = await plugin();
    const r = await run(stepScript(workflow, "verify", NAME), env);
    expect(r.code).toBe(0);
    expect(await readFile(env.GITHUB_OUTPUT!, "utf8")).toBe("tarball=rackbops-plugin-wow-1.0.3.tgz\n");
  });

  test("a plugin that declares adminApiVersion must carry dist/admin.js", async () => {
    const missing = await plugin({ admin: true });
    const r = await run(stepScript(workflow, "verify", NAME), missing);
    expect(r.code).toBe(1); // mutation: a flipped HAS_ADMIN test, a changed grep target or a dropped exit 1 passes
    expect(r.stderr).toContain("declares adminApiVersion but the tarball does not carry dist/admin.js");

    await rm(join(dir, "release"), { recursive: true, force: true });
    const present = await plugin({ admin: true, withAdminFile: true });
    expect((await run(stepScript(workflow, "verify", NAME), present)).code).toBe(0);
  });

  test("only dist/admin.js itself satisfies the admin check, not a file that starts with its name", async () => {
    const env = await plugin({ admin: true, mapOnly: true });
    const r = await run(stepScript(workflow, "verify", NAME), env);
    expect(r.code).toBe(1); // mutation: a substring grep accepts admin.js.map
  });

  test("a package.json version other than the tag's is refused", async () => {
    const env = await plugin({ version: "1.0.4" });
    const r = await run(stepScript(workflow, "verify", NAME), env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("expected @rackbops/plugin-wow@1.0.3");
  });

  test("a plugin without adminApiVersion is not asked for dist/admin.js", async () => {
    const env = await plugin({ admin: false });
    expect((await run(stepScript(workflow, "verify", NAME), env)).code).toBe(0);
  });

  test("a tarball whose package.json is another plugin's name is refused", async () => {
    const env = await plugin({ name: "@rackbops/plugin-tracker" });
    const r = await run(stepScript(workflow, "verify", NAME), env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("expected @rackbops/plugin-wow@1.0.3");
  });
});

describe.skipIf(!posix)("publish: what the privileged job runs", () => {
  const NAME = "Publish to npm (OIDC trusted publishing)";

  /** A release/ dir holding a tarball (made with tar, as the verify job's would be) and a recording `npm` stub. */
  async function release(tarball: string, pkg: { name: string; version: string }): Promise<Record<string, string>> {
    const stage = join(dir, "stage", "package");
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, "package.json"), JSON.stringify(pkg));
    await mkdir(join(dir, "release"), { recursive: true });
    const tar = Bun.spawn(["tar", "-czf", join(dir, "release", tarball), "-C", dirname(stage), "package"]);
    expect(await tar.exited).toBe(0);
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "npm"), `#!/bin/sh\necho "$@" >> "${join(dir, "npm-calls")}"\n`);
    await chmod(join(bin, "npm"), 0o755);
    return { PATH: `${bin}:${process.env.PATH ?? ""}`, TARBALL: tarball, PLUGIN_NAME: "wow", PLUGIN_VERSION: "1.0.3" };
  }
  const calls = async (): Promise<string> => readFile(join(dir, "npm-calls"), "utf8").catch(() => "");

  test("a tarball that is what the tag says is published as it is", async () => {
    const env = await release("rackbops-plugin-wow-1.0.3.tgz", { name: "@rackbops/plugin-wow", version: "1.0.3" });
    const r = await run(stepScript(workflow, "publish", NAME), env);
    expect(r.code).toBe(0);
    expect(await calls()).toBe("publish release/rackbops-plugin-wow-1.0.3.tgz --access public\n");
  });

  test("a tarball whose package.json is not the tagged plugin and version is never published", async () => {
    for (const pkg of [
      { name: "@rackbops/plugin-tracker", version: "1.0.3" },
      { name: "@rackbops/plugin-wow", version: "9.9.9" },
    ]) {
      await rm(join(dir, "release"), { recursive: true, force: true });
      await rm(join(dir, "bin"), { recursive: true, force: true });
      const env = await release("rackbops-plugin-wow-1.0.3.tgz", pkg);
      const r = await run(stepScript(workflow, "publish", NAME), env);
      expect(r.code).toBe(1); // mutation: dropping the comparison or its exit publishes the wrong package
      expect(r.stderr).toContain("expected @rackbops/plugin-wow@1.0.3");
      expect(await calls()).toBe("");
    }
  });

  test("a tarball name that is not a plain file name is refused even when a valid tarball exists under it", async () => {
    const env = await release("ok.tgz", { name: "@rackbops/plugin-wow", version: "1.0.3" });
    for (const bad of ["../ok.tgz", "ok.tgz --tag evil", "ok.tar", "$(id).tgz"]) {
      await copyFile(join(dir, "release", "ok.tgz"), join(dir, "release", bad)); // so only the name check can refuse it
      const r = await run(stepScript(workflow, "publish", NAME), { ...env, TARBALL: bad });
      expect(r.code).toBe(1); // mutation: dropping the `exit 1` (tar would succeed on a real file) publishes it
      expect(r.stderr).toContain("Unexpected tarball name");
    }
    expect(await calls()).toBe("");
  });
});

describe("stepScript", () => {
  const wf = ["jobs:", "  a:", "    steps:", "      - name: one", "        run: |", "          echo 1", "          echo 2", "", "      - name: two", "        uses: x/y@1", "      - name: three", "        run: |", "          echo 3", "      - name: four", "        run: echo 4", "  b:", "    steps:", "      - name: one", "        run: |", "          echo b"].join("\n");

  test("takes the block of the named step in the named job, and stops at the next step or job", () => {
    expect(stepScript(wf, "a" as never, "one")).toBe("echo 1\necho 2\n");
    expect(stepScript(wf, "a" as never, "three")).toBe("echo 3");
    expect(stepScript(wf, "b" as never, "one")).toBe("echo b");
    expect(stepScript(wf, "a" as never, "four")).toBe("echo 4");
  });

  test("a missing job, a missing step and a step with no run block all throw", () => {
    expect(() => stepScript(wf, "c" as never, "one")).toThrow(/job c not found/);
    expect(() => stepScript(wf, "a" as never, "nope")).toThrow(/step "nope" not found/);
    expect(() => stepScript(wf, "a" as never, "two")).toThrow(/no run: of its own/);
  });
});
