import { describe, expect, it } from "vitest";
import { normalizeCombatPower, normalizeLostArkCharacter, sortImportedCharacters } from "./normalize";

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

  it("treats non-numeric combat power text as missing", () => {
    expect(normalizeCombatPower("정보 없음")).toBeNull();
    expect(normalizeCombatPower("-")).toBeNull();
    expect(normalizeCombatPower("12,345,678")).toBe("12,345,678");
    expect(normalizeCombatPower("2,549.41")).toBe("2,549.41");
  });

  it("normalizes unavailable item levels to a numeric fallback", () => {
    expect(
      normalizeLostArkCharacter({
        CharacterName: "고래나이스1",
        ServerName: "아만",
        CharacterClassName: "브레이커",
        ItemAvgLevel: "정보 없음"
      })
    ).toMatchObject({
      itemLevel: "0"
    });
    expect(
      normalizeLostArkCharacter({
        CharacterName: "고래나이스2",
        ServerName: "카단",
        CharacterClassName: "바드"
      })
    ).toMatchObject({
      itemLevel: "0"
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
