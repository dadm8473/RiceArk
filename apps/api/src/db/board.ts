import {
  boardCompletionKey,
  getNextResetBoundary,
  getPeriodKey,
  normalizeCharacterSelection,
  type BoardAxis,
  type BoardAxisRole,
  type BoardOrientation,
  type BoardTaskAxis,
  type ResetRule
} from "@riceark/core";
import type { Env } from "../env";
import type { CharacterSnapshot } from "./characters";
import type { ChecklistOrientation } from "./settings";
import type { LostArkEventRewardFilter } from "../lostark/events";
import {
  buildBoardMutationVersions,
  bumpBoardManifestVersionForDeletableSheetStatement as bumpBoardManifestVersionForDeletableSheet,
  bumpBoardManifestVersionForOwnedSheetStatement as bumpBoardManifestVersionForOwnedSheet,
  bumpBoardManifestVersionStatement as bumpBoardManifestVersion,
  bumpBoardSheetVersionForAxisItemStatement as bumpBoardSheetVersionForAxisItem,
  bumpBoardSheetVersionForNoteStatement as bumpBoardSheetVersionForNote,
  bumpBoardSheetVersionForTableAtExpectedLockStatement as bumpBoardSheetVersionForTableAtExpectedLock,
  bumpBoardSheetVersionStatement as bumpBoardSheetVersion,
  bumpBoardSheetVersionsForTablesStatement as bumpBoardSheetVersionsForTables,
  type BoardMutationResult,
  type BoardSheetVersion
} from "./boardVersions";
import {
  buildBoardCellStatePayloadRows,
  buildBoardCompletionPayloadRows,
  prepareBoardBulkPreflightStatement,
  prepareBoardCellStateWriteStatements,
  prepareBoardCompletionWriteStatements,
  type BoardBulkPreflightRow,
  type BoardCellStatePayloadRow,
  type BoardCompletionPayloadRow,
  type GuardedBoardCellStatePayloadRow,
  type GuardedBoardCompletionPayloadRow
} from "./boardBulkSql";
import type { BoardVersionSummary as CanonicalBoardVersionSummary } from "./boardReads";

export type { BoardVersionSummary } from "./boardReads";

export const DEFAULT_SHEET_NAME = "기본";
export const DEFAULT_TABLE_NAME = "숙제";
const NEW_BOARD_TABLE_DEFAULT_X = 24;
const NEW_BOARD_TABLE_DEFAULT_Y = 24;

function firstBatchRow<T>(result: unknown): T | null {
  if (!result || typeof result !== "object" || !("results" in result)) return null;
  const rows = (result as { results?: unknown[] }).results;
  return Array.isArray(rows) && rows.length > 0 ? (rows[0] as T) : null;
}

function returnedMutationId(result: unknown, expectedId: string): string | null {
  const row = firstBatchRow<{ id?: unknown }>(result);
  return row?.id === expectedId ? expectedId : null;
}

function returnedIds(result: unknown): string[] | null {
  if (!result || typeof result !== "object" || !("results" in result)) return null;
  const rows = (result as { results?: unknown[] }).results;
  if (!Array.isArray(rows)) return null;
  const ids = rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const id = (row as { id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  });
  return ids.length === rows.length ? ids : null;
}

function returnedAnySheetVersion(result: unknown): BoardSheetVersion | null {
  const row = firstBatchRow<{ id?: unknown; version?: unknown }>(result);
  return typeof row?.id === "string" && typeof row.version === "number" ? { id: row.id, version: row.version } : null;
}

function returnedSheetVersions(result: unknown): BoardSheetVersion[] | null {
  if (!result || typeof result !== "object" || !("results" in result)) return null;
  const rows = (result as { results?: unknown[] }).results;
  if (!Array.isArray(rows)) return null;
  const versions = rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const { id, version } = row as { id?: unknown; version?: unknown };
    return typeof id === "string" && typeof version === "number" ? [{ id, version }] : [];
  });
  return versions.length === rows.length ? versions : null;
}

function returnedSheetVersion(result: unknown, expectedId: string): BoardSheetVersion | null {
  const sheetVersion = returnedAnySheetVersion(result);
  return sheetVersion?.id === expectedId ? sheetVersion : null;
}

function returnedManifestVersion(result: unknown, expectedUserId: string): number | null {
  const row = firstBatchRow<{ user_id?: unknown; version?: unknown }>(result);
  return row?.user_id === expectedUserId && typeof row.version === "number" ? row.version : null;
}

function isSheetNameConflictError(error: unknown): boolean {
  return /UNIQUE constraint failed:\s*sheets\.user_id,\s*sheets\.name/i.test(String(error));
}

function isBoardTaskCreateRequestConflictError(error: unknown): boolean {
  const message = String(error);
  if (!/UNIQUE constraint/i.test(message)) return false;
  return /(?:tasks\.user_id,\s*tasks\.create_request_id|board_axis_items\.table_id,\s*board_axis_items\.create_request_id|idx_tasks_user_create_request|idx_board_axis_items_table_create_request)/i.test(
    message
  );
}

function incompleteBoardMutation(): never {
  throw new Error("Board mutation batch did not return every required row");
}

export interface BoardRoles {
  rowRole: BoardAxisRole;
  columnRole: BoardAxisRole;
  taskAxis: BoardTaskAxis;
}

export interface BoardPayload {
  userId: string;
  settings: unknown;
  sheets: unknown[];
  tables: unknown[];
  notes: unknown[];
  axisItems: unknown[];
  cellStates: unknown[];
  completions: unknown[];
}

export interface BoardShareStartResult {
  shareId: string;
}

export interface BoardShareSummary {
  sheetId: string;
  sheetName: string;
  shareId: string;
  createdAt: string;
}

export interface BoardShareFavoriteSummary extends BoardShareSummary {
  ownerDisplayName: string;
}

export interface SharedBoardPayload extends BoardPayload {
  shareId: string;
  readOnly: true;
}

export interface SharedBoardVersionSummary {
  shareId: string;
  sheetId: string;
  version: number;
  periodFingerprint: string;
}

export interface BoardCompletionPatch {
  tableId: string;
  rowItemId: string;
  columnItemId: string;
  periodKey: string;
  completed: boolean;
}

export type BoardCellMarkIcon = "memo" | "pin" | "clock" | "star" | "alert" | "flag" | "tag";
export type BoardCellMarkType = "default" | "fixed" | "reserved" | "disabled";

export interface BoardCellStatePatch {
  tableId: string;
  rowItemId: string;
  columnItemId: string;
  markType: BoardCellMarkType;
  markIcon?: BoardCellMarkIcon | null | undefined;
  memo: string | null;
  periodKey?: string | undefined;
}

export type BoardCompletionRejectedKey = Pick<
  BoardCompletionPatch,
  "tableId" | "rowItemId" | "columnItemId" | "periodKey"
>;
export type BoardCellStateRejectedKey = Pick<BoardCellStatePatch, "tableId" | "rowItemId" | "columnItemId">;

export interface BoardBulkMutationRejection<K extends object> {
  ok: false;
  rejectedKeys: K[];
}

export interface CreateBoardSheetInput {
  name: string;
}

