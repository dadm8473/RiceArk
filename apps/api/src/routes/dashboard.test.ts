import { describe, expect, it } from "vitest";
import { completionPatchSchema } from "./dashboard";

describe("completionPatchSchema", () => {
  it("accepts reset period completion patches", () => {
    expect(
      completionPatchSchema.safeParse({
        patches: [
          {
            taskId: "template-kurzan-front",
            characterId: "character-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ]
      }).success
    ).toBe(true);
  });

  it("rejects oversized or unsafe completion patch identifiers", () => {
    expect(
      completionPatchSchema.safeParse({
        patches: [
          {
            taskId: "task🙂",
            characterId: "character-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ]
      }).success
    ).toBe(false);
    expect(
      completionPatchSchema.safeParse({
        patches: [
          {
            taskId: "task-1",
            characterId: "character-1",
            periodKey: "daily:" + "1".repeat(10_000),
            completed: true
          }
        ]
      }).success
    ).toBe(false);
  });
});
