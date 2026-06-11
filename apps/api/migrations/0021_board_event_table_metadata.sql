ALTER TABLE board_tables
  ADD COLUMN template_type TEXT NOT NULL DEFAULT 'custom'
  CHECK (template_type IN ('custom', 'lostark_event'));

ALTER TABLE board_tables
  ADD COLUMN event_options_json TEXT;
