import { boardCompletionKey, type BoardAxis, type BoardAxisRole, type BoardTaskAxis } from "@riceark/core";
import type { Env } from "../env";
import type { ChecklistOrientation } from "./settings";

export const DEFAULT_SHEET_NAME = "기본";
export const DEFAULT_TABLE_NAME = "숙제";

export interface BoardRoles {
  rowRole: BoardAxisRole;
  columnRole: BoardAxisRole;
  taskAxis: BoardTaskAxis;
}

export interface BoardPayload {
  userId: string;
  sheets: unknown[];
  tables: unknown[];
  axisItems: unknown[];
  cellStates: unknown[];
  completions: unknown[];
}

export interface BoardCompletionPatch {
  tableId: string;
  rowItemId: string;
  columnItemId: string;
  periodKey: string;
  completed: boolean;
}

export interface DefaultBoardTaskSource {
  id: string;
  name: string;
  scope: "character" | "roster";
  resetType: "daily" | "weekly" | "biweekly" | "custom";
  resetRuleJson: string;
  sortOrder: number;
}

export interface DefaultBoardCharacterSource {
  id: string;
  name: string;
  sortOrder: number;
}

export interface DefaultAxisItemSeed {
  axis: BoardAxis;
  kind: "character" | "task";
  label: string;
  characterId: string | null;
  taskId: string | null;
  taskScope: "character" | "roster" | null;
  taskResetType: "daily" | "weekly" | "biweekly" | "custom" | null;
  taskResetRuleJson: string | null;
  sortOrder: number;
}

export function defaultBoardRolesForOrientation(orientation: ChecklistOrientation): BoardRoles {
  if (orientation === "tasks_columns") {
    return {
      rowRole: "character",
      columnRole: "task",
      taskAxis: "columns"
    };
  }

  return {
    rowRole: "task",
    columnRole: "character",
    taskAxis: "rows"
  };
}

export function defaultOrientationForTableRoles(
  input: { rowRole: BoardAxisRole; columnRole: BoardAxisRole },
  fallback: ChecklistOrientation
): ChecklistOrientation {
  if (input.rowRole === "task" && input.columnRole === "character") return "tasks_rows";
  if (input.rowRole === "character" && input.columnRole === "task") return "tasks_columns";
  return fallback;
}

export function mergeBoardCompletionPatches(patches: BoardCompletionPatch[]): BoardCompletionPatch[] {
  const latest = new Map<string, BoardCompletionPatch>();
  for (const patch of patches) {
    latest.set(boardCompletionKey(patch), patch);
  }
  return [...latest.values()];
}

function bySortOrderThenName<T extends { sortOrder: number; name: string }>(left: T, right: T): number {
  return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name);
}

function buildTaskSeeds(axis: BoardAxis, tasks: DefaultBoardTaskSource[]): DefaultAxisItemSeed[] {
  return [...tasks].sort(bySortOrderThenName).map((task, index) => ({
    axis,
    kind: "task",
    label: task.name,
    characterId: null,
    taskId: task.id,
    taskScope: task.scope,
    taskResetType: task.resetType,
    taskResetRuleJson: task.resetRuleJson,
    sortOrder: index * 10
  }));
}

function buildCharacterSeeds(axis: BoardAxis, characters: DefaultBoardCharacterSource[]): DefaultAxisItemSeed[] {
  return [...characters].sort(bySortOrderThenName).map((character, index) => ({
    axis,
    kind: "character",
    label: character.name,
    characterId: character.id,
    taskId: null,
    taskScope: null,
    taskResetType: null,
    taskResetRuleJson: null,
    sortOrder: index * 10
  }));
}

export function buildDefaultAxisItemSeeds(input: {
  orientation: ChecklistOrientation;
  tasks: DefaultBoardTaskSource[];
  characters: DefaultBoardCharacterSource[];
}): DefaultAxisItemSeed[] {
  if (input.orientation === "tasks_columns") {
    return [...buildCharacterSeeds("row", input.characters), ...buildTaskSeeds("column", input.tasks)];
  }

  return [...buildTaskSeeds("row", input.tasks), ...buildCharacterSeeds("column", input.characters)];
}

function seedKey(seed: DefaultAxisItemSeed): string {
  return JSON.stringify([seed.axis, seed.kind, seed.taskId ?? seed.characterId]);
}

function axisItemKey(row: { axis: string; kind: string; task_id: string | null; character_id: string | null }): string {
  return JSON.stringify([row.axis, row.kind, row.task_id ?? row.character_id]);
}

