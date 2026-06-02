import { describe, expect, it } from "vitest";
import {
  boardAxisItemIdParamSchema,
  boardAxisOrderSchema,
  boardCellStatePatchBatchSchema,
  boardAxisSizePatchSchema,
  boardCellStatePatchSchema,
  boardCompletionPatchSchema,
  boardSheetIdParamSchema,
  boardTableIdParamSchema,
  boardTableLayoutPatchSchema,
  createBoardAxisItemSchema,
  createBoardSheetSchema,
  createBoardTableSchema,
  importBoardCharactersSchema,
  updateBoardTableSettingsSchema,
  updateBoardAxisItemSchema
} from "./board";

describe("board route schemas", () => {
  it("accepts small board completion batches", () => {
    expect(
      boardCompletionPatchSchema.safeParse({
        patches: [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ]
      }).success
    ).toBe(true);
  });

  it("rejects oversized board completion batches and unsafe ids", () => {
    expect(
      boardCompletionPatchSchema.safeParse({
        patches: new Array(201).fill({
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          periodKey: "daily:2026-06-01",
          completed: true
        })
      }).success
    ).toBe(false);

    expect(
      boardCompletionPatchSchema.safeParse({
        patches: [
          {
            tableId: "table🙂",
            rowItemId: "row-1",
            columnItemId: "column-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ]
      }).success
    ).toBe(false);
  });

  it("accepts bounded pixel sizes", () => {
    expect(boardAxisSizePatchSchema.safeParse({ sizePx: 48 }).success).toBe(true);
    expect(boardAxisSizePatchSchema.safeParse({ sizePx: 48, crossSizePx: 160 }).success).toBe(true);
    expect(boardAxisSizePatchSchema.safeParse({ crossSizePx: 48 }).success).toBe(true);
    expect(boardAxisSizePatchSchema.safeParse({}).success).toBe(false);
    expect(boardAxisSizePatchSchema.safeParse({ sizePx: 0 }).success).toBe(false);
    expect(boardAxisSizePatchSchema.safeParse({ crossSizePx: 0 }).success).toBe(false);
    expect(boardAxisSizePatchSchema.safeParse({ sizePx: 2000 }).success).toBe(false);
    expect(boardAxisSizePatchSchema.safeParse({ crossSizePx: 2000 }).success).toBe(false);
  });

  it("validates board axis item ids for size updates", () => {
    expect(boardAxisItemIdParamSchema.safeParse({ id: "axis-item-1" }).success).toBe(true);
    expect(boardAxisItemIdParamSchema.safeParse({ id: "axis🙂" }).success).toBe(false);
  });

  it("accepts bounded board table layout patches", () => {
    expect(boardTableIdParamSchema.safeParse({ id: "table-1" }).success).toBe(true);
    expect(boardTableIdParamSchema.safeParse({ id: "table🙂" }).success).toBe(false);
    expect(boardTableLayoutPatchSchema.safeParse({ x: 24, y: 48, width: 360, height: 240 }).success).toBe(true);
    expect(boardTableLayoutPatchSchema.safeParse({ x: 0, y: 0, width: null, height: null }).success).toBe(true);
  });

  it("validates board table ids for table-level actions", () => {
    expect(boardTableIdParamSchema.safeParse({ id: "table-1" }).success).toBe(true);
    expect(boardTableIdParamSchema.safeParse({ id: "table🙂" }).success).toBe(false);
  });

  it("validates board sheet ids for sheet-level actions", () => {
    expect(boardSheetIdParamSchema.safeParse({ id: "sheet-1" }).success).toBe(true);
    expect(boardSheetIdParamSchema.safeParse({ id: "sheet🙂" }).success).toBe(false);
  });

  it("rejects unsafe board table layout patches", () => {
    expect(boardTableLayoutPatchSchema.safeParse({ x: -1, y: 0, width: 360, height: 240 }).success).toBe(false);
    expect(boardTableLayoutPatchSchema.safeParse({ x: 0, y: -1, width: 360, height: 240 }).success).toBe(false);
    expect(boardTableLayoutPatchSchema.safeParse({ x: 0, y: 0, width: 120, height: 240 }).success).toBe(false);
    expect(boardTableLayoutPatchSchema.safeParse({ x: 0, y: 0, width: 360, height: 80 }).success).toBe(false);
    expect(boardTableLayoutPatchSchema.safeParse({ x: 10001, y: 0, width: 360, height: 240 }).success).toBe(false);
  });

  it("accepts complete board axis order payloads", () => {
    expect(
      boardAxisOrderSchema.safeParse({
        tableId: "table-1",
        axis: "row",
        axisItemIds: ["row-1", "row-2"]
      }).success
    ).toBe(true);
  });

  it("rejects duplicate or unsafe board axis order payloads", () => {
    expect(
      boardAxisOrderSchema.safeParse({
        tableId: "table-1",
        axis: "row",
        axisItemIds: ["row-1", "row-1"]
      }).success
    ).toBe(false);
    expect(
      boardAxisOrderSchema.safeParse({
        tableId: "table🙂",
        axis: "row",
        axisItemIds: ["row-1"]
      }).success
    ).toBe(false);
    expect(
      boardAxisOrderSchema.safeParse({
        tableId: "table-1",
        axis: "diagonal",
        axisItemIds: ["row-1"]
      }).success
    ).toBe(false);
  });

  it("accepts board cell visibility patches", () => {
    expect(
      boardCellStatePatchSchema.safeParse({
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        checkboxVisible: false
      }).success
    ).toBe(true);
  });

  it("rejects unsafe board cell visibility patches", () => {
    expect(
      boardCellStatePatchSchema.safeParse({
        tableId: "table🙂",
        rowItemId: "row-1",
        columnItemId: "column-1",
        checkboxVisible: false
      }).success
    ).toBe(false);
    expect(
      boardCellStatePatchSchema.safeParse({
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        checkboxVisible: "no"
      }).success
    ).toBe(false);
  });

  it("accepts small board cell visibility batches", () => {
    expect(
      boardCellStatePatchBatchSchema.safeParse({
        patches: [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1",
            checkboxVisible: false
          },
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-2",
            checkboxVisible: true
          }
        ]
      }).success
    ).toBe(true);
  });

  it("rejects oversized board cell visibility batches and unsafe ids", () => {
    expect(
      boardCellStatePatchBatchSchema.safeParse({
        patches: new Array(201).fill({
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          checkboxVisible: false
        })
      }).success
    ).toBe(false);

    expect(
      boardCellStatePatchBatchSchema.safeParse({
        patches: [
          {
            tableId: "table-1",
            rowItemId: "row🙂",
            columnItemId: "column-1",
            checkboxVisible: false
          }
        ]
      }).success
    ).toBe(false);
  });

  it("accepts normalized sheet and table names for board creation", () => {
    expect(createBoardSheetSchema.parse({ name: "  원정대  " })).toEqual({ name: "원정대" });
    expect(createBoardTableSchema.parse({ sheetId: "sheet-1", name: "  격주 이벤트  ", orientation: "custom" })).toEqual({
      sheetId: "sheet-1",
      name: "격주 이벤트",
      orientation: "custom"
    });
  });

  it("rejects unsafe board creation input", () => {
    expect(createBoardSheetSchema.safeParse({ name: "원정대🙂" }).success).toBe(false);
    expect(createBoardSheetSchema.safeParse({ name: "" }).success).toBe(false);
    expect(createBoardTableSchema.safeParse({ sheetId: "sheet🙂", name: "숙제", orientation: "tasks_rows" }).success).toBe(false);
    expect(createBoardTableSchema.safeParse({ sheetId: "sheet-1", name: "숙제", orientation: "unknown" }).success).toBe(false);
    expect(createBoardTableSchema.safeParse({ sheetId: "sheet-1", name: "숙제", orientation: "custom", extra: "x" }).success).toBe(false);
    expect(
      createBoardTableSchema.safeParse({
        sheetId: "sheet-1",
        name: "숙제",
        orientation: "custom",
        defaultRowHeight: 9999
      }).success
    ).toBe(false);
  });

  it("validates board table settings strictly", () => {
    expect(
      updateBoardTableSettingsSchema.safeParse({
        name: "숙제",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        locked: 1,
        displaySettings: {
          show_display_name: 1,
          show_server_name: 0,
          show_class_name: 0,
          show_item_level: 1,
          show_combat_power: 0
        }
      }).success
    ).toBe(true);
    expect(
      updateBoardTableSettingsSchema.safeParse({
        name: "숙제",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        locked: 2
      }).success
    ).toBe(false);
    expect(
      updateBoardTableSettingsSchema.safeParse({
        name: "숙제",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        applyRowSize: true
      }).success
    ).toBe(false);
    expect(
      updateBoardTableSettingsSchema.safeParse({
        name: "숙제",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        displaySettings: {
          show_display_name: 2,
          show_server_name: 0,
          show_class_name: 0,
          show_item_level: 1,
          show_combat_power: 0
        }
      }).success
    ).toBe(false);
  });

  it("accepts normalized custom axis item labels for board tables", () => {
    expect(createBoardAxisItemSchema.parse({ tableId: "table-1", axis: "row", label: "  카제로스  " })).toEqual({
      tableId: "table-1",
      axis: "row",
      label: "카제로스"
    });
  });

  it("rejects unsafe custom axis item input", () => {
    expect(createBoardAxisItemSchema.safeParse({ tableId: "table🙂", axis: "row", label: "카제로스" }).success).toBe(false);
    expect(createBoardAxisItemSchema.safeParse({ tableId: "table-1", axis: "diagonal", label: "카제로스" }).success).toBe(false);
    expect(createBoardAxisItemSchema.safeParse({ tableId: "table-1", axis: "row", label: "카제로스🙂" }).success).toBe(false);
    expect(createBoardAxisItemSchema.safeParse({ tableId: "table-1", axis: "row", label: "" }).success).toBe(false);
  });

  it("accepts normalized board axis item labels for updates", () => {
    expect(updateBoardAxisItemSchema.parse({ label: "  카제로스  " })).toEqual({ label: "카제로스" });
  });

  it("accepts normalized task colors for board axis item updates", () => {
    expect(updateBoardAxisItemSchema.parse({ label: "카제로스", taskColor: "#BE123C" })).toEqual({
      label: "카제로스",
      taskColor: "#be123c"
    });
    expect(updateBoardAxisItemSchema.parse({ label: "카제로스", taskColor: null })).toEqual({
      label: "카제로스",
      taskColor: null
    });
  });

  it("accepts normalized separator settings for board axis item updates", () => {
    expect(
      updateBoardAxisItemSchema.parse({
        label: "카제로스",
        separator: { widthPx: 3, style: "dashed", color: "#3344AA" }
      })
    ).toEqual({
      label: "카제로스",
      separator: { widthPx: 3, style: "dashed", color: "#3344aa" }
    });
    expect(updateBoardAxisItemSchema.parse({ label: "카제로스", separator: null })).toEqual({
      label: "카제로스",
      separator: null
    });
  });

  it("rejects unsafe board axis item update labels", () => {
    expect(updateBoardAxisItemSchema.safeParse({ label: "카제로스🙂" }).success).toBe(false);
    expect(updateBoardAxisItemSchema.safeParse({ label: "" }).success).toBe(false);
    expect(updateBoardAxisItemSchema.safeParse({ label: "카제로스", taskColor: "blue" }).success).toBe(false);
    expect(updateBoardAxisItemSchema.safeParse({ label: "카제로스", taskColor: "#12345g" }).success).toBe(false);
    expect(
      updateBoardAxisItemSchema.safeParse({
        label: "카제로스",
        separator: { widthPx: 0, style: "solid", color: "#334455" }
      }).success
    ).toBe(false);
    expect(
      updateBoardAxisItemSchema.safeParse({
        label: "카제로스",
        separator: { widthPx: 2, style: "double", color: "#334455" }
      }).success
    ).toBe(false);
    expect(updateBoardAxisItemSchema.safeParse({ label: "카제로스", unknown: true }).success).toBe(false);
  });

  it("rejects unsafe table-scoped character imports", () => {
    expect(
      importBoardCharactersSchema.safeParse({
        characters: [
          {
            name: "냠수 나이스1",
            serverName: "아만",
            className: "브레이커",
            itemLevel: "1,778.33",
            combatPower: "2,549.41"
          }
        ]
      }).success
    ).toBe(false);
    expect(
      importBoardCharactersSchema.safeParse({
        characters: [
          {
            name: "냠수나이스1",
            serverName: "아만🙂",
            className: "브레이커",
            itemLevel: "1,778.33",
            combatPower: "2,549.41"
          }
        ]
      }).success
    ).toBe(false);
  });
});
