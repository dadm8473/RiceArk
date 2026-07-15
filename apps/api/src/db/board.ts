import {
  boardCompletionKey,
  getPeriodKey,
  type BoardAxis,
  type BoardAxisRole,
  type BoardOrientation,
  type BoardTaskAxis,
  type ResetRule
} from "@riceark/core";
import type { Env } from "../env";
import { createManualCharacter, saveSelectedCharacters, type CharacterSnapshot } from "./characters";
import type { ChecklistOrientation } from "./settings";
import { createUserTask } from "./tasks";
import type { LostArkEventRewardFilter } from "../lostark/events";
import {
  bumpBoardManifestVersionStatement as bumpBoardManifestVersion,
  bumpBoardSheetVersionForNoteStatement as bumpBoardSheetVersionForNote,
  bumpBoardSheetVersionStatement as bumpBoardSheetVersion,
  bumpBoardSheetVersionsForTablesStatement as bumpBoardSheetVersionsForTables
} from "./boardVersions";

export const DEFAULT_SHEET_NAME = "기본";
export const DEFAULT_TABLE_NAME = "숙제";
const NEW_BOARD_TABLE_DEFAULT_X = 24;
const NEW_BOARD_TABLE_DEFAULT_Y = 24;

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

export interface BoardVersionSummary {
  manifestVersion: number;
  sheets: Array<{ id: string; version: number }>;
  periodFingerprint: string;
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

export type BoardTableSettingsUpdateResult = "updated" | "not_found" | "locked";

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

async function isBoardTableLocked(env: Env, userId: string, tableId: string): Promise<boolean | null> {
  const table = await env.DB.prepare("SELECT locked FROM board_tables WHERE id = ? AND user_id = ?")
    .bind(tableId, userId)
    .first<{ locked: number }>();
  if (!table) return null;
  return table.locked === 1;
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

async function repairBoardTableRolesFromExistingAxes(
  env: Env,
  userId: string,
  tableId: string,
  table: { row_role: BoardAxisRole; column_role: BoardAxisRole },
  axes: { characterAxis: BoardAxis | null; taskAxis: BoardAxis | null }
): Promise<{ row_role: BoardAxisRole; column_role: BoardAxisRole }> {
  if (!axes.characterAxis || !axes.taskAxis || axes.characterAxis === axes.taskAxis) return table;

  const roles =
    axes.taskAxis === "row"
      ? { row_role: "task" as const, column_role: "character" as const, task_axis: "rows" as const }
      : { row_role: "character" as const, column_role: "task" as const, task_axis: "columns" as const };
  if (table.row_role === roles.row_role && table.column_role === roles.column_role) return table;

  await env.DB.prepare(
    `UPDATE board_tables
     SET row_role = ?, column_role = ?, task_axis = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  )
    .bind(roles.row_role, roles.column_role, roles.task_axis, tableId, userId)
    .run();

  return roles;
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
  const sheet = await env.DB.prepare("SELECT id FROM sheets WHERE id = ? AND user_id = ?")
    .bind(sheetId, userId)
    .first<{ id: string }>();
  if (!sheet) return "not_found";

  const shareId = generateBoardShareId();
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM board_shares WHERE owner_user_id = ? AND sheet_id = ?").bind(userId, sheetId),
    env.DB.prepare(
      `INSERT INTO board_shares (id, owner_user_id, sheet_id, share_id)
       VALUES (?, ?, ?, ?)`
    ).bind(id, userId, sheetId, shareId),
    bumpBoardSheetVersion(env, userId, sheetId),
    bumpBoardManifestVersion(env, userId)
  ]);

  return { shareId };
}

export async function stopBoardSheetShare(env: Env, userId: string, sheetId: string): Promise<boolean> {
  const share = await env.DB.prepare("SELECT share_id FROM board_shares WHERE owner_user_id = ? AND sheet_id = ?")
    .bind(userId, sheetId)
    .first<{ share_id: string }>();
  if (!share) return false;

  await env.DB.batch([
    env.DB.prepare("DELETE FROM board_shares WHERE owner_user_id = ? AND sheet_id = ?").bind(userId, sheetId),
    bumpBoardSheetVersion(env, userId, sheetId),
    bumpBoardManifestVersion(env, userId)
  ]);
  return true;
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

export async function loadBoardVersionSummary(env: Env, userId: string, _now = new Date()): Promise<BoardVersionSummary> {
  const [manifest, sheets] = await Promise.all([
    env.DB.prepare("SELECT version FROM board_manifest_versions WHERE user_id = ?")
      .bind(userId)
      .first<{ version: number }>(),
    env.DB.prepare("SELECT id, content_version FROM sheets WHERE user_id = ? ORDER BY sort_order, name")
      .bind(userId)
      .all<{ id: string; content_version: number }>()
  ]);

  return {
    manifestVersion: manifest?.version ?? 0,
    sheets: sheets.results.map((sheet) => ({ id: sheet.id, version: sheet.content_version })),
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

export type DeleteBoardSheetResult = "deleted" | "last_sheet" | "not_found";

export type UpdateBoardSheetResult = "updated" | "name_conflict" | "not_found";

export async function updateBoardSheet(
  env: Env,
  userId: string,
  sheetId: string,
  input: CreateBoardSheetInput
): Promise<UpdateBoardSheetResult> {
  await ensureDefaultBoard(env, userId);

  const sheet = await env.DB.prepare("SELECT id FROM sheets WHERE id = ? AND user_id = ?")
    .bind(sheetId, userId)
    .first<{ id: string }>();
  if (!sheet) return "not_found";

  const existing = await env.DB.prepare("SELECT id FROM sheets WHERE user_id = ? AND name = ? AND id <> ?")
    .bind(userId, input.name, sheetId)
    .first<{ id: string }>();
  if (existing) return "name_conflict";

  await env.DB.prepare(
    `UPDATE sheets
     SET name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  )
    .bind(input.name, sheetId, userId)
    .run();

  return "updated";
}

export async function deleteBoardSheet(env: Env, userId: string, sheetId: string): Promise<DeleteBoardSheetResult> {
  await ensureDefaultBoard(env, userId);

  const sheet = await env.DB.prepare("SELECT id, is_default FROM sheets WHERE id = ? AND user_id = ?")
    .bind(sheetId, userId)
    .first<{ id: string; is_default: number }>();
  if (!sheet) return "not_found";

  const sheetCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM sheets WHERE user_id = ?")
    .bind(userId)
    .first<{ count: number }>();
  if ((sheetCount?.count ?? 0) <= 1) return "last_sheet";

  const tableIdsForSheet = "SELECT id FROM board_tables WHERE user_id = ? AND sheet_id = ?";
  const statements = [];

  if (sheet.is_default === 1) {
    statements.push(
      env.DB.prepare(
        `UPDATE sheets
         SET is_default = CASE
           WHEN id = (
             SELECT id FROM sheets
             WHERE user_id = ? AND id <> ?
             ORDER BY sort_order, name
             LIMIT 1
           ) THEN 1
           ELSE 0
         END,
         updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`
      ).bind(userId, sheetId, userId)
    );
  }

  statements.push(
    env.DB.prepare(`DELETE FROM board_cell_completions WHERE user_id = ? AND table_id IN (${tableIdsForSheet})`).bind(
      userId,
      userId,
      sheetId
    ),
    env.DB.prepare(`DELETE FROM board_cell_states WHERE user_id = ? AND table_id IN (${tableIdsForSheet})`).bind(userId, userId, sheetId),
    env.DB.prepare(`DELETE FROM board_axis_items WHERE user_id = ? AND table_id IN (${tableIdsForSheet})`).bind(userId, userId, sheetId),
    env.DB.prepare("DELETE FROM board_notes WHERE user_id = ? AND sheet_id = ?").bind(userId, sheetId),
    env.DB.prepare("DELETE FROM board_tables WHERE user_id = ? AND sheet_id = ?").bind(userId, sheetId),
    env.DB.prepare("DELETE FROM sheets WHERE id = ? AND user_id = ?").bind(sheetId, userId)
  );

  await env.DB.batch(statements);
  return "deleted";
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
  const roles = boardRolesForTableOrientation(input.orientation);
  const defaultRowHeight = input.defaultRowHeight ?? 40;
  const defaultColumnWidth = input.defaultColumnWidth ?? 132;
  const templateType = input.templateType ?? "custom";

  await env.DB.prepare(
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
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
      serializeBoardEventOptions(templateType, input.eventOptions)
    )
    .run();

  return { id };
}

export async function createBoardNote(env: Env, userId: string, input: CreateBoardNoteInput): Promise<{ id: string } | null> {
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

  await env.DB.batch([
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
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 220, 160)`
    ).bind(id, userId, input.sheetId, input.title, input.body, input.color ?? "#fef3c7", sortOrder, y),
    bumpBoardSheetVersion(env, userId, input.sheetId)
  ]);

  return { id };
}

export type BoardNoteUpdateResult = "updated" | "not_found";

export async function updateBoardNote(
  env: Env,
  userId: string,
  noteId: string,
  input: UpdateBoardNoteInput
): Promise<BoardNoteUpdateResult> {
  const [result] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE board_notes
       SET title = COALESCE(?, title),
           body = COALESCE(?, body),
           color = COALESCE(?, color),
           width = COALESCE(?, width),
           height = COALESCE(?, height),
           locked = COALESCE(?, locked),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`
    ).bind(
      input.title ?? null,
      input.body ?? null,
      input.color ?? null,
      input.width ?? null,
      input.height ?? null,
      input.locked ?? null,
      noteId,
      userId
    ),
    bumpBoardSheetVersionForNote(env, userId, noteId)
  ]);