export interface CreateBoardTableInput {
  sheetId: string;
  name: string;
  orientation: BoardOrientation;
  defaultRowHeight?: number | undefined;
  defaultColumnWidth?: number | undefined;
  displaySettings?: BoardDisplaySettingsInput | null | undefined;
  eventOptions?: BoardEventOptionsInput | null | undefined;
  templateType?: BoardTableTemplateType | undefined;
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

export interface BoardTableLayoutPatch {
  x: number;
  y: number;
  width: number | null;
  height: number | null;
}

export interface CreateBoardNoteInput {
  sheetId: string;
  title: string;
  body: string;
  color?: string | undefined;
}

export interface UpdateBoardNoteInput {
  title?: string | undefined;
  body?: string | undefined;
  color?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  locked?: 0 | 1 | undefined;
}

export interface BoardNoteLayoutPatch {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UpdateBoardTableSettingsInput {
  name: string;
  defaultRowHeight: number;
  defaultColumnWidth: number;
  locked?: 0 | 1 | undefined;
  displaySettings?: BoardDisplaySettingsInput | null | undefined;
  eventOptions?: BoardEventOptionsInput | null | undefined;
}

export type BoardTableSettingsUpdateResult = BoardMutationResult | "not_found" | "locked";

export interface CurrentBoardTableSettings {
  name: string;
  default_row_height: number;
  default_column_width: number;
  display_options_json: string | null;
  event_options_json: string | null;
  locked: number;
  template_type: BoardTableTemplateType;
}

export interface BoardAxisItemTransposeSource {
  id: string;
  axis: BoardAxis;
  sort_order: number;
  size_px: number | null;
  cross_size_px: number | null;
}

export interface BoardAxisItemTransposePlanEntry {
  id: string;
  fromAxis: BoardAxis;
  toAxis: BoardAxis;
  temporarySortOrder: number;
  finalSortOrder: number;
  finalSizePx: number | null;
  finalCrossSizePx: number | null;
}

export interface UpdateBoardAxisItemInput {
  label: string;
  taskColor?: string | null | undefined;
  taskResetRule?: ResetRule | undefined;
  separator?: BoardAxisSeparatorInput | null | undefined;
  displaySettings?: BoardDisplaySettingsInput | null | undefined;
}

export interface BoardAxisSeparatorInput {
  widthPx: number;
  style: "solid" | "dashed" | "dotted";
  color: string;
}

export interface BoardDisplaySettingsInput {
  show_display_name: 0 | 1;
  show_server_name: 0 | 1;
  show_class_name: 0 | 1;
  show_item_level: 0 | 1;
  show_combat_power: 0 | 1;
}

export type BoardTableTemplateType = "custom" | "lostark_event";

export interface BoardEventOptionsInput {
  rewardFilters: LostArkEventRewardFilter[];
}

export interface BoardCharacterSelectionInput {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  combatPower: string | null;
}

export type BoardManualCharacterInput = Omit<CharacterSnapshot, "id">;

export interface BoardTaskInput {
  name: string;
  scope: "character" | "roster";
  resetRule: ResetRule;
  taskColor?: string | undefined;
  createRequestId?: string | null | undefined;
}

export interface BoardAxisItemSizePatch {
  sizePx?: number | undefined;
  crossSizePx?: number | undefined;
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
  rowKind?: "character" | "task" | "custom";
  columnKind?: "character" | "task" | "custom";
  rowTaskResetRuleJson?: string | null;
  columnTaskResetRuleJson?: string | null;
}

export interface BoardAxisItemForCompletionMapping {
  id: string;
  axis: BoardAxis;
  kind: "character" | "task" | "custom";
  taskId: string | null;
  characterId: string | null;
}

interface BoardAxisItemSizeSeed {
  size_px: number | null;
  cross_size_px: number | null;
}

interface BoardLoadAxisItemRow extends Record<string, unknown> {
  kind: "character" | "task" | "custom";
  task_reset_rule_json: string | null;
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
  resetType: "daily" | "weekly" | "biweekly" | "custom" | "none";
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
  taskResetType: "daily" | "weekly" | "biweekly" | "custom" | "none" | null;
  taskResetRuleJson: string | null;
  taskColor: string | null;
  sortOrder: number;
}

const DEFAULT_TASK_COLORS = ["#2563eb", "#13795b", "#b45309", "#7c3aed", "#be123c", "#0f766e"];
const DEFAULT_MANUAL_TASK_RESET_RULE_JSON = '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}';
const DEFAULT_EVENT_REWARD_FILTERS: LostArkEventRewardFilter[] = ["gold", "card", "coin", "silver", "cardXp"];
const DEFAULT_BOARD_DISPLAY_SETTINGS = {
  show_display_name: 1,
  show_server_name: 0,
  show_class_name: 0,
  show_item_level: 1,
  show_combat_power: 0
};

function serializeBoardDisplaySettings(settings: BoardDisplaySettingsInput | null | undefined): string | null {
  return settings ? JSON.stringify(settings) : null;
}

function serializeBoardEventOptions(templateType: BoardTableTemplateType, options: BoardEventOptionsInput | null | undefined): string | null {
  if (templateType !== "lostark_event") return null;
  return JSON.stringify({
    rewardFilters: options?.rewardFilters === undefined ? DEFAULT_EVENT_REWARD_FILTERS : [...new Set(options.rewardFilters)]
  });
}

function getNextBoardTableDisplayOptionsJson(
  current: Pick<CurrentBoardTableSettings, "display_options_json">,
  input: Pick<UpdateBoardTableSettingsInput, "displaySettings">
): string | null {
  return input.displaySettings === undefined ? current.display_options_json : serializeBoardDisplaySettings(input.displaySettings);
}

function getNextBoardTableEventOptionsJson(
  current: Pick<CurrentBoardTableSettings, "event_options_json" | "template_type">,
  input: Pick<UpdateBoardTableSettingsInput, "eventOptions">
): string | null {
  return input.eventOptions === undefined ? current.event_options_json : serializeBoardEventOptions(current.template_type, input.eventOptions);
}

export function canApplyBoardTableSettingsUpdate(
  current: CurrentBoardTableSettings,
  input: UpdateBoardTableSettingsInput
): boolean {
  if (current.locked !== 1) return true;

  const displayOptionsJson = getNextBoardTableDisplayOptionsJson(current, input);
  const eventOptionsJson = getNextBoardTableEventOptionsJson(current, input);
  return (
    input.name === current.name &&
    input.defaultRowHeight === current.default_row_height &&
    input.defaultColumnWidth === current.default_column_width &&
    displayOptionsJson === current.display_options_json &&
    eventOptionsJson === current.event_options_json
  );
}

function getAxisForRole(table: { row_role: BoardAxisRole; column_role: BoardAxisRole }, role: BoardAxisRole): BoardAxis {
  if (table.row_role === role) return "row";
  if (table.column_role === role) return "column";
  return role === "task" ? "row" : "column";
}

async function readExistingAxisForKind(
  env: Env,
  userId: string,
  tableId: string,
  kind: "character" | "task"
): Promise<BoardAxis | null> {
  const axisItems = await env.DB.prepare(
    "SELECT axis, kind FROM board_axis_items WHERE user_id = ? AND table_id = ? AND visible = 1"
  )
    .bind(userId, tableId)
    .all<{ axis: BoardAxis; kind: "character" | "task" | "custom" }>();
  const axes = new Set(axisItems.results.filter((item) => item.kind === kind).map((item) => item.axis));

  if (axes.size !== 1) return null;
  return axes.has("column") ? "column" : "row";
}

function planBoardTableRoleRepairFromExistingAxes(
  env: Env,
  userId: string,
  tableId: string,
  table: { row_role: BoardAxisRole; column_role: BoardAxisRole },
  axes: { characterAxis: BoardAxis | null; taskAxis: BoardAxis | null }
): {
  roles: { row_role: BoardAxisRole; column_role: BoardAxisRole };
  statement: ReturnType<Env["DB"]["prepare"]> | null;
} {
  if (!axes.characterAxis || !axes.taskAxis || axes.characterAxis === axes.taskAxis) {
    return { roles: table, statement: null };
  }

  const roles =
    axes.taskAxis === "row"
      ? { row_role: "task" as const, column_role: "character" as const, task_axis: "rows" as const }
      : { row_role: "character" as const, column_role: "task" as const, task_axis: "columns" as const };
  if (table.row_role === roles.row_role && table.column_role === roles.column_role) {
    return { roles, statement: null };
  }

  return {
    roles,
    statement: env.DB.prepare(
      `UPDATE board_tables
       SET row_role = ?, column_role = ?, task_axis = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND locked = 0
       RETURNING id`
    ).bind(roles.row_role, roles.column_role, roles.task_axis, tableId, userId)
  };
}

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

export function transposeBoardRoles(input: BoardRoles): BoardRoles {
  return {
    rowRole: input.columnRole,
    columnRole: input.rowRole,
    taskAxis: input.taskAxis === "rows" ? "columns" : input.taskAxis === "columns" ? "rows" : "none"
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

export function buildBoardAxisItemTransposePlan(
  axisItems: BoardAxisItemTransposeSource[]
): BoardAxisItemTransposePlanEntry[] {
  const nextTemporaryIndex: Record<BoardAxis, number> = {
    row: 0,
    column: 0
  };
  const slotsByAxis: Record<BoardAxis, BoardAxisItemTransposeSource[]> = {
    row: axisItems.filter((item) => item.axis === "row").sort((a, b) => a.sort_order - b.sort_order),
    column: axisItems.filter((item) => item.axis === "column").sort((a, b) => a.sort_order - b.sort_order)
  };

  const readDestinationSlot = (axis: BoardAxis, index: number) => {
    const slots = slotsByAxis[axis];
    return slots[index] ?? slots.at(-1) ?? null;
  };

  return axisItems.map((item) => {
    const isRow = item.axis === "row";
    const sourceIndex = slotsByAxis[item.axis].findIndex((slot) => slot.id === item.id);
    const destinationSlot = readDestinationSlot(isRow ? "column" : "row", sourceIndex);
    nextTemporaryIndex[item.axis] += 1;
    return {
      id: item.id,
      fromAxis: item.axis,
      toAxis: isRow ? "column" : "row",
      temporarySortOrder: (isRow ? -1000000 : -2000000) - nextTemporaryIndex[item.axis] * 10,
      finalSortOrder: item.sort_order,
      finalSizePx: destinationSlot?.size_px ?? null,
      finalCrossSizePx: destinationSlot?.cross_size_px ?? null
    };
  });
}

export function mergeBoardCompletionPatches(patches: BoardCompletionPatch[]): BoardCompletionPatch[] {
  const latest = new Map<string, BoardCompletionPatch>();
  for (const patch of patches) {
    latest.set(boardCompletionKey(patch), patch);
  }
  return [...latest.values()];
}

function boardCellStatePatchKey(patch: BoardCellStatePatch): string {
  return JSON.stringify([patch.tableId, patch.rowItemId, patch.columnItemId]);
}

export function mergeBoardCellStatePatches(patches: BoardCellStatePatch[]): BoardCellStatePatch[] {
  const latest = new Map<string, BoardCellStatePatch>();
  for (const patch of patches) {
    latest.set(boardCellStatePatchKey(patch), patch);
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

function parseResetRule(value: string | null | undefined): ResetRule | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ResetRule;
  } catch {
    return null;
  }
}

function currentTargetPeriodKeys(target: AuthorizedBoardCompletionTarget, now: Date): string[] {
  const rules = [
    target.rowKind === "task" ? parseResetRule(target.rowTaskResetRuleJson) : null,
    target.columnKind === "task" ? parseResetRule(target.columnTaskResetRuleJson) : null
  ].filter((rule): rule is ResetRule => rule !== null);

  return rules.flatMap((rule) => {
    try {
      return [getPeriodKey(rule, now)];
    } catch {
      return [];
    }
  });
}

export function findBoardCompletionPatchesOutsideCurrentPeriod(
  patches: BoardCompletionPatch[],
  authorizedTargets: AuthorizedBoardCompletionTarget[],
  now: Date = new Date()
): BoardCompletionPatch[] {
  const authorized = new Map(authorizedTargets.map((target) => [completionTargetKey(target), target]));
  return patches.filter((patch) => {
    const target = authorized.get(completionTargetKey(patch));
    if (!target) return false;
    return !currentTargetPeriodKeys(target, now).includes(patch.periodKey);
  });
}

export function getCurrentBoardCompletionPeriodKeys(
  axisItems: Array<Pick<BoardAxisItemForCompletionMapping, "kind"> & { task_reset_rule_json?: string | null }>,
  now: Date = new Date()
): string[] {
  const keys = new Set<string>();
  for (const item of axisItems) {
    if (item.kind !== "task") continue;
    const rule = parseResetRule(item.task_reset_rule_json);
    if (rule) keys.add(getPeriodKey(rule, now));
  }
  return [...keys];
}

export function findUnauthorizedBoardCellStatePatches(
  patches: BoardCellStatePatch[],
  authorizedTargets: AuthorizedBoardCompletionTarget[]
): BoardCellStatePatch[] {
  const authorized = new Set(authorizedTargets.map(completionTargetKey));
  return patches.filter((patch) => !authorized.has(completionTargetKey(patch)));
}

export function findBoardCellStatePatchesOutsideCurrentPeriod(
  patches: BoardCellStatePatch[],
  authorizedTargets: AuthorizedBoardCompletionTarget[],
  now: Date = new Date()
): BoardCellStatePatch[] {
  const authorized = new Map(authorizedTargets.map((target) => [completionTargetKey(target), target]));
  return patches.filter((patch) => {
    if (patch.markType !== "reserved" || !patch.periodKey) return false;
    const target = authorized.get(completionTargetKey(patch));
    if (!target) return false;
    return !currentTargetPeriodKeys(target, now).includes(patch.periodKey);
  });
}

export interface BoardCellStateRowForExpiry {
  row_item_id: string;
  column_item_id: string;
  mark_type?: string | null;
  mark_period_key?: string | null;
}

export function resolveExpiredBoardCellStateRows<T extends BoardCellStateRowForExpiry>(
  rows: T[],
  axisItems: Array<{ id: string; kind: string; task_reset_rule_json?: string | null }>,
  now: Date = new Date()
): T[] {
  const itemsById = new Map(axisItems.map((item) => [item.id, item]));
  return rows.filter((row) => {
    if (row.mark_type !== "reserved") return true;
    const currentKeys = [itemsById.get(row.row_item_id), itemsById.get(row.column_item_id)].flatMap((item) => {
      if (!item || item.kind !== "task") return [];
      const rule = parseResetRule(item.task_reset_rule_json);
      if (!rule) return [];
      try {
        return [getPeriodKey(rule, now)];
      } catch {
        return [];
      }
    });
    return row.mark_period_key !== null && row.mark_period_key !== undefined && currentKeys.includes(row.mark_period_key);
  });
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

export function buildMissingDefaultAxisItemSeeds(input: {
  orientation: ChecklistOrientation;
  defaultTableCreated: boolean;
  existingAxisItems: Array<{
    axis: BoardAxis;
    kind: "character" | "task" | "custom";
    task_id: string | null;
    character_id: string | null;
    sort_order: number;
  }>;
  tasks: DefaultBoardTaskSource[];
  characters: DefaultBoardCharacterSource[];
}): DefaultAxisItemSeed[] {
  if (!input.defaultTableCreated) return [];

  const existingKeys = new Set(input.existingAxisItems.map(axisItemKey));
  const nextSortByAxis = new Map<BoardAxis, number>([
    ["row", 0],
    ["column", 0]
  ]);
  const hasExistingAxisItems = new Map<BoardAxis, boolean>([
    ["row", false],
    ["column", false]
  ]);

  for (const item of input.existingAxisItems) {
    hasExistingAxisItems.set(item.axis, true);
    nextSortByAxis.set(item.axis, Math.max(nextSortByAxis.get(item.axis) ?? 0, item.sort_order + 10));
  }

  return buildDefaultAxisItemSeeds({ orientation: input.orientation, tasks: input.tasks, characters: input.characters })
    .filter((seed) => !existingKeys.has(seedKey(seed)))
    .map((seed) => {
      const appendSortOrder = nextSortByAxis.get(seed.axis) ?? 0;
      const sortOrder = hasExistingAxisItems.get(seed.axis) ? appendSortOrder : seed.sortOrder;
      nextSortByAxis.set(seed.axis, sortOrder + 10);

      return {
        ...seed,
        sortOrder
      };
    });
}

function seedKey(seed: DefaultAxisItemSeed): string {
  return JSON.stringify([seed.axis, seed.kind, seed.taskId ?? seed.characterId]);
}

function axisItemKey(row: { axis: string; kind: string; task_id: string | null; character_id: string | null }): string {
  return JSON.stringify([row.axis, row.kind, row.task_id ?? row.character_id]);
}

async function readBoardAxisItemSizeSeed(env: Env, userId: string, tableId: string, axis: BoardAxis): Promise<BoardAxisItemSizeSeed> {
  const seed = await env.DB.prepare(
    `SELECT size_px, cross_size_px
     FROM board_axis_items
     WHERE user_id = ? AND table_id = ? AND axis = ? AND visible = 1
       AND (size_px IS NOT NULL OR cross_size_px IS NOT NULL)
     ORDER BY sort_order DESC, label DESC
     LIMIT 1`
  )
    .bind(userId, tableId, axis)
    .first<BoardAxisItemSizeSeed>();

  return seed ?? { size_px: null, cross_size_px: null };
}

async function readBoardAxisItemByCreateRequestId(
  env: Env,
  userId: string,
  tableId: string,
  createRequestId: string
): Promise<{ id: string } | null> {
  return env.DB.prepare(
    `SELECT id
     FROM board_axis_items
     WHERE user_id = ? AND table_id = ? AND create_request_id = ?`
  )
    .bind(userId, tableId, createRequestId)
    .first<{ id: string }>();
}

async function readChecklistOrientation(env: Env, userId: string): Promise<ChecklistOrientation> {
  const settings = await env.DB.prepare("SELECT checklist_orientation FROM user_settings WHERE user_id = ?")
    .bind(userId)
    .first<{ checklist_orientation: ChecklistOrientation | null }>();
  return settings?.checklist_orientation === "tasks_columns" ? "tasks_columns" : "tasks_rows";
}

async function getOrCreateDefaultSheet(env: Env, userId: string): Promise<{ id: string; created: boolean }> {
  const existing = await env.DB.prepare("SELECT id FROM sheets WHERE user_id = ? AND is_default = 1 ORDER BY sort_order LIMIT 1")
    .bind(userId)
    .first<{ id: string }>();
  if (existing) return { id: existing.id, created: false };

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
  return { id: sheet.id, created: true };
}

async function getOrCreateDefaultTable(
  env: Env,
  userId: string,
  sheetId: string,
  orientation: ChecklistOrientation,
  canCreate: boolean
): Promise<{ id: string; orientation: ChecklistOrientation; created: boolean } | null> {
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
      ),
      created: false
    };
  }

  if (!canCreate) return null;

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
  return { id, orientation, created: true };
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
      reset_type: "daily" | "weekly" | "biweekly" | "custom" | "none";
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

async function hasAnyBoardTable(env: Env, userId: string): Promise<boolean> {
  const table = await env.DB.prepare("SELECT id FROM board_tables WHERE user_id = ? LIMIT 1").bind(userId).first();
  return Boolean(table);
}

export async function ensureDefaultBoard(env: Env, userId: string): Promise<void> {
  if (await hasAnyBoardTable(env, userId)) return;

  const orientation = await readChecklistOrientation(env, userId);
  const sheet = await getOrCreateDefaultSheet(env, userId);
  const table = await getOrCreateDefaultTable(env, userId, sheet.id, orientation, sheet.created);
  if (!table) return;
  const [tasks, characters, existingAxisItems] = await Promise.all([
    loadDefaultBoardTasks(env, userId),
    loadDefaultBoardCharacters(env, userId),
    env.DB.prepare(
      "SELECT axis, kind, task_id, character_id, sort_order FROM board_axis_items WHERE user_id = ? AND table_id = ?"
    )
      .bind(userId, table.id)
      .all<{ axis: BoardAxis; kind: "character" | "task" | "custom"; task_id: string | null; character_id: string | null; sort_order: number }>()
  ]);

  const statements = buildMissingDefaultAxisItemSeeds({
    orientation: table.orientation,
    defaultTableCreated: table.created,
    existingAxisItems: existingAxisItems.results,
    tasks,
    characters
  }).map((seed) =>
    env.DB.prepare(
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
      seed.sortOrder
    )
  );

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

  const [sheets, tables, notes, axisItems, cellStates, settings] = await Promise.all([
    env.DB.prepare("SELECT * FROM sheets WHERE user_id = ? ORDER BY sort_order, name").bind(userId).all(),
    env.DB.prepare("SELECT * FROM board_tables WHERE user_id = ? ORDER BY sort_order, name").bind(userId).all(),
    env.DB.prepare("SELECT * FROM board_notes WHERE user_id = ? ORDER BY sort_order, title").bind(userId).all(),
    env.DB.prepare(
      `SELECT board_axis_items.*,
              characters.name AS character_name,
              characters.display_name AS character_display_name,
              characters.server_name AS character_server_name,
              characters.class_name AS character_class_name,
              characters.item_level AS character_item_level,
              characters.combat_power AS character_combat_power,
              characters.source AS character_source
       FROM board_axis_items
       LEFT JOIN characters
         ON characters.id = board_axis_items.character_id
        AND characters.user_id = board_axis_items.user_id
        AND characters.deleted_at IS NULL
       WHERE board_axis_items.user_id = ?
       ORDER BY board_axis_items.table_id, board_axis_items.axis, board_axis_items.sort_order, board_axis_items.label`
    )
      .bind(userId)
      .all<BoardLoadAxisItemRow>(),
    env.DB.prepare("SELECT * FROM board_cell_states WHERE user_id = ? ORDER BY table_id, row_item_id, column_item_id")
      .bind(userId)
      .all(),
    env.DB.prepare(
      `SELECT show_display_name,
              show_server_name,
              show_class_name,
              show_item_level,
              show_combat_power
       FROM user_settings
       WHERE user_id = ?`
    )
      .bind(userId)
      .first()
  ]);
  const periodKeys = getCurrentBoardCompletionPeriodKeys(axisItems.results);
  const completions =
    periodKeys.length > 0
      ? await env.DB.prepare(
          `SELECT table_id, row_item_id, column_item_id, period_key, completed
           FROM board_cell_completions
           WHERE user_id = ? AND period_key IN (${placeholders(periodKeys)})`
        )
          .bind(userId, ...periodKeys)
          .all()
      : { results: [] };

  return {
    userId,
    settings: settings ?? DEFAULT_BOARD_DISPLAY_SETTINGS,
    sheets: sheets.results,
    tables: tables.results,
    notes: notes.results,
    axisItems: axisItems.results,
    cellStates: resolveExpiredBoardCellStateRows(
      cellStates.results as unknown as BoardCellStateRowForExpiry[],
      axisItems.results as unknown as Array<{ id: string; kind: string; task_reset_rule_json?: string | null }>
    ),
    completions: completions.results
  };
}

const BOARD_SHARE_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function generateBoardShareId(length = 22): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => BOARD_SHARE_ID_ALPHABET[byte & 63]).join("");
}

export async function startBoardSheetShare(env: Env, userId: string, sheetId: string): Promise<BoardShareStartResult | "not_found"> {
  const shareId = generateBoardShareId();
  const id = crypto.randomUUID();
  const [, insertedResult] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM board_shares
       WHERE owner_user_id = ? AND sheet_id = ?
         AND EXISTS (
           SELECT 1 FROM sheets
           WHERE sheets.id = board_shares.sheet_id
             AND sheets.user_id = board_shares.owner_user_id
             AND sheets.user_id = ?
         )`
    ).bind(userId, sheetId, userId),
    env.DB.prepare(
      `INSERT INTO board_shares (id, owner_user_id, sheet_id, share_id)
       SELECT ?, ?, sheets.id, ?
       FROM sheets
       WHERE sheets.id = ? AND sheets.user_id = ?
       RETURNING id`
    ).bind(id, userId, shareId, sheetId, userId)
  ]);
  if (!returnedMutationId(insertedResult, id)) return "not_found";

  return { shareId };
}

export async function stopBoardSheetShare(env: Env, userId: string, sheetId: string): Promise<boolean> {
  const [deletedResult] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM board_shares
       WHERE owner_user_id = ? AND sheet_id = ?
         AND EXISTS (
           SELECT 1
           FROM sheets
           WHERE sheets.id = board_shares.sheet_id
             AND sheets.user_id = board_shares.owner_user_id
             AND sheets.user_id = ?
         )
       RETURNING sheet_id AS id`
    ).bind(userId, sheetId, userId)
  ]);
  return returnedMutationId(deletedResult, sheetId) !== null;
}

