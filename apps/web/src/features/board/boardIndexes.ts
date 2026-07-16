import type {
  BoardAxisItem,
  BoardCellState,
  BoardCellCompletion,
  BoardNote,
  BoardPayload,
  BoardTable
} from "./types";

export interface BoardPayloadIndexes {
  tablesBySheet: Map<string, BoardTable[]>;
  notesBySheet: Map<string, BoardNote[]>;
  axisItemsByTable: Map<string, BoardAxisItem[]>;
  cellStatesByTable: Map<string, BoardCellState[]>;
  completionsByTable: Map<string, BoardCellCompletion[]>;
}

function groupStable<Item>(items: readonly Item[], getKey: (item: Item) => string): Map<string, Item[]> {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = getKey(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

export function indexBoardPayloadByTable(
  payload: Pick<BoardPayload, "tables" | "notes" | "axisItems" | "cellStates" | "completions">
): BoardPayloadIndexes {
  return {
    tablesBySheet: groupStable(payload.tables, (table) => table.sheet_id),
    notesBySheet: groupStable(payload.notes ?? [], (note) => note.sheet_id),
    axisItemsByTable: groupStable(payload.axisItems, (item) => item.table_id),
    cellStatesByTable: groupStable(payload.cellStates, (state) => state.table_id),
    completionsByTable: groupStable(payload.completions, (completion) => completion.table_id)
  };
}
