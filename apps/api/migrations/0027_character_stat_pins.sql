ALTER TABLE characters
  ADD COLUMN item_level_pinned INTEGER NOT NULL DEFAULT 0
  CHECK (item_level_pinned IN (0, 1));

ALTER TABLE characters
  ADD COLUMN combat_power_pinned INTEGER NOT NULL DEFAULT 0
  CHECK (combat_power_pinned IN (0, 1));
