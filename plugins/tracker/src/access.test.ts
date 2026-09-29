import { describe, expect, it } from "bun:test";
import type { User } from "@rackbops/docket-core";
import { decideAccess, MEMBERSHIP_UNKNOWN, NOT_ADMIN, NOT_ADMITTED, NOT_MEMBER, NOT_REGISTERED, parseGuildId } from "./access.js";

const person = (admin = false): User => ({
  id: "u1",
  discordId: "111111111111111111",
  usrSubject: null,
  displayName: null,
  timeZone: "America/New_York",
  preferredHour: 9,
  admin,
  createdAt: "2026-10-01T12:00:00.000Z",
});

describe("decideAccess", () => {
  it("membership first: a non-member or an unknown lookup is refused whoever they are", () => {
    expect(decideAccess({ membership: "not-member", person: person(true), registered: true, need: "admin" })).toBe(NOT_MEMBER);
    expect(decideAccess({ membership: "unknown", person: person(true), registered: true, need: "registered" })).toBe(MEMBERSHIP_UNKNOWN);
  });

  it("then admission, then what the action needs", () => {
    for (const membership of ["member", "not-checked"] as const) {
      expect(decideAccess({ membership, person: null, registered: false, need: "admitted" })).toBe(NOT_ADMITTED);
      expect(decideAccess({ membership, person: person(), registered: false, need: "admitted" })).toBeNull();
      expect(decideAccess({ membership, person: person(), registered: false, need: "registered" })).toBe(NOT_REGISTERED);
      expect(decideAccess({ membership, person: person(), registered: true, need: "registered" })).toBeNull();
      expect(decideAccess({ membership, person: person(), registered: true, need: "admin" })).toBe(NOT_ADMIN);
      // An admin need not have registered to admit someone.
      expect(decideAccess({ membership, person: person(true), registered: false, need: "admin" })).toBeNull();
    }
  });
});

describe("parseGuildId", () => {
  it("unset or blank is no gate; a snowflake is the gate; anything else refuses by name", () => {
    expect(parseGuildId(undefined)).toBeNull();
    expect(parseGuildId("  ")).toBeNull();
    expect(parseGuildId(" 123456789012345678 ")).toBe("123456789012345678");
    expect(() => parseGuildId("12345")).toThrow("TRACKER_GUILD_ID");
  });
});
