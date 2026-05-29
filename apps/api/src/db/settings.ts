import type { Env } from "../env";

export type ChecklistOrientation = "tasks_rows" | "tasks_columns";

export async function saveUserSettings(
  env: Env,
  userId: string,
  input: {
    density: "comfortable" | "default" | "compact";
    rowHeight: number;
    columnWidth: number;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, density, row_height, column_width, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id)
     DO UPDATE SET density = excluded.density,
                   row_height = excluded.row_height,
                   column_width = excluded.column_width,
                   updated_at = CURRENT_TIMESTAMP`
  )
    .bind(userId, input.density, input.rowHeight, input.columnWidth)
    .run();
}

export async function updateChecklistOrientation(
  env: Env,
  userId: string,
  orientation: ChecklistOrientation
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, checklist_orientation, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id)
     DO UPDATE SET checklist_orientation = excluded.checklist_orientation,
                   updated_at = CURRENT_TIMESTAMP`
  )
    .bind(userId, orientation)
    .run();
}
