UPDATE tasks
SET enabled = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'template-serca'
  AND user_id IS NULL
  AND is_template = 1;
