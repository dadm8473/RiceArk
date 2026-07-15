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

export interface BoardSheetManifestItem extends BoardSheet {
  version: number;
}

export interface BoardSheetPayloadItem extends BoardSheet {
  content_version: number;
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
  locked: number;
  display_options_json?: string | null | undefined;
  event_options_json?: string | null | undefined;
  template_type?: "custom" | "lostark_event" | string | null | undefined;
}

export interface BoardNote {
  id: string;
  sheet_id: string;
  title: string;
  body: string;
  color: string;
  sort_order: number;
  x: number;
  y: number;
  width: number;
  height: number;
  locked: number;
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
  cross_size_px?: number | null | undefined;
  sort_order: number;
  visible: number;
  separator_json?: string | null | undefined;
  display_options_json?: string | null | undefined;
  character_name?: string | null | undefined;
  character_display_name?: string | null | undefined;
  character_server_name?: string | null | undefined;
  character_class_name?: string | null | undefined;
  character_item_level?: string | null | undefined;
  character_combat_power?: string | null | undefined;
  character_source?: "lostark" | "manual" | string | null | undefined;
}

export interface BoardCellState {
  table_id: string;
  row_item_id: string;
  column_item_id: string;
  checkbox_visible: number;
  mark_type: string;
  mark_icon?: string | null;
  memo: string | null;
  mark_period_key: string | null;
}

export interface BoardCellCompletion {
  table_id: string;
  row_item_id: string;
  column_item_id: string;
  period_key: string;
  completed: number;
}

export interface BoardMutationVersions {
  sheets: Array<{ id: string; version: number }>;
  manifestVersion?: number;
}

export interface BoardDisplaySettings {
  show_display_name: number;
  show_server_name: number;
  show_class_name: number;
  show_item_level: number;
  show_combat_power: number;
}

export interface BoardSheetPayload {
  sheet: BoardSheetPayloadItem;
  tables: BoardTable[];
  notes: BoardNote[];
  axisItems: BoardAxisItem[];
  cellStates: BoardCellState[];
  completions: BoardCellCompletion[];
  periodFingerprint: string;
}

export interface BoardBootstrapPayload {
  userId: string;
  settings: BoardDisplaySettings;
  manifest: {
    version: number;
    sheets: BoardSheetManifestItem[];
  };
  activeSheet: BoardSheetPayload;
}

export interface BoardVersionSummary {
  manifestVersion: number;
  sheets: BoardSheetManifestItem[];
  periodFingerprint: string;
  settings?: BoardDisplaySettings | undefined;
}

export interface BoardPayload {
  userId: string;
  readOnly?: boolean | undefined;
  shareId?: string | undefined;
  settings: BoardDisplaySettings;
  sheets: BoardSheet[];
  tables: BoardTable[];
  notes: BoardNote[];
  axisItems: BoardAxisItem[];
  cellStates: BoardCellState[];
  completions: BoardCellCompletion[];
}
