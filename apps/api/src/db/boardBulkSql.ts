import type { Env } from "../env";
import type { BoardCellStatePatch, BoardCompletionPatch } from "./board";

type IdFactory = (index: number) => string;

export interface BoardBulkGuardSnapshot {
  sheet_id: string;
  row_kind: "character" | "task" | "custom";
  column_kind: "character" | "task" | "custom";
  row_task_reset_rule_json: string | null;
  column_task_reset_rule_json: string | null;
  guard_expires_at: number | null;
}

export interface BoardCompletionPayloadRow {
  id: string;
  table_id: string;
  row_item_id: string;
  column_item_id: string;
  period_key: string;
  completed: 0 | 1;
}

export type GuardedBoardCompletionPayloadRow = BoardCompletionPayloadRow & BoardBulkGuardSnapshot;

export interface BoardCellStatePayloadRow {
  id: string;
  table_id: string;
  row_item_id: string;
  column_item_id: string;
  checkbox_visible: 0 | 1;
  mark_type: BoardCellStatePatch["markType"];
  mark_icon: BoardCellStatePatch["markIcon"] | null;
  memo: string | null;
  mark_period_key: string | null;
  delete_state: 0 | 1;
}

export type GuardedBoardCellStatePayloadRow = BoardCellStatePayloadRow & BoardBulkGuardSnapshot;

export interface BoardBulkPreflightRow {
  ordinal: number;
  tableId: string;
  rowItemId: string;
  columnItemId: string;
  eligible: number;
  sheetId: string | null;
  rowKind: "character" | "task" | "custom" | null;
  columnKind: "character" | "task" | "custom" | null;
  rowTaskResetRuleJson: string | null;
  columnTaskResetRuleJson: string | null;
}

const randomId: IdFactory = () => crypto.randomUUID();

export function buildBoardCompletionPayloadRows(
  patches: BoardCompletionPatch[],
  createId: IdFactory = randomId
): BoardCompletionPayloadRow[] {
  return patches.map((patch, index) => ({
    id: createId(index),
    table_id: patch.tableId,
    row_item_id: patch.rowItemId,
    column_item_id: patch.columnItemId,
    period_key: patch.periodKey,
    completed: patch.completed ? 1 : 0
  }));
}

export function buildBoardCellStatePayloadRows(
  patches: BoardCellStatePatch[],
  createId: IdFactory = randomId
): BoardCellStatePayloadRow[] {
  return patches.map((patch, index) => {
    const memo = patch.markType === "disabled" || patch.memo === "" ? null : patch.memo;
    const markIcon = patch.markType === "disabled" ? null : (patch.markIcon ?? null);
    return {
      id: createId(index),
      table_id: patch.tableId,
      row_item_id: patch.rowItemId,
      column_item_id: patch.columnItemId,
      checkbox_visible: patch.markType === "disabled" ? 0 : 1,
      mark_type: patch.markType,
      mark_icon: markIcon,
      memo,
      mark_period_key: patch.markType === "reserved" ? (patch.periodKey ?? null) : null,
      delete_state: patch.markType === "default" && memo === null && markIcon === null ? 1 : 0
    };
  });
}

const inputCte = `input AS (
  SELECT CAST(key AS INTEGER) AS ordinal,
         json_extract(value, '$.id') AS id,
         json_extract(value, '$.table_id') AS table_id,
         json_extract(value, '$.row_item_id') AS row_item_id,
         json_extract(value, '$.column_item_id') AS column_item_id,
         json_extract(value, '$.period_key') AS period_key,
         CAST(json_extract(value, '$.completed') AS INTEGER) AS completed,
         CAST(json_extract(value, '$.checkbox_visible') AS INTEGER) AS checkbox_visible,
         json_extract(value, '$.mark_type') AS mark_type,
         json_extract(value, '$.mark_icon') AS mark_icon,
         json_extract(value, '$.memo') AS memo,
         json_extract(value, '$.mark_period_key') AS mark_period_key,
         CAST(json_extract(value, '$.delete_state') AS INTEGER) AS delete_state,
         json_extract(value, '$.sheet_id') AS sheet_id,
         json_extract(value, '$.row_kind') AS row_kind,
         json_extract(value, '$.column_kind') AS column_kind,
         json_extract(value, '$.row_task_reset_rule_json') AS row_task_reset_rule_json,
         json_extract(value, '$.column_task_reset_rule_json') AS column_task_reset_rule_json,
         CAST(json_extract(value, '$.guard_expires_at') AS INTEGER) AS guard_expires_at
  FROM json_each(?2)
)`;