export async function listBoardShares(env: Env, userId: string): Promise<BoardShareSummary[]> {
  const rows = await env.DB.prepare(
    `SELECT board_shares.sheet_id,
            sheets.name AS sheet_name,
            board_shares.share_id,
            board_shares.created_at
     FROM board_shares
     JOIN sheets
       ON sheets.id = board_shares.sheet_id
      AND sheets.user_id = board_shares.owner_user_id
     WHERE board_shares.owner_user_id = ?
     ORDER BY sheets.sort_order, sheets.name`
  )
    .bind(userId)
    .all<{ sheet_id: string; sheet_name: string; share_id: string; created_at: string }>();

  return rows.results.map((row) => ({
    sheetId: row.sheet_id,
    sheetName: row.sheet_name,
    shareId: row.share_id,
    createdAt: row.created_at
  }));
}

export async function addBoardShareFavorite(env: Env, userId: string, shareId: string): Promise<{ shareId: string } | "not_found"> {
  const share = await env.DB.prepare("SELECT share_id FROM board_shares WHERE share_id = ?")
    .bind(shareId)
    .first<{ share_id: string }>();
  if (!share) return "not_found";

  await env.DB.prepare(
    `INSERT OR IGNORE INTO board_share_favorites (user_id, share_id)
     VALUES (?, ?)`
  )
    .bind(userId, shareId)
    .run();

  return { shareId };
}

export async function deleteBoardShareFavorite(env: Env, userId: string, shareId: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM board_share_favorites WHERE user_id = ? AND share_id = ?").bind(userId, shareId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function listBoardShareFavorites(env: Env, userId: string): Promise<BoardShareFavoriteSummary[]> {
  const rows = await env.DB.prepare(
    `SELECT board_share_favorites.share_id,
            board_shares.sheet_id,
            sheets.name AS sheet_name,
            users.display_name AS owner_display_name,
            board_share_favorites.created_at
     FROM board_share_favorites
     JOIN board_shares
       ON board_shares.share_id = board_share_favorites.share_id
     JOIN sheets
       ON sheets.id = board_shares.sheet_id
      AND sheets.user_id = board_shares.owner_user_id
     JOIN users
       ON users.id = board_shares.owner_user_id
     WHERE board_share_favorites.user_id = ?
     ORDER BY board_share_favorites.created_at DESC`
  )
    .bind(userId)
    .all<{
      share_id: string;
      sheet_id: string;
      sheet_name: string;
      owner_display_name: string;
      created_at: string;
    }>();

  return rows.results.map((row) => ({
    shareId: row.share_id,
    sheetId: row.sheet_id,
    sheetName: row.sheet_name,
    ownerDisplayName: row.owner_display_name,
    createdAt: row.created_at
  }));
}

export async function loadSharedBoard(env: Env, shareId: string, now = new Date()): Promise<SharedBoardPayload | null> {
  const share = await env.DB.prepare(
    `SELECT owner_user_id, sheet_id
     FROM board_shares
     WHERE share_id = ?`
  )
    .bind(shareId)
    .first<{ owner_user_id: string; sheet_id: string }>();
  if (!share) return null;

  const [sheets, tables, notes, settings] = await Promise.all([
    env.DB.prepare("SELECT * FROM sheets WHERE id = ? AND user_id = ?")
      .bind(share.sheet_id, share.owner_user_id)
      .all(),
    env.DB.prepare("SELECT * FROM board_tables WHERE user_id = ? AND sheet_id = ? ORDER BY sort_order, name")
      .bind(share.owner_user_id, share.sheet_id)
      .all(),
    env.DB.prepare("SELECT * FROM board_notes WHERE user_id = ? AND sheet_id = ? ORDER BY sort_order, title")
      .bind(share.owner_user_id, share.sheet_id)
      .all(),
    env.DB.prepare(
      `SELECT show_display_name,
              show_server_name,
              show_class_name,
              show_item_level,
              show_combat_power
       FROM user_settings
       WHERE user_id = ?`
    )
      .bind(share.owner_user_id)
      .first()
  ]);

  const tableIds = tables.results.map((table) => String((table as { id: string }).id));
  const axisItems =
    tableIds.length > 0
      ? await env.DB.prepare(
          `SELECT board_axis_items.*,
                  characters.name AS character_name,
                  characters.display_name AS character_display_name,
                  characters.server_name AS character_server_name,
                  characters.class_name AS character_class_name,
                  characters.item_level AS character_item_level,
                  characters.combat_power AS character_combat_power,
                  characters.source AS character_source
           FROM board_axis_items
           LEFT JOIN characters
             ON characters.id = board_axis_items.character_id
            AND characters.user_id = board_axis_items.user_id
            AND characters.deleted_at IS NULL
           WHERE board_axis_items.user_id = ?
             AND board_axis_items.table_id IN (${placeholders(tableIds)})
           ORDER BY board_axis_items.table_id, board_axis_items.axis, board_axis_items.sort_order, board_axis_items.label`
        )
          .bind(share.owner_user_id, ...tableIds)
          .all<BoardLoadAxisItemRow>()
      : { results: [] as BoardLoadAxisItemRow[] };
  const cellStates =
    tableIds.length > 0
      ? await env.DB.prepare(
          `SELECT *
           FROM board_cell_states
           WHERE user_id = ?
             AND table_id IN (${placeholders(tableIds)})
           ORDER BY table_id, row_item_id, column_item_id`
        )
          .bind(share.owner_user_id, ...tableIds)
          .all()
      : { results: [] };
  const periodKeys = getCurrentBoardCompletionPeriodKeys(axisItems.results, now);
  const completions =
    periodKeys.length > 0 && tableIds.length > 0
      ? await env.DB.prepare(
          `SELECT table_id, row_item_id, column_item_id, period_key, completed
           FROM board_cell_completions
           WHERE user_id = ?
             AND table_id IN (${placeholders(tableIds)})
             AND period_key IN (${placeholders(periodKeys)})`
        )
          .bind(share.owner_user_id, ...tableIds, ...periodKeys)
          .all()
      : { results: [] };

  return {
    shareId,
    readOnly: true,
    userId: share.owner_user_id,
    settings: settings ?? DEFAULT_BOARD_DISPLAY_SETTINGS,
    sheets: sheets.results,
    tables: tables.results,
    notes: notes.results,
    axisItems: axisItems.results,
    cellStates: resolveExpiredBoardCellStateRows(
      cellStates.results as unknown as BoardCellStateRowForExpiry[],
      axisItems.results as unknown as Array<{ id: string; kind: string; task_reset_rule_json?: string | null }>,
      now
    ),
    completions: completions.results
  };
}

