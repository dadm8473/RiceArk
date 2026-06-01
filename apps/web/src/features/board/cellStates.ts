import type { BoardCellState } from "./types";

export interface BoardCellStatePatch {
  tableId: string;
  rowItemId: string;
  columnItemId: string;
  checkboxVisible: boolean;
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
    checkbox_visible: patch.checkboxVisible ? 1 : 0
  };
  const key = cellStateKey(nextCell);
  if (patch.checkboxVisible) {
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
