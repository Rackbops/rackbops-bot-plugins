// #185: makeFakeInteraction has no production consumer yet (this plugin ships no interactions()
// handler) -- this pins that the helper itself works and matches the shape a real
// PluginInteractionHandler receives, so it doesn't bit-rot before the first real consumer arrives.
import { describe, expect, test } from "bun:test";
import { makeFakeInteraction } from "./test-host.js";

describe("makeFakeInteraction", () => {
  test("carries the FULL customId through, unstripped", () => {
    const interaction = makeFakeInteraction("warbandeer:link:confirm");
    expect(interaction.customId).toBe("warbandeer:link:confirm");
  });

  test("defaults replied/deferred to false, and reply() resolves", async () => {
    const interaction = makeFakeInteraction("warbandeer:x");
    expect(interaction.replied).toBe(false);
    expect(interaction.deferred).toBe(false);
    await expect(interaction.reply({ content: "ok" })).resolves.toBeUndefined();
  });

  test("overrides replied/deferred/reply", async () => {
    let replyCalledWith: unknown;
    const interaction = makeFakeInteraction("warbandeer:x", {
      replied: true,
      deferred: true,
      reply: async (opts: unknown) => {
        replyCalledWith = opts;
      },
    });
    expect(interaction.replied).toBe(true);
    expect(interaction.deferred).toBe(true);
    await interaction.reply({ content: "hi" });
    expect(replyCalledWith).toEqual({ content: "hi" });
  });
});
