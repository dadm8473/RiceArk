import type { Env } from "../env";
import { ensureDefaultBoard, getCurrentBoardCompletionPeriodKeys, resolveExpiredBoardCellStateRows } from "./board";

export interface BoardSheetManifestItem {
  id: string;
  name: string;
  sort_order: number;
  is_default: number;
  version: number;
}

export interface BoardSheetManifest {
  version: number;
  sheets: BoardSheetManifestItem[];
}

export interface BoardSheetPayloadItem {
  id: string;
  name: string;
  sort_order: number;
  is_default: number;
  content_version: number;
}

export interface BoardSheetPayload {
  sheet: BoardSheetPayloadItem;
  tables: unknown[];
  notes: unknown[];
  axisItems: unknown[];
  cellStates: unknown[];
  completions: unknown[];
  periodFingerprint: string;
}

export interface BoardBootstrapPayload {
  userId: string;
  settings: unknown;
  manifest: BoardSheetManifest;
  activeSheet: BoardSheetPayload;
}

export interface BoardVersionSummary {
  manifestVersion: number;
  sheets: BoardSheetManifestItem[];
  periodFingerprint: "";
}

interface BoardManifestRow {
  manifest_version: number;
  id: string | null;
  name: string | null;
  sort_order: number | null;
  is_default: number | null;
  version: number | null;
}

interface BoardAxisItemRow {
  id: string;
  table_id: string;
  axis: "row" | "column";
  kind: "character" | "task" | "custom";
  label: string;
  character_id: string | null;
  task_id: string | null;
  task_scope: "character" | "roster" | "custom" | null;
  task_reset_type: "daily" | "weekly" | "biweekly" | "custom" | "none" | null;
  task_reset_rule_json: string | null;
  task_color: string | null;
  size_px: number | null;
  cross_size_px: number | null;
  sort_order: number;
  visible: number;
  separator_json: string | null;
  display_options_json: string | null;
  character_name: string | null;
  character_display_name: string | null;
  character_server_name: string | null;
  character_class_name: string | null;
  character_item_level: string | null;
  character_combat_power: string | null;
  character_source: string | null;
}

interface BoardCellStateRow {
  table_id: string;
  row_item_id: string;
  column_item_id: string;
  checkbox_visible: number;
  mark_type: string;
  mark_icon: string | null;
  memo: string | null;
  mark_period_key: string | null;
}

interface BoardDisplaySettings {
  show_display_name: number;
  show_server_name: number;
  show_class_name: number;
  show_item_level: number;
  show_combat_power: number;
}

const DEFAULT_BOARD_DISPLAY_SETTINGS: BoardDisplaySettings = {
  show_display_name: 1,
  show_server_name: 0,
  show_class_name: 0,
  show_item_level: 1,
  show_combat_power: 0
};

const MAX_BOARD_SNAPSHOT_ATTEMPTS = 3;

const BOARD_MANIFEST_SQL = `WITH manifest AS (
  SELECT COALESCE(
    (SELECT version FROM board_manifest_versions WHERE user_id = ?1),
    0
  ) AS manifest_version
)
SELECT
  manifest.manifest_version,
  sheets.id,
  sheets.name,
  sheets.sort_order,
  sheets.is_default,
  sheets.content_version AS version
FROM manifest
LEFT JOIN sheets ON sheets.user_id = ?1
ORDER BY sheets.sort_order, sheets.name`;

function mapBoardManifestRows(rows: BoardManifestRow[]): BoardSheetManifest {
  return {
    version: rows[0]?.manifest_version ?? 0,
    sheets: rows.flatMap((row) => {
      if (row.id === null) return [];
      if (
        row.name === null ||
        row.sort_order === null ||
        row.is_default === null ||
        row.version === null
      ) {
        throw new Error("Board manifest returned an incomplete sheet row");
      }
      return [
        {
          id: row.id,
          name: row.name,
          sort_order: row.sort_order,
          is_default: row.is_default,
          version: row.version
        }
      ];
    })
  };
}

export async function loadBoardManifest(env: Env, userId: string): Promise<BoardSheetManifest> {
  const rows = await env.DB.prepare(BOARD_MANIFEST_SQL).bind(userId).all<BoardManifestRow>();
  return mapBoardManifestRows(rows.results);
}

function selectOwnedSheet(
  sheets: BoardSheetManifestItem[],
  requestedSheetId: string | undefined
): BoardSheetManifestItem | null {
  const requested = requestedSheetId ? sheets.find((sheet) => sheet.id === requestedSheetId) : undefined;
  return requested ?? sheets.find((sheet) => sheet.is_default === 1) ?? sheets[0] ?? null;
}

