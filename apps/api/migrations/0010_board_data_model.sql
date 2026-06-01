CREATE TABLE IF NOT EXISTS sheets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS board_tables (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  x INTEGER NOT NULL DEFAULT 0,
  y INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  row_role TEXT NOT NULL CHECK (row_role IN ('character', 'task', 'custom')),
  column_role TEXT NOT NULL CHECK (column_role IN ('character', 'task', 'custom')),
  task_axis TEXT NOT NULL CHECK (task_axis IN ('rows', 'columns', 'none')),
  default_row_height INTEGER NOT NULL DEFAULT 40,
  default_column_width INTEGER NOT NULL DEFAULT 132,
  default_reset_rule_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS board_axis_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES board_tables(id) ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK (axis IN ('row', 'column')),
  kind TEXT NOT NULL CHECK (kind IN ('character', 'task', 'custom')),
  label TEXT NOT NULL,
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  task_scope TEXT CHECK (task_scope IN ('character', 'roster', 'custom')),
  task_reset_type TEXT CHECK (task_reset_type IN ('daily', 'weekly', 'biweekly', 'custom', 'none')),
  task_reset_rule_json TEXT,
  task_color TEXT,
  size_px INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  separator_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (table_id, axis, sort_order)
);

CREATE TABLE IF NOT EXISTS board_cell_states (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES board_tables(id) ON DELETE CASCADE,
  row_item_id TEXT NOT NULL REFERENCES board_axis_items(id) ON DELETE CASCADE,
  column_item_id TEXT NOT NULL REFERENCES board_axis_items(id) ON DELETE CASCADE,
  checkbox_visible INTEGER NOT NULL DEFAULT 1 CHECK (checkbox_visible IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (table_id, row_item_id, column_item_id)
);

CREATE TABLE IF NOT EXISTS board_cell_completions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES board_tables(id) ON DELETE CASCADE,
  row_item_id TEXT NOT NULL REFERENCES board_axis_items(id) ON DELETE CASCADE,
  column_item_id TEXT NOT NULL REFERENCES board_axis_items(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, table_id, row_item_id, column_item_id, period_key)
);

CREATE INDEX IF NOT EXISTS idx_sheets_user_sort ON sheets(user_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_board_tables_sheet_sort ON board_tables(sheet_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_board_axis_items_table_axis_sort ON board_axis_items(table_id, axis, sort_order);
CREATE INDEX IF NOT EXISTS idx_board_cell_states_table ON board_cell_states(table_id);
CREATE INDEX IF NOT EXISTS idx_board_cell_completions_user_table_period ON board_cell_completions(user_id, table_id, period_key);
