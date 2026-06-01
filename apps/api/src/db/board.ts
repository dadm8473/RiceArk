import {
  boardCompletionKey,
  type BoardAxis,
  type BoardAxisRole,
  type BoardOrientation,
  type BoardTaskAxis
} from "@riceark/core";
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

export interface BoardCellStatePatch {
  tableId: string;
  rowItemId: string;
  columnItemId: string;
  checkboxVisible: boolean;
}

export interface CreateBoardSheetInput {
  name: string;
}

export interface CreateBoardTableInput {
  sheetId: string;
  name: string;
  orientation: BoardOrientation;
}

export interface CreateBoardAxisItemInput {
  tableId: string;
  axis: BoardAxis;
  label: string;
}

export interface BoardAxisOrderInput {
  tableId: string;
  axis: BoardAxis;
  axisItemIds: string[];
}

export interface ManualBoardAxisItemDraft {
  axis: BoardAxis;
  kind: "task" | "custom";
  label: string;
  characterId: null;
  taskId: null;
  taskScope: "custom" | null;
  taskResetType: "daily" | null;
  taskResetRuleJson: string | null;
  taskColor: string | null;
}

export interface AuthorizedBoardCompletionTarget {
  tableId: string;
  rowItemId: string;
  columnItemId: string;
}

export interface BoardAxisItemForCompletionMapping {
  id: string;
  axis: BoardAxis;
  kind: "character" | "task" | "custom";
  taskId: string | null;
  characterId: string | null;
}

export interface LegacyCompletionSource {
  taskId: string;
  characterId: string | null;
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
  taskColor: string | null;
  sortOrder: number;
}

const DEFAULT_TASK_COLORS = ["#2563eb", "#13795b", "#b45309", "#7c3aed", "#be123c", "#0f766e"];
const DEFAULT_MANUAL_TASK_RESET_RULE_JSON = '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}';

export function boardRolesForTableOrientation(orientation: BoardOrientation): BoardRoles {
  if (orientation === "custom") {
    return {
      rowRole: "custom",
      columnRole: "custom",
      taskAxis: "none"
    };
  }

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

export function defaultBoardRolesForOrientation(orientation: ChecklistOrientation): BoardRoles {
  return boardRolesForTableOrientation(orientation);
}

export function buildManualBoardAxisItemDraft(input: {
  axis: BoardAxis;
  axisRole: BoardAxisRole;
  label: string;
  taskColorIndex: number;
}): ManualBoardAxisItemDraft {
  const isTaskLikeAxis = input.axisRole === "task" || (input.axisRole === "custom" && input.axis === "row");
  if (isTaskLikeAxis) {
    return {
      axis: input.axis,
      kind: "task",
      label: input.label,
      characterId: null,
      taskId: null,
      taskScope: "custom",
      taskResetType: "daily",
      taskResetRuleJson: DEFAULT_MANUAL_TASK_RESET_RULE_JSON,
      taskColor: DEFAULT_TASK_COLORS[input.taskColorIndex % DEFAULT_TASK_COLORS.length]!
    };
  }

  return {
    axis: input.axis,
    kind: "custom",
    label: input.label,
    characterId: null,
    taskId: null,
    taskScope: null,
    taskResetType: null,
    taskResetRuleJson: null,
    taskColor: null
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

function completionTargetKey(target: AuthorizedBoardCompletionTarget): string {
  return JSON.stringify([target.tableId, target.rowItemId, target.columnItemId]);
}

export function findUnauthorizedBoardCompletionPatches(
  patches: BoardCompletionPatch[],
  authorizedTargets: AuthorizedBoardCompletionTarget[]
): BoardCompletionPatch[] {
  const authorized = new Set(authorizedTargets.map(completionTargetKey));
  return patches.filter((patch) => !authorized.has(completionTargetKey(patch)));
}

export function findUnauthorizedBoardCellStatePatches(
  patches: BoardCellStatePatch[],
  authorizedTargets: AuthorizedBoardCompletionTarget[]
): BoardCellStatePatch[] {
  const authorized = new Set(authorizedTargets.map(completionTargetKey));
  return patches.filter((patch) => !authorized.has(completionTargetKey(patch)));
}

export function buildBoardCompletionPatchesFromLegacy(input: {
  tableId: string;
  axisItems: BoardAxisItemForCompletionMapping[];
  completions: LegacyCompletionSource[];
}): BoardCompletionPatch[] {
  const taskItems = new Map<string, BoardAxisItemForCompletionMapping>();
  const characterItems = new Map<string, BoardAxisItemForCompletionMapping>();

  for (const item of input.axisItems) {
    if (item.kind === "task" && item.taskId) taskItems.set(item.taskId, item);
    if (item.kind === "character" && item.characterId) characterItems.set(item.characterId, item);
  }

  return input.completions.flatMap((completion) => {
    if (!completion.characterId) return [];

    const taskItem = taskItems.get(completion.taskId);
    const characterItem = characterItems.get(completion.characterId);
    if (!taskItem || !characterItem || taskItem.axis === characterItem.axis) return [];

    const rowItem = taskItem.axis === "row" ? taskItem : characterItem;
    const columnItem = taskItem.axis === "column" ? taskItem : characterItem;

    return [
      {
        tableId: input.tableId,
        rowItemId: rowItem.id,
        columnItemId: columnItem.id,
        periodKey: completion.periodKey,
        completed: completion.completed
      }
    ];
  });
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
    taskColor: DEFAULT_TASK_COLORS[index % DEFAULT_TASK_COLORS.length]!,
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
    taskColor: null,
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
           task_color,
           sort_order
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        seed.taskColor,
        sortOrder
      );
    });

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  await syncLegacyCompletionsToBoard(env, userId, table.id);
}

