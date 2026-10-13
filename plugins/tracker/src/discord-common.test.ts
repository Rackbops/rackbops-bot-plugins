import { describe, expect, it } from "bun:test";
import { serial } from "./discord-common.js";

/**
 * The one queue every store write goes through (#206, tracker-discord-8): turns run one at a time in
 * the order they were queued, a turn that throws does not stop the next, and each caller gets its
 * own turn's answer or error.
 */

/** A promise and the function that settles it, so a test decides when a turn ends. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe("serial", () => {
  it("runs turns one at a time, in the order they were queued", async () => {
    const queue = serial();
    const log: string[] = [];
    const first = gate();
    const a = queue(async () => {
      log.push("a starts");
      await first.wait;
      log.push("a ends");
    });
    const b = queue(async () => void log.push("b"));
    const c = queue(async () => void log.push("c"));
    // b waits for a to end, however long a takes.
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(["a starts"]);
    first.open();
    await Promise.all([a, b, c]);
    expect(log).toEqual(["a starts", "a ends", "b", "c"]);
  });

  it("a turn that throws rejects its own caller and does not stop the next", async () => {
    const queue = serial();
    const failed = queue(async () => {
      throw new Error("store down");
    });
    const next = queue(async () => "ran");
    await expect(failed).rejects.toThrow("store down");
    expect(await next).toBe("ran");
    // The queue still works after it.
    expect(await queue(async () => 3)).toBe(3);
  });

  it("answers each caller with its own turn's result", async () => {
    const queue = serial();
    const answers = await Promise.all([queue(async () => 1), queue(async () => "two"), queue(async () => ({ three: 3 }))]);
    expect(answers).toEqual([1, "two", { three: 3 }]);
  });

  it("keeps two queues apart: one's slow turn does not hold up the other", async () => {
    const one = serial();
    const two = serial();
    const slow = gate();
    const held = one(() => slow.wait);
    expect(await two(async () => "free")).toBe("free");
    slow.open();
    await held;
  });
});
