import { getPeriodKey, type ResetRule } from "@riceark/core";
import type { BoardAxisItem, BoardCellCompletion } from "./types";

export interface BoardCompletionPatch {
  tableId: string;
  rowItemId: string;
  columnItemId: string;
  periodKey: string;
  completed: boolean;
}

function patchKey(patch: BoardCompletionPatch): string {
  return JSON.stringify([patch.tableId, patch.rowItemId, patch.columnItemId, patch.periodKey]);
}

function completionKey(completion: BoardCellCompletion): string {
  return JSON.stringify([
    completion.table_id,
    completion.row_item_id,
    completion.column_item_id,
    completion.period_key
  ]);
}

export function mergeBoardCompletionPatches(patches: BoardCompletionPatch[]): BoardCompletionPatch[] {
  const latest = new Map<string, BoardCompletionPatch>();
  for (const patch of patches) {
    latest.set(patchKey(patch), patch);
  }
  return [...latest.values()];
}

export function applyPendingBoardCompletionPatches(
  completions: BoardCellCompletion[],
  pendingPatches: BoardCompletionPatch[]
): BoardCellCompletion[] {
  return mergeBoardCompletionPatches(pendingPatches).reduce(
    (next, patch) => applyBoardCompletionPatch(next, patch),
    completions
  );
}

export function applyBoardCompletionPatch(
  completions: BoardCellCompletion[],
  patch: BoardCompletionPatch
): BoardCellCompletion[] {
  const nextCompletion: BoardCellCompletion = {
    table_id: patch.tableId,
    row_item_id: patch.rowItemId,
    column_item_id: patch.columnItemId,
    period_key: patch.periodKey,
    completed: patch.completed ? 1 : 0
  };
  const key = completionKey(nextCompletion);
  let replaced = false;
  const next = completions.map((completion) => {
    if (completionKey(completion) !== key) return completion;
    replaced = true;
    return nextCompletion;
  });

  return replaced ? next : [...next, nextCompletion];
}

export function getBoardCellPeriodKey(row: BoardAxisItem, column: BoardAxisItem, now = new Date()): string | null {
  const taskItem = row.kind === "task" ? row : column.kind === "task" ? column : null;
  if (!taskItem?.task_reset_rule_json) return null;
  return getPeriodKey(JSON.parse(taskItem.task_reset_rule_json) as ResetRule, now);
}