async function syncLegacyCompletionsToBoard(env: Env, userId: string, tableId: string): Promise<void> {
  const [axisItems, completions] = await Promise.all([
    env.DB.prepare("SELECT id, axis, kind, task_id, character_id FROM board_axis_items WHERE user_id = ? AND table_id = ?")
      .bind(userId, tableId)
      .all<{
        id: string;
        axis: BoardAxis;
        kind: "character" | "task" | "custom";
        task_id: string | null;
        character_id: string | null;
      }>(),
    env.DB.prepare("SELECT task_id, character_id, period_key, completed FROM completions WHERE user_id = ?")
      .bind(userId)
      .all<{ task_id: string; character_id: string | null; period_key: string; completed: number }>()
  ]);

  const patches = buildBoardCompletionPatchesFromLegacy({
    tableId,
    axisItems: axisItems.results.map((item) => ({
      id: item.id,
      axis: item.axis,
      kind: item.kind,
      taskId: item.task_id,
      characterId: item.character_id
    })),
    completions: completions.results.map((completion) => ({
      taskId: completion.task_id,
      characterId: completion.character_id,
      periodKey: completion.period_key,
      completed: completion.completed === 1
    }))
  });

  await saveBoardCompletionPatches(env, userId, patches);
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

export async function createBoardSheet(
  env: Env,
  userId: string,
  input: CreateBoardSheetInput
): Promise<{ id: string } | null> {
  await ensureDefaultBoard(env, userId);

  const existing = await env.DB.prepare("SELECT id FROM sheets WHERE user_id = ? AND name = ?")
    .bind(userId, input.name)
    .first<{ id: string }>();
  if (existing) return null;

  const maxSort = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), -10) AS maxSortOrder FROM sheets WHERE user_id = ?")
    .bind(userId)
    .first<{ maxSortOrder: number | null }>();
  const id = crypto.randomUUID();
  const sortOrder = (maxSort?.maxSortOrder ?? -10) + 10;

  await env.DB.prepare(
    `INSERT INTO sheets (id, user_id, name, sort_order, is_default)
     VALUES (?, ?, ?, ?, 0)`
  )
    .bind(id, userId, input.name, sortOrder)
    .run();

  return { id };
}

