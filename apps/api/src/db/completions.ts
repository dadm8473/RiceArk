import { mergeCompletionPatches, type CompletionPatch } from "@riceark/core";
import type { Env } from "../env";

function targetKey(characterId: string | null): string {
  return characterId ?? "roster";
}

export async function saveCompletionPatches(env: Env, userId: string, patches: CompletionPatch[]): Promise<void> {
  const merged = mergeCompletionPatches(patches);
  const statements = merged.map((patch) =>
    env.DB.prepare(
      `INSERT INTO completions (id, user_id, task_id, character_id, target_key, period_key, completed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, task_id, target_key, period_key)
       DO UPDATE SET completed = excluded.completed, updated_at = CURRENT_TIMESTAMP`
    ).bind(
      crypto.randomUUID(),
      userId,
      patch.taskId,
      patch.characterId,
      targetKey(patch.characterId),
      patch.periodKey,
      patch.completed ? 1 : 0
    )
  );
  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
}
