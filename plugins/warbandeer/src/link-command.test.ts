import { describe, expect, test } from "bun:test";
import type { LinkedAccount } from "./links.js";
import { linkAvailability, linkReply, unlinkReply } from "./link-command.js";

describe("linkReply", () => {
  test("names the code and the 10-minute window", () => {
    const reply = linkReply("ABC12345");
    expect(reply).toContain("ABC12345");
    expect(reply).toContain("10 minutes");
  });
});

describe("linkAvailability", () => {
  test("available when configured and running", () => {
    expect(linkAvailability(true, true)).toEqual({ available: true });
  });

  test("not configured: names WARBANDEER_INGEST_PORT", () => {
    const result = linkAvailability(false, false);
    expect(result.available).toBe(false);
    if (!result.available) expect(result.message).toContain("WARBANDEER_INGEST_PORT");
  });

  test("configured but not running: a DIFFERENT message from 'not configured' — names a startup failure, not a missing setting", () => {
    const notConfigured = linkAvailability(false, false);
    const configuredNotRunning = linkAvailability(true, false);
    expect(configuredNotRunning.available).toBe(false);
    if (!configuredNotRunning.available && !notConfigured.available) {
      expect(configuredNotRunning.message).toContain("failed to start");
      expect(configuredNotRunning.message).not.toBe(notConfigured.message);
    }
  });
});

const account = (accountLabel: string): LinkedAccount => ({
  accountLabel,
  tokenHash: "hash",
  linkedAt: 0,
  updatedAt: 0,
});

describe("unlinkReply", () => {
  test("zero linked accounts: nothing to remove", () => {
    const result = unlinkReply([], undefined);
    expect(result.remove).toBeUndefined();
    expect(result.message).toContain("don't have any linked accounts");
  });

  test("exactly one linked account, no label given: removes it", () => {
    const result = unlinkReply([account("Main")], undefined);
    expect(result.remove).toBe("Main");
    expect(result.message).toContain("Main");
  });

  test("multiple linked accounts, no label given: asks which one, removes nothing", () => {
    const result = unlinkReply([account("Main"), account("Alts")], undefined);
    expect(result.remove).toBeUndefined();
    expect(result.message).toContain("Main");
    expect(result.message).toContain("Alts");
  });

  test("multiple linked accounts, a matching label given: removes that one", () => {
    const result = unlinkReply([account("Main"), account("Alts")], "Alts");
    expect(result.remove).toBe("Alts");
  });

  test("a label given that doesn't match any account: removes nothing, names the label", () => {
    const result = unlinkReply([account("Main")], "Nope");
    expect(result.remove).toBeUndefined();
    expect(result.message).toContain("Nope");
  });
});
