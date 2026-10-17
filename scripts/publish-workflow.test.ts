// #28: publish.yml's admin-bundle pack check has no .ts counterpart to unit-test -- it's a shell
// step in a GitHub Actions workflow, exercised for real only on an actual tag push. This pins the
// step's presence and ordering directly against the raw YAML text (no YAML parser dependency in
// this repo; minimal deps), the same
// static-regex-over-a-real-file pattern this repo's other drift guards already use.
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const PUBLISH_YML = fileURLToPath(new URL("../.github/workflows/publish.yml", import.meta.url));

describe("publish.yml carries the admin-bundle pack check (issue #28)", () => {
  test("packs the real tarball, greps it for dist/admin.js, and only then uploads it for the publish job", async () => {
    const text = await Bun.file(PUBLISH_YML).text();

    // Mutation: removing the step entirely drops both of these -> red.
    expect(text).toContain("npm pack --pack-destination");
    expect(text).toContain("package/dist/admin.js");

    // Mutation: moving/removing the step so it no longer runs before the artifact leaves the job -> red.
    const packIdx = text.indexOf("npm pack --pack-destination");
    const uploadIdx = text.indexOf("actions/upload-artifact");
    const publishIdx = text.indexOf('npm publish "release/$TARBALL" --access public');
    expect(packIdx).toBeGreaterThan(-1);
    expect(uploadIdx).toBeGreaterThan(packIdx);
    expect(publishIdx).toBeGreaterThan(uploadIdx);

    // Mutation: dropping the "only when adminApiVersion is declared" gate would fail every plugin's
    // publish, including one with no admin bundle at all.
    expect(text).toContain("adminApiVersion");
  });
});

// #178: the publish job holds the OIDC capability, so what reaches it is checked. Same static-text
// approach as above (the rewrite that parses the steps waits on #178 -2 and #135).
describe("publish.yml hardening (issue #178)", () => {
  test("refuses a tagged commit that is not on main, before anything is installed or run", async () => {
    const text = await Bun.file(PUBLISH_YML).text();
    expect(text).toContain("fetch-depth: 0");
    const ancestor = text.indexOf('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(ancestor).toBeGreaterThan(-1);
    expect(ancestor).toBeLessThan(text.indexOf("bun install --frozen-lockfile"));
    expect(ancestor).toBeLessThan(text.indexOf('npm publish "release/$TARBALL"'));
    // The refusal must actually fail the job, not just print.
    const afterCheck = text.slice(ancestor, text.indexOf("- name:", ancestor));
    expect(afterCheck).toContain("exit 1");
  });

  test("tag-derived values reach the shell as environment variables, never through ${{ }}", async () => {
    const text = await Bun.file(PUBLISH_YML).text();
    // `${{ }}` may only feed job outputs, the publish job's env mapping and GH_TOKEN -- never a script.
    const interpolated = text.split("\n").filter((l) => l.includes("${{") && !/^\s*#/.test(l));
    expect(interpolated.length).toBeGreaterThan(0);
    for (const line of interpolated) {
      expect(line).toMatch(
        /^\s+(name|version|tarball|PLUGIN_NAME|PLUGIN_VERSION|TARBALL|GH_TOKEN): \$\{\{ (steps\.(tag\.outputs\.(name|version)|pack\.outputs\.tarball)|needs\.verify\.outputs\.(name|version|tarball)|github\.token) \}\}$/,
      );
    }
    expect(text).toContain('echo "PLUGIN_NAME=$NAME" >> "$GITHUB_ENV"');
    expect(text).toContain('echo "PLUGIN_VERSION=$VERSION" >> "$GITHUB_ENV"');
    // ...and the tag is checked against the shape of a real one first (mutation: drop the check -> red).
    expect(text).toContain("is not <name>-v<semver>");
  });

  test("npm is pinned to the major that supports OIDC trusted publishing, not @latest", async () => {
    const text = await Bun.file(PUBLISH_YML).text();
    expect(text).toContain('npm install -g "npm@^11.5.1"');
    expect(text).not.toContain("npm@latest");
  });
});

// #178: the job that runs this repo's code (bun install lifecycle scripts, tests, the build) must not be
// able to mint the npm OIDC credential; the job that can runs none of it. Static text, same caveat.
describe("publish.yml splits the privileged publish from the build (issue #178)", () => {
  const jobs = async (): Promise<{ verify: string; publish: string }> => {
    const text = await Bun.file(PUBLISH_YML).text();
    const from = text.indexOf("\n  verify:\n");
    const at = text.indexOf("\n  publish:\n");
    expect(from).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(from);
    // Comments are prose (they name "bun publish" and "id-token"); the checks are about the YAML.
    const code = (t: string): string => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    return { verify: code(text.slice(from, at)), publish: code(text.slice(at)) };
  };

  test("the verify job has no id-token and read-only contents", async () => {
    const { verify } = await jobs();
    expect(verify).toContain("contents: read");
    expect(verify).not.toContain("id-token");
    expect(verify).not.toContain("contents: write");
  });

  test("the publish job holds the id-token and runs no repo code (no bun, no repo scripts)", async () => {
    const { publish } = await jobs();
    expect(publish).toContain("id-token: write");
    expect(publish).toContain("needs: verify");
    expect(publish).not.toMatch(/\bbun\b/);
    expect(publish).not.toContain("actions/checkout");
    // It publishes the tarball the verify job packed, unchanged -- not a fresh `npm publish` of a directory.
    expect(publish).toContain('npm publish "release/$TARBALL" --access public');
  });

  test("the verify job re-reads the packed tarball's own name and version before handing it over", async () => {
    const { verify } = await jobs();
    expect(verify).toContain("package/package.json");
    expect(verify).toContain('@rackbops/plugin-$PLUGIN_NAME@$PLUGIN_VERSION');
  });

  test("the publish job re-reads the tarball's name and version itself, with no repo code", async () => {
    const { publish } = await jobs();
    expect(publish).toContain("package/package.json");
    expect(publish).toContain('@rackbops/plugin-$PLUGIN_NAME@$PLUGIN_VERSION');
  });
});
