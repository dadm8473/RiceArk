import { describe, expect, it } from "vitest";
import { indexBoardPayloadByTable } from "./boardIndexes";
import type { BoardAxisItem, BoardNote, BoardPayload, BoardTable } from "./types";

function makeTable(id: string, sheetId: string): BoardTable {
  return {
    id,
    sheet_id: sheetId,
    name: id,
    sort_order: 0,
    x: 0,
    y: 0,
    width: null,
    height: null,
    row_role: "custom",
    column_role: "custom",
    task_axis: "none",
    default_row_height: 40,
    default_column_width: 132,
    locked: 0
  };
}

function makeNote(id: string, sheetId: string): BoardNote {
  return {
    id,
    sheet_id: sheetId,
    title: id,
    body: "",
    color: "#ffffff",
    sort_order: 0,
    x: 0,
    y: 0,
    width: 220,
    height: 160,
    locked: 0
  };
}

function makeAxisItem(id: string, tableId: string): BoardAxisItem {
  return {
    id,
    table_id: tableId,
    axis: "row",
    kind: "custom",
    label: id,
    character_id: null,
    task_id: null,
    task_color: null,
    size_px: null,
    sort_order: 0,
    visible: 1
  };
}

const payload = {
  tables: [
    makeTable("table-1a", "sheet-1"),
    makeTable("table-2", "sheet-2"),
    makeTable("table-1b", "sheet-1")
  ],
  notes: [
    makeNote("note-2a", "sheet-2"),
    makeNote("note-1", "sheet-1"),
    makeNote("note-2b", "sheet-2")
  ],
  axisItems: [
    makeAxisItem("axis-1a", "table-1a"),
    makeAxisItem("axis-2", "table-2"),
    makeAxisItem("axis-1b", "table-1a")
  ],
  cellStates: [
    {
      table_id: "table-2",
      row_item_id: "row-2a",
      column_item_id: "column-2",
      checkbox_visible: 1,
      mark_type: "default",
      memo: null,
      mark_period_key: null
    },
    {
      table_id: "table-1a",
      row_item_id: "row-1",
      column_item_id: "column-1",
      checkbox_visible: 1,
      mark_type: "default",
      memo: null,
      mark_period_key: null
    },
    {
      table_id: "table-2",
      row_item_id: "row-2b",
      column_item_id: "column-2",
      checkbox_visible: 1,
      mark_type: "default",
      memo: null,
      mark_period_key: null
    }
  ],
  completions: [
    {
      table_id: "table-1a",
      row_item_id: "row-1a",
      column_item_id: "column-1",
      period_key: "weekly:1",
      completed: 1
    },
    {
      table_id: "table-2",
      row_item_id: "row-2",
      column_item_id: "column-2",
      period_key: "weekly:1",
      completed: 1
    },
    {
      table_id: "table-1a",
      row_item_id: "row-1b",
      column_item_id: "column-1",
      period_key: "weekly:1",
      completed: 0
    }
  ]
} satisfies Pick<BoardPayload, "tables" | "notes" | "axisItems" | "cellStates" | "completions">;

describe("indexBoardPayloadByTable", () => {
  it("groups all five collections in stable source order", () => {
    const indexes = indexBoardPayloadByTable(payload);

    expect(indexes.tablesBySheet.get("sheet-1")?.map((item) => item.id)).toEqual(["table-1a", "table-1b"]);
    expect(indexes.notesBySheet.get("sheet-2")?.map((item) => item.id)).toEqual(["note-2a", "note-2b"]);
    expect(indexes.axisItemsByTable.get("table-1a")?.map((item) => item.id)).toEqual(["axis-1a", "axis-1b"]);
    expect(indexes.cellStatesByTable.get("table-2")?.map((item) => item.row_item_id)).toEqual(["row-2a", "row-2b"]);
    expect(indexes.completionsByTable.get("table-1a")?.map((item) => item.row_item_id)).toEqual(["row-1a", "row-1b"]);
  });

  it("creates isolated buckets without mutating or aliasing source arrays", () => {
    const indexes = indexBoardPayloadByTable(payload);
    const sheetOneTables = indexes.tablesBySheet.get("sheet-1");
    const sheetTwoTables = indexes.tablesBySheet.get("sheet-2");

    expect(sheetOneTables).not.toBe(payload.tables);
    expect(sheetOneTables).not.toBe(sheetTwoTables);
    sheetOneTables?.pop();

    expect(payload.tables.map((item) => item.id)).toEqual(["table-1a", "table-2", "table-1b"]);
    expect(sheetTwoTables?.map((item) => item.id)).toEqual(["table-2"]);
  });

  it("leaves absent keys absent so callers choose their own fallback arrays", () => {
    const indexes = indexBoardPayloadByTable(payload);

    expect(indexes.tablesBySheet.get("missing")).toBeUndefined();
    expect(indexes.notesBySheet.get("missing")).toBeUndefined();
    expect(indexes.axisItemsByTable.get("missing")).toBeUndefined();
    expect(indexes.cellStatesByTable.get("missing")).toBeUndefined();
    expect(indexes.completionsByTable.get("missing")).toBeUndefined();
  });
});
