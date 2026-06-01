ALTER TABLE user_settings
  ADD COLUMN show_display_name INTEGER NOT NULL DEFAULT 1 CHECK (show_display_name IN (0, 1));

ALTER TABLE user_settings
  ADD COLUMN show_server_name INTEGER NOT NULL DEFAULT 0 CHECK (show_server_name IN (0, 1));

ALTER TABLE user_settings
  ADD COLUMN show_class_name INTEGER NOT NULL DEFAULT 0 CHECK (show_class_name IN (0, 1));

ALTER TABLE user_settings
  ADD COLUMN show_item_level INTEGER NOT NULL DEFAULT 1 CHECK (show_item_level IN (0, 1));

ALTER TABLE user_settings
  ADD COLUMN show_combat_power INTEGER NOT NULL DEFAULT 0 CHECK (show_combat_power IN (0, 1));
