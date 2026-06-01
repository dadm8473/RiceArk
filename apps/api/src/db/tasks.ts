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

async function taskIsAvailable(env: Env, userId: string, taskId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT tasks.id
     FROM tasks
     LEFT JOIN task_overrides ON task_overrides.task_id = tasks.id AND task_overrides.user_id = ?
     WHERE tasks.id = ?
       AND tasks.enabled = 1
       AND (tasks.is_template = 1 OR tasks.user_id = ?)
       AND COALESCE(task_overrides.enabled, 1) = 1`
  )
    .bind(userId, taskId, userId)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function updateTaskOverride(
  env: Env,
  userId: string,
  taskId: string,
  input: {
    name: string;
    resetRule: ResetRule;
  }
): Promise<boolean> {
  if (!(await taskIsAvailable(env, userId, taskId))) return false;

  await env.DB.prepare(
    `INSERT INTO task_overrides (user_id, task_id, name, reset_type, reset_rule_json, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, task_id)
     DO UPDATE SET name = excluded.name,
                   reset_type = excluded.reset_type,
                   reset_rule_json = excluded.reset_rule_json,
                   enabled = 1,
                   updated_at = CURRENT_TIMESTAMP`
  )
    .bind(userId, taskId, input.name, input.resetRule.type, JSON.stringify(input.resetRule))
    .run();
  return true;
}

export async function deleteTaskOverride(env: Env, userId: string, taskId: string): Promise<boolean> {
  if (!(await taskIsAvailable(env, userId, taskId))) return false;

  await env.DB.prepare(
    `INSERT INTO task_overrides (user_id, task_id, enabled, updated_at)
     VALUES (?, ?, 0, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, task_id)
     DO UPDATE SET enabled = 0,
                   updated_at = CURRENT_TIMESTAMP`
  )
    .bind(userId, taskId)
    .run();
  return true;
}

export async function reorderTasks(env: Env, userId: string, taskIds: string[]): Promise<boolean> {
  if (taskIds.length === 0) return true;

  const placeholders = taskIds.map(() => "?").join(", ");
  const existing = await env.DB.prepare(
    `SELECT tasks.id
     FROM tasks
     LEFT JOIN task_overrides ON task_overrides.task_id = tasks.id AND task_overrides.user_id = ?
     WHERE tasks.enabled = 1
       AND (tasks.is_template = 1 OR tasks.user_id = ?)
       AND COALESCE(task_overrides.enabled, 1) = 1
       AND tasks.id IN (${placeholders})`
  )
    .bind(userId, userId, ...taskIds)
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
