import { describe, expect, it } from "vitest";
import { characterDetailsSchema, characterDisplayNameSchema, characterIdParamSchema, characterOrderSchema } from "./characters";

describe("characterDisplayNameSchema", () => {
  it("accepts optional compact display names", () => {
    expect(characterDisplayNameSchema.safeParse({ displayName: "냠1" }).success).toBe(true);
    expect(characterDisplayNameSchema.safeParse({ displayName: "" }).success).toBe(true);
    expect(characterDisplayNameSchema.safeParse({ displayName: null }).success).toBe(true);
  });

  it("rejects display names longer than 20 characters", () => {
    expect(characterDisplayNameSchema.safeParse({ displayName: "123456789012345678901" }).success).toBe(false);
  });
});

describe("characterDetailsSchema", () => {
  it("accepts editable character details except the character name", () => {
    expect(
      characterDetailsSchema.parse({
        displayName: "냠1",
        serverName: "루페온",
        className: "소서리스",
        itemLevel: "1,640.00",
        combatPower: "2,549.41",
        memo: "상아탑 고정"
      })
    ).toMatchObject({
      displayName: "냠1",
      serverName: "루페온",
      className: "소서리스",
      itemLevel: "1,640.00",
      combatPower: "2,549.41",
      memo: "상아탑 고정"
    });
  });

  it("does not accept character name edits", () => {
    expect(
      characterDetailsSchema.safeParse({
        name: "다른이름",
        displayName: "냠1",
        serverName: "루페온",
        className: "소서리스",
        itemLevel: "1,640.00"
      }).success
    ).toBe(false);
  });

  it("rejects blank required editable details", () => {
    expect(
      characterDetailsSchema.safeParse({
        displayName: null,
        serverName: " ",
        className: "소서리스",
        itemLevel: "1,640.00",
        combatPower: null,
        memo: null
      }).success
    ).toBe(false);
  });
});

describe("characterOrderSchema", () => {
  it("accepts ordered character ids", () => {
    expect(characterOrderSchema.safeParse({ characterIds: ["character-a", "character-b"] }).success).toBe(true);
  });

  it("rejects duplicate character ids", () => {
    expect(characterOrderSchema.safeParse({ characterIds: ["character-a", "character-a"] }).success).toBe(false);
  });
});

describe("characterIdParamSchema", () => {
  it("accepts non-empty character ids", () => {
    expect(characterIdParamSchema.safeParse({ id: "character-1" }).success).toBe(true);
  });

  it("rejects empty character ids", () => {
    expect(characterIdParamSchema.safeParse({ id: "" }).success).toBe(false);
  });
});
