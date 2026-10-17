// The WOW_REALM / DMF_TIMEZONE charsets are hand-copied in three places: package.json's
// botPlugin.env `format` (what the bot's env-set enforces), the admin tab's REALM_SLUG_RE /
// TZ_SHAPE_RE (browser pre-validation) and realmSlug's character class in transmog.ts. Nothing
// else ties them together, so this builds RegExps from the manifest and holds the other two to the
// same accept/reject answers.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateRealmSlug, validateTimezone } from "./admin/index.js";
import { realmSlug } from "./transmog.js";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
  botPlugin: { env: Array<{ key: string; format: string }> };
};
function manifestRe(key: string): RegExp {
  const entry = pkg.botPlugin.env.find((e) => e.key === key);
  if (!entry) throw new Error(`${key} missing from plugins/wow/package.json botPlugin.env`);
  return new RegExp(entry.format);
}

describe("WOW_REALM: manifest format vs admin REALM_SLUG_RE vs realmSlug", () => {
  const re = manifestRe("WOW_REALM");
  const accept = ["argent-dawn", "chants-éternels", "aggra-português", "area-52", "a", "x".repeat(40)];
  const reject = ["Has Spaces", "UPPER", "under_score", "kil'jaeden", "x".repeat(41), "Гордунни", "a/b", "ÉTERNELS"];

  test("the manifest and validateRealmSlug agree on every sample", () => {
    for (const v of accept) {
      expect(re.test(v)).toBe(true);
      expect(validateRealmSlug(v)).toBeNull();
    }
    for (const v of reject) {
      expect(re.test(v)).toBe(false);
      expect(validateRealmSlug(v)).not.toBeNull();
    }
    // Blank is handled before the format by the admin tab ("no realm") and by the host.
    expect(validateRealmSlug("")).toBeNull();
  });

  test("realmSlug keeps exactly the characters the manifest allows (single-char scan, U+0000-U+02FF)", () => {
    for (let cp = 0; cp <= 0x2ff; cp++) {
      const c = String.fromCodePoint(cp);
      expect({ cp, kept: realmSlug(c) === c }).toEqual({ cp, kept: re.test(c) });
    }
  });
});

describe("DMF_TIMEZONE: manifest format vs admin TZ_SHAPE_RE", () => {
  const re = manifestRe("DMF_TIMEZONE");
  // Shape-valid AND real zones, since validateTimezone also asks the engine whether it knows the zone.
  const accept = ["America/Los_Angeles", "Europe/Paris", "UTC", "Etc/GMT+5", "America/Argentina/Buenos_Aires"];
  const reject = ["America/", "/UTC", "a/b/c/d", "America Los_Angeles", "Europe/Paris!", "Europe//Paris"];

  test("the manifest and validateTimezone agree on every sample", () => {
    for (const v of accept) {
      expect(re.test(v)).toBe(true);
      expect(validateTimezone(v)).toBeNull();
    }
    for (const v of reject) {
      expect(re.test(v)).toBe(false);
      expect(validateTimezone(v)).not.toBeNull();
    }
    expect(validateTimezone("")).toBeNull(); // blank = region default
  });

  test("a shape-valid but unknown zone passes the manifest and is caught by the engine check", () => {
    expect(re.test("Not/AZone")).toBe(true);
    expect(validateTimezone("Not/AZone")).not.toBeNull();
  });
});
