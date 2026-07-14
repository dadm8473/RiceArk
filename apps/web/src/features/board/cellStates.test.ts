import { describe, expect, it } from "vitest";
import { applyBoardCellStatePatch, mergeBoardCellStatePatches, resolveBoardCellMark } from "./cellStates";

describe("board cell state helpers", () => {
  it("adds a cell state row when a cell is disabled", () => {
    expect(
      applyBoardCellStatePatch([], {
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        markType: "disabled",
        markIcon: null,
        memo: null
      })
    ).toEqual([
      {
        table_id: "table-1",
        row_item_id: "row-1",
        column_item_id: "column-1",
        checkbox_visible: 0,
        mark_type: "disabled",
        mark_icon: null,
        memo: null,
        mark_period_key: null
      }
    ]);
  });

  it("stores direct mark icons, memos, and reserved period keys", () => {
    expect(
      applyBoardCellStatePatch([], {
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        markType: "default",
        markIcon: "star",
        memo: "상시 메모"
      })
    ).toEqual([
      {
        table_id: "table-1",
        row_item_id: "row-1",
        column_item_id: "column-1",
        checkbox_visible: 1,
        mark_type: "default",
        mark_icon: "star",
        memo: "상시 메모",
        mark_period_key: null
      }
    ]);

    expect(
      applyBoardCellStatePatch([], {
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        markType: "fixed",
        markIcon: "pin",
        memo: "고정파티 21시"
      })
    ).toEqual([
      {
        table_id: "table-1",
        row_item_id: "row-1",
        column_item_id: "column-1",
        checkbox_visible: 1,
        mark_type: "fixed",
        mark_icon: "pin",
        memo: "고정파티 21시",
        mark_period_key: null
      }
    ]);

    expect(
      applyBoardCellStatePatch([], {
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        markType: "reserved",
        markIcon: "clock",
        memo: "이번주만",
        periodKey: "weekly:2026-06-10"
      })
    ).toEqual([
      {
        table_id: "table-1",
        row_item_id: "row-1",
        column_item_id: "column-1",
        checkbox_visible: 1,
        mark_type: "reserved",
        mark_icon: "clock",
        memo: "이번주만",
        mark_period_key: "weekly:2026-06-10"
      }
    ]);
  });

  it("removes explicit cell state when a cell returns to default", () => {
    expect(
      applyBoardCellStatePatch(
        [
          {
            table_id: "table-1",
            row_item_id: "row-1",
            column_item_id: "column-1",
            checkbox_visible: 0,
            mark_type: "disabled",
            mark_icon: null,
            memo: null,
            mark_period_key: null
          }
        ],
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          markType: "default",
          markIcon: null,
          memo: null
        }
      )
    ).toEqual([]);
  });

  it("keeps only the latest mark patch per board cell", () => {
    expect(
      mergeBoardCellStatePatches([
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          markType: "disabled",
          markIcon: null,
          memo: null
        },
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          markType: "fixed",
          markIcon: "pin",
          memo: "고정"
        }
      ])
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        markType: "fixed",
        markIcon: "pin",
        memo: "고정"
      }
    ]);
  });

  it("resolves marks and expires reserved marks outside the current period", () => {
    const base = { table_id: "table-1", row_item_id: "row-1", column_item_id: "column-1" };

    expect(resolveBoardCellMark(undefined, "weekly:2026-06-10")).toBeNull();
    expect(
      resolveBoardCellMark(
        { ...base, checkbox_visible: 1, mark_type: "default", mark_icon: "star", memo: "상시 메모", mark_period_key: null },
        "weekly:2026-06-10"
      )
    ).toEqual({ type: "default", icon: "star", retention: "permanent", memo: "상시 메모" });
    expect(
      resolveBoardCellMark(
        { ...base, checkbox_visible: 1, mark_type: "fixed", mark_icon: null, memo: "고정파티", mark_period_key: null },
        "weekly:2026-06-10"
      )
    ).toEqual({ type: "fixed", icon: "pin", retention: "permanent", memo: "고정파티" });
    expect(
      resolveBoardCellMark(
        { ...base, checkbox_visible: 1, mark_type: "reserved", mark_icon: null, memo: "이번주만", mark_period_key: "weekly:2026-06-10" },
        "weekly:2026-06-10"
      )
    ).toEqual({ type: "reserved", icon: "clock", retention: "period", memo: "이번주만" });
    expect(
      resolveBoardCellMark(
        { ...base, checkbox_visible: 1, mark_type: "default", mark_icon: null, memo: "메모만", mark_period_key: null },
        "weekly:2026-06-10"
      )
    ).toEqual({ type: "default", icon: "memo", retention: "permanent", memo: "메모만" });
    expect(
      resolveBoardCellMark(
        { ...base, checkbox_visible: 1, mark_type: "reserved", mark_icon: "flag", memo: "지난주 약속", mark_period_key: "weekly:2026-06-03" },
        "weekly:2026-06-10"
      )
    ).toBeNull();
    expect(
      resolveBoardCellMark(
        { ...base, checkbox_visible: 0, mark_type: "disabled", mark_icon: null, memo: null, mark_period_key: null },
        null
      )
    ).toEqual({ type: "disabled", icon: null, retention: "permanent", memo: null });
  });
});
