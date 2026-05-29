import type { Env } from "../env";

export async function loadDashboard(env: Env, userId: string) {
  const [characters, tasks, completions, settings] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM characters WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL ORDER BY sort_order, name"
    )
      .bind(userId)
      .all(),
    env.DB.prepare("SELECT * FROM tasks WHERE (user_id = ? OR is_template = 1) AND enabled = 1 ORDER BY sort_order, name")
      .bind(userId)
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
    settings: settings ?? { density: "default", row_height: 40, column_width: 132 }
  };
}
