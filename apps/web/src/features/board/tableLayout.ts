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

export interface BoardTableLayoutPointerStart extends BoardTableLayoutPatch {
  pointerX: number;
  pointerY: number;
}

export interface BoardTableLayoutPointerPosition {
  pointerX: number;
  pointerY: number;
}

export const BOARD_TABLE_LAYOUT_LIMITS = {
  minX: 0,
  maxX: 10000,
  minY: 0,
  maxY: 10000,
  minWidth: 160,
  maxWidth: 4000,
  minHeight: 120,
  maxHeight: 4000
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
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

export function getBoardTableMovePatch(
  start: BoardTableLayoutPointerStart,
  current: BoardTableLayoutPointerPosition
): BoardTableLayoutPatch {
  const deltaX = current.pointerX - start.pointerX;
  const deltaY = current.pointerY - start.pointerY;

  return {
    x: clamp(start.x + deltaX, BOARD_TABLE_LAYOUT_LIMITS.minX, BOARD_TABLE_LAYOUT_LIMITS.maxX),
    y: clamp(start.y + deltaY, BOARD_TABLE_LAYOUT_LIMITS.minY, BOARD_TABLE_LAYOUT_LIMITS.maxY),
    width: start.width,
    height: start.height
  };
}

export function getBoardTableResizePatch(
  start: BoardTableLayoutPointerStart,
  current: BoardTableLayoutPointerPosition
): BoardTableLayoutPatch {
  const deltaX = current.pointerX - start.pointerX;
  const deltaY = current.pointerY - start.pointerY;
  const width = start.width ?? BOARD_TABLE_LAYOUT_LIMITS.minWidth;
  const height = start.height ?? BOARD_TABLE_LAYOUT_LIMITS.minHeight;

  return {
    x: start.x,
    y: start.y,
    width: clamp(width + deltaX, BOARD_TABLE_LAYOUT_LIMITS.minWidth, BOARD_TABLE_LAYOUT_LIMITS.maxWidth),
    height: clamp(height + deltaY, BOARD_TABLE_LAYOUT_LIMITS.minHeight, BOARD_TABLE_LAYOUT_LIMITS.maxHeight)
  };
}