export async function loadBoardVersionSummary(
  env: Env,
  userId: string,
  _now = new Date()
): Promise<CanonicalBoardVersionSummary> {
  const [manifest, sheets] = await Promise.all([
    env.DB.prepare("SELECT version FROM board_manifest_versions WHERE user_id = ?")
      .bind(userId)
      .first<{ version: number }>(),
    env.DB.prepare(
      "SELECT id, name, sort_order, is_default, content_version FROM sheets WHERE user_id = ? ORDER BY sort_order, name"
    )
      .bind(userId)
      .all<{ id: string; name: string; sort_order: number; is_default: number; content_version: number }>()
  ]);

  return {
    manifestVersion: manifest?.version ?? 0,
    sheets: sheets.results.map((sheet) => ({
      id: sheet.id,
      name: sheet.name,
      sort_order: sheet.sort_order,
      is_default: sheet.is_default,
      version: sheet.content_version
    })),
    periodFingerprint: ""
  };
}

export async function loadSharedBoardVersionSummary(
  env: Env,
  shareId: string,
  _now = new Date()
): Promise<SharedBoardVersionSummary | null> {
  const share = await env.DB.prepare(
    `SELECT board_shares.owner_user_id,
            board_shares.sheet_id,
            sheets.content_version
     FROM board_shares
     JOIN sheets
       ON sheets.id = board_shares.sheet_id
      AND sheets.user_id = board_shares.owner_user_id
     WHERE board_shares.share_id = ?`
  )
    .bind(shareId)
    .first<{ owner_user_id: string; sheet_id: string; content_version: number }>();
  if (!share) return null;

  return {
    shareId,
    sheetId: share.sheet_id,
    version: share.content_version,
    periodFingerprint: ""
  };
}

export async function createBoardSheet(
  env: Env,
  userId: string,
  input: CreateBoardSheetInput
): Promise<BoardMutationResult<{ id: string }> | null> {
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

  try {
    const [createdResult, manifestResult] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sheets (id, user_id, name, sort_order, is_default)
         VALUES (?, ?, ?, ?, 0)
         RETURNING id`
      ).bind(id, userId, input.name, sortOrder),
      bumpBoardManifestVersion(env, userId)
    ]);
    const createdId = returnedMutationId(createdResult, id);
    const manifestVersion = returnedManifestVersion(manifestResult, userId);
    if (!createdId || manifestVersion === null) return incompleteBoardMutation();

    return { id, versions: buildBoardMutationVersions([], manifestVersion) };
  } catch (error) {
    if (isSheetNameConflictError(error)) return null;
    throw error;
  }
}

export type DeleteBoardSheetResult =
  | { type: "deleted"; result: BoardMutationResult }
  | { type: "last_sheet" }
  | { type: "not_found" };

export type UpdateBoardSheetResult =
  | { type: "updated"; result: BoardMutationResult }
  | { type: "name_conflict" }
  | { type: "not_found" };

export async function updateBoardSheet(
  env: Env,
  userId: string,
  sheetId: string,
  input: CreateBoardSheetInput
): Promise<UpdateBoardSheetResult> {
  await ensureDefaultBoard(env, userId);

  try {
    const [updatedResult, sheetVersionResult, manifestResult] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE sheets
         SET name = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?
         RETURNING id`
      ).bind(input.name, sheetId, userId),
      bumpBoardSheetVersion(env, userId, sheetId),
      bumpBoardManifestVersionForOwnedSheet(env, userId, sheetId)
    ]);
    const updatedId = returnedMutationId(updatedResult, sheetId);
    const sheetVersion = returnedSheetVersion(sheetVersionResult, sheetId);
    const manifestVersion = returnedManifestVersion(manifestResult, userId);
    if (!updatedId) {
      if (sheetVersion || manifestVersion !== null) return incompleteBoardMutation();
      return { type: "not_found" };
    }
    if (!sheetVersion || manifestVersion === null) return incompleteBoardMutation();

    return {
      type: "updated",
      result: { ok: true, versions: buildBoardMutationVersions([sheetVersion], manifestVersion) }
    };
  } catch (error) {
    if (isSheetNameConflictError(error)) return { type: "name_conflict" };
    throw error;
  }
}

export async function deleteBoardSheet(env: Env, userId: string, sheetId: string): Promise<DeleteBoardSheetResult> {
  await ensureDefaultBoard(env, userId);

  const results = await env.DB.batch([
    bumpBoardManifestVersionForDeletableSheet(env, userId, sheetId),
    env.DB.prepare(
      `UPDATE sheets
       SET is_default = CASE
         WHEN id = (
           SELECT other.id
           FROM sheets AS other
           WHERE other.user_id = ?
             AND other.id <> ?
           ORDER BY other.sort_order, other.name
           LIMIT 1
         ) THEN 1
         ELSE 0
       END,
       updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?
         AND EXISTS (
           SELECT 1
           FROM sheets AS target
           WHERE target.id = ?
             AND target.user_id = ?
             AND target.is_default = 1
             AND EXISTS (
               SELECT 1
               FROM sheets AS other
               WHERE other.user_id = ?
                 AND other.id <> target.id
             )
         )`
    ).bind(userId, sheetId, userId, sheetId, userId, userId),
    env.DB.prepare(
      `DELETE FROM sheets
       WHERE id = ?
         AND user_id = ?
         AND EXISTS (
           SELECT 1
           FROM sheets AS other
           WHERE other.user_id = ?
             AND other.id <> sheets.id
         )
       RETURNING id`
    ).bind(sheetId, userId, userId),
    env.DB.prepare(
      `SELECT CASE
         WHEN EXISTS (
           SELECT 1 FROM sheets WHERE id = ? AND user_id = ?
         ) THEN 'last_sheet'
         ELSE 'not_found'
       END AS type`
    ).bind(sheetId, userId)
  ]);
  const manifestVersion = returnedManifestVersion(results[0], userId);
  const deletedId = returnedMutationId(results[2], sheetId);
  if (!deletedId) {
    if (manifestVersion !== null) return incompleteBoardMutation();
    const status = firstBatchRow<{ type?: unknown }>(results[3])?.type;
    if (status === "last_sheet" || status === "not_found") return { type: status };
    return incompleteBoardMutation();
  }
  if (manifestVersion === null) return incompleteBoardMutation();

  return {
    type: "deleted",
    result: { ok: true, versions: buildBoardMutationVersions([], manifestVersion) }
  };
}

export async function createBoardTable(
  env: Env,
  userId: string,
  input: CreateBoardTableInput
): Promise<BoardMutationResult<{ id: string }> | null> {
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
  const roles = boardRolesForTableOrientation(input.orientation);
  const defaultRowHeight = input.defaultRowHeight ?? 40;
  const defaultColumnWidth = input.defaultColumnWidth ?? 132;
  const templateType = input.templateType ?? "custom";

  const [createdResult, sheetVersionResult] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO board_tables (
         id,
         user_id,
         sheet_id,
         name,
         sort_order,
         x,
         y,
         row_role,
         column_role,
         task_axis,
         default_row_height,
         default_column_width,
         display_options_json,
         template_type,
         event_options_json
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM sheets
       WHERE id = ? AND user_id = ?
       RETURNING id`
    ).bind(
      id,
      userId,
      input.sheetId,
      input.name,
      sortOrder,
      NEW_BOARD_TABLE_DEFAULT_X,
      NEW_BOARD_TABLE_DEFAULT_Y,
      roles.rowRole,
      roles.columnRole,
      roles.taskAxis,
      defaultRowHeight,
      defaultColumnWidth,
      serializeBoardDisplaySettings(input.displaySettings),
      templateType,
      serializeBoardEventOptions(templateType, input.eventOptions),
      input.sheetId,
      userId
    ),
    bumpBoardSheetVersion(env, userId, input.sheetId)
  ]);
  const createdId = returnedMutationId(createdResult, id);
  const sheetVersion = returnedSheetVersion(sheetVersionResult, input.sheetId);
  if (!createdId && !sheetVersion) return null;
  if (!createdId || !sheetVersion) return incompleteBoardMutation();

  return { id, versions: buildBoardMutationVersions([sheetVersion]) };
}

export async function createBoardNote(
  env: Env,
  userId: string,
  input: CreateBoardNoteInput
): Promise<BoardMutationResult<{ id: string }> | null> {
  await ensureDefaultBoard(env, userId);

  const sheet = await env.DB.prepare("SELECT id FROM sheets WHERE id = ? AND user_id = ?")
    .bind(input.sheetId, userId)
    .first<{ id: string }>();
  if (!sheet) return null;

  const placement = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), -10) AS maxSortOrder, COUNT(*) AS noteCount FROM board_notes WHERE user_id = ? AND sheet_id = ?"
  )
    .bind(userId, input.sheetId)
    .first<{ maxSortOrder: number | null; noteCount: number }>();
  const id = crypto.randomUUID();
  const sortOrder = (placement?.maxSortOrder ?? -10) + 10;
  const y = (placement?.noteCount ?? 0) * 180;

  const [createdResult, sheetVersionResult] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO board_notes (
         id,
         user_id,
         sheet_id,
         title,
         body,
         color,
         sort_order,
         x,
         y,
         width,
         height
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?, 220, 160
       FROM sheets
       WHERE id = ? AND user_id = ?
       RETURNING id`
    ).bind(id, userId, input.sheetId, input.title, input.body, input.color ?? "#fef3c7", sortOrder, y, input.sheetId, userId),
    bumpBoardSheetVersion(env, userId, input.sheetId)
  ]);
  const createdId = returnedMutationId(createdResult, id);
  const sheetVersion = returnedSheetVersion(sheetVersionResult, input.sheetId);
  if (!createdId && !sheetVersion) return null;
  if (!createdId || !sheetVersion) return incompleteBoardMutation();

  return { id, versions: buildBoardMutationVersions([sheetVersion]) };
}

export type BoardNoteUpdateResult =
  | { type: "updated"; result: BoardMutationResult }
  | { type: "not_found" };

export async function updateBoardNote(
  env: Env,
  userId: string,
  noteId: string,
  input: UpdateBoardNoteInput
): Promise<BoardNoteUpdateResult> {
  const [updatedResult, sheetVersionResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE board_notes
       SET title = COALESCE(?, title),
           body = COALESCE(?, body),
           color = COALESCE(?, color),
           width = COALESCE(?, width),
           height = COALESCE(?, height),
           locked = COALESCE(?, locked),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?
         AND sheet_id IN (SELECT id FROM sheets WHERE user_id = ?)
       RETURNING id`
    ).bind(
      input.title ?? null,
      input.body ?? null,
      input.color ?? null,
      input.width ?? null,
      input.height ?? null,
      input.locked ?? null,
      noteId,
      userId,
      userId
    ),
    bumpBoardSheetVersionForNote(env, userId, noteId)
  ]);
  const updatedId = returnedMutationId(updatedResult, noteId);
  const sheetVersion = returnedAnySheetVersion(sheetVersionResult);
  if (!updatedId && !sheetVersion) return { type: "not_found" };
  if (!updatedId || !sheetVersion) return incompleteBoardMutation();

  return {
    type: "updated",
    result: { ok: true, versions: buildBoardMutationVersions([sheetVersion]) }
  };
}

export async function updateBoardNoteLayout(
  env: Env,
  userId: string,
  noteId: string,
  patch: BoardNoteLayoutPatch
): Promise<BoardMutationResult | null> {
  const [updatedResult, sheetVersionResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE board_notes
       SET x = ?,
           y = ?,
           width = ?,
           height = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?
         AND sheet_id IN (SELECT id FROM sheets WHERE user_id = ?)
       RETURNING id`
    ).bind(patch.x, patch.y, patch.width, patch.height, noteId, userId, userId),
    bumpBoardSheetVersionForNote(env, userId, noteId)
  ]);
  const updatedId = returnedMutationId(updatedResult, noteId);
  const sheetVersion = returnedAnySheetVersion(sheetVersionResult);
  if (!updatedId && !sheetVersion) return null;
  if (!updatedId || !sheetVersion) return incompleteBoardMutation();

  return { ok: true, versions: buildBoardMutationVersions([sheetVersion]) };
}

