-- Per-cell checkmark marks: default / fixed (고정) / reserved (예약) / disabled (비활성화)
-- with an optional short memo. Reserved marks capture the period key they were
-- set in so they expire statelessly when the cell's reset period elapses.
-- Disabled absorbs the old checkbox_visible = 0 hiding feature; checkbox_visible
-- is kept in sync on writes for backward compatibility.
ALTER TABLE board_cell_states ADD COLUMN mark_type TEXT NOT NULL DEFAULT 'default'
  CHECK (mark_type IN ('default', 'fixed', 'reserved', 'disabled'));
ALTER TABLE board_cell_states ADD COLUMN memo TEXT;
ALTER TABLE board_cell_states ADD COLUMN mark_period_key TEXT;

UPDATE board_cell_states SET mark_type = 'disabled' WHERE checkbox_visible = 0;
