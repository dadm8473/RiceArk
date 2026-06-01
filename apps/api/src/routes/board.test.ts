import { describe, expect, it } from "vitest";
import {
  boardAxisItemIdParamSchema,
  boardAxisOrderSchema,
  boardAxisSizePatchSchema,
  boardCellStatePatchSchema,
  boardCompletionPatchSchema,
  createBoardAxisItemSchema,
  createBoardSheetSchema,
  createBoardTableSchema,
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
    expect(boardAxisSizePatchSchema.safeParse({ sizePx: 0 }).success).toBe(false);
    expect(boardAxisSizePatchSchema.safeParse({ sizePx: 2000 }).success).toBe(false);
  });

  it("validates board axis item ids for size updates", () => {
    expect(boardAxisItemIdParamSchema.safeParse({ id: "axis-item-1" }).success).toBe(true);
    expect(boardAxisItemIdParamSchema.safeParse({ id: "axis🙂" }).success).toBe(false);
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

  it("rejects unsafe board axis item update labels", () => {
    expect(updateBoardAxisItemSchema.safeParse({ label: "카제로스🙂" }).success).toBe(false);
    expect(updateBoardAxisItemSchema.safeParse({ label: "" }).success).toBe(false);
  });
});