function sameBoardManifest(left: BoardSheetManifest, right: BoardSheetManifest): boolean {
  return (
    left.version === right.version &&
    left.sheets.length === right.sheets.length &&
    left.sheets.every((sheet, index) => {
      const other = right.sheets[index];
      return (
        other !== undefined &&
        sheet.id === other.id &&
        sheet.name === other.name &&
        sheet.sort_order === other.sort_order &&
        sheet.is_default === other.is_default &&
        sheet.version === other.version
      );
    })
  );
}

function sameBoardSheetMetadata(left: BoardSheetPayloadItem, right: BoardSheetPayloadItem): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.sort_order === right.sort_order &&
    left.is_default === right.is_default &&
    left.content_version === right.content_version
  );
}

function manifestItemMatchesSheet(item: BoardSheetManifestItem | undefined, sheet: BoardSheetPayloadItem): boolean {
  return (
    item !== undefined &&
    item.id === sheet.id &&
    item.name === sheet.name &&
    item.sort_order === sheet.sort_order &&
    item.is_default === sheet.is_default &&
    item.version === sheet.content_version
  );
}

async function loadBoardDisplaySettings(env: Env, userId: string): Promise<BoardDisplaySettings> {
  const settings = await env.DB.prepare(
    `SELECT show_display_name,
            show_server_name,
            show_class_name,
            show_item_level,
            show_combat_power
     FROM user_settings
     WHERE user_id = ?`
  )
    .bind(userId)
    .first<BoardDisplaySettings>();
  return settings ?? { ...DEFAULT_BOARD_DISPLAY_SETTINGS };
}

async function loadOwnedBoardSheetMetadata(
  env: Env,
  userId: string,
  sheetId: string
): Promise<BoardSheetPayloadItem | null> {
  return env.DB.prepare(
    `SELECT id, name, sort_order, is_default, content_version
     FROM sheets
     WHERE id = ? AND user_id = ?`
  )
    .bind(sheetId, userId)
    .first<BoardSheetPayloadItem>();
}

async function loadBoardSheetAttempt(
  env: Env,
  userId: string,
  sheetId: string,
  now: Date
): Promise<BoardSheetPayload | null> {
  const sheet = await loadOwnedBoardSheetMetadata(env, userId, sheetId);
  if (!sheet) return null;

  const [tables, notes, axisItems, cellStates] = await Promise.all([
    env.DB.prepare(
      `SELECT board_tables.id,
              board_tables.sheet_id,
              board_tables.name,
              board_tables.sort_order,
              board_tables.x,
              board_tables.y,
              board_tables.width,
              board_tables.height,
              board_tables.row_role,
              board_tables.column_role,
              board_tables.task_axis,
              board_tables.default_row_height,
              board_tables.default_column_width,
              board_tables.locked,
              board_tables.display_options_json,
              board_tables.event_options_json,
              board_tables.template_type
       FROM board_tables
       JOIN sheets
         ON sheets.id = board_tables.sheet_id
        AND sheets.user_id = ?1
       WHERE board_tables.user_id = ?1
         AND sheets.id = ?2
       ORDER BY board_tables.sort_order, board_tables.name`
    )
      .bind(userId, sheetId)
      .all(),
    env.DB.prepare(
      `SELECT board_notes.id,
              board_notes.sheet_id,
              board_notes.title,
              board_notes.body,
              board_notes.color,
              board_notes.sort_order,
              board_notes.x,
              board_notes.y,
              board_notes.width,
              board_notes.height,
              board_notes.locked
       FROM board_notes
       JOIN sheets
         ON sheets.id = board_notes.sheet_id
        AND sheets.user_id = ?1
       WHERE board_notes.user_id = ?1
         AND sheets.id = ?2
       ORDER BY board_notes.sort_order, board_notes.title`
    )
      .bind(userId, sheetId)
      .all(),
    env.DB.prepare(
      `SELECT board_axis_items.id,
              board_axis_items.table_id,
              board_axis_items.axis,
              board_axis_items.kind,
              board_axis_items.label,
              board_axis_items.character_id,
              board_axis_items.task_id,
              board_axis_items.task_scope,
              board_axis_items.task_reset_type,
              board_axis_items.task_reset_rule_json,
              board_axis_items.task_color,
              board_axis_items.size_px,
              board_axis_items.cross_size_px,
              board_axis_items.sort_order,
              board_axis_items.visible,
              board_axis_items.separator_json,
              board_axis_items.display_options_json,
              characters.name AS character_name,
              characters.display_name AS character_display_name,
              characters.server_name AS character_server_name,
              characters.class_name AS character_class_name,
              characters.item_level AS character_item_level,
              characters.combat_power AS character_combat_power,
              characters.source AS character_source
       FROM board_axis_items
       JOIN board_tables
         ON board_tables.id = board_axis_items.table_id
        AND board_tables.user_id = ?1
       JOIN sheets
         ON sheets.id = board_tables.sheet_id
        AND sheets.user_id = ?1
       LEFT JOIN characters
         ON characters.id = board_axis_items.character_id
        AND characters.user_id = board_axis_items.user_id
        AND characters.deleted_at IS NULL
       WHERE board_axis_items.user_id = ?1
         AND sheets.id = ?2
       ORDER BY board_axis_items.table_id,
                board_axis_items.axis,
                board_axis_items.sort_order,
                board_axis_items.label`
    )
      .bind(userId, sheetId)
      .all<BoardAxisItemRow>(),
    env.DB.prepare(
      `SELECT board_cell_states.table_id,
              board_cell_states.row_item_id,
              board_cell_states.column_item_id,
              board_cell_states.checkbox_visible,
              board_cell_states.mark_type,
              board_cell_states.mark_icon,
              board_cell_states.memo,
              board_cell_states.mark_period_key
       FROM board_cell_states
       JOIN board_tables
         ON board_tables.id = board_cell_states.table_id
        AND board_tables.user_id = ?1
       JOIN sheets
         ON sheets.id = board_tables.sheet_id
        AND sheets.user_id = ?1
       WHERE board_cell_states.user_id = ?1
         AND sheets.id = ?2
       ORDER BY board_cell_states.table_id,
                board_cell_states.row_item_id,
                board_cell_states.column_item_id`
    )
      .bind(userId, sheetId)
      .all<BoardCellStateRow>()
  ]);

  const periodKeys = getCurrentBoardCompletionPeriodKeys(axisItems.results, now).sort();
  const completions =
    periodKeys.length === 0
      ? { results: [] }
      : await env.DB.prepare(
          `SELECT board_cell_completions.table_id,
                  board_cell_completions.row_item_id,
                  board_cell_completions.column_item_id,
                  board_cell_completions.period_key,
                  board_cell_completions.completed
           FROM board_cell_completions
           JOIN board_tables
             ON board_tables.id = board_cell_completions.table_id
            AND board_tables.user_id = ?1
           JOIN sheets
             ON sheets.id = board_tables.sheet_id
            AND sheets.user_id = ?1
           WHERE board_cell_completions.user_id = ?1
             AND sheets.id = ?2
             AND board_cell_completions.period_key IN (${periodKeys.map((_, index) => `?${index + 3}`).join(", ")})
           ORDER BY board_cell_completions.table_id,
                    board_cell_completions.row_item_id,
                    board_cell_completions.column_item_id,
                    board_cell_completions.period_key`
        )
          .bind(userId, sheetId, ...periodKeys)
          .all();

  return {
    sheet,
    tables: tables.results,
    notes: notes.results,
    axisItems: axisItems.results,
    cellStates: resolveExpiredBoardCellStateRows(cellStates.results, axisItems.results, now),
    completions: completions.results,
    periodFingerprint: periodKeys.join("|")
  };
}

