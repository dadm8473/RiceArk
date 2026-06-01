import { describe, expect, it } from "vitest";
import { applyBoardCompletionPatch, getBoardCellPeriodKey, mergeBoardCompletionPatches } from "./completions";
import type { BoardAxisItem, BoardCellCompletion } from "./types";

const taskRow: BoardAxisItem = {
  id: "row-task-1",
  table_id: "table-1",
  axis: "row",
  kind: "task",
  label: "쿠르잔 전선",
  character_id: null,
  task_id: "task-1",
  task_color: "#2563eb",
  task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
  size_px: null,
  sort_order: 0,
  visible: 1
};

const characterColumn: BoardAxisItem = {
  id: "column-character-1",
  table_id: "table-1",
  axis: "column",
  kind: "character",
  label: "냠수나이스1",
  character_id: "character-1",
  task_id: null,
  task_color: null,
  task_reset_rule_json: null,
  size_px: null,
  sort_order: 0,
  visible: 1
};

describe("board completion helpers", () => {
  it("derives the current period from the task axis item", () => {
    expect(getBoardCellPeriodKey(taskRow, characterColumn, new Date("2026-06-01T00:00:00.000Z"))).toBe("daily:2026-06-01");
  });

  it("applies a completion patch without changing unrelated cells", () => {
    const completions: BoardCellCompletion[] = [
      {
        table_id: "table-1",
        row_item_id: "row-task-1",
        column_item_id: "column-character-2",
        period_key: "daily:2026-06-01",
        completed: 1
      }
    ];

    expect(
      applyBoardCompletionPatch(completions, {
        tableId: "table-1",
        rowItemId: "row-task-1",
        columnItemId: "column-character-1",
        periodKey: "daily:2026-06-01",
        completed: true
      })
    ).toEqual([
      completions[0],
      {
        table_id: "table-1",
        row_item_id: "row-task-1",
        column_item_id: "column-character-1",
        period_key: "daily:2026-06-01",
        completed: 1
      }
    ]);
  });

  it("keeps only the latest patch per board cell period", () => {
    expect(
      mergeBoardCompletionPatches([
        {
          tableId: "table-1",
          rowItemId: "row-task-1",
          columnItemId: "column-character-1",
          periodKey: "daily:2026-06-01",
          completed: true
        },
        {
          tableId: "table-1",
          rowItemId: "row-task-1",
          columnItemId: "column-character-1",
          periodKey: "daily:2026-06-01",
          completed: false
        }
      ])
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-task-1",
        columnItemId: "column-character-1",
        periodKey: "daily:2026-06-01",
        completed: false
      }
    ]);
  });
});
