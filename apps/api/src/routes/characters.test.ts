import { describe, expect, it } from "vitest";
import { characterDisplayNameSchema } from "./characters";

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