export async function deleteBoardNote(env: Env, userId: string, noteId: string): Promise<BoardMutationResult | null> {
  const [sheetVersionResult, deletedResult] = await env.DB.batch([
    bumpBoardSheetVersionForNote(env, userId, noteId),
    env.DB.prepare(
      `DELETE FROM board_notes
       WHERE id = ? AND user_id = ?
         AND sheet_id IN (SELECT id FROM sheets WHERE user_id = ?)
       RETURNING id`
    ).bind(noteId, userId, userId)
  ]);
  const deletedId = returnedMutationId(deletedResult, noteId);
  const sheetVersion = returnedAnySheetVersion(sheetVersionResult);
  if (!deletedId && !sheetVersion) return null;
  if (!deletedId || !sheetVersion) return incompleteBoardMutation();

  return { ok: true, versions: buildBoardMutationVersions([sheetVersion]) };
}

export async function updateBoardTableSettings(
  env: Env,
  userId: string,
  tableId: string,
  input: UpdateBoardTableSettingsInput
): Promise<BoardTableSettingsUpdateResult> {
  const current = await env.DB.prepare(
    `SELECT name, default_row_height, default_column_width, display_options_json, event_options_json, template_type, locked
     FROM board_tables
     WHERE id = ? AND user_id = ?`
  )
    .bind(tableId, userId)
    .first<CurrentBoardTableSettings>();
  if (!current) return "not_found";

  const displayOptionsJson = getNextBoardTableDisplayOptionsJson(current, input);
  const eventOptionsJson = getNextBoardTableEventOptionsJson(current, input);
  const nextLocked = input.locked ?? (current.locked === 1 ? 1 : 0);

  if (!canApplyBoardTableSettingsUpdate(current, input)) {
    return "locked";
  }

  const [sheetVersionResult, updatedResult] = await env.DB.batch([
    bumpBoardSheetVersionForTableAtExpectedLock(env, userId, tableId, current.locked === 1 ? 1 : 0),
    env.DB.prepare(
      `UPDATE board_tables
       SET name = ?,
           default_row_height = ?,
           default_column_width = ?,
           display_options_json = ?,
           event_options_json = ?,
           locked = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND locked = ?
       RETURNING id`
    ).bind(
      input.name,
      input.defaultRowHeight,
      input.defaultColumnWidth,
      displayOptionsJson,
      eventOptionsJson,
      nextLocked,
      tableId,
      userId,
      current.locked
    )
  ]);
  const updatedId = returnedMutationId(updatedResult, tableId);
  const sheetVersion = returnedAnySheetVersion(sheetVersionResult);
  if (!updatedId && !sheetVersion) return "not_found";
  if (!updatedId || !sheetVersion) return incompleteBoardMutation();
  return { ok: true, versions: buildBoardMutationVersions([sheetVersion]) };
}

export async function deleteBoardTable(env: Env, userId: string, tableId: string): Promise<BoardMutationResult | null> {
  const table = await env.DB.prepare("SELECT id, locked FROM board_tables WHERE id = ? AND user_id = ?")
    .bind(tableId, userId)
    .first<{ id: string; locked: number }>();
  if (!table) return null;
  if (table.locked === 1) return null;

  const results = await env.DB.batch([
    bumpBoardSheetVersionsForTables(env, userId, [tableId]),
    env.DB.prepare(
      `DELETE FROM board_cell_completions
       WHERE user_id = ?1 AND table_id = ?2
         AND EXISTS (
           SELECT 1 FROM board_tables
           WHERE board_tables.id = ?2 AND board_tables.user_id = ?1 AND board_tables.locked = 0
         )`
    ).bind(userId, tableId),
    env.DB.prepare(
      `DELETE FROM board_cell_states
       WHERE user_id = ?1 AND table_id = ?2
         AND EXISTS (
           SELECT 1 FROM board_tables
           WHERE board_tables.id = ?2 AND board_tables.user_id = ?1 AND board_tables.locked = 0
         )`
    ).bind(userId, tableId),
    env.DB.prepare(
      `DELETE FROM board_axis_items
       WHERE user_id = ?1 AND table_id = ?2
         AND EXISTS (
           SELECT 1 FROM board_tables
           WHERE board_tables.id = ?2 AND board_tables.user_id = ?1 AND board_tables.locked = 0
         )`
    ).bind(userId, tableId),
    env.DB.prepare("DELETE FROM board_tables WHERE id = ? AND user_id = ? AND locked = 0 RETURNING id").bind(tableId, userId)
  ]);
  const sheetVersion = returnedAnySheetVersion(results[0]);
  const deletedId = returnedMutationId(results.at(-1), tableId);
  if (!sheetVersion && !deletedId) return null;
  if (!sheetVersion || !deletedId) return incompleteBoardMutation();
  return { ok: true, versions: buildBoardMutationVersions([sheetVersion]) };
}

export async function importBoardCharactersForTable(
  env: Env,
  userId: string,
  tableId: string,
  characters: BoardCharacterSelectionInput[]
): Promise<BoardMutationResult | null> {
  const table = await env.DB.prepare("SELECT id, row_role, column_role, locked FROM board_tables WHERE id = ? AND user_id = ?")
    .bind(tableId, userId)
    .first<{ id: string; row_role: BoardAxisRole; column_role: BoardAxisRole; locked: number }>();
  if (!table) return null;
  if (table.locked === 1) return null;

  const existingCharacterAxis = await readExistingAxisForKind(env, userId, tableId, "character");
  const existingTaskAxis = await readExistingAxisForKind(env, userId, tableId, "task");
  const roleRepair = planBoardTableRoleRepairFromExistingAxes(env, userId, tableId, table, {
    characterAxis: existingCharacterAxis,
    taskAxis: existingTaskAxis
  });
  const axis = existingCharacterAxis ?? getAxisForRole(roleRepair.roles, "character");
  const sizeSeed = await readBoardAxisItemSizeSeed(env, userId, tableId, axis);
  const maxSort = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), -10) AS maxSortOrder FROM board_axis_items WHERE user_id = ? AND table_id = ? AND axis = ?"
  )
    .bind(userId, tableId, axis)
    .first<{ maxSortOrder: number | null }>();
  let sortOrder = (maxSort?.maxSortOrder ?? -10) + 10;
  const normalizedCharacters = normalizeCharacterSelection(characters);
  const statements: Array<ReturnType<Env["DB"]["prepare"]>> = roleRepair.statement ? [roleRepair.statement] : [];
  const axisItemIds: string[] = [];

  for (const [index, character] of normalizedCharacters.entries()) {
    const characterId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        `INSERT INTO characters (id, user_id, name, server_name, class_name, item_level, combat_power, sort_order, enabled, deleted_at, source, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 'lostark', CURRENT_TIMESTAMP
         WHERE EXISTS (
           SELECT 1 FROM board_tables WHERE id = ? AND user_id = ? AND locked = 0
         )
         ON CONFLICT(user_id, name, server_name)
         DO UPDATE SET class_name = excluded.class_name,
                       item_level = excluded.item_level,
                       combat_power = excluded.combat_power,
                       sort_order = excluded.sort_order,
                       source = 'lostark',
                       enabled = 1,
                       deleted_at = NULL,
                       updated_at = CURRENT_TIMESTAMP`
      ).bind(
        characterId,
        userId,
        character.name,
        character.serverName,
        character.className,
        character.itemLevel,
        character.combatPower ?? null,
        index * 10,
        tableId,
        userId
      )
    );
    const existing = await env.DB.prepare(
      `SELECT board_axis_items.id
       FROM board_axis_items
       JOIN characters
         ON characters.id = board_axis_items.character_id
        AND characters.user_id = board_axis_items.user_id
       WHERE board_axis_items.user_id = ?
         AND board_axis_items.table_id = ?
         AND board_axis_items.axis = ?
         AND board_axis_items.kind = 'character'
         AND characters.name = ?
         AND characters.server_name = ?`
    )
      .bind(userId, tableId, axis, character.name, character.serverName)
      .first<{ id: string }>();

    if (existing) {
      axisItemIds.push(existing.id);
      statements.push(
        env.DB.prepare(
          `UPDATE board_axis_items
           SET visible = 1,
               label = ?,
               size_px = ?,
               cross_size_px = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND user_id = ?
             AND EXISTS (
               SELECT 1 FROM board_tables
               WHERE board_tables.id = board_axis_items.table_id
                 AND board_tables.user_id = board_axis_items.user_id
                 AND board_tables.locked = 0
             )
           RETURNING id`
        ).bind(character.name, sizeSeed.size_px, sizeSeed.cross_size_px, existing.id, userId)
      );
      continue;
    }

    const axisItemId = crypto.randomUUID();
    axisItemIds.push(axisItemId);
    statements.push(
      env.DB.prepare(
        `INSERT INTO board_axis_items (
           id, user_id, table_id, axis, kind, label, character_id, task_id, task_scope, task_reset_type,
           task_reset_rule_json, task_color, sort_order, size_px, cross_size_px
         )
         SELECT ?, ?, board_tables.id, ?, 'character', characters.name, characters.id,
                NULL, NULL, NULL, NULL, NULL, ?, ?, ?
         FROM board_tables
         JOIN characters
           ON characters.user_id = board_tables.user_id
          AND characters.name = ?
          AND characters.server_name = ?
          AND characters.enabled = 1
          AND characters.deleted_at IS NULL
         WHERE board_tables.id = ? AND board_tables.user_id = ? AND board_tables.locked = 0
         RETURNING id`
      ).bind(
        axisItemId,
        userId,
        axis,
        sortOrder,
        sizeSeed.size_px,
        sizeSeed.cross_size_px,
        character.name,
        character.serverName,
        tableId,
        userId
      )
    );
    sortOrder += 10;
  }

  const results = await env.DB.batch([...statements, bumpBoardSheetVersionsForTables(env, userId, [tableId])]);
  const roleOffset = roleRepair.statement ? 1 : 0;
  const axisResults = normalizedCharacters.map((_, index) => results[roleOffset + index * 2 + 1]);
  const everyAxisItemReturned = axisResults.every((result, index) => returnedMutationId(result, axisItemIds[index]!) !== null);
  const anyAxisItemReturned = axisResults.some((result, index) => returnedMutationId(result, axisItemIds[index]!) !== null);
  const sheetVersion = returnedAnySheetVersion(results.at(-1));
  const roleResultId = roleRepair.statement ? returnedMutationId(results[0], tableId) : null;
  const roleReturned = !roleRepair.statement || roleResultId !== null;
  if (!sheetVersion && !anyAxisItemReturned && !roleResultId) return null;
  if (!everyAxisItemReturned || !sheetVersion || !roleReturned) return incompleteBoardMutation();
  return { ok: true, versions: buildBoardMutationVersions([sheetVersion]) };
}