export async function createBoardTable(
  env: Env,
  userId: string,
  input: CreateBoardTableInput
): Promise<{ id: string } | null> {
  await ensureDefaultBoard(env, userId);

  const sheet = await env.DB.prepare("SELECT id FROM sheets WHERE id = ? AND user_id = ?")
    .bind(input.sheetId, userId)
    .first<{ id: string }>();
  if (!sheet) return null;

  const placement = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), -10) AS maxSortOrder, COUNT(*) AS tableCount FROM board_tables WHERE user_id = ? AND sheet_id = ?"
  )
    .bind(userId, input.sheetId)
    .first<{ maxSortOrder: number | null; tableCount: number }>();
  const id = crypto.randomUUID();
  const sortOrder = (placement?.maxSortOrder ?? -10) + 10;
  const y = (placement?.tableCount ?? 0) * 220;
  const roles = boardRolesForTableOrientation(input.orientation);

  await env.DB.prepare(
    `INSERT INTO board_tables (
       id, user_id, sheet_id, name, sort_order, x, y, row_role, column_role, task_axis
     )
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
  )
    .bind(id, userId, input.sheetId, input.name, sortOrder, y, roles.rowRole, roles.columnRole, roles.taskAxis)
    .run();

  return { id };
}

export async function createBoardAxisItem(
  env: Env,
  userId: string,
  input: CreateBoardAxisItemInput
): Promise<{ id: string } | null> {
  await ensureDefaultBoard(env, userId);

  const table = await env.DB.prepare("SELECT id, row_role, column_role FROM board_tables WHERE id = ? AND user_id = ?")
    .bind(input.tableId, userId)
    .first<{ id: string; row_role: BoardAxisRole; column_role: BoardAxisRole }>();
  if (!table) return null;

  const stats = await env.DB.prepare(
    `SELECT COALESCE(MAX(sort_order), -10) AS maxSortOrder,
            SUM(CASE WHEN kind = 'task' THEN 1 ELSE 0 END) AS taskCount
     FROM board_axis_items
     WHERE user_id = ? AND table_id = ? AND axis = ?`
  )
    .bind(userId, input.tableId, input.axis)
    .first<{ maxSortOrder: number | null; taskCount: number | null }>();
  const axisRole = input.axis === "row" ? table.row_role : table.column_role;
  const draft = buildManualBoardAxisItemDraft({
    axis: input.axis,
    axisRole,
    label: input.label,
    taskColorIndex: stats?.taskCount ?? 0
  });
  const id = crypto.randomUUID();
  const sortOrder = (stats?.maxSortOrder ?? -10) + 10;

  await env.DB.prepare(
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
       task_color,
       sort_order
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      userId,
      input.tableId,
      draft.axis,
      draft.kind,
      draft.label,
      draft.characterId,
      draft.taskId,
      draft.taskScope,
      draft.taskResetType,
      draft.taskResetRuleJson,
      draft.taskColor,
      sortOrder
    )
    .run();

  return { id };
}

export async function reorderBoardAxisItems(
  env: Env,
  userId: string,
  input: BoardAxisOrderInput
): Promise<boolean> {
  const table = await env.DB.prepare("SELECT id FROM board_tables WHERE id = ? AND user_id = ?")
    .bind(input.tableId, userId)
    .first<{ id: string }>();
  if (!table) return false;

  const existing = await env.DB.prepare(
    `SELECT id
     FROM board_axis_items
     WHERE user_id = ? AND table_id = ? AND axis = ?
     ORDER BY sort_order, label`
  )
    .bind(userId, input.tableId, input.axis)
    .all<{ id: string }>();
  const existingIds = existing.results.map((item) => item.id);
  if (existingIds.length !== input.axisItemIds.length) return false;

  const existingSet = new Set(existingIds);
  if (input.axisItemIds.some((id) => !existingSet.has(id))) return false;

  const temporaryUpdates = input.axisItemIds.map((id, index) =>
    env.DB.prepare(
      `UPDATE board_axis_items
       SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND table_id = ? AND axis = ?`
    ).bind(-((index + 1) * 10), id, userId, input.tableId, input.axis)
  );
  const finalUpdates = input.axisItemIds.map((id, index) =>
    env.DB.prepare(
      `UPDATE board_axis_items
       SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND table_id = ? AND axis = ?`
    ).bind(index * 10, id, userId, input.tableId, input.axis)
  );

  if (temporaryUpdates.length > 0) {
    await env.DB.batch([...temporaryUpdates, ...finalUpdates]);
  }
  return true;
}

export async function saveBoardCompletionPatches(
  env: Env,
  userId: string,
  patches: BoardCompletionPatch[]
): Promise<boolean> {
  const merged = mergeBoardCompletionPatches(patches);
  const authorizedTargets = await loadAuthorizedBoardCompletionTargets(env, userId, merged);
  if (findUnauthorizedBoardCompletionPatches(merged, authorizedTargets).length > 0) {
    return false;
  }

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
  return true;
}

export async function saveBoardCellStatePatch(
  env: Env,
  userId: string,
  patch: BoardCellStatePatch
): Promise<boolean> {
  const authorizedTargets = await loadAuthorizedBoardCompletionTargets(env, userId, [
    {
      ...patch,
      periodKey: "daily:2000-01-01",
      completed: false
    }
  ]);
  if (findUnauthorizedBoardCellStatePatches([patch], authorizedTargets).length > 0) {
    return false;
  }

  if (patch.checkboxVisible) {
    await env.DB.prepare(
      `DELETE FROM board_cell_states
       WHERE user_id = ? AND table_id = ? AND row_item_id = ? AND column_item_id = ?`
    )
      .bind(userId, patch.tableId, patch.rowItemId, patch.columnItemId)
      .run();
    return true;
  }

  await env.DB.prepare(
    `INSERT INTO board_cell_states
       (id, user_id, table_id, row_item_id, column_item_id, checkbox_visible, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
     ON CONFLICT(table_id, row_item_id, column_item_id)
     DO UPDATE SET checkbox_visible = 0, updated_at = CURRENT_TIMESTAMP`
  )
    .bind(crypto.randomUUID(), userId, patch.tableId, patch.rowItemId, patch.columnItemId)
    .run();
  return true;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function placeholders(values: string[]): string {
  return values.map(() => "?").join(", ");
}

async function loadAuthorizedBoardCompletionTargets(
  env: Env,
  userId: string,
  patches: BoardCompletionPatch[]
): Promise<AuthorizedBoardCompletionTarget[]> {
  if (patches.length === 0) return [];

  const tableIds = unique(patches.map((patch) => patch.tableId));
  const rowItemIds = unique(patches.map((patch) => patch.rowItemId));
  const columnItemIds = unique(patches.map((patch) => patch.columnItemId));

  const authorized = await env.DB.prepare(
    `SELECT board_tables.id AS tableId,
            row_items.id AS rowItemId,
            column_items.id AS columnItemId
     FROM board_tables
     JOIN board_axis_items row_items
       ON row_items.table_id = board_tables.id
      AND row_items.axis = 'row'
      AND row_items.user_id = ?
      AND row_items.id IN (${placeholders(rowItemIds)})
     JOIN board_axis_items column_items
       ON column_items.table_id = board_tables.id
      AND column_items.axis = 'column'
      AND column_items.user_id = ?
      AND column_items.id IN (${placeholders(columnItemIds)})
     WHERE board_tables.user_id = ?
       AND board_tables.id IN (${placeholders(tableIds)})`
  )
    .bind(userId, ...rowItemIds, userId, ...columnItemIds, userId, ...tableIds)
    .all<AuthorizedBoardCompletionTarget>();

  return authorized.results;
}

export async function updateBoardAxisItemSize(
  env: Env,
  userId: string,
  axisItemId: string,
  sizePx: number
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE board_axis_items
     SET size_px = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  )
    .bind(sizePx, axisItemId, userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}
