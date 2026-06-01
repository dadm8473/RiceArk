import { describe, expect, it } from "vitest";
import { applyBoardCellStatePatch, mergeBoardCellStatePatches } from "./cellStates";

describe("board cell state helpers", () => {
  it("adds hidden cell state when a checkbox is hidden", () => {
    expect(
      applyBoardCellStatePatch([], {
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        checkboxVisible: false
      })
    ).toEqual([
      {
        table_id: "table-1",
        row_item_id: "row-1",
        column_item_id: "column-1",
        checkbox_visible: 0
      }
    ]);
  });

  it("removes explicit cell state when a checkbox returns to visible default", () => {
    expect(
      applyBoardCellStatePatch(
        [
          {
            table_id: "table-1",
            row_item_id: "row-1",
            column_item_id: "column-1",
            checkbox_visible: 0
          }
        ],
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          checkboxVisible: true
        }
      )
    ).toEqual([]);
  });

  it("keeps only the latest visibility patch per board cell", () => {
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
});
