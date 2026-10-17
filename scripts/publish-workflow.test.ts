// #28: publish.yml's admin-bundle pack check has no .ts counterpart to unit-test -- it's a shell
// step in a GitHub Actions workflow, exercised for real only on an actual tag push. This pins the
// step's presence and ordering directly against the raw YAML text (no YAML parser dependency in
// this repo; minimal deps), the same
// static-regex-over-a-real-file pattern this repo's other drift guards already use.
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const PUBLISH_YML = fileURLToPath(new URL("../.github/workflows/publish.yml", import.meta.url));

describe("publish.yml carries the admin-bundle pack check (issue #28)", () => {
  test("has an npm pack --dry-run step that greps for dist/admin.js, before npm publish", async () => {
    const text = await Bun.file(PUBLISH_YML).text();

    // Mutation: removing the step entirely drops both of these -> red.
    expect(text).toContain("npm pack --dry-run");
    expect(text).toContain("dist/admin.js");

    // Mutation: moving/removing the step so it no longer runs before the real publish -> red.
    const packIdx = text.indexOf("npm pack --dry-run");
    const publishIdx = text.indexOf("npm publish --access public");
    expect(packIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(-1);
    expect(packIdx).toBeLessThan(publishIdx);

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
    expect(ancestor).toBeLessThan(text.indexOf("bun install"));
    expect(ancestor).toBeLessThan(text.indexOf("npm publish --access public"));
    // The refusal must actually fail the job, not just print.
    const afterCheck = text.slice(ancestor, text.indexOf("- name:", ancestor));
    expect(afterCheck).toContain("exit 1");
  });

  test("tag-derived values reach the shell as environment variables, never through ${{ }}", async () => {
    const text = await Bun.file(PUBLISH_YML).text();
    expect(text).not.toMatch(/\$\{\{\s*steps\./);
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
