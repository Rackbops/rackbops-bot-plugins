import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { makeRealStorage } from "../../../packages/testkit/index.js";
import { initCharacters, charactersDir, loadCharacterSnapshotsFrom, saveCharacterSnapshotTo } from "./characters.js";
import type { LinkedAccount } from "./links.js";
import { hashToken, links, loadLinks } from "./links.js";
import { handleLinkCommand, handleUnlinkCommand, linkAvailability, linkReply, unlinkReply } from "./link-command.js";
import { createRateLimiter, setConnectorConfigured, startWarbandeerServer, type WarbandeerDeps } from "./server.js";

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

// Drives the real handlers (#157) against a temp dir: the pure helpers above can't catch a dropped
// Ephemeral flag, a reordered deferReply, or a missing snapshot deletion.
describe("handleLinkCommand / handleUnlinkCommand", () => {
  const USER = "123456789012345678";
  let dir: string;
  let server: { stop: () => void } | undefined;

  function fakeInteraction(opts: { accountLabel?: string } = {}) {
    const calls: string[] = [];
    const defer: unknown[] = [];
    const replies: { content: string; flags?: unknown }[] = [];
    const interaction = {
      user: { id: USER },
      options: { getString: () => opts.accountLabel ?? null },
      reply: async (r: { content: string; flags?: unknown }) => void (calls.push("reply"), replies.push(r)),
      deferReply: async (r: unknown) => void (calls.push("defer"), defer.push(r)),
      editReply: async (r: { content: string }) => void (calls.push("edit"), replies.push(r)),
    } as unknown as ChatInputCommandInteraction;
    return { interaction, calls, defer, replies };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "warbandeer-link-"));
    const storage = makeRealStorage();
    initCharacters(dir, storage);
    await loadLinks(dir, storage);
    links.pending = [];
    links.accounts = {};
    setConnectorConfigured(true);
    const deps: WarbandeerDeps = {
      maxBodyBytes: 1024,
      rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      redeemCode: async () => ({ ok: true, token: "t" }),
      authenticate: () => undefined,
      storeCharacters: async () => ({ ok: true }),
    };
    server = startWarbandeerServer(0, deps); // flips warbandeerServerRunning() to true
  });

  afterEach(() => {
    server?.stop();
    setConnectorConfigured(false);
    links.pending = [];
    links.accounts = {};
    rmSync(dir, { recursive: true, force: true });
  });

  test("/link defers ephemerally, then puts the code only in the edited reply", async () => {
    const { interaction, calls, defer, replies } = fakeInteraction();
    await handleLinkCommand(interaction);
    expect(defer).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(calls).toEqual(["defer", "edit"]);
    expect(links.pending).toHaveLength(1);
    expect(replies).toHaveLength(1);
    const code = /\*\*([A-Z0-9]+)\*\*/.exec(replies[0]!.content)?.[1];
    expect(code).toBeDefined();
    expect(hashToken(code!)).toBe(links.pending[0]!.codeHash);
  });

  test("/link when the connector is not running refuses ephemerally without minting a code", async () => {
    server?.stop();
    server = undefined;
    const { interaction, replies } = fakeInteraction();
    await handleLinkCommand(interaction);
    expect(replies[0]!.flags).toBe(MessageFlags.Ephemeral);
    expect(links.pending).toHaveLength(0);
  });

  test("/link answers a failure when the save throws, and the unsaved code is not left redeemable", async () => {
    await loadLinks(dir, { ...makeRealStorage(), createJsonWriter: () => ({ save: async () => { throw new Error("disk full"); } }) });
    const { interaction, replies } = fakeInteraction();
    await handleLinkCommand(interaction);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.content).toContain("Something went wrong");
    expect(replies[0]!.content).not.toMatch(/\*\*[A-Z0-9]+\*\*/); // mutation: no catch leaves "thinking..."
    expect(links.pending).toHaveLength(0);
  });

  test("/link taking back an unsaved code does not undo a change another request made meanwhile", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await loadLinks(dir, {
      ...makeRealStorage(),
      createJsonWriter: () => ({
        save: async () => {
          await gate;
          throw new Error("disk full");
        },
      }),
    });
    const { interaction } = fakeInteraction();
    const pending = handleLinkCommand(interaction);
    await Bun.sleep(0);
    // While the save is pending, a redeem lands on the same shared state.
    links.accounts = { ...links.accounts, other: [{ accountLabel: "Alts", tokenHash: "h", linkedAt: 0, updatedAt: 0 }] };
    release();
    await pending;
    expect(links.pending).toHaveLength(0);
    expect(links.accounts.other).toHaveLength(1); // mutation: restoring a snapshot of `accounts` drops it
  });

  test("/link whose code was saved but whose reply failed leaves the saved code redeemable and does not throw", async () => {
    const { interaction } = fakeInteraction();
    (interaction as unknown as { editReply: () => Promise<never> }).editReply = async () => {
      throw new Error("Unknown interaction");
    };
    await handleLinkCommand(interaction);
    expect(links.pending).toHaveLength(1);
  });

  test("/unlink answers a failure when the save throws, and the account stays linked", async () => {
    links.accounts = { [USER]: [{ accountLabel: "Main", tokenHash: "h", linkedAt: 0, updatedAt: 0 }] };
    await loadLinks(dir, { ...makeRealStorage(), createJsonWriter: () => ({ save: async () => { throw new Error("disk full"); } }) });
    links.accounts = { [USER]: [{ accountLabel: "Main", tokenHash: "h", linkedAt: 0, updatedAt: 0 }] };
    const { interaction, replies } = fakeInteraction();
    await handleUnlinkCommand(interaction);
    expect(replies[0]!.content).toContain("Something went wrong");
    expect(links.accounts[USER]).toHaveLength(1);
  });

  test("/unlink still says the account is unlinked when deleting its snapshot throws, and says the data remains", async () => {
    links.accounts = { [USER]: [{ accountLabel: "Main", tokenHash: "h", linkedAt: 0, updatedAt: 0 }] };
    await saveCharacterSnapshotTo(charactersDir(), USER, { accountLabel: "Main", characters: [] } as never);
    const snapshotFile = join(charactersDir(), `${USER}.json`);
    initCharacters(dir, { ...makeRealStorage(), createKeyedJsonMutator: () => ({ update: async () => { throw new Error("EIO"); } }) } as never);
    const { interaction, replies } = fakeInteraction();
    await handleUnlinkCommand(interaction);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.content).toContain("Unlinked");
    expect(replies[0]!.content).toContain("could not be deleted");
    expect(links.accounts[USER] ?? []).toHaveLength(0);
    expect(existsSync(snapshotFile)).toBe(true); // and the message does not lie: the data really is still there
  });

  test("/unlink removes the account and deletes its Character Snapshot from disk", async () => {
    links.accounts = { [USER]: [{ accountLabel: "Main", tokenHash: "h", linkedAt: 0, updatedAt: 0 }] };
    await saveCharacterSnapshotTo(charactersDir(), USER, { accountLabel: "Main", characters: [] } as never);
    expect((await loadCharacterSnapshotsFrom(charactersDir(), USER)).snapshots).toHaveLength(1);

    const { interaction, defer, replies } = fakeInteraction();
    await handleUnlinkCommand(interaction);

    expect(defer).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(links.accounts[USER] ?? []).toHaveLength(0);
    expect((await loadCharacterSnapshotsFrom(charactersDir(), USER)).snapshots).toHaveLength(0);
    expect(replies[0]!.content).toContain("Unlinked");
  });
});