const guardedValidCte = `valid AS (
  SELECT input.*
  FROM input
  JOIN board_tables AS tables
    ON tables.id = input.table_id
   AND tables.user_id = ?1
   AND tables.locked = 0
   AND tables.sheet_id = input.sheet_id
  JOIN sheets
    ON sheets.id = input.sheet_id
   AND sheets.user_id = ?1
  JOIN board_axis_items AS row_items
    ON row_items.id = input.row_item_id
   AND row_items.user_id = ?1
   AND row_items.table_id = input.table_id
   AND row_items.axis = 'row'
   AND row_items.visible = 1
   AND row_items.kind = input.row_kind
   AND row_items.task_reset_rule_json IS input.row_task_reset_rule_json
  JOIN board_axis_items AS column_items
    ON column_items.id = input.column_item_id
   AND column_items.user_id = ?1
   AND column_items.table_id = input.table_id
   AND column_items.axis = 'column'
   AND column_items.visible = 1
   AND column_items.kind = input.column_kind
   AND column_items.task_reset_rule_json IS input.column_task_reset_rule_json
  WHERE input.guard_expires_at IS NULL
     OR CAST(strftime('%s', 'now') AS INTEGER) < input.guard_expires_at
)`;

const completeGuard = `(SELECT COUNT(*) FROM valid) = (SELECT COUNT(*) FROM input)`;

function bindPayload(env: Env, sql: string, userId: string, payloadJson: string) {
  return env.DB.prepare(sql).bind(userId, payloadJson);
}

export function prepareBoardBulkPreflightStatement(env: Env, userId: string, payloadJson: string) {
  return bindPayload(
    env,
    `WITH ${inputCte}
     SELECT input.ordinal,
            input.table_id AS tableId,
            input.row_item_id AS rowItemId,
            input.column_item_id AS columnItemId,
            CASE WHEN sheets.id IS NOT NULL AND row_items.id IS NOT NULL AND column_items.id IS NOT NULL THEN 1 ELSE 0 END AS eligible,
            tables.sheet_id AS sheetId,
            row_items.kind AS rowKind,
            column_items.kind AS columnKind,
            row_items.task_reset_rule_json AS rowTaskResetRuleJson,
            column_items.task_reset_rule_json AS columnTaskResetRuleJson
     FROM input
     LEFT JOIN board_tables AS tables
       ON tables.id = input.table_id AND tables.user_id = ?1 AND tables.locked = 0
     LEFT JOIN sheets
       ON sheets.id = tables.sheet_id AND sheets.user_id = ?1
     LEFT JOIN board_axis_items AS row_items
       ON row_items.id = input.row_item_id
      AND row_items.user_id = ?1
      AND row_items.table_id = input.table_id
      AND row_items.axis = 'row'
      AND row_items.visible = 1
     LEFT JOIN board_axis_items AS column_items
       ON column_items.id = input.column_item_id
      AND column_items.user_id = ?1
      AND column_items.table_id = input.table_id
      AND column_items.axis = 'column'
      AND column_items.visible = 1
     ORDER BY input.ordinal`,
    userId,
    payloadJson
  );
}

