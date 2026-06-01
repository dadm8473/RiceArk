import { describe, expect, it } from "vitest";
import {
  applyBoardTableLayoutPatch,
  getBoardTableMovePatch,
  getBoardTableResizePatch,
  normalizeBoardTableLayoutNumber
} from "./tableLayout";
import type { BoardTable } from "./types";

const tables: BoardTable[] = [
  {
    id: "table-1",
    sheet_id: "sheet-1",
    name: "숙제",
    sort_order: 0,
    x: 0,
    y: 0,
    width: null,
    height: null,
    row_role: "task",
    column_role: "character",
    task_axis: "rows",
    default_row_height: 40,
    default_column_width: 132
  },
  {
    id: "table-2",
    sheet_id: "sheet-1",
    name: "격주",
    sort_order: 10,
    x: 24,
    y: 48,
    width: 320,
    height: 200,
    row_role: "custom",
    column_role: "custom",
    task_axis: "none",
    default_row_height: 40,
    default_column_width: 132
  }
];

describe("board table layout helpers", () => {
  it("applies x, y, width, and height to the selected table only", () => {
    expect(
      applyBoardTableLayoutPatch(tables, "table-1", {
        x: 12,
        y: 30,
        width: 360,
        height: 240
      })
    ).toEqual([
      {
        ...tables[0],
        x: 12,
        y: 30,
        width: 360,
        height: 240
      },
      tables[1]
    ]);
  });

  it("keeps nullable table width and height explicit", () => {
    expect(
      applyBoardTableLayoutPatch(tables, "table-2", {
        x: 0,
        y: 0,
        width: null,
        height: null
      })[1]
    ).toMatchObject({
      x: 0,
      y: 0,
      width: null,
      height: null
    });
  });

  it("normalizes compact numeric layout inputs with safe bounds", () => {
    expect(normalizeBoardTableLayoutNumber("42", { min: 0, max: 10000, nullable: false })).toBe(42);
    expect(normalizeBoardTableLayoutNumber("-2", { min: 0, max: 10000, nullable: false })).toBe(0);
    expect(normalizeBoardTableLayoutNumber("50000", { min: 0, max: 10000, nullable: false })).toBe(10000);
    expect(normalizeBoardTableLayoutNumber("", { min: 160, max: 4000, nullable: true })).toBeNull();
  });

  it("builds bounded table move patches from pointer deltas", () => {
    expect(
      getBoardTableMovePatch(
        { x: 20, y: 30, width: 360, height: 240, pointerX: 100, pointerY: 200 },
        { pointerX: 145, pointerY: 260 }
      )
    ).toEqual({ x: 65, y: 90, width: 360, height: 240 });

    expect(
      getBoardTableMovePatch(
        { x: 20, y: 30, width: null, height: null, pointerX: 100, pointerY: 200 },
        { pointerX: 50, pointerY: 150 }
      )
    ).toEqual({ x: 0, y: 0, width: null, height: null });
  });

  it("builds bounded table resize patches from pointer deltas", () => {
    expect(
      getBoardTableResizePatch(
        { x: 20, y: 30, width: 360, height: 240, pointerX: 100, pointerY: 200 },
        { pointerX: 180, pointerY: 250 }
      )
    ).toEqual({ x: 20, y: 30, width: 440, height: 290 });

    expect(
      getBoardTableResizePatch(
        { x: 20, y: 30, width: 360, height: 240, pointerX: 100, pointerY: 200 },
        { pointerX: -500, pointerY: -500 }
      )
    ).toEqual({ x: 20, y: 30, width: 160, height: 120 });
  });
});
