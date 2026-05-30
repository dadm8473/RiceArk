import type { Env } from "../env";

export async function loadDashboard(env: Env, userId: string) {
  const [characters, tasks, completions, settings] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM characters WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL ORDER BY sort_order, name"
    )
      .bind(userId)
      .all(),
    env.DB.prepare(
      `SELECT tasks.*
       FROM tasks
       LEFT JOIN task_orders ON task_orders.task_id = tasks.id AND task_orders.user_id = ?
       WHERE (tasks.user_id = ? OR tasks.is_template = 1) AND tasks.enabled = 1
       ORDER BY COALESCE(task_orders.sort_order, tasks.sort_order), tasks.name`
    )
      .bind(userId, userId)
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
    settings: settings ?? { density: "default", row_height: 40, column_width: 132, checklist_orientation: "tasks_rows" }
  };
}
