import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHEET_NAME,
  DEFAULT_TABLE_NAME,
  buildBoardCompletionPatchesFromLegacy,
  buildDefaultAxisItemSeeds,
  buildManualBoardAxisItemDraft,
  buildBoardAxisItemTransposePlan,
  boardRolesForTableOrientation,
  defaultBoardRolesForOrientation,
  defaultOrientationForTableRoles,
  findUnauthorizedBoardCellStatePatches,
  findUnauthorizedBoardCompletionPatches,
  findBoardCompletionPatchesOutsideCurrentPeriod,
  mergeBoardCellStatePatches,
  mergeBoardCompletionPatches,
  transposeBoardRoles
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

  it("maps creatable table orientations to board roles", () => {
    expect(boardRolesForTableOrientation("tasks_rows")).toMatchObject({
      rowRole: "task",
      columnRole: "character",
      taskAxis: "rows"
    });
    expect(boardRolesForTableOrientation("tasks_columns")).toMatchObject({
      rowRole: "character",
      columnRole: "task",
      taskAxis: "columns"
    });
    expect(boardRolesForTableOrientation("custom")).toMatchObject({
      rowRole: "custom",
      columnRole: "custom",
      taskAxis: "none"
    });
  });

  it("transposes board table roles without changing custom semantics", () => {
    expect(transposeBoardRoles({ rowRole: "task", columnRole: "character", taskAxis: "rows" })).toEqual({
      rowRole: "character",
      columnRole: "task",
      taskAxis: "columns"
    });
    expect(transposeBoardRoles({ rowRole: "custom", columnRole: "custom", taskAxis: "none" })).toEqual({
      rowRole: "custom",
      columnRole: "custom",
      taskAxis: "none"
    });
  });

  it("plans axis transposition with temporary sort orders to avoid unique collisions", () => {
    expect(
      buildBoardAxisItemTransposePlan([
        { id: "row-task-1", axis: "row", sort_order: 0 },
        { id: "row-task-2", axis: "row", sort_order: 10 },
        { id: "column-character-1", axis: "column", sort_order: 0 },
        { id: "column-character-2", axis: "column", sort_order: 10 }
      ])
    ).toEqual([
      { id: "row-task-1", fromAxis: "row", toAxis: "column", temporarySortOrder: -1000010, finalSortOrder: 0 },
      { id: "row-task-2", fromAxis: "row", toAxis: "column", temporarySortOrder: -1000020, finalSortOrder: 10 },
      {
        id: "column-character-1",
        fromAxis: "column",
        toAxis: "row",
        temporarySortOrder: -2000010,
        finalSortOrder: 0
      },
      {
        id: "column-character-2",
        fromAxis: "column",
        toAxis: "row",
        temporarySortOrder: -2000020,
        finalSortOrder: 10
      }
    ]);
  });

  it("builds task-like manual axis items when the axis role is task", () => {
    expect(
      buildManualBoardAxisItemDraft({
        axis: "row",
        axisRole: "task",
        label: "세르카",
        taskColorIndex: 1
      })
    ).toMatchObject({
      axis: "row",
      kind: "task",
      label: "세르카",
      taskId: null,
      taskScope: "custom",
      taskResetType: "daily",
      taskResetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
      taskColor: "#13795b"
    });
  });

  it("builds free manual axis items when the axis role is not task", () => {
    expect(
      buildManualBoardAxisItemDraft({
        axis: "column",
        axisRole: "custom",
        label: "냠1",
        taskColorIndex: 0
      })
    ).toMatchObject({
      axis: "column",
      kind: "custom",
      label: "냠1",
      taskId: null,
      characterId: null,
      taskScope: null,
      taskResetType: null,
      taskResetRuleJson: null,
      taskColor: null
    });
  });

  it("builds task-like manual rows for custom tables so their checkboxes can reset", () => {
    expect(
      buildManualBoardAxisItemDraft({
        axis: "row",
        axisRole: "custom",
        label: "필드 보스",
        taskColorIndex: 2
      })
    ).toMatchObject({
      axis: "row",
      kind: "task",
      taskScope: "custom",
      taskResetType: "daily",
      taskResetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
      taskColor: "#b45309"
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

  it("keeps the latest board cell state patch per semantic cell", () => {
    expect(
      mergeBoardCellStatePatches([
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          checkboxVisible: false
        },
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          checkboxVisible: true
        }
      ])
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        checkboxVisible: true
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
      { axis: "row", kind: "task", taskId: "task-a", label: "쿠르잔 전선", sortOrder: 0, taskColor: "#2563eb" },
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

  it("maps legacy task-character completions to board row and column item ids", () => {
    expect(
      buildBoardCompletionPatchesFromLegacy({
        tableId: "table-1",
        axisItems: [
          {
            id: "row-task-1",
            axis: "row",
            kind: "task",
            taskId: "task-1",
            characterId: null
          },
          {
            id: "column-character-1",
            axis: "column",
            kind: "character",
            taskId: null,
            characterId: "character-1"
          }
        ],
        completions: [
          {
            taskId: "task-1",
            characterId: "character-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ]
      })
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-task-1",
        columnItemId: "column-character-1",
        periodKey: "daily:2026-06-01",
        completed: true
      }
    ]);
  });

  it("detects board completion patches outside authorized table and axis targets", () => {
    expect(
      findUnauthorizedBoardCompletionPatches(
        [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1",
            periodKey: "daily:2026-06-01",
            completed: true
          },
          {
            tableId: "table-1",
            rowItemId: "row-from-other-table",
            columnItemId: "column-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ],
        [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1"
          }
        ]
      )
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-from-other-table",
        columnItemId: "column-1",
        periodKey: "daily:2026-06-01",
        completed: true
      }
    ]);
  });

  it("detects board completion patches outside the server-derived KST period", () => {
    expect(
      findBoardCompletionPatchesOutsideCurrentPeriod(
        [
          {
            tableId: "table-1",
            rowItemId: "row-task-1",
            columnItemId: "column-1",
            periodKey: "daily:2026-05-28",
            completed: true
          },
          {
            tableId: "table-1",
            rowItemId: "row-task-1",
            columnItemId: "column-2",
            periodKey: "daily:2026-05-29",
            completed: true
          }
        ],
        [
          {
            tableId: "table-1",
            rowItemId: "row-task-1",
            columnItemId: "column-1",
            rowKind: "task",
            columnKind: "character",
            rowTaskResetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
            columnTaskResetRuleJson: null
          },
          {
            tableId: "table-1",
            rowItemId: "row-task-1",
            columnItemId: "column-2",
            rowKind: "task",
            columnKind: "character",
            rowTaskResetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
            columnTaskResetRuleJson: null
          }
        ],
        new Date("2026-05-28T20:59:00.000Z")
      )
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-task-1",
        columnItemId: "column-2",
        periodKey: "daily:2026-05-29",
        completed: true
      }
    ]);
  });

  it("detects board cell state patches outside authorized table and axis targets", () => {
    expect(
      findUnauthorizedBoardCellStatePatches(
        [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1",
            checkboxVisible: false
          },
          {
            tableId: "table-1",
            rowItemId: "row-from-other-table",
            columnItemId: "column-1",
            checkboxVisible: true
          }
        ],
        [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1"
          }
        ]
      )
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-from-other-table",
        columnItemId: "column-1",
        checkboxVisible: true
      }
    ]);
  });
});