  return (result?.meta.changes ?? 0) > 0 ? "updated" : "not_found";
}

export async function updateBoardNoteLayout(
  env: Env,
  userId: string,
  noteId: string,
  patch: BoardNoteLayoutPatch
): Promise<boolean> {
  const [result] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE board_notes
       SET x = ?,
           y = ?,
           width = ?,
           height = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`
    ).bind(patch.x, patch.y, patch.width, patch.height, noteId, userId),
    bumpBoardSheetVersionForNote(env, userId, noteId)
  ]);

  return (result?.meta.changes ?? 0) > 0;
}

export async function deleteBoardNote(env: Env, userId: string, noteId: string): Promise<boolean> {
  const [, result] = await env.DB.batch([
    bumpBoardSheetVersionForNote(env, userId, noteId),
    env.DB.prepare("DELETE FROM board_notes WHERE id = ? AND user_id = ?").bind(noteId, userId)
  ]);
  return (result?.meta.changes ?? 0) > 0;
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

  const result = await env.DB.prepare(
    `UPDATE board_tables
     SET name = ?,
         default_row_height = ?,
         default_column_width = ?,
         display_options_json = ?,
         event_options_json = ?,
         locked = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  )
    .bind(
      input.name,
      input.defaultRowHeight,
      input.defaultColumnWidth,
      displayOptionsJson,
      eventOptionsJson,
      nextLocked,
      tableId,
      userId
    )
    .run();
  return (result.meta.changes ?? 0) > 0 ? "updated" : "not_found";
}

