import { describe, expect, test } from "bun:test";
import { clip, ECHO_LIMIT } from "./clip.js";

describe("clip", () => {
  test("leaves a string within the limit as it is, including one exactly at it", () => {
    expect(clip("abc")).toBe("abc");
    expect(clip("x".repeat(ECHO_LIMIT))).toBe("x".repeat(ECHO_LIMIT));
  });

  test("cuts a longer string to the limit, ending in an ellipsis", () => {
    const out = clip("x".repeat(ECHO_LIMIT + 1));
    expect(out).toHaveLength(ECHO_LIMIT);
    expect(out.endsWith("…")).toBe(true);
  });

  test("takes an explicit limit", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
  });

  test("does not leave half of an emoji before the ellipsis", () => {
    const out = clip("ab😀cd", 4); // the cut would fall between the two halves of the emoji
    expect(out).toBe("ab…");
    expect(out).not.toMatch(/[\ud800-\udbff]…/);
  });
});
