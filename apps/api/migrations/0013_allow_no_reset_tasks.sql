PRAGMA foreign_keys = OFF;

CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('character', 'roster')),
  reset_type TEXT NOT NULL CHECK (reset_type IN ('daily', 'weekly', 'biweekly', 'custom', 'none')),
  reset_rule_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_template INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO tasks_new (
  id,
  user_id,
  name,
  scope,
  reset_type,
  reset_rule_json,
  sort_order,
  enabled,
  is_template,
  created_at,
  updated_at
)
SELECT
  id,
  user_id,
  name,
  scope,
  reset_type,
  reset_rule_json,
  sort_order,
  enabled,
  is_template,
  created_at,
  updated_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE TABLE task_overrides_new (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT,
  reset_type TEXT CHECK (reset_type IN ('daily', 'weekly', 'biweekly', 'custom', 'none')),
  reset_rule_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, task_id)
);

INSERT INTO task_overrides_new (
  user_id,
  task_id,
  name,
  reset_type,
  reset_rule_json,
  enabled,
  updated_at
)
SELECT
  user_id,
  task_id,
  name,
  reset_type,
  reset_rule_json,
  enabled,
  updated_at
FROM task_overrides;

DROP TABLE task_overrides;
ALTER TABLE task_overrides_new RENAME TO task_overrides;

CREATE INDEX IF NOT EXISTS idx_task_overrides_user_enabled ON task_overrides(user_id, enabled);

PRAGMA foreign_keys = ON;
