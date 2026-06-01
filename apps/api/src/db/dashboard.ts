import type { Env } from "../env";

export async function loadDashboard(env: Env, userId: string) {
  const [characters, tasks, completions, settings] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM characters WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL ORDER BY sort_order, name"
    )
      .bind(userId)
      .all(),
    env.DB.prepare(
      `SELECT tasks.id,
              tasks.user_id,
              COALESCE(task_overrides.name, tasks.name) AS name,
              tasks.scope,
              COALESCE(task_overrides.reset_type, tasks.reset_type) AS reset_type,
              COALESCE(task_overrides.reset_rule_json, tasks.reset_rule_json) AS reset_rule_json,
              tasks.sort_order,
              tasks.enabled,
              tasks.is_template,
              tasks.created_at,
              tasks.updated_at
       FROM tasks
       LEFT JOIN task_orders ON task_orders.task_id = tasks.id AND task_orders.user_id = ?
       LEFT JOIN task_overrides ON task_overrides.task_id = tasks.id AND task_overrides.user_id = ?
       WHERE (tasks.user_id = ? OR tasks.is_template = 1) AND tasks.enabled = 1
         AND COALESCE(task_overrides.enabled, 1) = 1
       ORDER BY COALESCE(task_orders.sort_order, tasks.sort_order), COALESCE(task_overrides.name, tasks.name)`
    )
      .bind(userId, userId, userId)
      .all(),
    env.DB.prepare("SELECT task_id, character_id, period_key, completed FROM completions WHERE user_id = ?")
      .bind(userId)
      .all(),
    env.DB.prepare("SELECT * FROM user_settings WHERE user_id = ?").bind(userId).first()
  ]);

  return {
    characters: characters.results,
    tasks: tasks.results,
    completions: completions.results,
    settings: settings ?? {
      density: "default",
      row_height: 40,
      column_width: 132,
      checklist_orientation: "tasks_rows",
      show_display_name: 1,
      show_server_name: 0,
      show_class_name: 0,
      show_item_level: 1,
      show_combat_power: 0
    }
  };
}
