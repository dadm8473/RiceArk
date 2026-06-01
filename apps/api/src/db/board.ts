import type { BoardAxisRole, BoardTaskAxis } from "@riceark/core";
import type { Env } from "../env";
import type { ChecklistOrientation } from "./settings";

export const DEFAULT_SHEET_NAME = "기본";
export const DEFAULT_TABLE_NAME = "숙제";

export interface BoardRoles {
  rowRole: BoardAxisRole;
  columnRole: BoardAxisRole;
  taskAxis: BoardTaskAxis;
}

export interface BoardPayload {
  userId: string;
  sheets: unknown[];
  tables: unknown[];
  axisItems: unknown[];
  cellStates: unknown[];
  completions: unknown[];
}

export function defaultBoardRolesForOrientation(orientation: ChecklistOrientation): BoardRoles {
  if (orientation === "tasks_columns") {
    return {
      rowRole: "character",
      columnRole: "task",
      taskAxis: "columns"
    };
  }

  return {
    rowRole: "task",
    columnRole: "character",
    taskAxis: "rows"
  };
}

export async function loadBoard(env: Env, userId: string): Promise<BoardPayload> {
  const [sheets, tables, axisItems, cellStates, completions] = await Promise.all([
    env.DB.prepare("SELECT * FROM sheets WHERE user_id = ? ORDER BY sort_order, name").bind(userId).all(),
    env.DB.prepare("SELECT * FROM board_tables WHERE user_id = ? ORDER BY sort_order, name").bind(userId).all(),
    env.DB.prepare("SELECT * FROM board_axis_items WHERE user_id = ? ORDER BY table_id, axis, sort_order, label")
      .bind(userId)
      .all(),
    env.DB.prepare("SELECT * FROM board_cell_states WHERE user_id = ? ORDER BY table_id, row_item_id, column_item_id")
      .bind(userId)
      .all(),
    env.DB.prepare(
      "SELECT table_id, row_item_id, column_item_id, period_key, completed FROM board_cell_completions WHERE user_id = ?"
    )
      .bind(userId)
      .all()
  ]);

  return {
    userId,
    sheets: sheets.results,
    tables: tables.results,
    axisItems: axisItems.results,
    cellStates: cellStates.results,
    completions: completions.results
  };
}
