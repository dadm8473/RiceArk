import { describe, expect, it } from "vitest";
import { normalizeCharacterSelection } from "../src/characters";

describe("normalizeCharacterSelection", () => {
  it("deduplicates selected characters by server and name", () => {
    expect(
      normalizeCharacterSelection([
        { name: "바드쌀", serverName: "루페온", className: "바드", itemLevel: "1,640.00", combatPower: "12,345,678" },
        { name: "바드쌀", serverName: "루페온", className: "바드", itemLevel: "1,640.00", combatPower: "12,345,678" }
      ])
    ).toEqual([
      { name: "바드쌀", serverName: "루페온", className: "바드", itemLevel: "1,640.00", combatPower: "12,345,678" }
    ]);
  });

  it("sorts by item level descending then character name", () => {
    expect(
      normalizeCharacterSelection([
        { name: "저렙", serverName: "루페온", className: "바드", itemLevel: "1,580.00", combatPower: null },
        { name: "나나", serverName: "루페온", className: "바드", itemLevel: "1,640.00", combatPower: "22,222,222" },
        { name: "가가", serverName: "카단", className: "도화가", itemLevel: "1,640.00", combatPower: "11,111,111" }
      ])
    ).toEqual([
      { name: "가가", serverName: "카단", className: "도화가", itemLevel: "1,640.00", combatPower: "11,111,111" },
      { name: "나나", serverName: "루페온", className: "바드", itemLevel: "1,640.00", combatPower: "22,222,222" },
      { name: "저렙", serverName: "루페온", className: "바드", itemLevel: "1,580.00", combatPower: null }
    ]);
  });
});
