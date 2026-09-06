import { describe, expect, test } from "bun:test";
import { initWowConfig, config } from "./config.js";

// The WoW config validation moved here from the bot's config.test.ts (the region + DMF_TIMEZONE cases),
// carrying the exact error text so an operator sees the same message the bot used to throw at boot.
describe("initWowConfig", () => {
  test("defaults region to us and the DMF timezone to America/Los_Angeles", () => {
    const c = initWowConfig({});
    expect(c.region).toBe("us");
    expect(c.dmfTimezone).toBe("America/Los_Angeles");
  });

  test("eu region defaults the DMF timezone to Europe/Paris", () => {
    // Mutation: swapping the us/eu defaults fails both this and the test above.
    const c = initWowConfig({ WOW_REGION: "eu" });
    expect(c.region).toBe("eu");
    expect(c.dmfTimezone).toBe("Europe/Paris");
  });

  test("rejects an invalid region with the exact bot error text", () => {
    expect(() => initWowConfig({ WOW_REGION: "xx" })).toThrow(`WOW_REGION must be "us" or "eu", got "xx"`);
  });

  test("rejects an invalid DMF timezone with the exact bot error text", () => {
    expect(() => initWowConfig({ DMF_TIMEZONE: "Invalid/Zone" })).toThrow(
      `DMF_TIMEZONE is not a valid IANA time zone, got "Invalid/Zone"`,
    );
  });

  test("accepts a valid custom DMF timezone", () => {
    const c = initWowConfig({ WOW_REGION: "eu", DMF_TIMEZONE: "America/New_York" });
    expect(c.dmfTimezone).toBe("America/New_York");
  });

  test("reads the realm and Blizzard creds from env, treating blank as unset (mirrors the bot's optional())", () => {
    const set = initWowConfig({
      WOW_REALM: "argent-dawn",
      BLIZZARD_CLIENT_ID: "id",
      BLIZZARD_CLIENT_SECRET: "secret",
    });
    expect(set.realmSlug).toBe("argent-dawn");
    expect(set.blizzardClientId).toBe("id");
    expect(set.blizzardClientSecret).toBe("secret");
    // Blank ("") must resolve to undefined, exactly like the bot's config.ts optional() — otherwise a
    // blank WOW_REALM would count as "a realm is set" and turn the realm watch on with an empty slug.
    const blank = initWowConfig({ WOW_REALM: "", BLIZZARD_CLIENT_ID: "" });
    expect(blank.realmSlug).toBeUndefined();
    expect(blank.blizzardClientId).toBeUndefined();
  });

  test("mutates the shared config singleton the ported modules read", () => {
    initWowConfig({ WOW_REGION: "eu", WOW_REALM: "hyjal" });
    expect(config.region).toBe("eu");
    expect(config.realmSlug).toBe("hyjal");
  });
});