function prepareGuardAssertionStatement(env: Env, userId: string, payloadJson: string) {
  // An invalid guard deliberately violates NOT NULL so D1 rolls the whole batch back.
  return bindPayload(
    env,
    `WITH ${inputCte}, ${guardedValidCte}
     -- guard assertion
     INSERT INTO board_cell_completions
       (id, user_id, table_id, row_item_id, column_item_id, period_key, completed, updated_at)
     SELECT 'board-bulk-guard', NULL, '', '', '', '', 0, CURRENT_TIMESTAMP
     WHERE NOT (${completeGuard})`,
    userId,
    payloadJson
  );
}

function prepareVersionStatement(env: Env, userId: string, payloadJson: string) {
  return bindPayload(
    env,
    `WITH ${inputCte}, ${guardedValidCte}
     UPDATE sheets
     SET content_version = content_version + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE sheets.user_id = ?1
       AND ${completeGuard}
       AND sheets.id IN (SELECT DISTINCT sheet_id FROM valid)
     RETURNING id, content_version AS version`,
    userId,
    payloadJson
  );
}

export function prepareBoardCompletionWriteStatements(env: Env, userId: string, payloadJson: string) {
  const upsert = bindPayload(
    env,
    `WITH ${inputCte}, ${guardedValidCte}
     INSERT INTO board_cell_completions
       (id, user_id, table_id, row_item_id, column_item_id, period_key, completed, updated_at)
     SELECT id, ?1, table_id, row_item_id, column_item_id, period_key, completed, CURRENT_TIMESTAMP
     FROM valid
     WHERE ${completeGuard}
     ON CONFLICT(user_id, table_id, row_item_id, column_item_id, period_key)
     DO UPDATE SET completed = excluded.completed, updated_at = CURRENT_TIMESTAMP
     RETURNING table_id AS tableId, row_item_id AS rowItemId,
               column_item_id AS columnItemId, period_key AS periodKey`,
    userId,
    payloadJson
  );
  return [upsert, prepareGuardAssertionStatement(env, userId, payloadJson), prepareVersionStatement(env, userId, payloadJson)];
}

export function prepareBoardCellStateWriteStatements(env: Env, userId: string, payloadJson: string) {
  const deleteStatement = bindPayload(
    env,
    `WITH ${inputCte}, ${guardedValidCte}
     DELETE FROM board_cell_states
     WHERE user_id = ?1
       AND ${completeGuard}
       AND (table_id, row_item_id, column_item_id) IN (
         SELECT table_id, row_item_id, column_item_id FROM valid WHERE delete_state = 1
       )
     RETURNING table_id AS tableId, row_item_id AS rowItemId, column_item_id AS columnItemId`,
    userId,
    payloadJson
  );
  const upsert = bindPayload(
    env,
    `WITH ${inputCte}, ${guardedValidCte}
     INSERT INTO board_cell_states
       (id, user_id, table_id, row_item_id, column_item_id, checkbox_visible, mark_type, mark_icon, memo, mark_period_key, updated_at)
     SELECT id, ?1, table_id, row_item_id, column_item_id, checkbox_visible, mark_type, mark_icon, memo, mark_period_key, CURRENT_TIMESTAMP
     FROM valid
     WHERE delete_state = 0 AND ${completeGuard}
     ON CONFLICT(table_id, row_item_id, column_item_id)
     DO UPDATE SET checkbox_visible = excluded.checkbox_visible,
                   mark_type = excluded.mark_type,
                   mark_icon = excluded.mark_icon,
                   memo = excluded.memo,
                   mark_period_key = excluded.mark_period_key,
                   updated_at = CURRENT_TIMESTAMP
     RETURNING table_id AS tableId, row_item_id AS rowItemId, column_item_id AS columnItemId`,
    userId,
    payloadJson
  );
  return [
    deleteStatement,
    upsert,
    prepareGuardAssertionStatement(env, userId, payloadJson),
    prepareVersionStatement(env, userId, payloadJson)
  ];
}
