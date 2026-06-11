ALTER TABLE sheets
  ADD COLUMN content_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS board_manifest_versions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS board_shares (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_user_id, sheet_id)
);

CREATE INDEX IF NOT EXISTS idx_board_shares_owner_sheet ON board_shares(owner_user_id, sheet_id);
CREATE INDEX IF NOT EXISTS idx_board_shares_share_id ON board_shares(share_id);

CREATE TABLE IF NOT EXISTS board_share_favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, share_id),
  UNIQUE (user_id, share_id)
);

CREATE INDEX IF NOT EXISTS idx_board_share_favorites_user_sort ON board_share_favorites(user_id, created_at);