async function readChecklistOrientation(env: Env, userId: string): Promise<ChecklistOrientation> {
  const settings = await env.DB.prepare("SELECT checklist_orientation FROM user_settings WHERE user_id = ?")
    .bind(userId)
    .first<{ checklist_orientation: ChecklistOrientation | null }>();
  return settings?.checklist_orientation === "tasks_columns" ? "tasks_columns" : "tasks_rows";
}

async function getOrCreateDefaultSheet(env: Env, userId: string): Promise<{ id: string }> {
  const existing = await env.DB.prepare("SELECT id FROM sheets WHERE user_id = ? AND is_default = 1 ORDER BY sort_order LIMIT 1")
    .bind(userId)
    .first<{ id: string }>();
  if (existing) return existing;

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sheets (id, user_id, name, sort_order, is_default)
     VALUES (?, ?, ?, 0, 1)
     ON CONFLICT(user_id, name)
     DO UPDATE SET is_default = 1, updated_at = CURRENT_TIMESTAMP`
  )
    .bind(id, userId, DEFAULT_SHEET_NAME)
    .run();

  const sheet = await env.DB.prepare("SELECT id FROM sheets WHERE user_id = ? AND name = ?")
    .bind(userId, DEFAULT_SHEET_NAME)
    .first<{ id: string }>();
  if (!sheet) throw new Error("Failed to create default sheet");
  return sheet;
}

async function getOrCreateDefaultTable(
  env: Env,
  userId: string,
  sheetId: string,
  orientation: ChecklistOrientation
): Promise<{ id: string; orientation: ChecklistOrientation }> {
  const existing = await env.DB.prepare(
    "SELECT id, row_role, column_role FROM board_tables WHERE user_id = ? AND sheet_id = ? ORDER BY sort_order LIMIT 1"
  )
    .bind(userId, sheetId)
    .first<{ id: string; row_role: BoardAxisRole; column_role: BoardAxisRole }>();
  if (existing) {
    return {
      id: existing.id,
      orientation: defaultOrientationForTableRoles(
        { rowRole: existing.row_role, columnRole: existing.column_role },
        orientation
      )
    };
  }

  const roles = defaultBoardRolesForOrientation(orientation);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO board_tables (
       id, user_id, sheet_id, name, sort_order, x, y, row_role, column_role, task_axis
     )
     VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`
  )
    .bind(id, userId, sheetId, DEFAULT_TABLE_NAME, roles.rowRole, roles.columnRole, roles.taskAxis)
    .run();
  return { id, orientation };
}

async function loadDefaultBoardTasks(env: Env, userId: string): Promise<DefaultBoardTaskSource[]> {
  const tasks = await env.DB.prepare(
    `SELECT tasks.id,
            COALESCE(task_overrides.name, tasks.name) AS name,
            tasks.scope,
            COALESCE(task_overrides.reset_type, tasks.reset_type) AS reset_type,
            COALESCE(task_overrides.reset_rule_json, tasks.reset_rule_json) AS reset_rule_json,
            COALESCE(task_orders.sort_order, tasks.sort_order) AS sort_order
     FROM tasks
     LEFT JOIN task_orders ON task_orders.task_id = tasks.id AND task_orders.user_id = ?
     LEFT JOIN task_overrides ON task_overrides.task_id = tasks.id AND task_overrides.user_id = ?
     WHERE (tasks.user_id = ? OR tasks.is_template = 1) AND tasks.enabled = 1
       AND COALESCE(task_overrides.enabled, 1) = 1`
  )
    .bind(userId, userId, userId)
    .all<{
      id: string;
      name: string;
      scope: "character" | "roster";
      reset_type: "daily" | "weekly" | "biweekly" | "custom";
      reset_rule_json: string;
      sort_order: number;
    }>();

  return tasks.results.map((task) => ({
    id: task.id,
    name: task.name,
    scope: task.scope,
    resetType: task.reset_type,
    resetRuleJson: task.reset_rule_json,
    sortOrder: task.sort_order
  }));
}

async function loadDefaultBoardCharacters(env: Env, userId: string): Promise<DefaultBoardCharacterSource[]> {
  const characters = await env.DB.prepare(
    "SELECT id, name, sort_order FROM characters WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL"
  )
    .bind(userId)
    .all<{ id: string; name: string; sort_order: number }>();

  return characters.results.map((character) => ({
    id: character.id,
    name: character.name,
    sortOrder: character.sort_order
  }));
}

