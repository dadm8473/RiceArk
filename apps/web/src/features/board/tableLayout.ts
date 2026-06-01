import type { BoardTable } from "./types";

export interface BoardTableLayoutPatch {
  x: number;
  y: number;
  width: number | null;
  height: number | null;
}

export interface BoardTableLayoutNumberOptions {
  min: number;
  max: number;
  nullable: boolean;
}

export function applyBoardTableLayoutPatch(
  tables: BoardTable[],
  tableId: string,
  patch: BoardTableLayoutPatch
): BoardTable[] {
  return tables.map((table) => (table.id === tableId ? { ...table, ...patch } : table));
}

export function normalizeBoardTableLayoutNumber(
  value: string,
  options: BoardTableLayoutNumberOptions
): number | null {
  if (value.trim() === "" && options.nullable) return null;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return options.nullable ? null : options.min;

  return Math.min(options.max, Math.max(options.min, Math.round(parsed)));
}
