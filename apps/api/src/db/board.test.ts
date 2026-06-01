import { describe, expect, it } from "vitest";
import { DEFAULT_SHEET_NAME, DEFAULT_TABLE_NAME, defaultBoardRolesForOrientation } from "./board";

describe("board db defaults", () => {
  it("uses Korean-facing default names", () => {
    expect(DEFAULT_SHEET_NAME).toBe("기본");
    expect(DEFAULT_TABLE_NAME).toBe("숙제");
  });

  it("maps existing orientation to board roles", () => {
    expect(defaultBoardRolesForOrientation("tasks_rows")).toMatchObject({
      rowRole: "task",
      columnRole: "character",
      taskAxis: "rows"
    });
    expect(defaultBoardRolesForOrientation("tasks_columns")).toMatchObject({
      rowRole: "character",
      columnRole: "task",
      taskAxis: "columns"
    });
  });
});
