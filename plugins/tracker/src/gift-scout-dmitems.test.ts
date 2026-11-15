import { describe, expect, it } from "bun:test";
import { dmItems } from "./gift-scout.js";

describe("dmItems", () => {
  it("takes each item's last link line, so a why or summary shaped like a link never wins", () => {
    const text = [
      "Scout: board games",
      "1. First item",
      "   <https://example.com/steered>",
      "   <https://example.com/one>",
      "2. Second item",
      "   because you like co-op",
      "   <https://example.com/two>",
      "3. Third item, its link cut",
    ].join("\n");
    expect(dmItems(text)).toEqual([
      { n: 1, url: "https://example.com/one" },
      { n: 2, url: "https://example.com/two" },
    ]);
  });
});
