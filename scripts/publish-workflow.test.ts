// #28: publish.yml's admin-bundle pack check has no .ts counterpart to unit-test -- it's a shell
// step in a GitHub Actions workflow, exercised for real only on an actual tag push. This pins the
// step's presence and ordering directly against the raw YAML text (no YAML parser dependency in
// this repo -- see CLAUDE.md's "no linter configured" / minimal-deps note), the same
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
