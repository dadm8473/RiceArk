import type { ResetRule, TaskScope } from "@riceark/core";
import type { Env } from "../env";

function returnedTaskIds(result: unknown): string[] | null {
  if (!result || typeof result !== "object" || !("results" in result)) return null;
  const rows = (result as { results?: unknown[] }).results;
  if (!Array.isArray(rows)) return null;
  const ids = rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const id = (row as { task_id?: unknown }).task_id;
    return typeof id === "string" ? [id] : [];
  });
  return ids.length === rows.length ? ids : null;
}

export async function createUserTask(
  env: Env,
  userId: string,
  input: {
    name: string;
    scope: TaskScope;
    resetRule: ResetRule;
    createRequestId?: string | null | undefined;
  }
): Promise<string> {
  const createRequestId = input.createRequestId ?? null;
  if (createRequestId) {
    const existing = await env.DB.prepare(
      "SELECT id FROM tasks WHERE user_id = ? AND create_request_id = ? AND enabled = 1"
    )
      .bind(userId, createRequestId)
      .first<{ id: string }>();
    if (existing) return existing.id;
  }

  const id = crypto.randomUUID();
  const maxSort = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM tasks WHERE user_id = ?")
    .bind(userId)
    .first<{ max_sort: number }>();
  try {
    await env.DB.prepare(
      `INSERT INTO tasks (
         id,
         user_id,
         name,
         scope,
         reset_type,
         reset_rule_json,
         sort_order,
         enabled,
         is_template,
         create_request_id
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`
    )
      .bind(
        id,
        userId,
        input.name,
        input.scope,
        input.resetRule.type,
        JSON.stringify(input.resetRule),
        (maxSort?.max_sort ?? 0) + 10,
        createRequestId
      )
      .run();
  } catch (error) {
    if (createRequestId) {
      const existing = await env.DB.prepare(
        "SELECT id FROM tasks WHERE user_id = ? AND create_request_id = ? AND enabled = 1"
      )
        .bind(userId, createRequestId)
        .first<{ id: string }>();
      if (existing) return existing.id;
    }
    throw error;
  }

  if (createRequestId) {
    const created = await env.DB.prepare(
      "SELECT id FROM tasks WHERE user_id = ? AND create_request_id = ? AND enabled = 1"
    )
      .bind(userId, createRequestId)
      .first<{ id: string }>();
    if (created) return created.id;
  }
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

  const idsJson = JSON.stringify(taskIds);
  const [result] = await env.DB.batch([
    env.DB.prepare(
      `WITH input AS (
         SELECT CAST(key AS INTEGER) AS position, value AS id
         FROM json_each(?2)
       ),
       valid AS (
         SELECT input.position, input.id
         FROM input
         JOIN tasks ON tasks.id = input.id
         LEFT JOIN task_overrides
           ON task_overrides.task_id = tasks.id
          AND task_overrides.user_id = ?1
         WHERE tasks.enabled = 1
           AND (tasks.is_template = 1 OR tasks.user_id = ?1)
           AND COALESCE(task_overrides.enabled, 1) = 1
       )
       INSERT INTO task_orders (user_id, task_id, sort_order, updated_at)
       SELECT ?1, valid.id, valid.position * 10, CURRENT_TIMESTAMP
       FROM valid
       WHERE (SELECT COUNT(*) FROM valid) = json_array_length(?2)
         AND (SELECT COUNT(DISTINCT id) FROM input) = json_array_length(?2)
       ON CONFLICT(user_id, task_id)
       DO UPDATE SET sort_order = excluded.sort_order,
                     updated_at = CURRENT_TIMESTAMP
       RETURNING task_id`
    ).bind(userId, idsJson)
  ]);
  const returned = returnedTaskIds(result);
  if (returned === null) throw new Error("Task order returned malformed rows");
  if (returned.length === 0) return false;
  const expected = new Set(taskIds);
  if (
    returned.length !== expected.size ||
    new Set(returned).size !== returned.length ||
    returned.some((id) => !expected.has(id))
  ) {
    throw new Error("Task order did not return every task");
  }
  return true;
}
