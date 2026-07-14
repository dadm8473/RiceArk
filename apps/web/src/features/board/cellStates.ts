import type { BoardCellState } from "./types";

export type BoardCellMarkIcon = "memo" | "pin" | "clock" | "star" | "alert" | "flag" | "tag";
export type BoardCellMarkRetention = "permanent" | "period";
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

export interface BoardCellMark {
  type: BoardCellMarkType;
  icon: BoardCellMarkIcon | null;
  retention: BoardCellMarkRetention;
  memo: string | null;
}

const BOARD_CELL_MARK_ICONS = new Set<BoardCellMarkIcon>(["memo", "pin", "clock", "star", "alert", "flag", "tag"]);

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
  const memo = patch.markType === "disabled" || patch.memo === "" ? null : patch.memo;
  const markIcon = patch.markType === "disabled" ? null : (patch.markIcon ?? null);
  const nextCell: BoardCellState = {
    table_id: patch.tableId,
    row_item_id: patch.rowItemId,
    column_item_id: patch.columnItemId,
    checkbox_visible: patch.markType === "disabled" ? 0 : 1,
    mark_type: patch.markType,
    mark_icon: markIcon,
    memo,
    mark_period_key: patch.markType === "reserved" ? (patch.periodKey ?? null) : null
  };
  const key = cellStateKey(nextCell);
  if (patch.markType === "default" && memo === null && markIcon === null) {
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
  const explicitIcon = normalizeBoardCellMarkIcon(cell.mark_icon);
  if (cell.mark_type === "disabled") return { type: "disabled", icon: null, retention: "permanent", memo: null };
  if (cell.mark_type === "default") {
    const icon = explicitIcon ?? (cell.memo ? "memo" : null);
    return icon || cell.memo ? { type: "default", icon, retention: "permanent", memo: cell.memo ?? null } : null;
  }
  if (cell.mark_type === "fixed") return { type: "fixed", icon: explicitIcon ?? "pin", retention: "permanent", memo: cell.memo ?? null };
  if (cell.mark_type === "reserved") {
    if (!cell.mark_period_key || cell.mark_period_key !== currentPeriodKey) return null;
    return { type: "reserved", icon: explicitIcon ?? "clock", retention: "period", memo: cell.memo ?? null };
  }
  return null;
}

export function normalizeBoardCellMarkIcon(value: string | null | undefined): BoardCellMarkIcon | null {
  return value && BOARD_CELL_MARK_ICONS.has(value as BoardCellMarkIcon) ? (value as BoardCellMarkIcon) : null;
}
