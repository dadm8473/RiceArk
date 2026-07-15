import { describe, expect, it } from "vitest";
import {
  buildBoardCellStatePayloadRows,
  buildBoardCompletionPayloadRows,
  prepareBoardBulkPreflightStatement,
  prepareBoardCellStateWriteStatements,
  prepareBoardCompletionWriteStatements,
  type GuardedBoardCellStatePayloadRow,
  type GuardedBoardCompletionPayloadRow
} from "./boardBulkSql";

interface CapturedStatement {
  sql: string;
  values: unknown[];
}

function captureEnv() {
  const prepared: CapturedStatement[] = [];
  return {
    prepared,
    env: {
      DB: {
        prepare(sql: string) {
          const statement = {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              const bound = { sql, values };
              prepared.push(bound);
              return bound;
            }
          };
          return statement;
        }
      }
    }
  };
}

function guardCompletionRows(rows: ReturnType<typeof buildBoardCompletionPayloadRows>): GuardedBoardCompletionPayloadRow[] {
  return rows.map((row, index) => ({
    ...row,
    sheet_id: index < 100 ? "sheet-a" : "sheet-b",
    row_kind: "task",
    column_kind: "character",
    row_task_reset_rule_json: '{"type":"none"}',
    column_task_reset_rule_json: null,
    guard_expires_at: null
  }));
}

describe("board bulk SQL", () => {
  it("normalizes completion ids and one snake_case JSON payload for 200 rows", () => {
    const rows = buildBoardCompletionPayloadRows(
      Array.from({ length: 200 }, (_, index) => ({
        tableId: index < 100 ? "table-a" : "table-b",
        rowItemId: `row-${index}`,
        columnItemId: `column-${index}`,
        periodKey: "none:permanent",
        completed: index % 2 === 0
      })),
      (index) => `completion-${index}`
    );
    const guarded = guardCompletionRows(rows);
    const { env, prepared } = captureEnv();

    prepareBoardBulkPreflightStatement(env as never, "user-1", JSON.stringify(rows));
    prepareBoardCompletionWriteStatements(env as never, "user-1", JSON.stringify(guarded));

    expect(rows).toHaveLength(200);
    expect(rows[0]).toEqual({
      id: "completion-0",
      table_id: "table-a",
      row_item_id: "row-0",
      column_item_id: "column-0",
      period_key: "none:permanent",
      completed: 1
    });
    expect(prepared).toHaveLength(4);
    expect(prepared.every((statement) => statement.values.length === 2)).toBe(true);
    expect(prepared.every((statement) => statement.values[0] === "user-1")).toBe(true);
    expect(prepared.every((statement) => typeof statement.values[1] === "string")).toBe(true);
    expect(prepared.every((statement) => statement.sql.includes("json_each(?2)"))).toBe(true);
    expect(prepared[0]?.sql).not.toContain("board_cell_states");
    expect(prepared.some((statement) => statement.sql.includes("VALUES (?,"))).toBe(false);
  });

  it("normalizes cell-state delete, disabled, reserved, memo, and icon behavior", () => {
    const rows = buildBoardCellStatePayloadRows(
      [
        { tableId: "t", rowItemId: "r1", columnItemId: "c", markType: "default", memo: "", markIcon: null },
        { tableId: "t", rowItemId: "r2", columnItemId: "c", markType: "disabled", memo: "ignored", markIcon: "star" },
        { tableId: "t", rowItemId: "r3", columnItemId: "c", markType: "reserved", memo: "memo", markIcon: "clock", periodKey: "daily:2026-07-15" },
        { tableId: "t", rowItemId: "r4", columnItemId: "c", markType: "fixed", memo: null, markIcon: "pin", periodKey: "daily:ignored" }
      ],
      (index) => `state-${index}`
    );

    expect(rows.map(({ id: _id, ...row }) => row)).toEqual([
      { table_id: "t", row_item_id: "r1", column_item_id: "c", checkbox_visible: 1, mark_type: "default", mark_icon: null, memo: null, mark_period_key: null, delete_state: 1 },
      { table_id: "t", row_item_id: "r2", column_item_id: "c", checkbox_visible: 0, mark_type: "disabled", mark_icon: null, memo: null, mark_period_key: null, delete_state: 0 },
      { table_id: "t", row_item_id: "r3", column_item_id: "c", checkbox_visible: 1, mark_type: "reserved", mark_icon: "clock", memo: "memo", mark_period_key: "daily:2026-07-15", delete_state: 0 },
      { table_id: "t", row_item_id: "r4", column_item_id: "c", checkbox_visible: 1, mark_type: "fixed", mark_icon: "pin", memo: null, mark_period_key: null, delete_state: 0 }
    ]);
  });

  it("uses four bounded write statements for mixed cell-state rows", () => {
    const base = buildBoardCellStatePayloadRows(
      [{ tableId: "t", rowItemId: "r", columnItemId: "c", markType: "fixed", memo: null }],
      () => "state-1"
    )[0]!;
    const guarded: GuardedBoardCellStatePayloadRow[] = [{
      ...base,
      sheet_id: "sheet-1",
      row_kind: "task",
      column_kind: "character",
      row_task_reset_rule_json: '{"type":"none"}',
      column_task_reset_rule_json: null,
      guard_expires_at: null
    }];
    const { env, prepared } = captureEnv();

    prepareBoardCellStateWriteStatements(env as never, "user-1", JSON.stringify(guarded));

    expect(prepared).toHaveLength(4);
    expect(prepared.map((statement) => statement.values.length)).toEqual([2, 2, 2, 2]);
    expect(prepared[0]?.sql).toMatch(/^WITH[\s\S]*DELETE FROM board_cell_states/);
    expect(prepared[1]?.sql).toMatch(/^WITH[\s\S]*INSERT INTO board_cell_states/);
    expect(prepared[1]?.sql).toMatch(/WHERE[\s\S]*ON CONFLICT/);
    expect(prepared[2]?.sql).toContain("guard assertion");
    expect(prepared[3]?.sql).toMatch(/^WITH[\s\S]*UPDATE sheets/);
  });
});
