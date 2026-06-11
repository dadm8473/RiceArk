CREATE INDEX IF NOT EXISTS idx_board_tables_user_sort ON board_tables(user_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_board_axis_items_user_table_axis_sort ON board_axis_items(user_id, table_id, axis, sort_order);

CREATE INDEX IF NOT EXISTS idx_board_notes_user_sort ON board_notes(user_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_board_cell_states_user_table ON board_cell_states(user_id, table_id);

CREATE INDEX IF NOT EXISTS idx_board_cell_completions_user_period ON board_cell_completions(user_id, period_key);