export async function loadBoardSheet(
  env: Env,
  userId: string,
  sheetId: string,
  now = new Date()
): Promise<BoardSheetPayload | null> {
  for (let attempt = 0; attempt < MAX_BOARD_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const payload = await loadBoardSheetAttempt(env, userId, sheetId, now);
    if (!payload) return null;

    const fence = await loadOwnedBoardSheetMetadata(env, userId, sheetId);
    if (!fence) return null;
    if (sameBoardSheetMetadata(payload.sheet, fence)) return payload;
  }

  throw new Error("Unable to read a stable board sheet snapshot");
}

export async function loadBoardBootstrap(
  env: Env,
  userId: string,
  requestedSheetId?: string
): Promise<BoardBootstrapPayload> {
  const now = new Date();
  let settingsPromise: Promise<BoardDisplaySettings> | null = null;
  let selectedAnySheet = false;

  for (let attempt = 0; attempt < MAX_BOARD_SNAPSHOT_ATTEMPTS; attempt += 1) {
    let manifest = await loadBoardManifest(env, userId);
    if (manifest.sheets.length === 0) {
      await ensureDefaultBoard(env, userId);
      manifest = await loadBoardManifest(env, userId);
    }

    const selected = selectOwnedSheet(manifest.sheets, requestedSheetId);
    if (!selected) continue;
    selectedAnySheet = true;
    settingsPromise ??= loadBoardDisplaySettings(env, userId);

    const [activeSheet, settings] = await Promise.all([
      loadBoardSheetAttempt(env, userId, selected.id, now),
      settingsPromise
    ]);
    const fence = await loadBoardManifest(env, userId);
    if (!activeSheet) continue;

    const fencedActiveSheet = fence.sheets.find((sheet) => sheet.id === activeSheet.sheet.id);
    if (sameBoardManifest(manifest, fence) && manifestItemMatchesSheet(fencedActiveSheet, activeSheet.sheet)) {
      return { userId, settings, manifest: fence, activeSheet };
    }
  }

  if (!selectedAnySheet) throw new Error("Default board initialization produced no sheet");
  throw new Error("Unable to read a stable board bootstrap snapshot");
}
