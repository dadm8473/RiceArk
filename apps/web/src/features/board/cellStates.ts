import type { BoardCellState } from "./types";

export type BoardCellMarkType = "default" | "fixed" | "reserved" | "disabled";

export interface BoardCellStatePatch {
  tableId: string;
  rowItemId: string;
  columnItemId: string;
  markType: BoardCellMarkType;
  memo: string | null;
  periodKey?: string | undefined;
}

export interface BoardCellMark {
  type: "fixed" | "reserved" | "disabled";
  memo: string | null;
}

function cellStateKey(cell: Pick<BoardCellState, "table_id" | "row_item_id" | "column_item_id">): string {
  return JSON.stringify([cell.table_id, cell.row_item_id, cell.column_item_id]);
}

function patchKey(patch: BoardCellStatePatch): string {
  return JSON.stringify([patch.tableId, patch.rowItemId, patch.columnItemId]);
}

export function mergeBoardCellStatePatches(patches: BoardCellStatePatch[]): BoardCellStatePatch[] {
  const latest = new Map<string, BoardCellStatePatch>();
  for (const patch of patches) {
    latest.set(patchKey(patch), patch);
  }
  return [...latest.values()];
}

export function applyBoardCellStatePatch(
  cellStates: BoardCellState[],
  patch: BoardCellStatePatch
): BoardCellState[] {
  const nextCell: BoardCellState = {
    table_id: patch.tableId,
    row_item_id: patch.rowItemId,
    column_item_id: patch.columnItemId,
    checkbox_visible: patch.markType === "disabled" ? 0 : 1,
    mark_type: patch.markType,
    memo: patch.markType === "fixed" || patch.markType === "reserved" ? (patch.memo === "" ? null : patch.memo) : null,
    mark_period_key: patch.markType === "reserved" ? (patch.periodKey ?? null) : null
  };
  const key = cellStateKey(nextCell);
  if (patch.markType === "default") {
    return cellStates.filter((cell) => cellStateKey(cell) !== key);
  }

  let replaced = false;
  const next = cellStates.map((cell) => {
    if (cellStateKey(cell) !== key) return cell;
    replaced = true;
    return nextCell;
  });
  return replaced ? next : [...next, nextCell];
}

export function resolveBoardCellMark(
  cell: BoardCellState | undefined,
  currentPeriodKey: string | null
): BoardCellMark | null {
  if (!cell) return null;
  if (cell.mark_type === "disabled") return { type: "disabled", memo: null };
  if (cell.mark_type === "fixed") return { type: "fixed", memo: cell.memo ?? null };
  if (cell.mark_type === "reserved") {
    if (!cell.mark_period_key || cell.mark_period_key !== currentPeriodKey) return null;
    return { type: "reserved", memo: cell.memo ?? null };
  }
  return null;
}
