import { describe, expect, it } from "bun:test";
import { decodeReplyRef } from "@rackbops/docket-core";
import { hostButtons, MAX_BUTTONS, modalId, parseCustomId, replyButtonId } from "./buttons.js";

describe("the tracker's customIds", () => {
  it("parses its own Reply button and modal, passes docket's references through, and ignores anything else", () => {
    expect(parseCustomId(replyButtonId("o7"))).toEqual({ kind: "reply-button", occurrenceId: "o7" });
    expect(parseCustomId(modalId("o7"))).toEqual({ kind: "reply-modal", occurrenceId: "o7" });
    expect(parseCustomId("tracker:d.o.o7")).toEqual({ kind: "ref", ref: "d.o.o7" });
    expect(parseCustomId("music:setlist-pick:1")).toBeNull();
    expect(parseCustomId("tracker:")).toBeNull();
    // The Reply codes are not docket codes, so docket never mistakes one for a reply.
    expect(decodeReplyRef("r.o.o7")).toBeNull();
    expect(decodeReplyRef("m.o.o7")).toBeNull();
  });
});

describe("hostButtons", () => {
  it("renders a run's actions, then Reply; an invitation's accept and decline, with no Reply", () => {
    const run = hostButtons({ text: "x", actions: ["done", "snooze"], ref: { taskId: "t1", occurrenceId: "o2" } });
    expect(run).toEqual([
      { customId: "tracker:d.o.o2", label: "Done", style: "success" },
      { customId: "tracker:s.o.o2", label: "Snooze 1h", style: "secondary" },
      { customId: "tracker:r.o.o2", label: "Reply", style: "secondary" },
    ]);
    const invite = hostButtons({ text: "x", actions: ["accept", "decline"], ref: { taskId: "t1", occurrenceId: null } });
    expect(invite.map((b) => b.customId)).toEqual(["tracker:a.t.t1", "tracker:x.t.t1"]);
    expect(hostButtons({ text: "x", actions: ["done"] })).toEqual([]);
  });

  it("stays within Discord's 25 buttons and 100-character ids, keeping Reply", () => {
    const decisions = Array.from({ length: 30 }, (_, i) => `choice-${i}`);
    const buttons = hostButtons({ text: "x", actions: ["decision"], decisions, ref: { taskId: "t1", occurrenceId: "o123456789" } });
    expect(buttons).toHaveLength(MAX_BUTTONS);
    expect(buttons.at(-1)?.label).toBe("Reply");
    expect(buttons.every((b) => b.customId.length <= 100 && b.customId.startsWith("tracker:"))).toBe(true);
  });
});
