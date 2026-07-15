import type { Env } from "../env";

export interface BoardSheetVersion {
  id: string;
  version: number;
}

export interface BoardMutationVersions {
  sheets: BoardSheetVersion[];
  manifestVersion?: number;
}

export type BoardMutationResult<T extends object = { ok: true }> = T & { versions: BoardMutationVersions };

export interface BoardCharacterProfileVersionInput {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  combatPower: string | null;
}

export interface BoardCharacterImportVersionOptions {
  targetTableId?: string | undefined;
  targetAxis?: "row" | "column" | undefined;
}

export function bumpBoardManifestVersionStatement(env: Env, userId: string) {
  return env.DB.prepare(
    `INSERT INTO board_manifest_versions (user_id, version, updated_at)
     VALUES (?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE
     SET version = board_manifest_versions.version + 1,
         updated_at = CURRENT_TIMESTAMP
     RETURNING user_id, version`
  ).bind(userId);
}

export function bumpBoardManifestVersionForOwnedSheetStatement(env: Env, userId: string, sheetId: string) {
  return env.DB.prepare(
    `INSERT INTO board_manifest_versions (user_id, version, updated_at)
     SELECT ?, 1, CURRENT_TIMESTAMP
     WHERE EXISTS (
       SELECT 1 FROM sheets WHERE id = ? AND user_id = ?
     )
     ON CONFLICT(user_id) DO UPDATE
     SET version = board_manifest_versions.version + 1,
         updated_at = CURRENT_TIMESTAMP
     RETURNING user_id, version`
  ).bind(userId, sheetId, userId);
}

export function bumpBoardManifestVersionForDeletableSheetStatement(env: Env, userId: string, sheetId: string) {
  return env.DB.prepare(
    `INSERT INTO board_manifest_versions (user_id, version, updated_at)
     SELECT ?, 1, CURRENT_TIMESTAMP
     WHERE EXISTS (
       SELECT 1
       FROM sheets AS target
       WHERE target.id = ?
         AND target.user_id = ?
         AND EXISTS (
           SELECT 1
           FROM sheets AS other
           WHERE other.user_id = ?
             AND other.id <> target.id
         )
     )
     ON CONFLICT(user_id) DO UPDATE
     SET version = board_manifest_versions.version + 1,
         updated_at = CURRENT_TIMESTAMP
     RETURNING user_id, version`
  ).bind(userId, sheetId, userId, userId);
}

export function bumpBoardSheetVersionStatement(env: Env, userId: string, sheetId: string) {
  return env.DB.prepare(
    `UPDATE sheets
     SET content_version = content_version + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?
     RETURNING id, content_version AS version`
  ).bind(sheetId, userId);
}

export function bumpBoardSheetVersionsForTablesStatement(env: Env, userId: string, tableIds: string[]) {
  const ids = [...new Set(tableIds)];
  return env.DB.prepare(
    `UPDATE sheets
     SET content_version = content_version + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE sheets.user_id = ?1
       AND EXISTS (SELECT 1 FROM json_each(?3))
       AND NOT EXISTS (
         SELECT 1
         FROM json_each(?3) AS requested
         WHERE NOT EXISTS (
           SELECT 1
           FROM board_tables AS target
           WHERE target.id = requested.value
             AND target.user_id = ?2
             AND target.locked = 0
         )
       )
       AND sheets.id IN (
         SELECT DISTINCT sheet_id
         FROM board_tables
         WHERE user_id = ?2
           AND locked = 0
           AND id IN (SELECT value FROM json_each(?3))
       )
     RETURNING id, content_version AS version`
  ).bind(userId, userId, JSON.stringify(ids));
}

export function bumpBoardSheetVersionForTableAtExpectedLockStatement(
  env: Env,
  userId: string,
  tableId: string,
  expectedLock: 0 | 1
) {
  return env.DB.prepare(
    `UPDATE sheets
     SET content_version = content_version + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE sheets.user_id = ?
       AND sheets.id IN (
         SELECT board_tables.sheet_id
         FROM board_tables
         WHERE board_tables.id = ?
           AND board_tables.user_id = sheets.user_id
           AND board_tables.locked = ?
       )
     RETURNING id, content_version AS version`
  ).bind(userId, tableId, expectedLock);
}

export function bumpBoardSheetVersionForNoteStatement(env: Env, userId: string, noteId: string) {
  return env.DB.prepare(
    `UPDATE sheets
     SET content_version = content_version + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?
       AND id IN (
         SELECT sheet_id
         FROM board_notes
         WHERE id = ? AND user_id = ?
       )
     RETURNING id, content_version AS version`
  ).bind(userId, noteId, userId);
}

export function bumpBoardSheetVersionForAxisItemStatement(env: Env, userId: string, axisItemId: string) {
  return env.DB.prepare(
    `UPDATE sheets
     SET content_version = content_version + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE sheets.user_id = ?
       AND sheets.id IN (
         SELECT board_tables.sheet_id
         FROM board_axis_items
         JOIN board_tables
           ON board_axis_items.table_id = board_tables.id
          AND board_axis_items.user_id = board_tables.user_id
         WHERE board_axis_items.id = ?
           AND board_axis_items.user_id = ?
           AND board_axis_items.visible = 1
           AND board_tables.user_id = ?
           AND board_tables.locked = 0
       )
     RETURNING id, content_version AS version`
  ).bind(userId, axisItemId, userId, userId);
}

