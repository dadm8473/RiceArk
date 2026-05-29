import { describe, expect, it } from "vitest";
import { normalizeCharacterSelection } from "../src/characters";

describe("normalizeCharacterSelection", () => {
  it("deduplicates selected characters by server and name", () => {
    expect(
      normalizeCharacterSelection([
        { name: "바드쌀", serverName: "루페온", className: "바드", itemLevel: "1,640.00" },
        { name: "바드쌀", serverName: "루페온", className: "바드", itemLevel: "1,640.00" }
      ])
    ).toEqual([{ name: "바드쌀", serverName: "루페온", className: "바드", itemLevel: "1,640.00" }]);
  });
});
