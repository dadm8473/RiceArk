CREATE TABLE IF NOT EXISTS task_overrides (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT,
  reset_type TEXT CHECK (reset_type IN ('daily', 'weekly', 'biweekly', 'custom')),
  reset_rule_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_overrides_user_enabled ON task_overrides(user_id, enabled);
