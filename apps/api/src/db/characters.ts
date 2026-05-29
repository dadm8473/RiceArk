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
