export type BoardAxis = "row" | "column";
export type BoardAxisRole = "character" | "task" | "custom";
export type BoardTaskAxis = "rows" | "columns" | "none";
export type BoardAxisKind = "character" | "task" | "custom";
export type BoardOrientation = "tasks_rows" | "tasks_columns" | "custom";

export interface BoardSheet {
  id: string;
  name: string;
  sort_order: number;
  is_default: number;
}

export interface BoardTable {
  id: string;
  sheet_id: string;
  name: string;
  sort_order: number;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  row_role: BoardAxisRole;
  column_role: BoardAxisRole;
  task_axis: BoardTaskAxis;
  default_row_height: number;
  default_column_width: number;
}

export interface BoardAxisItem {
  id: string;
  table_id: string;
  axis: BoardAxis;
  kind: BoardAxisKind;
  label: string;
  character_id: string | null;
  task_id: string | null;
  task_scope?: "character" | "roster" | "custom" | null;
  task_reset_type?: "daily" | "weekly" | "biweekly" | "custom" | "none" | null;
  task_reset_rule_json?: string | null;
  task_color: string | null;
  size_px: number | null;
  sort_order: number;
  visible: number;
  separator_json?: string | null | undefined;
}

export interface BoardCellState {
  table_id: string;
  row_item_id: string;
  column_item_id: string;
  checkbox_visible: number;
}

export interface BoardCellCompletion {
  table_id: string;
  row_item_id: string;
  column_item_id: string;
  period_key: string;
  completed: number;
}

export interface BoardPayload {
  userId: string;
  sheets: BoardSheet[];
  tables: BoardTable[];
  axisItems: BoardAxisItem[];
  cellStates: BoardCellState[];
  completions: BoardCellCompletion[];
}
