import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHEET_NAME,
  DEFAULT_TABLE_NAME,
  buildDefaultAxisItemSeeds,
  defaultBoardRolesForOrientation,
  defaultOrientationForTableRoles,
  mergeBoardCompletionPatches
} from "./board";

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

  it("derives bootstrap orientation from an existing table's roles", () => {
    expect(defaultOrientationForTableRoles({ rowRole: "task", columnRole: "character" }, "tasks_columns")).toBe("tasks_rows");
    expect(defaultOrientationForTableRoles({ rowRole: "character", columnRole: "task" }, "tasks_rows")).toBe("tasks_columns");
    expect(defaultOrientationForTableRoles({ rowRole: "custom", columnRole: "custom" }, "tasks_rows")).toBe("tasks_rows");
  });

  it("keeps the latest board completion patch per semantic cell and period", () => {
    expect(
      mergeBoardCompletionPatches([
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          periodKey: "daily:2026-06-01",
          completed: true
        },
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          periodKey: "daily:2026-06-01",
          completed: false
        }
      ])
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        periodKey: "daily:2026-06-01",
        completed: false
      }
    ]);
  });

  it("builds task rows and character columns from existing checklist data", () => {
    expect(
      buildDefaultAxisItemSeeds({
        orientation: "tasks_rows",
        tasks: [
          {
            id: "task-a",
            name: "쿠르잔 전선",
            scope: "character",
            resetType: "daily",
            resetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
            sortOrder: 20
          }
        ],
        characters: [{ id: "character-a", name: "냠수나이스1", sortOrder: 10 }]
      })
    ).toMatchObject([
      { axis: "row", kind: "task", taskId: "task-a", label: "쿠르잔 전선", sortOrder: 0 },
      { axis: "column", kind: "character", characterId: "character-a", label: "냠수나이스1", sortOrder: 0 }
    ]);
  });

  it("builds character rows and task columns when the user chose tasks as columns", () => {
    expect(
      buildDefaultAxisItemSeeds({
        orientation: "tasks_columns",
        tasks: [
          {
            id: "task-a",
            name: "쿠르잔 전선",
            scope: "character",
            resetType: "daily",
            resetRuleJson: "{}",
            sortOrder: 20
          }
        ],
        characters: [{ id: "character-a", name: "냠수나이스1", sortOrder: 10 }]
      })
    ).toMatchObject([
      { axis: "row", kind: "character", characterId: "character-a", label: "냠수나이스1", sortOrder: 0 },
      { axis: "column", kind: "task", taskId: "task-a", label: "쿠르잔 전선", sortOrder: 0 }
    ]);
  });
});
