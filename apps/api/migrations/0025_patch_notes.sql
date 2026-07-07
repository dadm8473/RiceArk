CREATE TABLE IF NOT EXISTS patch_notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  author_user_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_patch_notes_published_at
  ON patch_notes (published_at DESC, id DESC);
