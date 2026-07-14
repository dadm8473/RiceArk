-- Optional per-cell icon displayed inside the checkbox. Existing legacy
-- fixed/reserved/default memo rows are interpreted as pin/clock/memo when this
-- value is NULL.
ALTER TABLE board_cell_states ADD COLUMN mark_icon TEXT;
