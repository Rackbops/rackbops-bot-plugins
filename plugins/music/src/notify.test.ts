import { afterEach, describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import { notifyParty, rememberClient, resetClientForTest } from "./notify.js";
import type { Party } from "./party.js";

const party: Party = {
  guildId: "G1",
  channelId: "C1",
  hostId: "host",
  members: ["host", "friend"],
  queue: [{ uri: "spotify:track:one", name: "One", artist: "Band", durationMs: 180_000 }],
  index: 0,
};

/** A borrowed client whose one channel records what it is asked to send. */
function fakeClient(channel: unknown): Client {
  return { channels: { fetch: async () => channel } } as unknown as Client;
}

afterEach(() => {
  resetClientForTest();
});

describe("notifyParty", () => {
  test("a notice about one member may mention that member and nobody else", async () => {
    const sent: unknown[] = [];
    rememberClient(fakeClient({ isTextBased: () => true, send: async (opts: unknown) => void sent.push(opts) }));
    const message = "<@42> has dropped out of the party: @everyone look";

    await notifyParty(party, message, "42");

    expect(sent).toEqual([{ content: message, allowedMentions: { parse: [], users: ["42"] } }]);
  });

  test("a plain notice mentions nobody", async () => {
    const sent: unknown[] = [];
    rememberClient(fakeClient({ isTextBased: () => true, send: async (opts: unknown) => void sent.push(opts) }));

    await notifyParty(party, "That was the last track. @here");

    expect(sent).toEqual([{ content: "That was the last track. @here", allowedMentions: { parse: [] } }]);
  });

  test("no client means no send and no throw", async () => {
    await expect(notifyParty(party, "hello")).resolves.toBeUndefined();
  });

  test("a channel that is not text-based is skipped", async () => {
    const sent: unknown[] = [];
    rememberClient(fakeClient({ isTextBased: () => false, send: async (opts: unknown) => void sent.push(opts) }));

    await notifyParty(party, "hello");

    expect(sent).toEqual([]);
  });

  test("a send that throws is swallowed", async () => {
    rememberClient(
      fakeClient({
        isTextBased: () => true,
        send: async () => {
          throw new Error("Missing Permissions");
        },
      }),
    );

    await expect(notifyParty(party, "hello", "42")).resolves.toBeUndefined();
  });
});
