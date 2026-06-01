import { describe, expect, it } from "vitest";
import {
  applyBoardAxisOrder,
  getBoardAxisSortableId,
  moveBoardAxisItemIds,
  parseBoardAxisSortableId
} from "./reorder";

describe("board reorder helpers", () => {
  it("round-trips sortable ids even when resource ids contain colons", () => {
    const sortableId = getBoardAxisSortableId("table:1", "row", "axis:item:1");

    expect(parseBoardAxisSortableId(sortableId)).toEqual({
      tableId: "table:1",
      axis: "row",
      axisItemId: "axis:item:1"
    });
  });

  it("ignores malformed sortable ids", () => {
    expect(parseBoardAxisSortableId("row:axis-1")).toBeNull();
    expect(parseBoardAxisSortableId(JSON.stringify(["board-axis", "table-1", "bad", "axis-1"]))).toBeNull();
  });

  it("moves board axis item ids by active and target ids", () => {
    expect(moveBoardAxisItemIds(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(moveBoardAxisItemIds(["a", "b", "c"], "missing", "c")).toEqual(["a", "b", "c"]);
  });

  it("applies sort order updates to the requested table axis only", () => {
    expect(
      applyBoardAxisOrder(
        [
          { id: "a", table_id: "table-1", axis: "row", sort_order: 0 },
          { id: "b", table_id: "table-1", axis: "row", sort_order: 10 },
          { id: "c", table_id: "table-1", axis: "column", sort_order: 0 }
        ],
        "table-1",
        "row",
        ["b", "a"]
      )
    ).toEqual([
      { id: "a", table_id: "table-1", axis: "row", sort_order: 10 },
      { id: "b", table_id: "table-1", axis: "row", sort_order: 0 },
      { id: "c", table_id: "table-1", axis: "column", sort_order: 0 }
    ]);
  });
});
