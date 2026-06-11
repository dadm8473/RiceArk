ALTER TABLE characters
  ADD COLUMN source TEXT NOT NULL DEFAULT 'lostark'
  CHECK (source IN ('lostark', 'manual'));