export async function deleteBoardTable(env: Env, userId: string, tableId: string): Promise<boolean> {
  const table = await env.DB.prepare("SELECT id, locked FROM board_tables WHERE id = ? AND user_id = ?")
    .bind(tableId, userId)
    .first<{ id: string; locked: number }>();
  if (!table) return false;
  if (table.locked === 1) return false;

  await env.DB.batch([
    env.DB.prepare("DELETE FROM board_cell_completions WHERE user_id = ? AND table_id = ?").bind(userId, tableId),
    env.DB.prepare("DELETE FROM board_cell_states WHERE user_id = ? AND table_id = ?").bind(userId, tableId),
    env.DB.prepare("DELETE FROM board_axis_items WHERE user_id = ? AND table_id = ?").bind(userId, tableId),
    env.DB.prepare("DELETE FROM board_tables WHERE id = ? AND user_id = ?").bind(tableId, userId)
  ]);
  return true;
}

export async function importBoardCharactersForTable(
  env: Env,
  userId: string,
  tableId: string,
  characters: BoardCharacterSelectionInput[]
): Promise<boolean> {
  await ensureDefaultBoard(env, userId);

  const table = await env.DB.prepare("SELECT id, row_role, column_role, locked FROM board_tables WHERE id = ? AND user_id = ?")
    .bind(tableId, userId)
    .first<{ id: string; row_role: BoardAxisRole; column_role: BoardAxisRole; locked: number }>();
  if (!table) return false;
  if (table.locked === 1) return false;

  await saveSelectedCharacters(env, userId, characters);
  const existingCharacterAxis = await readExistingAxisForKind(env, userId, tableId, "character");
  const existingTaskAxis = await readExistingAxisForKind(env, userId, tableId, "task");
  const tableRoles = await repairBoardTableRolesFromExistingAxes(env, userId, tableId, table, {
    characterAxis: existingCharacterAxis,
    taskAxis: existingTaskAxis
  });
  const axis = existingCharacterAxis ?? getAxisForRole(tableRoles, "character");
  const sizeSeed = await readBoardAxisItemSizeSeed(env, userId, tableId, axis);
  const maxSort = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), -10) AS maxSortOrder FROM board_axis_items WHERE user_id = ? AND table_id = ? AND axis = ?"
  )
    .bind(userId, tableId, axis)
    .first<{ maxSortOrder: number | null }>();
  let sortOrder = (maxSort?.maxSortOrder ?? -10) + 10;
  const statements = [];

  for (const character of characters) {
    const saved = await env.DB.prepare(
      `SELECT id, name
       FROM characters
       WHERE user_id = ? AND name = ? AND server_name = ? AND enabled = 1 AND deleted_at IS NULL`
    )
      .bind(userId, character.name, character.serverName)
      .first<{ id: string; name: string }>();
    if (!saved) continue;

    const existing = await env.DB.prepare(
      `SELECT id
       FROM board_axis_items
       WHERE user_id = ? AND table_id = ? AND axis = ? AND kind = 'character' AND character_id = ?`
    )
      .bind(userId, tableId, axis, saved.id)
      .first<{ id: string }>();

    if (existing) {
      statements.push(
        env.DB.prepare(
          `UPDATE board_axis_items
           SET visible = 1,
               label = ?,
               size_px = ?,
               cross_size_px = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND user_id = ?`
        ).bind(saved.name, sizeSeed.size_px, sizeSeed.cross_size_px, existing.id, userId)
      );
      continue;
    }

    statements.push(
      env.DB.prepare(
        `INSERT INTO board_axis_items (
           id, user_id, table_id, axis, kind, label, character_id, task_id, task_scope, task_reset_type,
           task_reset_rule_json, task_color, sort_order, size_px, cross_size_px
         )
         VALUES (?, ?, ?, ?, 'character', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`
      ).bind(crypto.randomUUID(), userId, tableId, axis, saved.name, saved.id, sortOrder, sizeSeed.size_px, sizeSeed.cross_size_px)
    );
    sortOrder += 10;
  }

  if (statements.length > 0) await env.DB.batch(statements);
  return true;
}