export async function createManualBoardCharacterForTable(
  env: Env,
  userId: string,
  tableId: string,
  input: BoardManualCharacterInput
): Promise<BoardMutationResult<{ id: string }> | null> {
  const table = await env.DB.prepare("SELECT id, row_role, column_role, locked FROM board_tables WHERE id = ? AND user_id = ?")
    .bind(tableId, userId)
    .first<{ id: string; row_role: BoardAxisRole; column_role: BoardAxisRole; locked: number }>();
  if (!table) return null;
  if (table.locked === 1) return null;

  const existingCharacterAxis = await readExistingAxisForKind(env, userId, tableId, "character");
  const existingTaskAxis = await readExistingAxisForKind(env, userId, tableId, "task");
  const roleRepair = planBoardTableRoleRepairFromExistingAxes(env, userId, tableId, table, {
    characterAxis: existingCharacterAxis,
    taskAxis: existingTaskAxis
  });
  const axis = existingCharacterAxis ?? getAxisForRole(roleRepair.roles, "character");
  const existingCharacter = await env.DB.prepare(
    `SELECT id
     FROM characters
     WHERE user_id = ? AND name = ? AND server_name = ? AND enabled = 1 AND deleted_at IS NULL`
  )
    .bind(userId, input.name, input.serverName)
    .first<{ id: string }>();
  const characterId = existingCharacter?.id ?? crypto.randomUUID();
  const characterMaxSort = existingCharacter
    ? null
    : await env.DB.prepare("SELECT COALESCE(MAX(sort_order), -10) AS max_sort FROM characters WHERE user_id = ?")
        .bind(userId)
        .first<{ max_sort: number }>();
  const sizeSeed = await readBoardAxisItemSizeSeed(env, userId, tableId, axis);
  const existing = await env.DB.prepare(
    `SELECT id
     FROM board_axis_items
     WHERE user_id = ? AND table_id = ? AND axis = ? AND kind = 'character' AND character_id = ?`
  )
    .bind(userId, tableId, axis, characterId)
    .first<{ id: string }>();
  const statements: Array<ReturnType<Env["DB"]["prepare"]>> = roleRepair.statement ? [roleRepair.statement] : [];
  if (!existingCharacter) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO characters (
           id, user_id, name, server_name, class_name, item_level, combat_power,
           sort_order, enabled, deleted_at, source, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 'manual', CURRENT_TIMESTAMP
         WHERE EXISTS (
           SELECT 1 FROM board_tables WHERE id = ? AND user_id = ? AND locked = 0
         )
         RETURNING id`
      ).bind(
        characterId,
        userId,
        input.name,
        input.serverName,
        input.className,
        input.itemLevel,
        input.combatPower,
        (characterMaxSort?.max_sort ?? -10) + 10,
        tableId,
        userId
      )
    );
  }

  const axisItemId = existing?.id ?? crypto.randomUUID();
  if (existing) {
    statements.push(
      env.DB.prepare(
        `UPDATE board_axis_items
         SET visible = 1,
             label = ?,
             size_px = ?,
             cross_size_px = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?
           AND EXISTS (
             SELECT 1 FROM board_tables
             WHERE board_tables.id = board_axis_items.table_id
               AND board_tables.user_id = board_axis_items.user_id
               AND board_tables.locked = 0
           )
         RETURNING id`
      ).bind(input.name, sizeSeed.size_px, sizeSeed.cross_size_px, existing.id, userId)
    );
  } else {
    const maxSort = await env.DB.prepare(
      "SELECT COALESCE(MAX(sort_order), -10) AS maxSortOrder FROM board_axis_items WHERE user_id = ? AND table_id = ? AND axis = ?"
    )
      .bind(userId, tableId, axis)
      .first<{ maxSortOrder: number | null }>();
    statements.push(
      env.DB.prepare(
        `INSERT INTO board_axis_items (
           id, user_id, table_id, axis, kind, label, character_id, task_id, task_scope,
           task_reset_type, task_reset_rule_json, task_color, sort_order, size_px, cross_size_px
         )
         SELECT ?, ?, board_tables.id, ?, 'character', ?, characters.id,
                NULL, NULL, NULL, NULL, NULL, ?, ?, ?
         FROM board_tables
         JOIN characters ON characters.id = ? AND characters.user_id = board_tables.user_id
         WHERE board_tables.id = ? AND board_tables.user_id = ? AND board_tables.locked = 0
         RETURNING id`
      ).bind(
        axisItemId,
        userId,
        axis,
        input.name,
        (maxSort?.maxSortOrder ?? -10) + 10,
        sizeSeed.size_px,
        sizeSeed.cross_size_px,
        characterId,
        tableId,
        userId
      )
    );
  }

  const results = await env.DB.batch([...statements, bumpBoardSheetVersionsForTables(env, userId, [tableId])]);
  let resultIndex = 0;
  const roleResultId = roleRepair.statement ? returnedMutationId(results[resultIndex++], tableId) : null;
  const characterResultId = !existingCharacter ? returnedMutationId(results[resultIndex++], characterId) : null;
  const axisResultId = returnedMutationId(results[resultIndex], axisItemId);
  const sheetVersion = returnedAnySheetVersion(results.at(-1));
  if (!roleResultId && !characterResultId && !axisResultId && !sheetVersion) return null;
  if ((roleRepair.statement && !roleResultId) || (!existingCharacter && !characterResultId) || !axisResultId || !sheetVersion) {
    return incompleteBoardMutation();
  }
  return { id: axisItemId, versions: buildBoardMutationVersions([sheetVersion]) };
}

export async function createBoardTaskForTable(
  env: Env,
  userId: string,
  tableId: string,
  input: BoardTaskInput
): Promise<BoardMutationResult<{ id: string }> | null> {
  const table = await env.DB.prepare("SELECT id, row_role, column_role, locked FROM board_tables WHERE id = ? AND user_id = ?")
    .bind(tableId, userId)
    .first<{ id: string; row_role: BoardAxisRole; column_role: BoardAxisRole; locked: number }>();
  if (!table) return null;
  if (table.locked === 1) return null;

  const createRequestId = input.createRequestId ?? null;
  if (createRequestId) {
    const existing = await readBoardAxisItemByCreateRequestId(env, userId, tableId, createRequestId);
    if (existing) return { ...existing, versions: buildBoardMutationVersions([]) };
  }

  const existingTaskAxis = await readExistingAxisForKind(env, userId, tableId, "task");
  const existingCharacterAxis = await readExistingAxisForKind(env, userId, tableId, "character");
  const roleRepair = planBoardTableRoleRepairFromExistingAxes(env, userId, tableId, table, {
    characterAxis: existingCharacterAxis,
    taskAxis: existingTaskAxis
  });
  const axis = existingTaskAxis ?? getAxisForRole(roleRepair.roles, "task");
  const existingTask = createRequestId
    ? await env.DB.prepare("SELECT id FROM tasks WHERE user_id = ? AND create_request_id = ? AND enabled = 1")
        .bind(userId, createRequestId)
        .first<{ id: string }>()
    : null;
  const taskId = existingTask?.id ?? crypto.randomUUID();
  const taskMaxSort = existingTask
    ? null
    : await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM tasks WHERE user_id = ?")
        .bind(userId)
        .first<{ max_sort: number }>();
  const sizeSeed = await readBoardAxisItemSizeSeed(env, userId, tableId, axis);
  const stats = await env.DB.prepare(
    `SELECT COALESCE(MAX(sort_order), -10) AS maxSortOrder,
            SUM(CASE WHEN kind = 'task' THEN 1 ELSE 0 END) AS taskCount
     FROM board_axis_items
     WHERE user_id = ? AND table_id = ? AND axis = ?`
  )
    .bind(userId, tableId, axis)
    .first<{ maxSortOrder: number | null; taskCount: number | null }>();
  const id = crypto.randomUUID();
  const sortOrder = (stats?.maxSortOrder ?? -10) + 10;
  const color = input.taskColor ?? DEFAULT_TASK_COLORS[(stats?.taskCount ?? 0) % DEFAULT_TASK_COLORS.length]!;
  const statements: Array<ReturnType<Env["DB"]["prepare"]>> = roleRepair.statement ? [roleRepair.statement] : [];
  if (!existingTask) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO tasks (
           id, user_id, name, scope, reset_type, reset_rule_json, sort_order,
           enabled, is_template, create_request_id
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, 1, 0, ?
         WHERE EXISTS (
           SELECT 1 FROM board_tables WHERE id = ? AND user_id = ? AND locked = 0
         )
         RETURNING id`
      ).bind(
        taskId,
        userId,
        input.name,
        input.scope,
        input.resetRule.type,
        JSON.stringify(input.resetRule),
        (taskMaxSort?.max_sort ?? 0) + 10,
        createRequestId,
        tableId,
        userId
      )
    );
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO board_axis_items (
         id, user_id, table_id, axis, kind, label, character_id, task_id, task_scope,
         task_reset_type, task_reset_rule_json, task_color, sort_order, size_px,
         cross_size_px, create_request_id
       )
       SELECT ?, ?, board_tables.id, ?, 'task', ?, NULL, tasks.id, ?, ?, ?, ?, ?, ?, ?, ?
       FROM board_tables
       JOIN tasks ON tasks.id = ? AND tasks.user_id = board_tables.user_id AND tasks.enabled = 1
       WHERE board_tables.id = ? AND board_tables.user_id = ? AND board_tables.locked = 0
       RETURNING id`
    ).bind(
      id,
      userId,
      axis,
      input.name,
      input.scope,
      input.resetRule.type,
      JSON.stringify(input.resetRule),
      color,
      sortOrder,
      sizeSeed.size_px,
      sizeSeed.cross_size_px,
      createRequestId,
      taskId,
      tableId,
      userId
    )
  );

  let results: Awaited<ReturnType<Env["DB"]["batch"]>>;
  try {
    results = await env.DB.batch([...statements, bumpBoardSheetVersionsForTables(env, userId, [tableId])]);
  } catch (error) {
    if (!createRequestId || !isBoardTaskCreateRequestConflictError(error)) throw error;
    const existing = await readBoardAxisItemByCreateRequestId(env, userId, tableId, createRequestId);
    if (!existing) throw error;
    return { ...existing, versions: buildBoardMutationVersions([]) };
  }
  let resultIndex = 0;
  const roleResultId = roleRepair.statement ? returnedMutationId(results[resultIndex++], tableId) : null;
  const taskResultId = !existingTask ? returnedMutationId(results[resultIndex++], taskId) : null;
  const axisResultId = returnedMutationId(results[resultIndex], id);
  const sheetVersion = returnedAnySheetVersion(results.at(-1));
  if (!roleResultId && !taskResultId && !axisResultId && !sheetVersion) return null;
  if ((roleRepair.statement && !roleResultId) || (!existingTask && !taskResultId) || !axisResultId || !sheetVersion) {
    return incompleteBoardMutation();
  }
  return { id, versions: buildBoardMutationVersions([sheetVersion]) };
}

export async function createBoardAxisItem(
  env: Env,
  userId: string,
  input: CreateBoardAxisItemInput
): Promise<BoardMutationResult<{ id: string }> | null> {
  const table = await env.DB.prepare("SELECT id, row_role, column_role, locked FROM board_tables WHERE id = ? AND user_id = ?")
    .bind(input.tableId, userId)
    .first<{ id: string; row_role: BoardAxisRole; column_role: BoardAxisRole; locked: number }>();
  if (!table) return null;
  if (table.locked === 1) return null;

  const stats = await env.DB.prepare(
    `SELECT COALESCE(MAX(sort_order), -10) AS maxSortOrder,
            SUM(CASE WHEN kind = 'task' THEN 1 ELSE 0 END) AS taskCount
     FROM board_axis_items
     WHERE user_id = ? AND table_id = ? AND axis = ?`
  )
    .bind(userId, input.tableId, input.axis)
    .first<{ maxSortOrder: number | null; taskCount: number | null }>();
  const axisRole = input.axis === "row" ? table.row_role : table.column_role;
  const sizeSeed = await readBoardAxisItemSizeSeed(env, userId, input.tableId, input.axis);
  const draft = buildManualBoardAxisItemDraft({
    axis: input.axis,
    axisRole,
    label: input.label,
    taskColorIndex: stats?.taskCount ?? 0
  });
  const id = crypto.randomUUID();
  const sortOrder = (stats?.maxSortOrder ?? -10) + 10;

  const [createdResult, sheetVersionResult] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO board_axis_items (
         id, user_id, table_id, axis, kind, label, character_id, task_id, task_scope,
         task_reset_type, task_reset_rule_json, task_color, sort_order, size_px, cross_size_px
       )
       SELECT ?, ?, board_tables.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM board_tables
       WHERE board_tables.id = ? AND board_tables.user_id = ? AND board_tables.locked = 0
       RETURNING id`
    ).bind(
      id,
      userId,
      draft.axis,
      draft.kind,
      draft.label,
      draft.characterId,
      draft.taskId,
      draft.taskScope,
      draft.taskResetType,
      draft.taskResetRuleJson,
      draft.taskColor,
      sortOrder,
      sizeSeed.size_px,
      sizeSeed.cross_size_px,
      input.tableId,
      userId
    ),
    bumpBoardSheetVersionsForTables(env, userId, [input.tableId])
  ]);
  const createdId = returnedMutationId(createdResult, id);
  const sheetVersion = returnedAnySheetVersion(sheetVersionResult);
  if (!createdId && !sheetVersion) return null;
  if (!createdId || !sheetVersion) return incompleteBoardMutation();
  return { id, versions: buildBoardMutationVersions([sheetVersion]) };
}

