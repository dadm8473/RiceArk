import type { BoardAxis, BoardAxisItem } from "./types";

export interface BoardAxisSortableIdentity {
  tableId: string;
  axis: BoardAxis;
  axisItemId: string;
}

const SORTABLE_KIND = "board-axis";

export function getBoardAxisSortableId(tableId: string, axis: BoardAxis, axisItemId: string): string {
  return JSON.stringify([SORTABLE_KIND, tableId, axis, axisItemId]);
}

export function parseBoardAxisSortableId(sortableId: string): BoardAxisSortableIdentity | null {
  try {
    const value = JSON.parse(sortableId) as unknown;
    if (!Array.isArray(value) || value.length !== 4) return null;
    const [kind, tableId, axis, axisItemId] = value;
    if (kind !== SORTABLE_KIND) return null;
    if (typeof tableId !== "string" || typeof axisItemId !== "string") return null;
    if (axis !== "row" && axis !== "column") return null;
    if (!tableId || !axisItemId) return null;
    return { tableId, axis, axisItemId };
  } catch {
    return null;
  }
}

export function moveBoardAxisItemIds(ids: string[], activeId: string, overId: string): string[] {
  const fromIndex = ids.indexOf(activeId);
  const toIndex = ids.indexOf(overId);
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return ids;

  const next = [...ids];
  const [item] = next.splice(fromIndex, 1);
  if (item === undefined) return ids;
  next.splice(toIndex, 0, item);
  return next;
}

export function applyBoardAxisOrder<T extends Pick<BoardAxisItem, "id" | "table_id" | "axis" | "sort_order">>(
  items: T[],
  tableId: string,
  axis: BoardAxis,
  orderedIds: string[]
): T[] {
  const sortOrderById = new Map(orderedIds.map((id, index) => [id, index * 10]));
  return items.map((item) => {
    if (item.table_id !== tableId || item.axis !== axis) return item;
    const sortOrder = sortOrderById.get(item.id);
    return sortOrder === undefined ? item : { ...item, sort_order: sortOrder };
  });
}
