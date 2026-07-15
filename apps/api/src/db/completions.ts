import { mergeCompletionPatches, type CompletionPatch } from "@riceark/core";
import type { Env } from "../env";

function targetKey(characterId: string | null): string {
  return characterId ?? "roster";
}

function completionKey(taskId: string, target: string, periodKey: string): string {
  return JSON.stringify([taskId, target, periodKey]);
}

function returnedCompletionKeys(result: unknown): string[] | null {
  if (!result || typeof result !== "object" || !("results" in result)) return null;
  const rows = (result as { results?: unknown[] }).results;
  if (!Array.isArray(rows)) return null;
  const keys = rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const { task_id: taskId, target_key: target, period_key: periodKey } = row as {
      task_id?: unknown;
      target_key?: unknown;
      period_key?: unknown;
    };
    return typeof taskId === "string" && typeof target === "string" && typeof periodKey === "string"
      ? [completionKey(taskId, target, periodKey)]
      : [];
  });
  return keys.length === rows.length ? keys : null;
}

export async function saveCompletionPatches(env: Env, userId: string, patches: CompletionPatch[]): Promise<void> {
  const merged = mergeCompletionPatches(patches);
  if (merged.length === 0) return;

  const rows = merged.map((patch) => ({
    id: crypto.randomUUID(),
    taskId: patch.taskId,
    characterId: patch.characterId,
    targetKey: targetKey(patch.characterId),
    periodKey: patch.periodKey,
    completed: patch.completed ? 1 : 0
  }));
  const rowsJson = JSON.stringify(rows);
  const [result] = await env.DB.batch([
    env.DB.prepare(
      `WITH input AS (
         SELECT json_extract(value, '$.id') AS id,
                json_extract(value, '$.taskId') AS task_id,
                json_extract(value, '$.characterId') AS character_id,
                json_extract(value, '$.targetKey') AS target_key,
                json_extract(value, '$.periodKey') AS period_key,
                json_extract(value, '$.completed') AS completed
         FROM json_each(?2)
       ),
       valid AS (
         SELECT input.*
         FROM input
         JOIN tasks ON tasks.id = input.task_id
         LEFT JOIN task_overrides
           ON task_overrides.task_id = tasks.id
          AND task_overrides.user_id = ?1
         WHERE typeof(input.id) = 'text'
           AND typeof(input.task_id) = 'text'
           AND (input.character_id IS NULL OR typeof(input.character_id) = 'text')
           AND typeof(input.target_key) = 'text'
           AND typeof(input.period_key) = 'text'
           AND input.completed IN (0, 1)
           AND tasks.enabled = 1
           AND (tasks.is_template = 1 OR tasks.user_id = ?1)
           AND COALESCE(task_overrides.enabled, 1) = 1
           AND (
             input.character_id IS NULL
             OR EXISTS (
               SELECT 1
               FROM characters
               WHERE characters.id = input.character_id
                 AND characters.user_id = ?1
                 AND characters.enabled = 1
                 AND characters.deleted_at IS NULL
             )
           )
       )
       INSERT INTO completions (
         id, user_id, task_id, character_id, target_key, period_key, completed, updated_at
       )
       SELECT id, ?1, task_id, character_id, target_key, period_key, completed, CURRENT_TIMESTAMP
       FROM valid
       WHERE (SELECT COUNT(*) FROM valid) = json_array_length(?2)
         AND (
           SELECT COUNT(*)
           FROM (SELECT task_id, target_key, period_key FROM input GROUP BY task_id, target_key, period_key)
         ) = json_array_length(?2)
       ON CONFLICT(user_id, task_id, target_key, period_key)
       DO UPDATE SET completed = excluded.completed,
                     updated_at = CURRENT_TIMESTAMP
       RETURNING task_id, target_key, period_key`
    ).bind(userId, rowsJson)
  ]);
  const returned = returnedCompletionKeys(result);
  if (returned === null) throw new Error("Completion patch write returned malformed rows");
  if (returned.length === 0) throw new Error("Completion patch targets are unavailable");
  const expected = new Set(rows.map((row) => completionKey(row.taskId, row.targetKey, row.periodKey)));
  if (
    returned.length !== expected.size ||
    new Set(returned).size !== returned.length ||
    returned.some((key) => !expected.has(key))
  ) {
    throw new Error("Completion patch write did not return every patch");
  }
}
