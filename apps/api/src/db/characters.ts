import type { CharacterSelection } from "@riceark/core";
import { normalizeCharacterSelection } from "@riceark/core";
import type { Env } from "../env";

export async function saveSelectedCharacters(env: Env, userId: string, selected: CharacterSelection[]): Promise<void> {
  const characters = normalizeCharacterSelection(selected);
  const statements = characters.map((character, index) =>
    env.DB.prepare(
      `INSERT INTO characters (id, user_id, name, server_name, class_name, item_level, combat_power, sort_order, enabled, deleted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, name, server_name)
       DO UPDATE SET class_name = excluded.class_name,
                     item_level = excluded.item_level,
                     combat_power = excluded.combat_power,
                     sort_order = excluded.sort_order,
                     enabled = 1,
                     deleted_at = NULL,
                     updated_at = CURRENT_TIMESTAMP`
    ).bind(
      crypto.randomUUID(),
      userId,
      character.name,
      character.serverName,
      character.className,
      character.itemLevel,
      character.combatPower ?? null,
      index * 10
    )
  );
  if (statements.length > 0) await env.DB.batch(statements);
}

export async function updateCharacterDisplayName(
  env: Env,
  userId: string,
  characterId: string,
  displayName: string | null
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE characters
     SET display_name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL`
  )
    .bind(displayName, characterId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updateCharacterDetails(
  env: Env,
  userId: string,
  characterId: string,
  input: {
    displayName: string | null;
    itemLevel: string;
    combatPower: string | null;
    memo?: string | null | undefined;
  }
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE characters
     SET display_name = ?,
         item_level = ?,
         combat_power = ?,
         memo = CASE WHEN ? = 1 THEN ? ELSE memo END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL`
  )
    .bind(
      input.displayName,
      input.itemLevel,
      input.combatPower,
      input.memo !== undefined ? 1 : 0,
      input.memo ?? null,
      characterId,
      userId
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteCharacter(env: Env, userId: string, characterId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE characters
     SET enabled = 0,
         deleted_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL`
  )
    .bind(characterId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function reorderCharacters(env: Env, userId: string, characterIds: string[]): Promise<boolean> {
  if (characterIds.length === 0) return true;

  const placeholders = characterIds.map(() => "?").join(", ");
  const existing = await env.DB.prepare(
    `SELECT id FROM characters
     WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL AND id IN (${placeholders})`
  )
    .bind(userId, ...characterIds)
    .all<{ id: string }>();
  if (existing.results.length !== characterIds.length) return false;

  await env.DB.batch(
    characterIds.map((id, index) =>
      env.DB.prepare(
        `UPDATE characters
         SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL`
      ).bind(index * 10, id, userId)
    )
  );
  return true;
}
