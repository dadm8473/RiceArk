import { describe, expect, it } from "vitest";
import { boardAxisSizePatchSchema, boardCompletionPatchSchema } from "./board";

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
});
