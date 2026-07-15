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
           AND board_axis_items.visible = 1
           AND characters.enabled = 1
           AND characters.deleted_at IS NULL
       )
     RETURNING id, content_version AS version`
  ).bind(userId, userId, userId, characterId);
}

export function buildBoardMutationVersions(
  sheetRows: BoardSheetVersion[],
  manifestVersion?: number
): BoardMutationVersions {
  const sheets = [...new Map(sheetRows.map((sheet) => [sheet.id, sheet])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));

  return manifestVersion === undefined ? { sheets } : { sheets, manifestVersion };
}