export async function createManualBoardCharacterForTable(
  env: Env,
  userId: string,
  tableId: string,
  input: BoardManualCharacterInput
): Promise<{ id: string } | null> {
  await ensureDefaultBoard(env, userId);

  const table = await env.DB.prepare("SELECT id, row_role, column_role, locked FROM board_tables WHERE id = ? AND user_id = ?")
    .bind(tableId, userId)
    .first<{ id: string; row_role: BoardAxisRole; column_role: BoardAxisRole; locked: number }>();
  if (!table) return null;
  if (table.locked === 1) return null;

  const existingCharacterAxis = await readExistingAxisForKind(env, userId, tableId, "character");
  const existingTaskAxis = await readExistingAxisForKind(env, userId, tableId, "task");
  const tableRoles = await repairBoardTableRolesFromExistingAxes(env, userId, tableId, table, {
    characterAxis: existingCharacterAxis,
    taskAxis: existingTaskAxis
  });
  const axis = existingCharacterAxis ?? getAxisForRole(tableRoles, "character");
  const character = await createManualCharacter(env, userId, input);
  const sizeSeed = await readBoardAxisItemSizeSeed(env, userId, tableId, axis);
  const existing = await env.DB.prepare(
    `SELECT id
     FROM board_axis_items
     WHERE user_id = ? AND table_id = ? AND axis = ? AND kind = 'character' AND character_id = ?`
  )
    .bind(userId, tableId, axis, character.id)
    .first<{ id: string }>();

  if (existing) {
    await env.DB.prepare(
      `UPDATE board_axis_items
       SET visible = 1,
           label = ?,
           size_px = ?,
           cross_size_px = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`
    )
      .bind(input.name, sizeSeed.size_px, sizeSeed.cross_size_px, existing.id, userId)
      .run();
    return existing;
  }

  const maxSort = await env.DB.prepare(
    "SELECT COALESCE(MAX(sort_order), -10) AS maxSortOrder FROM board_axis_items WHERE user_id = ? AND table_id = ? AND axis = ?"
  )
    .bind(userId, tableId, axis)
    .first<{ maxSortOrder: number | null }>();
  const id = crypto.randomUUID();
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
       sort_order,
       size_px,
       cross_size_px
     )
     VALUES (?, ?, ?, ?, 'character', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`
  )
    .bind(
      id,
      userId,
      tableId,
      axis,
      input.name,
      character.id,
      (maxSort?.maxSortOrder ?? -10) + 10,
      sizeSeed.size_px,
      sizeSeed.cross_size_px
    )
    .run();
  return { id };
}

export async function createBoardTaskForTable(
  env: Env,
  userId: string,
  tableId: string,
  input: BoardTaskInput
): Promise<{ id: string } | null> {
  await ensureDefaultBoard(env, userId);

  const table = await env.DB.prepare("SELECT id, row_role, column_role, locked FROM board_tables WHERE id = ? AND user_id = ?")
    .bind(tableId, userId)
    .first<{ id: string; row_role: BoardAxisRole; column_role: BoardAxisRole; locked: number }>();
  if (!table) return null;
  if (table.locked === 1) return null;

  const createRequestId = input.createRequestId ?? null;
  if (createRequestId) {
    const existing = await readBoardAxisItemByCreateRequestId(env, userId, tableId, createRequestId);
    if (existing) return existing;
  }

  const existingTaskAxis = await readExistingAxisForKind(env, userId, tableId, "task");
  const existingCharacterAxis = await readExistingAxisForKind(env, userId, tableId, "character");
  const tableRoles = await repairBoardTableRolesFromExistingAxes(env, userId, tableId, table, {
    characterAxis: existingCharacterAxis,
    taskAxis: existingTaskAxis
  });
  const axis = existingTaskAxis ?? getAxisForRole(tableRoles, "task");
  const taskId = await createUserTask(env, userId, {
    name: input.name,
    scope: input.scope,
    resetRule: input.resetRule,
    createRequestId
  });
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
       sort_order,
       size_px,
       cross_size_px,
       create_request_id
     )
     VALUES (?, ?, ?, ?, 'task', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      userId,
      tableId,
      axis,
      input.name,
      taskId,
      input.scope,
      input.resetRule.type,
      JSON.stringify(input.resetRule),
      color,
      sortOrder,
      sizeSeed.size_px,
      sizeSeed.cross_size_px,
      createRequestId
    )
    .run()
    .catch(async (error) => {
      if (createRequestId) {
        const existing = await readBoardAxisItemByCreateRequestId(env, userId, tableId, createRequestId);
        if (existing) return;
      }
      throw error;
    });

  if (createRequestId) {
    const created = await readBoardAxisItemByCreateRequestId(env, userId, tableId, createRequestId);
    if (created) return created;
  }

  return { id };
}

export async function createBoardAxisItem(
  env: Env,
  userId: string,
  input: CreateBoardAxisItemInput
): Promise<{ id: string } | null> {
  await ensureDefaultBoard(env, userId);

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
       sort_order,
       size_px,
       cross_size_px
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      sortOrder,
      sizeSeed.size_px,
      sizeSeed.cross_size_px
    )
    .run();

  return { id };
}

export async function reorderBoardAxisItems(
  env: Env,
  userId: string,
  input: BoardAxisOrderInput
): Promise<boolean> {
  const table = await env.DB.prepare("SELECT id, locked FROM board_tables WHERE id = ? AND user_id = ?")
    .bind(input.tableId, userId)
    .first<{ id: string; locked: number }>();
  if (!table) return false;
  if (table.locked === 1) return false;

  const existing = await env.DB.prepare(
    `SELECT id, visible
     FROM board_axis_items
     WHERE user_id = ? AND table_id = ? AND axis = ?
     ORDER BY sort_order, label`
  )
    .bind(userId, input.tableId, input.axis)
    .all<{ id: string; visible: number }>();
  const visibleIds = existing.results.filter((item) => item.visible === 1).map((item) => item.id);
  if (visibleIds.length !== input.axisItemIds.length) return false;

  const visibleSet = new Set(visibleIds);
  if (input.axisItemIds.some((id) => !visibleSet.has(id))) return false;

  const hiddenIds = existing.results.filter((item) => item.visible !== 1).map((item) => item.id);
  const orderedIds = [...input.axisItemIds, ...hiddenIds];

  const temporaryUpdates = orderedIds.map((id, index) =>
    env.DB.prepare(
      `UPDATE board_axis_items
       SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND table_id = ? AND axis = ?`
    ).bind(-((index + 1) * 10), id, userId, input.tableId, input.axis)
  );
  const finalUpdates = orderedIds.map((id, index) =>
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

export async function updateBoardTableLayout(
  env: Env,
  userId: string,
  tableId: string,
  patch: BoardTableLayoutPatch
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE board_tables
     SET x = ?, y = ?, width = ?, height = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND locked = 0`
  )
    .bind(patch.x, patch.y, patch.width, patch.height, tableId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function transposeBoardTable(env: Env, userId: string, tableId: string): Promise<boolean> {
  const table = await env.DB.prepare(
    "SELECT id, row_role, column_role, task_axis, locked FROM board_tables WHERE id = ? AND user_id = ?"
  )
    .bind(tableId, userId)
    .first<{ id: string; row_role: BoardAxisRole; column_role: BoardAxisRole; task_axis: BoardTaskAxis; locked: number }>();
  if (!table) return false;
  if (table.locked === 1) return false;

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

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE board_tables
       SET row_role = ?, column_role = ?, task_axis = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`
    ).bind(roles.rowRole, roles.columnRole, roles.taskAxis, tableId, userId),
    ...plan.map((item) =>
      env.DB.prepare(
        `UPDATE board_axis_items
         SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND table_id = ?`
      ).bind(item.temporarySortOrder, item.id, userId, tableId)
    ),
    ...plan.map((item) =>
      env.DB.prepare(
        `UPDATE board_axis_items
         SET axis = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND table_id = ?`
      ).bind(item.toAxis, item.id, userId, tableId)
    ),
    ...plan.map((item) =>
      env.DB.prepare(
        `UPDATE board_axis_items
         SET sort_order = ?,
             size_px = ?,
             cross_size_px = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND table_id = ?`
      ).bind(item.finalSortOrder, item.finalSizePx, item.finalCrossSizePx, item.id, userId, tableId)
    ),
    env.DB.prepare(
      `UPDATE board_cell_states
       SET row_item_id = column_item_id,
           column_item_id = row_item_id,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND table_id = ?`
    ).bind(userId, tableId),
    env.DB.prepare(
      `UPDATE board_cell_completions
       SET row_item_id = column_item_id,
           column_item_id = row_item_id,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND table_id = ?`
    ).bind(userId, tableId)
  ]);

  return true;
}

export async function updateBoardAxisItem(
  env: Env,
  userId: string,
  axisItemId: string,
  input: UpdateBoardAxisItemInput
): Promise<boolean> {
  const separatorJson = input.separator === undefined || input.separator === null ? null : JSON.stringify(input.separator);
  const displayOptionsJson =
    input.displaySettings === undefined || input.displaySettings === null
      ? null
      : serializeBoardDisplaySettings(input.displaySettings);
  const result = await env.DB.prepare(
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
       )`
  )
    .bind(
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
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function hideBoardAxisItem(env: Env, userId: string, axisItemId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE board_axis_items
     SET visible = 0, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND visible = 1
       AND EXISTS (
         SELECT 1
         FROM board_tables
         WHERE board_tables.id = board_axis_items.table_id
           AND board_tables.user_id = board_axis_items.user_id
           AND board_tables.locked = 0
       )`
  )
    .bind(axisItemId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
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
  if (findBoardCompletionPatchesOutsideCurrentPeriod(merged, authorizedTargets).length > 0) {
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
    await env.DB.batch([...statements, bumpBoardSheetVersionsForTables(env, userId, merged.map((patch) => patch.tableId))]);
  }
  return true;
}

export async function saveBoardCellStatePatch(
  env: Env,
  userId: string,
  patch: BoardCellStatePatch
): Promise<boolean> {
  return saveBoardCellStatePatches(env, userId, [patch]);
}

export async function saveBoardCellStatePatches(
  env: Env,
  userId: string,
  patches: BoardCellStatePatch[]
): Promise<boolean> {
  const merged = mergeBoardCellStatePatches(patches);
  const lockedTableIds = new Set<string>();
  for (const tableId of unique(merged.map((patch) => patch.tableId))) {
    if ((await isBoardTableLocked(env, userId, tableId)) === true) lockedTableIds.add(tableId);
  }
  if (merged.some((patch) => lockedTableIds.has(patch.tableId))) {
    return false;
  }

  const authorizedTargets = await loadAuthorizedBoardCompletionTargets(
    env,
    userId,
    merged.map((patch) => ({
      ...patch,
      periodKey: "daily:2000-01-01",
      completed: false
    }))
  );
  if (findUnauthorizedBoardCellStatePatches(merged, authorizedTargets).length > 0) {
    return false;
  }
  if (findBoardCellStatePatchesOutsideCurrentPeriod(merged, authorizedTargets).length > 0) {
    return false;
  }

  const statements = merged.map((patch) => {
    const memo = patch.markType === "disabled" || patch.memo === "" ? null : patch.memo;
    const markIcon = patch.markType === "disabled" ? null : (patch.markIcon ?? null);
    if (patch.markType === "default" && memo === null && markIcon === null) {
      return env.DB.prepare(
        `DELETE FROM board_cell_states
         WHERE user_id = ? AND table_id = ? AND row_item_id = ? AND column_item_id = ?`
      ).bind(userId, patch.tableId, patch.rowItemId, patch.columnItemId);
    }

    const markPeriodKey = patch.markType === "reserved" ? (patch.periodKey ?? null) : null;
    const checkboxVisible = patch.markType === "disabled" ? 0 : 1;
    return env.DB.prepare(
      `INSERT INTO board_cell_states
         (id, user_id, table_id, row_item_id, column_item_id, checkbox_visible, mark_type, mark_icon, memo, mark_period_key, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(table_id, row_item_id, column_item_id)
       DO UPDATE SET checkbox_visible = excluded.checkbox_visible,
                     mark_type = excluded.mark_type,
                     mark_icon = excluded.mark_icon,
                     memo = excluded.memo,
                     mark_period_key = excluded.mark_period_key,
                     updated_at = CURRENT_TIMESTAMP`
    ).bind(
      crypto.randomUUID(),
      userId,
      patch.tableId,
      patch.rowItemId,
      patch.columnItemId,
      checkboxVisible,
      patch.markType,
      markIcon,
      memo,
      markPeriodKey
    );
  });

  if (statements.length > 0) {
    await env.DB.batch([...statements, bumpBoardSheetVersionsForTables(env, userId, merged.map((patch) => patch.tableId))]);
  }
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
            column_items.id AS columnItemId,
            row_items.kind AS rowKind,
            column_items.kind AS columnKind,
            row_items.task_reset_rule_json AS rowTaskResetRuleJson,
            column_items.task_reset_rule_json AS columnTaskResetRuleJson
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
  patch: BoardAxisItemSizePatch
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE board_axis_items
     SET size_px = CASE WHEN ? = 1 THEN ? ELSE size_px END,
         cross_size_px = CASE WHEN ? = 1 THEN ? ELSE cross_size_px END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?
       AND EXISTS (
         SELECT 1
         FROM board_tables
         WHERE board_tables.id = board_axis_items.table_id
           AND board_tables.user_id = board_axis_items.user_id
           AND board_tables.locked = 0
       )`
  )
    .bind(
      patch.sizePx !== undefined ? 1 : 0,
      patch.sizePx ?? null,
      patch.crossSizePx !== undefined ? 1 : 0,
      patch.crossSizePx ?? null,
      axisItemId,
      userId
    )
    .run();

  return (result.meta.changes ?? 0) > 0;
}
