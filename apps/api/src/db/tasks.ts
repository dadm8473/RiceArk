import type { ResetRule, TaskScope } from "@riceark/core";
import type { Env } from "../env";

export async function createUserTask(
  env: Env,
  userId: string,
  input: {
    name: string;
    scope: TaskScope;
    resetRule: ResetRule;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  const maxSort = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM tasks WHERE user_id = ?")
    .bind(userId)
    .first<{ max_sort: number }>();
  await env.DB.prepare(
    `INSERT INTO tasks (id, user_id, name, scope, reset_type, reset_rule_json, sort_order, enabled, is_template)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`
  )
    .bind(id, userId, input.name, input.scope, input.resetRule.type, JSON.stringify(input.resetRule), (maxSort?.max_sort ?? 0) + 10)
    .run();
  return id;
}

export async function reorderTasks(env: Env, userId: string, taskIds: string[]): Promise<boolean> {
  if (taskIds.length === 0) return true;

  const placeholders = taskIds.map(() => "?").join(", ");
  const existing = await env.DB.prepare(
    `SELECT id FROM tasks
     WHERE enabled = 1 AND (is_template = 1 OR user_id = ?) AND id IN (${placeholders})`
  )
    .bind(userId, ...taskIds)
    .all<{ id: string }>();
  if (existing.results.length !== taskIds.length) return false;

  await env.DB.batch(
    taskIds.map((id, index) =>
      env.DB.prepare(
        `INSERT INTO task_orders (user_id, task_id, sort_order, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, task_id)
         DO UPDATE SET sort_order = excluded.sort_order,
                       updated_at = CURRENT_TIMESTAMP`
      ).bind(userId, id, index * 10)
    )
  );
  return true;
}
