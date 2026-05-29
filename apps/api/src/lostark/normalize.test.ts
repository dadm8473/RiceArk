import { describe, expect, it } from "vitest";
import { normalizeLostArkCharacter, sortImportedCharacters } from "./normalize";

describe("normalizeLostArkCharacter", () => {
  it("normalizes API fields used by the import UI", () => {
    expect(
      normalizeLostArkCharacter({
        CharacterName: "바드쌀",
        ServerName: "루페온",
        CharacterClassName: "바드",
        ItemAvgLevel: "1,640.00",
        CombatPower: "12,345,678"
      })
    ).toEqual({
      name: "바드쌀",
      serverName: "루페온",
      className: "바드",
      itemLevel: "1,640.00",
      combatPower: "12,345,678"
    });
  });

  it("sorts import candidates by item level descending then name", () => {
    expect(
      sortImportedCharacters([
        { name: "저렙", serverName: "루페온", className: "바드", itemLevel: "1,580.00", combatPower: null },
        { name: "나나", serverName: "루페온", className: "바드", itemLevel: "1,640.00", combatPower: null },
        { name: "가가", serverName: "카단", className: "도화가", itemLevel: "1,640.00", combatPower: null }
      ])
    ).toEqual([
      { name: "가가", serverName: "카단", className: "도화가", itemLevel: "1,640.00", combatPower: null },
      { name: "나나", serverName: "루페온", className: "바드", itemLevel: "1,640.00", combatPower: null },
      { name: "저렙", serverName: "루페온", className: "바드", itemLevel: "1,580.00", combatPower: null }
    ]);
  });
});
