import { describe, expect, it } from "vitest";
import {
  isValidLostArkCharacterName,
  LOSTARK_CHARACTER_NAME_MAX_LENGTH,
  normalizeCharacterSelection,
  normalizeLostArkCharacterNameInput
} from "../src/characters";

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

describe("Lost Ark character name validation", () => {
  it("accepts Hangul Latin letters and numbers up to 12 characters", () => {
    expect(LOSTARK_CHARACTER_NAME_MAX_LENGTH).toBe(12);
    expect(isValidLostArkCharacterName("냠수나이스1")).toBe(true);
    expect(isValidLostArkCharacterName("RiceArk123")).toBe(true);
    expect(isValidLostArkCharacterName("가나다라마바사아자차카타")).toBe(true);
  });

  it("normalizes edge whitespace before validation", () => {
    expect(normalizeLostArkCharacterNameInput("  Ｒｉｃｅ１２  ")).toBe("Rice12");
    expect(isValidLostArkCharacterName("  냠수나이스1  ")).toBe(true);
  });

  it("rejects empty long spaced or special character names", () => {
    expect(isValidLostArkCharacterName("")).toBe(false);
    expect(isValidLostArkCharacterName("가나다라마바사아자차카타파")).toBe(false);
    expect(isValidLostArkCharacterName("냠수 나이스1")).toBe(false);
    expect(isValidLostArkCharacterName("냠수-나이스1")).toBe(false);
    expect(isValidLostArkCharacterName("냠수🙂")).toBe(false);
  });
});
