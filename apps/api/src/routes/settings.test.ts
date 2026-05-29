import { describe, expect, it } from "vitest";
import { settingsPatchSchema } from "./settings";

describe("settingsPatchSchema", () => {
  it("accepts checklist orientation updates", () => {
    expect(settingsPatchSchema.safeParse({ checklistOrientation: "tasks_rows" }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ checklistOrientation: "tasks_columns" }).success).toBe(true);
  });

  it("rejects unknown checklist orientations", () => {
    expect(settingsPatchSchema.safeParse({ checklistOrientation: "wrong" }).success).toBe(false);
  });

  it("still accepts density settings", () => {
    expect(
      settingsPatchSchema.safeParse({
        density: "compact",
        rowHeight: 32,
        columnWidth: 120
      }).success
    ).toBe(true);
  });
});