export async function ensureDefaultBoard(env: Env, userId: string): Promise<void> {
  const orientation = await readChecklistOrientation(env, userId);
  const sheet = await getOrCreateDefaultSheet(env, userId);
  const table = await getOrCreateDefaultTable(env, userId, sheet.id, orientation);
  const [tasks, characters, existingAxisItems] = await Promise.all([
    loadDefaultBoardTasks(env, userId),
    loadDefaultBoardCharacters(env, userId),
    env.DB.prepare(
      "SELECT axis, kind, task_id, character_id, sort_order FROM board_axis_items WHERE user_id = ? AND table_id = ?"
    )
      .bind(userId, table.id)
      .all<{ axis: BoardAxis; kind: "character" | "task" | "custom"; task_id: string | null; character_id: string | null; sort_order: number }>()
  ]);

  const existingKeys = new Set(existingAxisItems.results.map(axisItemKey));
  const nextSortByAxis = new Map<BoardAxis, number>([
    ["row", 0],
    ["column", 0]
  ]);
  const hasExistingAxisItems = new Map<BoardAxis, boolean>([
    ["row", false],
    ["column", false]
  ]);

  for (const item of existingAxisItems.results) {
    hasExistingAxisItems.set(item.axis, true);
    nextSortByAxis.set(item.axis, Math.max(nextSortByAxis.get(item.axis) ?? 0, item.sort_order + 10));
  }

  const statements = buildDefaultAxisItemSeeds({ orientation: table.orientation, tasks, characters })
    .filter((seed) => !existingKeys.has(seedKey(seed)))
    .map((seed) => {
      const appendSortOrder = nextSortByAxis.get(seed.axis) ?? 0;
      const sortOrder = hasExistingAxisItems.get(seed.axis) ? appendSortOrder : seed.sortOrder;
      nextSortByAxis.set(seed.axis, sortOrder + 10);

      return env.DB.prepare(
        `INSERT INTO board_axis_items (
           id,
           user_id,
           table_id,
           axis,
           kind,
           label,
           character_id,
           task_id,
           task_scope,
           task_reset_type,
           task_reset_rule_json,
           sort_order
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        userId,
        table.id,
        seed.axis,
        seed.kind,
        seed.label,
        seed.characterId,
        seed.taskId,
        seed.taskScope,
        seed.taskResetType,
        seed.taskResetRuleJson,
        sortOrder
      );
    });

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
}

export async function loadBoard(env: Env, userId: string): Promise<BoardPayload> {
  await ensureDefaultBoard(env, userId);

  const [sheets, tables, axisItems, cellStates, completions] = await Promise.all([
    env.DB.prepare("SELECT * FROM sheets WHERE user_id = ? ORDER BY sort_order, name").bind(userId).all(),
    env.DB.prepare("SELECT * FROM board_tables WHERE user_id = ? ORDER BY sort_order, name").bind(userId).all(),
    env.DB.prepare("SELECT * FROM board_axis_items WHERE user_id = ? ORDER BY table_id, axis, sort_order, label")
      .bind(userId)
      .all(),
    env.DB.prepare("SELECT * FROM board_cell_states WHERE user_id = ? ORDER BY table_id, row_item_id, column_item_id")
      .bind(userId)
      .all(),
    env.DB.prepare(
      "SELECT table_id, row_item_id, column_item_id, period_key, completed FROM board_cell_completions WHERE user_id = ?"
    )
      .bind(userId)
      .all()
  ]);

  return {
    userId,
    sheets: sheets.results,
    tables: tables.results,
    axisItems: axisItems.results,
    cellStates: cellStates.results,
    completions: completions.results
  };
}

export async function saveBoardCompletionPatches(
  env: Env,
  userId: string,
  patches: BoardCompletionPatch[]
): Promise<void> {
  const merged = mergeBoardCompletionPatches(patches);
  const statements = merged.map((patch) =>
    env.DB.prepare(
      `INSERT INTO board_cell_completions
         (id, user_id, table_id, row_item_id, column_item_id, period_key, completed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, table_id, row_item_id, column_item_id, period_key)
       DO UPDATE SET completed = excluded.completed, updated_at = CURRENT_TIMESTAMP`
    ).bind(
      crypto.randomUUID(),
      userId,
      patch.tableId,
      patch.rowItemId,
      patch.columnItemId,
      patch.periodKey,
      patch.completed ? 1 : 0
    )
  );

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
}
