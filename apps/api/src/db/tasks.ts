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
