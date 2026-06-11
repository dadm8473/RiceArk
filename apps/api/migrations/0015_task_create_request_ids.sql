ALTER TABLE tasks ADD COLUMN create_request_id TEXT;
ALTER TABLE board_axis_items ADD COLUMN create_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_user_create_request
  ON tasks(user_id, create_request_id)
  WHERE create_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_board_axis_items_table_create_request
  ON board_axis_items(table_id, create_request_id)
  WHERE create_request_id IS NOT NULL;
