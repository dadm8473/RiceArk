import { describe, expect, it } from "vitest";
import { normalizeLostArkCharacter } from "./normalize";

describe("normalizeLostArkCharacter", () => {
  it("normalizes API fields used by the import UI", () => {
    expect(
      normalizeLostArkCharacter({
        CharacterName: "바드쌀",
        ServerName: "루페온",
        CharacterClassName: "바드",
        ItemAvgLevel: "1,640.00"
      })
    ).toEqual({
      name: "바드쌀",
      serverName: "루페온",
      className: "바드",
      itemLevel: "1,640.00"
    });
  });
});
