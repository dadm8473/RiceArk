import { describe, expect, it } from "vitest";
import { boardCompletionKey, getBoardOrientation } from "../src/board";

describe("board helpers", () => {
  it("keys completion by semantic row and column ids", () => {
    expect(
      boardCompletionKey({
        tableId: "table-1",
        rowItemId: "row-character-a",
        columnItemId: "column-task-b",
        periodKey: "daily:2026-06-01"
      })
    ).toBe('["table-1","row-character-a","column-task-b","daily:2026-06-01"]');
  });

  it("does not collide when ids contain separators", () => {
    const first = boardCompletionKey({
      tableId: "table:1",
      rowItemId: "row",
      columnItemId: "column",
      periodKey: "daily:2026-06-01"
    });
    const second = boardCompletionKey({
      tableId: "table",
      rowItemId: "1:row",
      columnItemId: "column",
      periodKey: "daily:2026-06-01"
    });

    expect(first).not.toBe(second);
  });

  it("derives table orientation from row and column roles", () => {
    expect(getBoardOrientation({ rowRole: "task", columnRole: "character" })).toBe("tasks_rows");
    expect(getBoardOrientation({ rowRole: "character", columnRole: "task" })).toBe("tasks_columns");
    expect(getBoardOrientation({ rowRole: "custom", columnRole: "custom" })).toBe("custom");
  });
});
