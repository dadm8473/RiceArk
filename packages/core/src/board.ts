export type BoardAxis = "row" | "column";
export type BoardAxisRole = "character" | "task" | "custom";
export type BoardTaskAxis = "rows" | "columns" | "none";
export type BoardOrientation = "tasks_rows" | "tasks_columns" | "custom";

export interface BoardCompletionIdentity {
  tableId: string;
  rowItemId: string;
  columnItemId: string;
  periodKey: string;
}

export function boardCompletionKey(identity: BoardCompletionIdentity): string {
  return JSON.stringify([identity.tableId, identity.rowItemId, identity.columnItemId, identity.periodKey]);
}

export function getBoardOrientation(input: { rowRole: BoardAxisRole; columnRole: BoardAxisRole }): BoardOrientation {
  if (input.rowRole === "task" && input.columnRole === "character") return "tasks_rows";
  if (input.rowRole === "character" && input.columnRole === "task") return "tasks_columns";
  return "custom";
}