export async function reorderBoardAxisItems(
  env: Env,
  userId: string,
  input: BoardAxisOrderInput
): Promise<BoardMutationResult | null> {
  const table = await env.DB.prepare("SELECT id, locked FROM board_tables WHERE id = ? AND user_id = ?")
    .bind(input.tableId, userId)
    .first<{ id: string; locked: number }>();
  if (!table) return null;
  if (table.locked === 1) return null;

  const existing = await env.DB.prepare(
    `SELECT id, visible
     FROM board_axis_items
     WHERE user_id = ? AND table_id = ? AND axis = ?
     ORDER BY sort_order, label`
  )
    .bind(userId, input.tableId, input.axis)
    .all<{ id: string; visible: number }>();
  const visibleIds = existing.results.filter((item) => item.visible === 1).map((item) => item.id);
  if (visibleIds.length !== input.axisItemIds.length) return null;

  const visibleSet = new Set(visibleIds);
  if (input.axisItemIds.some((id) => !visibleSet.has(id))) return null;

  const hiddenIds = existing.results.filter((item) => item.visible !== 1).map((item) => item.id);
  const orderedIds = [...input.axisItemIds, ...hiddenIds];

  const orderedIdsJson = JSON.stringify(orderedIds);
  const [temporaryResult, finalResult, sheetVersionResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE board_axis_items
       SET sort_order = -(
             CAST((SELECT key FROM json_each(?) WHERE value = board_axis_items.id) AS INTEGER) + 1
           ) * 10,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND table_id = ? AND axis = ?
         AND id IN (SELECT value FROM json_each(?))
         AND EXISTS (
           SELECT 1 FROM board_tables
           WHERE board_tables.id = board_axis_items.table_id
             AND board_tables.user_id = board_axis_items.user_id
             AND board_tables.locked = 0
         )
       RETURNING id`
    ).bind(orderedIdsJson, userId, input.tableId, input.axis, orderedIdsJson),
    env.DB.prepare(
      `UPDATE board_axis_items
       SET sort_order = CAST((SELECT key FROM json_each(?) WHERE value = board_axis_items.id) AS INTEGER) * 10,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND table_id = ? AND axis = ?
         AND id IN (SELECT value FROM json_each(?))
         AND EXISTS (
           SELECT 1 FROM board_tables
           WHERE board_tables.id = board_axis_items.table_id
             AND board_tables.user_id = board_axis_items.user_id
             AND board_tables.locked = 0
         )
       RETURNING id`
    ).bind(orderedIdsJson, userId, input.tableId, input.axis, orderedIdsJson),
    bumpBoardSheetVersionsForTables(env, userId, [input.tableId])
  ]);
  const temporaryIds = returnedIds(temporaryResult);
  const finalIds = returnedIds(finalResult);
  const sheetVersion = returnedAnySheetVersion(sheetVersionResult);
  if (temporaryIds?.length === 0 && finalIds?.length === 0 && !sheetVersion) return null;
  if (!temporaryIds || !finalIds || !sheetVersion) return incompleteBoardMutation();
  if (temporaryIds.length !== orderedIds.length || finalIds.length !== orderedIds.length) return incompleteBoardMutation();
  return { ok: true, versions: buildBoardMutationVersions([sheetVersion]) };
}

export async function updateBoardTableLayout(
  env: Env,
  userId: string,
  tableId: string,
  patch: BoardTableLayoutPatch
): Promise<BoardMutationResult | null> {
  const [updatedResult, sheetVersionResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE board_tables
       SET x = ?, y = ?, width = ?, height = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND locked = 0
       RETURNING id`
    ).bind(patch.x, patch.y, patch.width, patch.height, tableId, userId),
    bumpBoardSheetVersionsForTables(env, userId, [tableId])
  ]);
  const updatedId = returnedMutationId(updatedResult, tableId);
  const sheetVersion = returnedAnySheetVersion(sheetVersionResult);
  if (!updatedId && !sheetVersion) return null;
  if (!updatedId || !sheetVersion) return incompleteBoardMutation();
  return { ok: true, versions: buildBoardMutationVersions([sheetVersion]) };
}

