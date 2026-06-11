import { describe, expect, it } from "vitest";
import {
  characterDetailsSchema,
  characterDisplayNameSchema,
  characterIdParamSchema,
  importCharactersSchema,
  manualCharacterSchema,
  characterOrderSchema,
  characterSearchSchema
} from "./characters";

describe("characterDisplayNameSchema", () => {
  it("accepts optional compact display names", () => {
    expect(characterDisplayNameSchema.safeParse({ displayName: "냠1" }).success).toBe(true);
    expect(characterDisplayNameSchema.safeParse({ displayName: "냠🙂" }).success).toBe(true);
    expect(characterDisplayNameSchema.safeParse({ displayName: "" }).success).toBe(true);
    expect(characterDisplayNameSchema.safeParse({ displayName: null }).success).toBe(true);
  });

  it("rejects display names longer than 20 characters", () => {
    expect(characterDisplayNameSchema.safeParse({ displayName: "123456789012345678901" }).success).toBe(false);
  });

  it("rejects invisible control characters in display names", () => {
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
  it("accepts editable character details including manual identity fields", () => {
    expect(
      characterDetailsSchema.parse({
        name: "임의캐릭터",
        serverName: "",
        className: null,
        displayName: "냠🙂",
        itemLevel: "1,640.00",
        combatPower: "2,549.41",
        memo: "상아탑 고정🙂"
      })
    ).toMatchObject({
      name: "임의캐릭터",
      serverName: "",
      className: null,
      displayName: "냠🙂",
      itemLevel: "1,640.00",
      combatPower: "2,549.41",
      memo: "상아탑 고정🙂"
    });
  });

  it("accepts blank optional manual details while keeping nickname required when supplied", () => {
    expect(
      characterDetailsSchema.parse({
        name: "임의캐릭터",
        serverName: "",
        className: "",
        displayName: null,
        itemLevel: "",
        combatPower: null,
        memo: null
      })
    ).toMatchObject({
      name: "임의캐릭터",
      serverName: "",
      className: "",
      itemLevel: "",
      combatPower: null
    });
    expect(
      characterDetailsSchema.safeParse({
        name: " ",
        displayName: null,
        itemLevel: "1,640.00"
      }).success
    ).toBe(false);
  });

  it("accepts plus suffixes on user-edited character level and combat power notes", () => {
    expect(
      characterDetailsSchema.parse({
        displayName: "냠1",
        itemLevel: "1770+",
        combatPower: "5000+",
        memo: null
      })
    ).toMatchObject({
      itemLevel: "1770+",
      combatPower: "5000+"
    });
  });

  it("allows blank optional item level for manual characters", () => {
    expect(
      characterDetailsSchema.safeParse({
        displayName: null,
        itemLevel: " ",
        combatPower: null,
        memo: null
      }).success
    ).toBe(true);
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

describe("importCharactersSchema", () => {
  it("accepts rosters larger than 30 characters across multiple servers", () => {
    const characters = Array.from({ length: 120 }, (_, index) => ({
      name: `캐릭터${index + 1}`,
      serverName: index % 2 === 0 ? "아만" : "카단",
      className: "브레이커",
      itemLevel: "1,640.00",
      combatPower: "2,549.41"
    }));

    expect(importCharactersSchema.safeParse({ characters }).success).toBe(true);
  });

  it("keeps plus suffixes out of imported Lost Ark character stats", () => {
    expect(
      importCharactersSchema.safeParse({
        characters: [
          {
            name: "냠수나이스1",
            serverName: "아만",
            className: "브레이커",
            itemLevel: "1,770+",
            combatPower: "5,000"
          }
        ]
      }).success
    ).toBe(false);
  });
});

describe("manualCharacterSchema", () => {
  it("requires only a nickname and accepts blank optional fields", () => {
    expect(
      manualCharacterSchema.parse({
        name: "임의캐릭터🙂",
        serverName: "",
        className: null,
        itemLevel: "",
        combatPower: null
      })
    ).toMatchObject({
      name: "임의캐릭터🙂",
      serverName: "",
      className: null,
      itemLevel: "",
      combatPower: null
    });
  });

  it("accepts plus suffixes on manually added character level and combat power", () => {
    expect(
      manualCharacterSchema.parse({
        name: "임의캐릭터",
        itemLevel: "1770+",
        combatPower: "5000+"
      })
    ).toMatchObject({
      itemLevel: "1770+",
      combatPower: "5000+"
    });
  });

  it("rejects unsafe or empty manual character names", () => {
    expect(manualCharacterSchema.safeParse({ name: "", serverName: "" }).success).toBe(false);
    expect(manualCharacterSchema.safeParse({ name: "임의\u200B", serverName: "" }).success).toBe(false);
  });
});
