import type { Env } from "../env";

export type ChecklistOrientation = "tasks_rows" | "tasks_columns";

export interface CharacterDisplaySettings {
  displayName: boolean;
  serverName: boolean;
  className: boolean;
  itemLevel: boolean;
  combatPower: boolean;
}

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

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

export async function updateCharacterDisplaySettings(
  env: Env,
  userId: string,
  input: CharacterDisplaySettings
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_settings (
       user_id,
       show_display_name,
       show_server_name,
       show_class_name,
       show_item_level,
       show_combat_power,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id)
     DO UPDATE SET show_display_name = excluded.show_display_name,
                   show_server_name = excluded.show_server_name,
                   show_class_name = excluded.show_class_name,
                   show_item_level = excluded.show_item_level,
                   show_combat_power = excluded.show_combat_power,
                   updated_at = CURRENT_TIMESTAMP`
  )
    .bind(
      userId,
      boolToInt(input.displayName),
      boolToInt(input.serverName),
      boolToInt(input.className),
      boolToInt(input.itemLevel),
      boolToInt(input.combatPower)
    )
    .run();
}