export async function transposeBoardTable(env: Env, userId: string, tableId: string): Promise<BoardMutationResult | null> {
  const table = await env.DB.prepare(
    "SELECT id, row_role, column_role, task_axis, locked FROM board_tables WHERE id = ? AND user_id = ?"
  )
    .bind(tableId, userId)
    .first<{ id: string; row_role: BoardAxisRole; column_role: BoardAxisRole; task_axis: BoardTaskAxis; locked: number }>();
  if (!table) return null;
  if (table.locked === 1) return null;

  const axisItems = await env.DB.prepare(
    "SELECT id, axis, sort_order, size_px, cross_size_px FROM board_axis_items WHERE user_id = ? AND table_id = ? ORDER BY axis, sort_order, label"
  )
    .bind(userId, tableId)
    .all<BoardAxisItemTransposeSource>();
  const roles = transposeBoardRoles({
    rowRole: table.row_role,
    columnRole: table.column_role,
    taskAxis: table.task_axis
  });
  const plan = buildBoardAxisItemTransposePlan(axisItems.results);

  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE board_tables
       SET row_role = ?, column_role = ?, task_axis = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND locked = 0
       RETURNING id`
    ).bind(roles.rowRole, roles.columnRole, roles.taskAxis, tableId, userId),
    ...plan.map((item) =>
      env.DB.prepare(
        `UPDATE board_axis_items
         SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND table_id = ?
           AND EXISTS (
             SELECT 1 FROM board_tables
             WHERE board_tables.id = board_axis_items.table_id
               AND board_tables.user_id = board_axis_items.user_id
               AND board_tables.locked = 0
           )
         RETURNING id`
      ).bind(item.temporarySortOrder, item.id, userId, tableId)
    ),
    ...plan.map((item) =>
      env.DB.prepare(
        `UPDATE board_axis_items
         SET axis = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND table_id = ?
           AND EXISTS (
             SELECT 1 FROM board_tables
             WHERE board_tables.id = board_axis_items.table_id
               AND board_tables.user_id = board_axis_items.user_id
               AND board_tables.locked = 0
           )
         RETURNING id`
      ).bind(item.toAxis, item.id, userId, tableId)
    ),
    ...plan.map((item) =>
      env.DB.prepare(
        `UPDATE board_axis_items
         SET sort_order = ?,
             size_px = ?,
             cross_size_px = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND table_id = ?
           AND EXISTS (
             SELECT 1 FROM board_tables
             WHERE board_tables.id = board_axis_items.table_id
               AND board_tables.user_id = board_axis_items.user_id
               AND board_tables.locked = 0
           )
         RETURNING id`
      ).bind(item.finalSortOrder, item.finalSizePx, item.finalCrossSizePx, item.id, userId, tableId)
    ),
    env.DB.prepare(
      `UPDATE board_cell_states
       SET row_item_id = column_item_id,
           column_item_id = row_item_id,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?1 AND table_id = ?2
         AND EXISTS (
           SELECT 1 FROM board_tables
           WHERE board_tables.id = ?2 AND board_tables.user_id = ?1 AND board_tables.locked = 0
         )`
    ).bind(userId, tableId),
    env.DB.prepare(
      `UPDATE board_cell_completions
       SET row_item_id = column_item_id,
           column_item_id = row_item_id,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?1 AND table_id = ?2
         AND EXISTS (
           SELECT 1 FROM board_tables
           WHERE board_tables.id = ?2 AND board_tables.user_id = ?1 AND board_tables.locked = 0
         )`
    ).bind(userId, tableId),
    bumpBoardSheetVersionsForTables(env, userId, [tableId])
  ]);

  const tableIdResult = returnedMutationId(results[0], tableId);
  const axisMutationResults = results.slice(1, 1 + plan.length * 3);
  const everyAxisMutationReturned = axisMutationResults.every((result, index) =>
    returnedMutationId(result, plan[index % plan.length]?.id ?? "") !== null
  );
  const sheetVersion = returnedAnySheetVersion(results.at(-1));
  if (!tableIdResult && !sheetVersion) return null;
  if (!tableIdResult || !sheetVersion || !everyAxisMutationReturned) return incompleteBoardMutation();
  return { ok: true, versions: buildBoardMutationVersions([sheetVersion]) };
}

export async function updateBoardAxisItem(
  env: Env,
  userId: string,
  axisItemId: string,
  input: UpdateBoardAxisItemInput
): Promise<BoardMutationResult | null> {
  const separatorJson = input.separator === undefined || input.separator === null ? null : JSON.stringify(input.separator);
  const displayOptionsJson =
    input.displaySettings === undefined || input.displaySettings === null
      ? null
      : serializeBoardDisplaySettings(input.displaySettings);
  const [sheetVersionResult, updatedResult] = await env.DB.batch([
    bumpBoardSheetVersionForAxisItem(env, userId, axisItemId),
    env.DB.prepare(
      `UPDATE board_axis_items
       SET label = ?,
           task_color = CASE WHEN ? = 1 AND kind = 'task' THEN ? ELSE task_color END,
           task_reset_type = CASE WHEN ? = 1 AND kind = 'task' THEN ? ELSE task_reset_type END,
           task_reset_rule_json = CASE WHEN ? = 1 AND kind = 'task' THEN ? ELSE task_reset_rule_json END,
           separator_json = CASE WHEN ? = 1 THEN ? ELSE separator_json END,
           display_options_json = CASE WHEN ? = 1 THEN ? ELSE display_options_json END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND visible = 1
         AND EXISTS (
           SELECT 1
           FROM board_tables
           WHERE board_tables.id = board_axis_items.table_id
             AND board_tables.user_id = board_axis_items.user_id
             AND board_tables.locked = 0
         )
       RETURNING id`
    ).bind(
      input.label,
      input.taskColor !== undefined ? 1 : 0,
      input.taskColor ?? null,
      input.taskResetRule !== undefined ? 1 : 0,
      input.taskResetRule?.type ?? null,
      input.taskResetRule !== undefined ? 1 : 0,
      input.taskResetRule === undefined ? null : JSON.stringify(input.taskResetRule),
      input.separator !== undefined ? 1 : 0,
      separatorJson,
      input.displaySettings !== undefined ? 1 : 0,
      displayOptionsJson,
      axisItemId,
      userId
    )
  ]);
  const sheetVersion = returnedAnySheetVersion(sheetVersionResult);
  const updatedId = returnedMutationId(updatedResult, axisItemId);
  if (!sheetVersion && !updatedId) return null;
  if (!sheetVersion || !updatedId) return incompleteBoardMutation();
  return { ok: true, versions: buildBoardMutationVersions([sheetVersion]) };
}

export async function hideBoardAxisItem(env: Env, userId: string, axisItemId: string): Promise<BoardMutationResult | null> {
  const [sheetVersionResult, hiddenResult] = await env.DB.batch([
    bumpBoardSheetVersionForAxisItem(env, userId, axisItemId),
    env.DB.prepare(
      `UPDATE board_axis_items
       SET visible = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND visible = 1
         AND EXISTS (
           SELECT 1
           FROM board_tables
           WHERE board_tables.id = board_axis_items.table_id
             AND board_tables.user_id = board_axis_items.user_id
             AND board_tables.locked = 0
         )
       RETURNING id`
    ).bind(axisItemId, userId)
  ]);
  const sheetVersion = returnedAnySheetVersion(sheetVersionResult);
  const hiddenId = returnedMutationId(hiddenResult, axisItemId);
  if (!sheetVersion && !hiddenId) return null;
  if (!sheetVersion || !hiddenId) return incompleteBoardMutation();
  return { ok: true, versions: buildBoardMutationVersions([sheetVersion]) };
}

export async function saveBoardCompletionPatches(
  env: Env,
  userId: string,
  patches: BoardCompletionPatch[]
): Promise<BoardMutationResult | BoardBulkMutationRejection<BoardCompletionRejectedKey>> {
  const merged = mergeBoardCompletionPatches(patches);
  if (merged.length === 0) return { ok: true, versions: buildBoardMutationVersions([]) };
  const rows = buildBoardCompletionPayloadRows(merged);
  const preflight = await loadBoardBulkPreflight(env, userId, rows);
  const now = new Date();
  const targets = preflight.map(preflightTarget);
  const invalidOrdinals = new Set<number>();
  preflight.forEach((row, ordinal) => {
    if (row.eligible !== 1) invalidOrdinals.add(ordinal);
  });
  const outsideCurrentPeriod = findBoardCompletionPatchesOutsideCurrentPeriod(merged, targets, now);
  const outsideKeys = new Set(outsideCurrentPeriod.map((patch) => boardCompletionKey(patch)));
  merged.forEach((patch, ordinal) => {
    if (outsideKeys.has(boardCompletionKey(patch))) invalidOrdinals.add(ordinal);
  });
  if (invalidOrdinals.size > 0) {
    return {
      ok: false,
      rejectedKeys: [...invalidOrdinals].sort((a, b) => a - b).map((ordinal) => completionRejectedKey(merged[ordinal]!))
    };
  }

  const guardedRows: GuardedBoardCompletionPayloadRow[] = rows.map((row, ordinal) => ({
    ...row,
    ...preflightGuardSnapshot(preflight[ordinal]!, now)
  }));
  const payloadJson = JSON.stringify(guardedRows);
  let results: unknown[];
  try {
    results = await env.DB.batch(prepareBoardCompletionWriteStatements(env, userId, payloadJson));
  } catch (error) {
    if (isBoardBulkGuardAssertionError(error)) return incompleteBoardMutation();
    throw error;
  }
  if (results.length !== 3 || !results.every(isSuccessfulBatchResult) || !hasEmptyBatchRows(results[1])) {
    return incompleteBoardMutation();
  }
  const returnedKeys = returnedObjectKeySet(results[0], completionRowKey);
  const expectedKeys = new Set(guardedRows.map(completionPayloadKey));
  const sheetVersions = returnedSheetVersions(results[2]);
  const expectedSheetIds = new Set(guardedRows.map((row) => row.sheet_id));
  if (!sameStringSet(returnedKeys, expectedKeys) || !hasExactSheetVersions(sheetVersions, expectedSheetIds)) {
    return incompleteBoardMutation();
  }
  return { ok: true, versions: buildBoardMutationVersions(sheetVersions) };
}

export async function saveBoardCellStatePatch(
  env: Env,
  userId: string,
  patch: BoardCellStatePatch
): Promise<BoardMutationResult | null> {
  const result = await saveBoardCellStatePatches(env, userId, [patch]);
  return result.ok === false ? null : result;
}

export async function saveBoardCellStatePatches(
  env: Env,
  userId: string,
  patches: BoardCellStatePatch[]
): Promise<BoardMutationResult | BoardBulkMutationRejection<BoardCellStateRejectedKey>> {
  const merged = mergeBoardCellStatePatches(patches);
  if (merged.length === 0) return { ok: true, versions: buildBoardMutationVersions([]) };
  const rows = buildBoardCellStatePayloadRows(merged);
  const preflight = await loadBoardBulkPreflight(env, userId, rows);
  const now = new Date();
  const targets = preflight.map(preflightTarget);
  const expired = new Set(findBoardCellStatePatchesOutsideCurrentPeriod(merged, targets, now).map(boardCellStatePatchKey));
  const invalidOrdinals = merged.flatMap((patch, ordinal) =>
    preflight[ordinal]?.eligible !== 1 || expired.has(boardCellStatePatchKey(patch)) ? [ordinal] : []
  );
  if (invalidOrdinals.length > 0) {
    return { ok: false, rejectedKeys: invalidOrdinals.map((ordinal) => cellStateRejectedKey(merged[ordinal]!)) };
  }

  const guardedRows: GuardedBoardCellStatePayloadRow[] = rows.map((row, ordinal) => ({
    ...row,
    ...preflightGuardSnapshot(preflight[ordinal]!, now)
  }));
  const payloadJson = JSON.stringify(guardedRows);
  let results: unknown[];
  try {
    results = await env.DB.batch(prepareBoardCellStateWriteStatements(env, userId, payloadJson));
  } catch (error) {
    if (isBoardBulkGuardAssertionError(error)) return incompleteBoardMutation();
    throw error;
  }
  if (results.length !== 4 || !results.every(isSuccessfulBatchResult) || !hasEmptyBatchRows(results[2])) {
    return incompleteBoardMutation();
  }
  const returnedDeleteKeys = returnedObjectKeySet(results[0], cellStateRowKey);
  const returnedUpsertKeys = returnedObjectKeySet(results[1], cellStateRowKey);
  const requestedDeleteKeys = new Set(guardedRows.filter((row) => row.delete_state === 1).map(cellStatePayloadKey));
  const expectedUpsertKeys = new Set(guardedRows.filter((row) => row.delete_state === 0).map(cellStatePayloadKey));
  const sheetVersions = returnedSheetVersions(results[3]);
  const expectedSheetIds = new Set(guardedRows.map((row) => row.sheet_id));
  if (
    !isReturnedKeySubset(returnedDeleteKeys, requestedDeleteKeys) ||
    !sameStringSet(returnedUpsertKeys, expectedUpsertKeys) ||
    !hasExactSheetVersions(sheetVersions, expectedSheetIds)
  ) {
    return incompleteBoardMutation();
  }
  return { ok: true, versions: buildBoardMutationVersions(sheetVersions) };
}

type BoardBulkPayloadRow = BoardCompletionPayloadRow | BoardCellStatePayloadRow;

async function loadBoardBulkPreflight(env: Env, userId: string, rows: BoardBulkPayloadRow[]): Promise<BoardBulkPreflightRow[]> {
  const result = await prepareBoardBulkPreflightStatement(env, userId, JSON.stringify(rows)).all<BoardBulkPreflightRow>();
  if (!Array.isArray(result.results) || result.results.length !== rows.length) return incompleteBoardMutation();
  const byOrdinal = new Map<number, BoardBulkPreflightRow>();
  for (const row of result.results) {
    if (!Number.isInteger(row.ordinal) || row.ordinal < 0 || row.ordinal >= rows.length || byOrdinal.has(row.ordinal)) {
      return incompleteBoardMutation();
    }
    const expected = rows[row.ordinal];
    if (
      !expected ||
      row.tableId !== expected.table_id ||
      row.rowItemId !== expected.row_item_id ||
      row.columnItemId !== expected.column_item_id ||
      (row.eligible !== 0 && row.eligible !== 1) ||
      (row.eligible === 1 &&
        (typeof row.sheetId !== "string" ||
          !isBoardAxisItemKind(row.rowKind) ||
          !isBoardAxisItemKind(row.columnKind) ||
          !isNullableString(row.rowTaskResetRuleJson) ||
          !isNullableString(row.columnTaskResetRuleJson)))
    ) {
      return incompleteBoardMutation();
    }
    byOrdinal.set(row.ordinal, row);
  }
  const ordered = rows.map((_, ordinal) => byOrdinal.get(ordinal));
  return ordered.every((row): row is BoardBulkPreflightRow => row !== undefined) ? ordered : incompleteBoardMutation();
}

function preflightTarget(row: BoardBulkPreflightRow): AuthorizedBoardCompletionTarget {
  return {
    tableId: row.tableId,
    rowItemId: row.rowItemId,
    columnItemId: row.columnItemId,
    ...(row.eligible === 1 && row.rowKind && row.columnKind
      ? {
          rowKind: row.rowKind,
          columnKind: row.columnKind,
          rowTaskResetRuleJson: row.rowTaskResetRuleJson,
          columnTaskResetRuleJson: row.columnTaskResetRuleJson
        }
      : {})
  };
}

function preflightGuardSnapshot(row: BoardBulkPreflightRow, now: Date) {
  if (row.eligible !== 1 || !row.sheetId || !row.rowKind || !row.columnKind) return incompleteBoardMutation();
  const target = preflightTarget(row);
  const boundaries = [
    target.rowKind === "task" ? parseResetRule(target.rowTaskResetRuleJson) : null,
    target.columnKind === "task" ? parseResetRule(target.columnTaskResetRuleJson) : null
  ].flatMap((rule) => {
    if (!rule) return [];
    const boundary = getNextResetBoundary(rule, now);
    return boundary ? [Math.floor(boundary.getTime() / 1000)] : [];
  });
  return {
    sheet_id: row.sheetId,
    row_kind: row.rowKind,
    column_kind: row.columnKind,
    row_task_reset_rule_json: row.rowTaskResetRuleJson,
    column_task_reset_rule_json: row.columnTaskResetRuleJson,
    guard_expires_at: boundaries.length > 0 ? Math.min(...boundaries) : null
  };
}

function completionRejectedKey(patch: BoardCompletionPatch): BoardCompletionRejectedKey {
  const { tableId, rowItemId, columnItemId, periodKey } = patch;
  return { tableId, rowItemId, columnItemId, periodKey };
}

function cellStateRejectedKey(patch: BoardCellStatePatch): BoardCellStateRejectedKey {
  const { tableId, rowItemId, columnItemId } = patch;
  return { tableId, rowItemId, columnItemId };
}

function completionPayloadKey(row: BoardCompletionPayloadRow): string {
  return JSON.stringify([row.table_id, row.row_item_id, row.column_item_id, row.period_key]);
}

function cellStatePayloadKey(row: BoardCellStatePayloadRow): string {
  return JSON.stringify([row.table_id, row.row_item_id, row.column_item_id]);
}

function completionRowKey(row: Record<string, unknown>): string | null {
  const { tableId, rowItemId, columnItemId, periodKey } = row;
  return [tableId, rowItemId, columnItemId, periodKey].every((value) => typeof value === "string")
    ? JSON.stringify([tableId, rowItemId, columnItemId, periodKey])
    : null;
}

function cellStateRowKey(row: Record<string, unknown>): string | null {
  const { tableId, rowItemId, columnItemId } = row;
  return [tableId, rowItemId, columnItemId].every((value) => typeof value === "string")
    ? JSON.stringify([tableId, rowItemId, columnItemId])
    : null;
}

function returnedObjectKeySet(
  result: unknown,
  keyOf: (row: Record<string, unknown>) => string | null
): Set<string> | null {
  if (!result || typeof result !== "object" || !("results" in result)) return null;
  const rows = (result as { results?: unknown[] }).results;
  if (!Array.isArray(rows)) return null;
  const keys = rows.map((row) => (row && typeof row === "object" ? keyOf(row as Record<string, unknown>) : null));
  if (keys.some((key) => key === null)) return null;
  const set = new Set(keys as string[]);
  return set.size === rows.length ? set : null;
}

function isSuccessfulBatchResult(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as { success?: unknown }).success === true);
}

function hasEmptyBatchRows(result: unknown): boolean {
  return Boolean(
    result &&
      typeof result === "object" &&
      Array.isArray((result as { results?: unknown }).results) &&
      (result as { results: unknown[] }).results.length === 0
  );
}

function isBoardAxisItemKind(value: unknown): value is "character" | "task" | "custom" {
  return value === "character" || value === "task" || value === "custom";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function sameStringSet(actual: Set<string> | null, expected: Set<string>): boolean {
  return actual !== null && actual.size === expected.size && [...expected].every((value) => actual.has(value));
}

function isReturnedKeySubset(actual: Set<string> | null, requested: Set<string>): boolean {
  return actual !== null && [...actual].every((value) => requested.has(value));
}

function hasExactSheetVersions(actual: BoardSheetVersion[] | null, expectedIds: Set<string>): actual is BoardSheetVersion[] {
  if (!actual || actual.length !== expectedIds.size) return false;
  const ids = new Set(actual.map((row) => row.id));
  return ids.size === actual.length && ids.size === expectedIds.size && [...expectedIds].every((id) => ids.has(id));
}

function isBoardBulkGuardAssertionError(error: unknown): boolean {
  return /NOT NULL constraint failed:\s*board_cell_completions\.user_id/i.test(String(error));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function placeholders(values: string[]): string {
  return values.map(() => "?").join(", ");
}

export async function updateBoardAxisItemSize(
  env: Env,
  userId: string,
  axisItemId: string,
  patch: BoardAxisItemSizePatch
): Promise<BoardMutationResult | null> {
  const [sheetVersionResult, updatedResult] = await env.DB.batch([
    bumpBoardSheetVersionForAxisItem(env, userId, axisItemId),
    env.DB.prepare(
      `UPDATE board_axis_items
       SET size_px = CASE WHEN ? = 1 THEN ? ELSE size_px END,
           cross_size_px = CASE WHEN ? = 1 THEN ? ELSE cross_size_px END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND visible = 1
         AND EXISTS (
           SELECT 1
           FROM board_tables
           WHERE board_tables.id = board_axis_items.table_id
             AND board_tables.user_id = board_axis_items.user_id
             AND board_tables.locked = 0
         )
       RETURNING id`
    ).bind(
      patch.sizePx !== undefined ? 1 : 0,
      patch.sizePx ?? null,
      patch.crossSizePx !== undefined ? 1 : 0,
      patch.crossSizePx ?? null,
      axisItemId,
      userId
    )
  ]);
  const sheetVersion = returnedAnySheetVersion(sheetVersionResult);
  const updatedId = returnedMutationId(updatedResult, axisItemId);
  if (!sheetVersion && !updatedId) return null;
  if (!sheetVersion || !updatedId) return incompleteBoardMutation();
  return { ok: true, versions: buildBoardMutationVersions([sheetVersion]) };
}
