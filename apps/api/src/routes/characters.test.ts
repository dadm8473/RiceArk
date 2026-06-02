import { describe, expect, it } from "vitest";
import {
  characterDetailsSchema,
  characterDisplayNameSchema,
  characterIdParamSchema,
  characterOrderSchema,
  characterSearchSchema
} from "./characters";

describe("characterDisplayNameSchema", () => {
  it("accepts optional compact display names", () => {
    expect(characterDisplayNameSchema.safeParse({ displayName: "냠1" }).success).toBe(true);
    expect(characterDisplayNameSchema.safeParse({ displayName: "" }).success).toBe(true);
    expect(characterDisplayNameSchema.safeParse({ displayName: null }).success).toBe(true);
  });

  it("rejects display names longer than 20 characters", () => {
    expect(characterDisplayNameSchema.safeParse({ displayName: "123456789012345678901" }).success).toBe(false);
  });

  it("rejects emoji and invisible control characters", () => {
    expect(characterDisplayNameSchema.safeParse({ displayName: "냠🙂" }).success).toBe(false);
    expect(characterDisplayNameSchema.safeParse({ displayName: "냠\u200B1" }).success).toBe(false);
  });
});

describe("characterSearchSchema", () => {
  it("accepts valid Lost Ark character names", () => {
    expect(characterSearchSchema.safeParse({ name: "냠수나이스1" }).success).toBe(true);
    expect(characterSearchSchema.safeParse({ name: "RiceArk123" }).success).toBe(true);
  });

  it("rejects names over 12 characters or containing spaces and special characters", () => {
    expect(characterSearchSchema.safeParse({ name: "가나다라마바사아자차카타파" }).success).toBe(false);
    expect(characterSearchSchema.safeParse({ name: "냠수 나이스1" }).success).toBe(false);
    expect(characterSearchSchema.safeParse({ name: "냠수-나이스1" }).success).toBe(false);
  });
});

describe("characterDetailsSchema", () => {
  it("accepts editable character details except immutable identity fields", () => {
    expect(
      characterDetailsSchema.parse({
        displayName: "냠1",
        itemLevel: "1,640.00",
        combatPower: "2,549.41",
        memo: "상아탑 고정"
      })
    ).toMatchObject({
      displayName: "냠1",
      itemLevel: "1,640.00",
      combatPower: "2,549.41",
      memo: "상아탑 고정"
    });
  });

  it("does not accept character identity edits", () => {
    expect(
      characterDetailsSchema.safeParse({
        name: "다른이름",
        displayName: "냠1",
        itemLevel: "1,640.00"
      }).success
    ).toBe(false);
    expect(
      characterDetailsSchema.safeParse({
        displayName: "냠1",
        serverName: "카단",
        itemLevel: "1,640.00"
      }).success
    ).toBe(false);
    expect(
      characterDetailsSchema.safeParse({
        displayName: "냠1",
        className: "도화가",
        itemLevel: "1,640.00"
      }).success
    ).toBe(false);
  });

  it("rejects blank required editable details", () => {
    expect(
      characterDetailsSchema.safeParse({
        displayName: null,
        itemLevel: " ",
        combatPower: null,
        memo: null
      }).success
    ).toBe(false);
  });

  it("rejects unsafe editable character text", () => {
    expect(
      characterDetailsSchema.safeParse({
        displayName: "냠1",
        itemLevel: "1,640.00",
        combatPower: "2,549.41",
        memo: "상아탑\u0000고정"
      }).success
    ).toBe(false);
    expect(
      characterDetailsSchema.safeParse({
        displayName: "냠1",
        itemLevel: "1,640.00",
        combatPower: "2,549.41",
        memo: "메모🙂"
      }).success
    ).toBe(false);
  });

  it("rejects non-numeric character level and combat power text", () => {
    expect(
      characterDetailsSchema.safeParse({
        displayName: "냠1",
        itemLevel: "높음",
        combatPower: "2,549.41",
        memo: null
      }).success
    ).toBe(false);
    expect(
      characterDetailsSchema.safeParse({
        displayName: "냠1",
        itemLevel: "1,640.00",
        combatPower: "전투력높음",
        memo: null
      }).success
    ).toBe(false);
  });

  it("normalizes safe editable character text", () => {
    expect(
      characterDetailsSchema.parse({
        displayName: "  ＮＡＭ１  ",
        itemLevel: "１,６４０.００",
        combatPower: "２,５４９.４１",
        memo: "  상아탑\r\n고정  "
      })
    ).toMatchObject({
      displayName: "NAM1",
      itemLevel: "1,640.00",
      combatPower: "2,549.41",
      memo: "상아탑\n고정"
    });
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
