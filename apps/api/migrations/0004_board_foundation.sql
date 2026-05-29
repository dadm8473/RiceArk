ALTER TABLE characters ADD COLUMN display_name TEXT;

ALTER TABLE user_settings
  ADD COLUMN checklist_orientation TEXT NOT NULL DEFAULT 'tasks_rows'
  CHECK (checklist_orientation IN ('tasks_rows', 'tasks_columns'));