export function bumpBoardSheetVersionsForCharacterStatement(env: Env, userId: string, characterId: string) {
  return env.DB.prepare(
    `UPDATE sheets
     SET content_version = content_version + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE sheets.user_id = ?
       AND sheets.id IN (
         SELECT DISTINCT board_tables.sheet_id
         FROM board_tables
         JOIN board_axis_items
           ON board_axis_items.table_id = board_tables.id
          AND board_axis_items.user_id = board_tables.user_id
         JOIN characters
           ON characters.id = board_axis_items.character_id
          AND characters.user_id = board_axis_items.user_id
         WHERE board_tables.user_id = ?
           AND board_axis_items.user_id = ?
           AND board_axis_items.character_id = ?
           AND characters.enabled = 1
           AND characters.deleted_at IS NULL
       )
     RETURNING id, content_version AS version`
  ).bind(userId, userId, userId, characterId);
}

export function bumpBoardSheetVersionsForCharacterImportStatement(
  env: Env,
  userId: string,
  profiles: BoardCharacterProfileVersionInput[],
  options: BoardCharacterImportVersionOptions = {}
) {
  const profilesJson = JSON.stringify(profiles);
  const targetTableId = options.targetTableId ?? null;
  const targetAxis = options.targetAxis ?? null;

  return env.DB.prepare(
    `WITH input AS (
       SELECT json_extract(value, '$.name') AS name,
              json_extract(value, '$.serverName') AS server_name,
              json_extract(value, '$.className') AS class_name,
              json_extract(value, '$.itemLevel') AS item_level,
              json_extract(value, '$.combatPower') AS combat_power
       FROM json_each(?2)
     ),
     valid_input AS (
       SELECT *
       FROM input
       WHERE typeof(name) = 'text'
         AND typeof(server_name) = 'text'
         AND typeof(class_name) = 'text'
         AND typeof(item_level) = 'text'
         AND (combat_power IS NULL OR typeof(combat_power) = 'text')
     ),
     changed_characters AS (
       SELECT characters.id
       FROM characters
       JOIN valid_input
         ON valid_input.name = characters.name
        AND valid_input.server_name = characters.server_name
       WHERE characters.user_id = ?1
         AND (
           characters.class_name IS NOT valid_input.class_name
           OR characters.item_level IS NOT valid_input.item_level
           OR characters.combat_power IS NOT valid_input.combat_power
           OR characters.source <> 'lostark'
           OR characters.enabled <> 1
           OR characters.deleted_at IS NOT NULL
         )
     ),
     affected_sheets AS (
       SELECT DISTINCT board_tables.sheet_id
       FROM board_axis_items
       JOIN board_tables
         ON board_tables.id = board_axis_items.table_id
        AND board_tables.user_id = board_axis_items.user_id
       JOIN changed_characters
         ON changed_characters.id = board_axis_items.character_id
       WHERE board_axis_items.user_id = ?1
         AND board_tables.user_id = ?1
       UNION
       SELECT board_tables.sheet_id
       FROM board_tables
       WHERE ?3 IS NOT NULL
         AND board_tables.id = ?3
         AND board_tables.user_id = ?1
         AND board_tables.locked = 0
     )
     UPDATE sheets
     SET content_version = content_version + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE sheets.user_id = ?1
       AND json_array_length(?2) > 0
       AND (SELECT COUNT(*) FROM valid_input) = json_array_length(?2)
       AND (
         SELECT COUNT(*)
         FROM (SELECT name, server_name FROM valid_input GROUP BY name, server_name)
       ) = json_array_length(?2)
       AND (
         ?3 IS NULL
         OR (
           ?4 IN ('row', 'column')
           AND EXISTS (
             SELECT 1
             FROM board_tables
             WHERE board_tables.id = ?3
               AND board_tables.user_id = ?1
               AND board_tables.locked = 0
           )
           AND NOT EXISTS (
             SELECT 1
             FROM valid_input
             JOIN characters
               ON characters.user_id = ?1
              AND characters.name = valid_input.name
              AND characters.server_name = valid_input.server_name
             JOIN board_axis_items
               ON board_axis_items.user_id = ?1
              AND board_axis_items.table_id = ?3
              AND board_axis_items.axis = ?4
              AND board_axis_items.kind = 'character'
              AND board_axis_items.character_id = characters.id
             GROUP BY characters.id
             HAVING COUNT(*) > 1
           )
         )
       )
       AND sheets.id IN (SELECT sheet_id FROM affected_sheets)
     RETURNING id, content_version AS version`
  ).bind(userId, profilesJson, targetTableId, targetAxis);
}

export function buildBoardMutationVersions(
  sheetRows: BoardSheetVersion[],
  manifestVersion?: number
): BoardMutationVersions {
  const sheets = [...new Map(sheetRows.map((sheet) => [sheet.id, sheet])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));

  return manifestVersion === undefined ? { sheets } : { sheets, manifestVersion };
}
