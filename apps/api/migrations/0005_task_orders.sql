CREATE TABLE IF NOT EXISTS task_orders (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_orders_user_sort ON task_orders(user_id, sort_order);
