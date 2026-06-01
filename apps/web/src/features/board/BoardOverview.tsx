import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeftRight, Eye, EyeOff, Maximize2, Move, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type PointerEvent, type ReactNode } from "react";
import { apiDelete, apiPatch, apiPost } from "../../api/client";
import { applyBoardCellStatePatch, type BoardCellStatePatch } from "./cellStates";
import { applyBoardCompletionPatch, getBoardCellPeriodKey, type BoardCompletionPatch } from "./completions";
import {
  applyBoardAxisOrder,
  getBoardAxisSortableId,
  moveBoardAxisItemIds,
  parseBoardAxisSortableId
} from "./reorder";
import {
  applyBoardTableLayoutPatch,
  getBoardTableMovePatch,
  getBoardTableResizePatch,
  normalizeBoardTableLayoutNumber,
  type BoardTableLayoutPatch,
  type BoardTableLayoutPointerStart
} from "./tableLayout";
import type { BoardAxis, BoardAxisItem, BoardAxisRole, BoardOrientation, BoardPayload, BoardTable } from "./types";
import { useBoardCompletionQueue } from "./useBoardCompletionQueue";

interface Props {
  board: BoardPayload;
  onBoardChanged?: () => Promise<BoardPayload> | void;
}

type BoardTableLayoutDragMode = "move" | "resize";

interface ActiveBoardTableLayoutDrag {
  tableId: string;
  mode: BoardTableLayoutDragMode;
  start: BoardTableLayoutPointerStart;
}

interface BoardAxisSeparator {
  widthPx: number;
  style: "solid" | "dashed" | "dotted";
  color: string;
}

const roleLabels: Record<BoardAxisRole, string> = {
  character: "캐릭터",
  task: "숙제",
  custom: "사용자"
};

const axisLabels: Record<BoardAxis, string> = {
  row: "행",
  column: "열"
};

const BOARD_CANVAS_MIN_WIDTH = 480;
const BOARD_CANVAS_MIN_HEIGHT = 260;
const BOARD_TABLE_FALLBACK_WIDTH = 360;
const BOARD_TABLE_FALLBACK_HEIGHT = 240;

function tableOrientationLabel(table: BoardTable): string {
  return `${roleLabels[table.row_role]} 행 / ${roleLabels[table.column_role]} 열`;
}

function getTransposedTable(table: BoardTable): BoardTable {
  return {
    ...table,
    row_role: table.column_role,
    column_role: table.row_role,
    task_axis: table.task_axis === "rows" ? "columns" : table.task_axis === "columns" ? "rows" : "none"
  };
}

function axisCount(axisItems: BoardAxisItem[], tableId: string, axis: "row" | "column"): number {
  return axisItems.filter((item) => item.table_id === tableId && item.axis === axis && item.visible === 1).length;
}

function cellKey(rowItemId: string, columnItemId: string): string {
  return JSON.stringify([rowItemId, columnItemId]);
}

function getTaskColor(row: BoardAxisItem, column: BoardAxisItem): string | null {
  if (row.kind === "task") return row.task_color;
  if (column.kind === "task") return column.task_color;
  return null;
}

function buildGridColumns(table: BoardTable, columns: BoardAxisItem[]): string {
  return `160px ${columns.map((column) => `${column.size_px ?? table.default_column_width}px`).join(" ")}`;
}

function parseBoardAxisSeparator(separatorJson: string | null | undefined): BoardAxisSeparator | null {
  if (!separatorJson) return null;

  try {
    const value = JSON.parse(separatorJson) as Partial<BoardAxisSeparator>;
    if (typeof value.widthPx !== "number" || !Number.isInteger(value.widthPx) || value.widthPx < 1 || value.widthPx > 8) {
      return null;
    }
    if (value.style !== "solid" && value.style !== "dashed" && value.style !== "dotted") return null;
    if (typeof value.color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.color)) return null;

    return {
      widthPx: value.widthPx,
      style: value.style,
      color: value.color.toLowerCase()
    };
  } catch {
    return null;
  }
}

function getSeparatorBorder(item: BoardAxisItem): string | undefined {
  const separator = parseBoardAxisSeparator(item.separator_json);
  return separator ? `${separator.widthPx}px ${separator.style} ${separator.color}` : undefined;
}

function normalizeAxisSize(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.min(1024, Math.max(16, Math.round(value)));
}

function axisDraftKey(tableId: string, axis: BoardAxis): string {
  return `${tableId}:${axis}`;
}

function getBoardCanvasStyle(tables: BoardTable[]): CSSProperties {
  const width = Math.max(
    BOARD_CANVAS_MIN_WIDTH,
    ...tables.map((table) => table.x + (table.width ?? BOARD_TABLE_FALLBACK_WIDTH))
  );
  const height = Math.max(
    BOARD_CANVAS_MIN_HEIGHT,
    ...tables.map((table) => table.y + (table.height ?? BOARD_TABLE_FALLBACK_HEIGHT))
  );

  return {
    "--board-canvas-width": `${width}px`,
    "--board-canvas-height": `${height}px`
  } as CSSProperties;
}

function getBoardTableStyle(table: BoardTable): CSSProperties {
  return {
    left: `${table.x}px`,
    top: `${table.y}px`,
    width: table.width === null ? undefined : `${table.width}px`,
    minHeight: table.height === null ? undefined : `${table.height}px`
  };
}

export function BoardOverview({ board, onBoardChanged }: Props) {
  const { enqueue } = useBoardCompletionQueue();
  const [completions, setCompletions] = useState(board.completions);
  const [cellStates, setCellStates] = useState(board.cellStates);
  const [axisItems, setAxisItems] = useState(board.axisItems);
  const [tables, setTables] = useState(board.tables);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [tableName, setTableName] = useState("");
  const [tableOrientation, setTableOrientation] = useState<BoardOrientation>("custom");
  const [pendingAction, setPendingAction] = useState<"sheet" | "table" | null>(null);
  const [pendingAxisKey, setPendingAxisKey] = useState<string | null>(null);
  const [axisDrafts, setAxisDrafts] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isReorderMode, setIsReorderMode] = useState(false);
  const [isCellVisibilityMode, setIsCellVisibilityMode] = useState(false);
  const [activeSortableId, setActiveSortableId] = useState<string | null>(null);
  const [activeTableLayoutDrag, setActiveTableLayoutDrag] = useState<ActiveBoardTableLayoutDrag | null>(null);
  const [editingAxisItem, setEditingAxisItem] = useState<BoardAxisItem | null>(null);
  const [transposingTable, setTransposingTable] = useState<BoardTable | null>(null);
  const [pendingTransposeTableId, setPendingTransposeTableId] = useState<string | null>(null);
  const [transposeError, setTransposeError] = useState<string | null>(null);
  const sortedSheets = useMemo(
    () => board.sheets.slice().sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name)),
    [board.sheets]
  );
  const activeSheet =
    sortedSheets.find((sheet) => sheet.id === activeSheetId) ??
    sortedSheets.find((sheet) => sheet.is_default === 1) ??
    sortedSheets[0];
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

  useEffect(() => {
    setCompletions(board.completions);
  }, [board.completions]);

  useEffect(() => {
    setCellStates(board.cellStates);
  }, [board.cellStates]);

  useEffect(() => {
    setAxisItems(board.axisItems);
  }, [board.axisItems]);

  useEffect(() => {
    setTables(board.tables);
  }, [board.tables]);

  function handleCompletionToggle(patch: BoardCompletionPatch) {
    setCompletions((current) => applyBoardCompletionPatch(current, patch));
    enqueue(patch);
  }

  async function handleCellVisibilityToggle(patch: BoardCellStatePatch) {
    setCellStates((current) => applyBoardCellStatePatch(current, patch));
    try {
      await apiPatch("/api/board/cell-states", patch);
    } catch {
      window.location.reload();
    }
  }

  async function handleAxisItemSave(
    axisItemId: string,
    label: string,
    taskColor?: string | null,
    separator?: BoardAxisSeparator | null
  ) {
    await apiPatch("/api/board/axis-items/" + encodeURIComponent(axisItemId), { label, taskColor, separator });
    setAxisItems((current) =>
      current.map((item) =>
        item.id === axisItemId
          ? {
              ...item,
              label,
              task_color: taskColor === undefined ? item.task_color : taskColor,
              separator_json: separator === undefined ? item.separator_json : separator === null ? null : JSON.stringify(separator)
            }
          : item
      )
    );
    setEditingAxisItem(null);
  }

  async function handleAxisItemDelete(axisItemId: string) {
    await apiDelete("/api/board/axis-items/" + encodeURIComponent(axisItemId));
    setAxisItems((current) => current.map((item) => (item.id === axisItemId ? { ...item, visible: 0 } : item)));
    setEditingAxisItem(null);
  }

  async function refreshBoard() {
    if (onBoardChanged) {
      await onBoardChanged();
      return;
    }
    window.location.reload();
  }

  async function handleCreateSheet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = sheetName.trim();
    if (!name) return;

    setPendingAction("sheet");
    setFormError(null);
    try {
      const sheet = await apiPost<{ id: string }>("/api/board/sheets", { name });
      setSheetName("");
      setActiveSheetId(sheet.id);
      await refreshBoard();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "시트를 추가하지 못했습니다.");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleCreateTable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeSheet) return;
    const name = tableName.trim();
    if (!name) return;

    setPendingAction("table");
    setFormError(null);
    try {
      await apiPost<{ id: string }>("/api/board/tables", {
        sheetId: activeSheet.id,
        name,
        orientation: tableOrientation
      });
      setTableName("");
      await refreshBoard();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "표를 추가하지 못했습니다.");
    } finally {
      setPendingAction(null);
    }
  }

  function handleAxisDraftChange(tableId: string, axis: BoardAxis, value: string) {
    setAxisDrafts((current) => ({ ...current, [axisDraftKey(tableId, axis)]: value }));
  }

  async function handleCreateAxisItem(event: FormEvent<HTMLFormElement>, table: BoardTable, axis: BoardAxis) {
    event.preventDefault();
    const key = axisDraftKey(table.id, axis);
    const label = (axisDrafts[key] ?? "").trim();
    if (!label) return;

    setPendingAxisKey(key);
    setFormError(null);
    try {
      await apiPost<{ id: string }>("/api/board/axis-items", {
        tableId: table.id,
        axis,
        label
      });
      setAxisDrafts((current) => ({ ...current, [key]: "" }));
      await refreshBoard();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : `${axisLabels[axis]}을 추가하지 못했습니다.`);
    } finally {
      setPendingAxisKey(null);
    }
  }

  async function handleAxisSizeChange(axisItemId: string, nextSize: number) {
    const sizePx = normalizeAxisSize(nextSize);
    if (sizePx === null) return;

    setAxisItems((current) =>
      current.map((item) => (item.id === axisItemId ? { ...item, size_px: sizePx } : item))
    );

    try {
      await apiPatch("/api/board/axis-items/" + encodeURIComponent(axisItemId) + "/size", { sizePx });
    } catch {
      window.location.reload();
    }
  }

  async function handleTableLayoutChange(tableId: string, patch: BoardTableLayoutPatch) {
    setTables((current) => applyBoardTableLayoutPatch(current, tableId, patch));

    try {
      await apiPatch("/api/board/tables/" + encodeURIComponent(tableId) + "/layout", patch);
    } catch {
      window.location.reload();
    }
  }

  async function handleTableTranspose(tableId: string) {
    setPendingTransposeTableId(tableId);
    setTransposeError(null);

    try {
      await apiPost<{ ok: true }>("/api/board/tables/" + encodeURIComponent(tableId) + "/transpose", {});
      setTransposingTable(null);
      await refreshBoard();
    } catch (err) {
      setTransposeError(err instanceof Error ? err.message : "행/열을 전환하지 못했습니다.");
    } finally {
      setPendingTransposeTableId(null);
    }
  }

  function getTableLayoutPointerStart(
    table: BoardTable,
    mode: BoardTableLayoutDragMode,
    event: PointerEvent<HTMLElement>
  ): BoardTableLayoutPointerStart {
    const tableElement = event.currentTarget.closest(".board-table-summary");
    const rect = tableElement?.getBoundingClientRect();
    const width = mode === "resize" ? table.width ?? Math.round(rect?.width ?? BOARD_TABLE_FALLBACK_WIDTH) : table.width;
    const height = mode === "resize" ? table.height ?? Math.round(rect?.height ?? BOARD_TABLE_FALLBACK_HEIGHT) : table.height;

    return {
      x: table.x,
      y: table.y,
      width,
      height,
      pointerX: event.clientX,
      pointerY: event.clientY
    };
  }

  function buildTableLayoutDragPatch(
    drag: ActiveBoardTableLayoutDrag,
    event: PointerEvent<HTMLElement>
  ): BoardTableLayoutPatch {
    const current = {
      pointerX: event.clientX,
      pointerY: event.clientY
    };
    return drag.mode === "move"
      ? getBoardTableMovePatch(drag.start, current)
      : getBoardTableResizePatch(drag.start, current);
  }

  function handleTableLayoutPointerDown(
    table: BoardTable,
    mode: BoardTableLayoutDragMode,
    event: PointerEvent<HTMLButtonElement>
  ) {
    if (isReorderMode) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setActiveTableLayoutDrag({
      tableId: table.id,
      mode,
      start: getTableLayoutPointerStart(table, mode, event)
    });
  }

  function handleTableLayoutPointerMove(event: PointerEvent<HTMLButtonElement>) {
    if (!activeTableLayoutDrag) return;

    event.preventDefault();
    const patch = buildTableLayoutDragPatch(activeTableLayoutDrag, event);
    setTables((current) => applyBoardTableLayoutPatch(current, activeTableLayoutDrag.tableId, patch));
  }

  function handleTableLayoutPointerEnd(event: PointerEvent<HTMLButtonElement>) {
    if (!activeTableLayoutDrag) return;

    event.preventDefault();
    const drag = activeTableLayoutDrag;
    setActiveTableLayoutDrag(null);
    if (event.clientX === drag.start.pointerX && event.clientY === drag.start.pointerY) return;

    void handleTableLayoutChange(drag.tableId, buildTableLayoutDragPatch(drag, event));
  }

  async function saveAxisOrder(tableId: string, axis: BoardAxis, axisItemIds: string[]) {
    try {
      await apiPatch("/api/board/axis-items/order", { tableId, axis, axisItemIds });
    } catch {
      window.location.reload();
    }
  }

  function moveAxisOrder(tableId: string, axis: BoardAxis, activeId: string, overId: string) {
    const orderedIds = axisItems
      .filter((item) => item.table_id === tableId && item.axis === axis)
      .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label))
      .map((item) => item.id);
    const nextIds = moveBoardAxisItemIds(orderedIds, activeId, overId);
    if (nextIds === orderedIds) return;

    setAxisItems((current) => applyBoardAxisOrder(current, tableId, axis, nextIds));
    void saveAxisOrder(tableId, axis, nextIds);
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveSortableId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveSortableId(null);
    const active = parseBoardAxisSortableId(String(event.active.id));
    const over = event.over ? parseBoardAxisSortableId(String(event.over.id)) : null;
    if (!active || !over) return;
    if (active.tableId !== over.tableId || active.axis !== over.axis || active.axisItemId === over.axisItemId) return;
    moveAxisOrder(active.tableId, active.axis, active.axisItemId, over.axisItemId);
  }

  function handleDragCancel() {
    setActiveSortableId(null);
  }

  if (!activeSheet) {
    return (
      <section className="board-overview" aria-label="보드">
        <p className="board-empty">보드 데이터를 준비하는 중입니다.</p>
      </section>
    );
  }

  const activeTables = tables
    .filter((table) => table.sheet_id === activeSheet.id)
    .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name));

  const boardCanvas = (
    <div className="board-canvas" style={getBoardCanvasStyle(activeTables)}>
      {activeTables.length === 0 ? <p className="board-empty">이 시트에는 아직 표가 없습니다.</p> : null}
      {activeTables.length > 0 ? (
        <div className="board-canvas-space">
          {activeTables.map((table) => (
            <article key={table.id} className="board-table-summary" style={getBoardTableStyle(table)}>
              <div className="board-table-heading">
                <button
                  className="board-table-drag-button"
                  type="button"
                  aria-label={`${table.name} 표 이동`}
                  disabled={isReorderMode}
                  title="표 이동"
                  onPointerCancel={handleTableLayoutPointerEnd}
                  onPointerDown={(event) => handleTableLayoutPointerDown(table, "move", event)}
                  onPointerMove={handleTableLayoutPointerMove}
                  onPointerUp={handleTableLayoutPointerEnd}
                >
                  <Move aria-hidden="true" size={16} />
                </button>
                <div className="board-table-title">
                  <strong>{table.name}</strong>
                  <span>{tableOrientationLabel(table)}</span>
                </div>
                <button
                  className="board-table-transpose-button"
                  type="button"
                  aria-label={`${table.name} 행/열 전환 미리보기`}
                  disabled={isReorderMode}
                  onClick={() => {
                    setTransposeError(null);
                    setTransposingTable(table);
                  }}
                >
                  <ArrowLeftRight aria-hidden="true" size={14} />
                  행/열 전환
                </button>
              </div>
              <div className="board-table-metrics">
                <span>행 {axisCount(axisItems, table.id, "row")}</span>
                <span>열 {axisCount(axisItems, table.id, "column")}</span>
                <span>행 높이 {table.default_row_height}px</span>
                <span>열 너비 {table.default_column_width}px</span>
              </div>
              <BoardTableLayoutControls table={table} onChange={handleTableLayoutChange} />
              <div className="board-axis-create-row">
                {(["row", "column"] as const).map((axis) => {
                  const key = axisDraftKey(table.id, axis);
                  return (
                    <form
                      key={axis}
                      className="board-create-form board-axis-create-form"
                      aria-label={`${table.name} ${axisLabels[axis]} 추가`}
                      onSubmit={(event) => handleCreateAxisItem(event, table, axis)}
                    >
                      <input
                        aria-label={`${table.name} ${axisLabels[axis]} 이름`}
                        maxLength={30}
                        placeholder={`${axisLabels[axis]} 이름`}
                        value={axisDrafts[key] ?? ""}
                        onChange={(event) => handleAxisDraftChange(table.id, axis, event.currentTarget.value)}
                      />
                      <button disabled={pendingAxisKey === key} type="submit">
                        {axisLabels[axis]} 추가
                      </button>
                    </form>
                  );
                })}
              </div>
              <BoardTableGrid
                axisItems={axisItems}
                cellStates={cellStates}
                completions={completions}
                isCellVisibilityMode={isCellVisibilityMode}
                isReorderMode={isReorderMode}
                table={table}
                onAxisSizeChange={handleAxisSizeChange}
                onAxisItemEdit={setEditingAxisItem}
                onCellVisibilityToggle={handleCellVisibilityToggle}
                onToggle={handleCompletionToggle}
              />
              <button
                className="board-table-resize-handle"
                type="button"
                aria-label={`${table.name} 표 크기 조절`}
                disabled={isReorderMode}
                title="표 크기 조절"
                onPointerCancel={handleTableLayoutPointerEnd}
                onPointerDown={(event) => handleTableLayoutPointerDown(table, "resize", event)}
                onPointerMove={handleTableLayoutPointerMove}
                onPointerUp={handleTableLayoutPointerEnd}
              >
                <Maximize2 aria-hidden="true" size={14} />
              </button>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <section className="board-overview" aria-label="보드">
      <div className="sheet-tab-bar" aria-label="시트">
        <span className="sheet-tab-label">시트</span>
        {sortedSheets.map((sheet) => (
          <button
            key={sheet.id}
            type="button"
            className={`sheet-tab${sheet.id === activeSheet.id ? " active" : ""}`}
            aria-current={sheet.id === activeSheet.id ? "page" : undefined}
            onClick={() => setActiveSheetId(sheet.id)}
          >
            {sheet.name}
          </button>
        ))}
        <form className="board-create-form" aria-label="시트 추가" onSubmit={handleCreateSheet}>
          <input
            aria-label="새 시트 이름"
            maxLength={30}
            placeholder="새 시트"
            value={sheetName}
            onChange={(event) => setSheetName(event.currentTarget.value)}
          />
          <button disabled={pendingAction === "sheet"} type="submit">
            시트 추가
          </button>
        </form>
      </div>
      <div className="board-toolbar">
        <button
          className={`button board-reorder-button${isReorderMode ? " active" : ""}`}
          type="button"
          onClick={() => {
            setActiveSortableId(null);
            setIsCellVisibilityMode(false);
            setIsReorderMode((current) => !current);
          }}
        >
          {isReorderMode ? "순서 변경 완료" : "순서 변경"}
        </button>
        <button
          className={`button board-visibility-button${isCellVisibilityMode ? " active" : ""}`}
          type="button"
          onClick={() => {
            setActiveSortableId(null);
            setIsReorderMode(false);
            setIsCellVisibilityMode((current) => !current);
          }}
        >
          {isCellVisibilityMode ? "표시 편집 완료" : "표시 편집"}
        </button>
        <form className="board-create-form" aria-label="표 추가" onSubmit={handleCreateTable}>
          <input
            aria-label="새 표 이름"
            maxLength={30}
            placeholder="새 표"
            value={tableName}
            onChange={(event) => setTableName(event.currentTarget.value)}
          />
          <select
            aria-label="새 표 구조"
            value={tableOrientation}
            onChange={(event) => setTableOrientation(event.currentTarget.value as BoardOrientation)}
          >
            <option value="custom">사용자 표</option>
            <option value="tasks_rows">숙제 행</option>
            <option value="tasks_columns">숙제 열</option>
          </select>
          <button disabled={pendingAction === "table" || !activeSheet} type="submit">
            표 추가
          </button>
        </form>
        {formError ? <p className="board-form-error">{formError}</p> : null}
      </div>
      {isReorderMode ? (
        <DndContext
          collisionDetection={closestCenter}
          sensors={sensors}
          onDragCancel={handleDragCancel}
          onDragEnd={handleDragEnd}
          onDragStart={handleDragStart}
        >
          {boardCanvas}
          <DragOverlay>{renderBoardDragOverlay(activeSortableId, axisItems)}</DragOverlay>
        </DndContext>
      ) : (
        boardCanvas
      )}
      {editingAxisItem ? (
        <BoardAxisItemEditModal
          item={editingAxisItem}
          onClose={() => setEditingAxisItem(null)}
          onDelete={handleAxisItemDelete}
          onSave={handleAxisItemSave}
        />
      ) : null}
      {transposingTable ? (
        <BoardTableTransposeModal
          error={transposeError}
          isPending={pendingTransposeTableId === transposingTable.id}
          table={transposingTable}
          onClose={() => setTransposingTable(null)}
          onConfirm={handleTableTranspose}
        />
      ) : null}
    </section>
  );
}

function BoardTableTransposeModal({
  error,
  isPending,
  onClose,
  onConfirm,
  table
}: {
  error: string | null;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (tableId: string) => Promise<void>;
  table: BoardTable;
}) {
  const transposedTable = getTransposedTable(table);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="tool-modal edit-modal" aria-modal="true" role="dialog" aria-label="행/열 전환 미리보기">
        <header className="tool-modal-header">
          <h2>행/열 전환</h2>
          <button className="modal-close-button" type="button" aria-label="닫기" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="tool-modal-body edit-form">
          <div className="transpose-preview">
            <div>
              <span>현재</span>
              <strong>{tableOrientationLabel(table)}</strong>
            </div>
            <ArrowLeftRight aria-hidden="true" size={18} />
            <div>
              <span>전환 후</span>
              <strong>{tableOrientationLabel(transposedTable)}</strong>
            </div>
          </div>
          <p className="compact-notice">
            행/열 항목과 체크 상태, 숨김 상태를 함께 전환합니다. 같은 숙제/캐릭터 조합의 데이터는 유지됩니다.
          </p>
          {error ? <p className="error-text">{error}</p> : null}
          <div className="edit-actions">
            <button disabled={isPending} type="button" onClick={onClose}>
              취소
            </button>
            <button className="primary-button" disabled={isPending} type="button" onClick={() => void onConfirm(table.id)}>
              <ArrowLeftRight aria-hidden="true" size={16} />
              전환 적용
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function BoardTableLayoutControls({
  onChange,
  table
}: {
  onChange: (tableId: string, patch: BoardTableLayoutPatch) => void;
  table: BoardTable;
}) {
  function updateLayout(next: Partial<BoardTableLayoutPatch>) {
    onChange(table.id, {
      x: table.x,
      y: table.y,
      width: table.width,
      height: table.height,
      ...next
    });
  }

  return (
    <div className="board-table-layout-row" aria-label={`${table.name} 위치와 크기`}>
      <TableLayoutInput
        label={`${table.name} X 위치`}
        max={10000}
        min={0}
        nullable={false}
        shortLabel="X"
        value={table.x}
        onChange={(value) => {
          if (value !== null) updateLayout({ x: value });
        }}
      />
      <TableLayoutInput
        label={`${table.name} Y 위치`}
        max={10000}
        min={0}
        nullable={false}
        shortLabel="Y"
        value={table.y}
        onChange={(value) => {
          if (value !== null) updateLayout({ y: value });
        }}
      />
      <TableLayoutInput
        label={`${table.name} 너비`}
        max={4000}
        min={160}
        nullable={true}
        shortLabel="W"
        value={table.width}
        onChange={(value) => updateLayout({ width: value })}
      />
      <TableLayoutInput
        label={`${table.name} 높이`}
        max={4000}
        min={120}
        nullable={true}
        shortLabel="H"
        value={table.height}
        onChange={(value) => updateLayout({ height: value })}
      />
    </div>
  );
}

function TableLayoutInput({
  label,
  max,
  min,
  nullable,
  onChange,
  shortLabel,
  value
}: {
  label: string;
  max: number;
  min: number;
  nullable: boolean;
  onChange: (value: number | null) => void;
  shortLabel: string;
  value: number | null;
}) {
  const [draftValue, setDraftValue] = useState(value === null ? "" : String(value));

  useEffect(() => {
    setDraftValue(value === null ? "" : String(value));
  }, [value]);

  function commitDraftValue() {
    const nextValue = normalizeBoardTableLayoutNumber(draftValue, {
      min,
      max,
      nullable
    });
    setDraftValue(nextValue === null ? "" : String(nextValue));
    if (nextValue !== value) {
      onChange(nextValue);
    }
  }

  return (
    <label className="board-table-layout-field">
      <span>{shortLabel}</span>
      <input
        aria-label={label}
        max={max}
        min={min}
        placeholder={nullable ? "auto" : undefined}
        type="number"
        value={draftValue}
        onBlur={commitDraftValue}
        onChange={(event) => setDraftValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

function BoardTableGrid({
  axisItems,
  cellStates,
  completions,
  isCellVisibilityMode,
  isReorderMode,
  table,
  onAxisSizeChange,
  onAxisItemEdit,
  onCellVisibilityToggle,
  onToggle
}: {
  axisItems: BoardAxisItem[];
  cellStates: BoardPayload["cellStates"];
  completions: BoardPayload["completions"];
  isCellVisibilityMode: boolean;
  isReorderMode: boolean;
  table: BoardTable;
  onAxisSizeChange: (axisItemId: string, sizePx: number) => void;
  onAxisItemEdit: (item: BoardAxisItem) => void;
  onCellVisibilityToggle: (patch: BoardCellStatePatch) => void;
  onToggle: (patch: BoardCompletionPatch) => void;
}) {
  const rows = axisItems
    .filter((item) => item.table_id === table.id && item.axis === "row" && item.visible === 1)
    .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label));
  const columns = axisItems
    .filter((item) => item.table_id === table.id && item.axis === "column" && item.visible === 1)
    .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label));
  const hiddenCells = new Set(
    cellStates
      .filter((cell) => cell.table_id === table.id && cell.checkbox_visible === 0)
      .map((cell) => cellKey(cell.row_item_id, cell.column_item_id))
  );
  const completedCells = new Set(
    completions
      .filter((completion) => completion.table_id === table.id && completion.completed === 1)
      .map((completion) => cellKey(completion.row_item_id, completion.column_item_id))
  );

  if (rows.length === 0 || columns.length === 0) {
    return <p className="board-empty">이 표에는 아직 행 또는 열이 없습니다.</p>;
  }

  return (
    <div className="board-check-grid" style={{ gridTemplateColumns: buildGridColumns(table, columns) }}>
      <div className="board-axis-corner" />
      <SortableContext
        items={columns.map((column) => getBoardAxisSortableId(table.id, "column", column.id))}
        strategy={horizontalListSortingStrategy}
      >
        {columns.map((column) => (
          <BoardColumnHeader
            key={column.id}
            column={column}
            isReorderMode={isReorderMode}
            onAxisItemEdit={onAxisItemEdit}
            onAxisSizeChange={onAxisSizeChange}
            table={table}
          />
        ))}
      </SortableContext>
      <SortableContext
        items={rows.map((row) => getBoardAxisSortableId(table.id, "row", row.id))}
        strategy={verticalListSortingStrategy}
      >
        {rows.map((row) => (
          <BoardGridRow
            key={row.id}
            columns={columns}
            completedCells={completedCells}
            hiddenCells={hiddenCells}
            isCellVisibilityMode={isCellVisibilityMode}
            isReorderMode={isReorderMode}
            onAxisItemEdit={onAxisItemEdit}
            onCellVisibilityToggle={onCellVisibilityToggle}
            onToggle={onToggle}
            onAxisSizeChange={onAxisSizeChange}
            row={row}
            rowHeight={row.size_px ?? table.default_row_height}
            tableId={table.id}
          />
        ))}
      </SortableContext>
    </div>
  );
}

function BoardColumnHeader({
  column,
  isReorderMode,
  onAxisItemEdit,
  onAxisSizeChange,
  table
}: {
  column: BoardAxisItem;
  isReorderMode: boolean;
  onAxisItemEdit: (item: BoardAxisItem) => void;
  onAxisSizeChange: (axisItemId: string, sizePx: number) => void;
  table: BoardTable;
}) {
  const columnSeparator = getSeparatorBorder(column);

  return (
    <BoardAxisLabel
      className="board-axis-label board-column-label"
      isReorderMode={isReorderMode}
      item={column}
      onEdit={() => onAxisItemEdit(column)}
      style={columnSeparator ? { borderRight: columnSeparator } : undefined}
      tableId={table.id}
    >
      <BoardAxisLabelText item={column} />
      {!isReorderMode ? (
        <AxisSizeInput
          label={`${column.label} 열 너비`}
          value={column.size_px ?? table.default_column_width}
          onChange={(sizePx) => onAxisSizeChange(column.id, sizePx)}
        />
      ) : null}
    </BoardAxisLabel>
  );
}

function BoardAxisLabelText({ item }: { item: BoardAxisItem }) {
  return (
    <span className="board-axis-label-text">
      {item.kind === "task" && item.task_color ? (
        <span
          aria-label={`${item.label} 색상 ${item.task_color}`}
          className="board-task-color-swatch"
          style={{ background: item.task_color }}
        />
      ) : null}
      <span>{item.label}</span>
    </span>
  );
}

function BoardAxisLabel({
  children,
  className,
  isReorderMode,
  item,
  onEdit,
  style,
  tableId
}: {
  children: ReactNode;
  className: string;
  isReorderMode: boolean;
  item: BoardAxisItem;
  onEdit?: () => void;
  style?: CSSProperties | undefined;
  tableId: string;
}) {
  if (!isReorderMode) {
    if (onEdit) {
      return (
        <button className={`${className} board-axis-edit-button`} style={style} type="button" aria-label={`${item.label} 편집`} onClick={onEdit}>
          {children}
        </button>
      );
    }
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }

  return (
    <SortableBoardAxisLabel className={className} item={item} style={style} tableId={tableId}>
      {children}
    </SortableBoardAxisLabel>
  );
}

function SortableBoardAxisLabel({
  children,
  className,
  item,
  style,
  tableId
}: {
  children: ReactNode;
  className: string;
  item: BoardAxisItem;
  style?: CSSProperties | undefined;
  tableId: string;
}) {
  const sortableId = getBoardAxisSortableId(tableId, item.axis, item.id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sortableId });
  const sortableStyle: CSSProperties = {
    ...style,
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div
      className={`${className} board-sortable-axis-label${isDragging ? " dragging" : ""}`}
      ref={setNodeRef}
      style={sortableStyle}
      {...attributes}
      {...listeners}
      aria-label={`${item.label} 순서 이동`}
      data-board-axis-id={item.id}
      data-board-axis={item.axis}
    >
      {children}
    </div>
  );
}

function BoardGridRow({
  columns,
  completedCells,
  hiddenCells,
  isCellVisibilityMode,
  isReorderMode,
  onAxisItemEdit,
  onCellVisibilityToggle,
  onAxisSizeChange,
  onToggle,
  row,
  rowHeight,
  tableId
}: {
  columns: BoardAxisItem[];
  completedCells: Set<string>;
  hiddenCells: Set<string>;
  isCellVisibilityMode: boolean;
  isReorderMode: boolean;
  onAxisItemEdit: (item: BoardAxisItem) => void;
  onCellVisibilityToggle: (patch: BoardCellStatePatch) => void;
  onAxisSizeChange: (axisItemId: string, sizePx: number) => void;
  onToggle: (patch: BoardCompletionPatch) => void;
  row: BoardAxisItem;
  rowHeight: number;
  tableId: string;
}) {
  const rowSeparator = getSeparatorBorder(row);

  return (
    <>
      <BoardAxisLabel
        className="board-axis-label board-row-label"
        isReorderMode={isReorderMode}
        item={row}
        onEdit={() => onAxisItemEdit(row)}
        style={{ minHeight: `${rowHeight}px`, ...(rowSeparator ? { borderBottom: rowSeparator } : {}) }}
        tableId={tableId}
      >
        <BoardAxisLabelText item={row} />
        {!isReorderMode ? (
          <AxisSizeInput
            label={`${row.label} 행 높이`}
            value={row.size_px ?? rowHeight}
            onChange={(sizePx) => onAxisSizeChange(row.id, sizePx)}
          />
        ) : null}
      </BoardAxisLabel>
      {columns.map((column) => {
        const key = cellKey(row.id, column.id);
        const taskColor = getTaskColor(row, column);
        const colorStyle = taskColor ? ({ "--task-color": taskColor } as CSSProperties) : undefined;
        const columnSeparator = getSeparatorBorder(column);
        const periodKey = getBoardCellPeriodKey(row, column);
        const isHidden = hiddenCells.has(key);
        const nextVisible = isHidden;
        const cellStyle: CSSProperties = {
          minHeight: `${rowHeight}px`,
          ...(rowSeparator ? { borderBottom: rowSeparator } : {}),
          ...(columnSeparator ? { borderRight: columnSeparator } : {})
        };

        return (
          <div key={column.id} className="board-check-cell" style={cellStyle}>
            {isCellVisibilityMode ? (
              <button
                aria-label={`${row.label} / ${column.label} 표시 전환`}
                className={`board-cell-visibility-toggle${isHidden ? " hidden" : ""}`}
                type="button"
                onClick={() =>
                  onCellVisibilityToggle({
                    tableId,
                    rowItemId: row.id,
                    columnItemId: column.id,
                    checkboxVisible: nextVisible
                  })
                }
              >
                {isHidden ? <EyeOff aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}
              </button>
            ) : isHidden ? (
              <span className="board-check-placeholder" aria-label={`${row.label} / ${column.label} 숨김`} />
            ) : (
              <input
                aria-label={`${row.label} / ${column.label}`}
                checked={completedCells.has(key)}
                className="board-check"
                disabled={!periodKey}
                onChange={(event) => {
                  if (!periodKey) return;
                  onToggle({
                    tableId,
                    rowItemId: row.id,
                    columnItemId: column.id,
                    periodKey,
                    completed: event.currentTarget.checked
                  });
                }}
                style={colorStyle}
                type="checkbox"
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function renderBoardDragOverlay(activeSortableId: string | null, axisItems: BoardAxisItem[]) {
  if (!activeSortableId) return null;
  const active = parseBoardAxisSortableId(activeSortableId);
  if (!active) return null;
  const item = axisItems.find((axisItem) => axisItem.id === active.axisItemId);
  if (!item) return null;
  return <div className="board-drag-overlay">{item.label}</div>;
}

function BoardAxisItemEditModal({
  item,
  onClose,
  onDelete,
  onSave
}: {
  item: BoardAxisItem;
  onClose: () => void;
  onDelete: (axisItemId: string) => Promise<void>;
  onSave: (axisItemId: string, label: string, taskColor?: string | null, separator?: BoardAxisSeparator | null) => Promise<void>;
}) {
  const initialSeparator = parseBoardAxisSeparator(item.separator_json);
  const [label, setLabel] = useState(item.label);
  const [taskColor, setTaskColor] = useState(item.task_color ?? "#2563eb");
  const [separatorEnabled, setSeparatorEnabled] = useState(initialSeparator !== null);
  const [separatorWidthPx, setSeparatorWidthPx] = useState(initialSeparator?.widthPx ?? 2);
  const [separatorStyle, setSeparatorStyle] = useState<BoardAxisSeparator["style"]>(initialSeparator?.style ?? "solid");
  const [separatorColor, setSeparatorColor] = useState(initialSeparator?.color ?? "#64748b");
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const normalizedLabel = label.trim();
  const isTaskItem = item.kind === "task";
  const separator = separatorEnabled
    ? {
        widthPx: Math.min(8, Math.max(1, Math.round(separatorWidthPx))),
        style: separatorStyle,
        color: separatorColor
      }
    : null;

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedLabel) return;

    setPending("save");
    setError(null);
    try {
      await onSave(item.id, normalizedLabel, isTaskItem ? taskColor : undefined, separator);
    } catch (err) {
      setError(err instanceof Error ? err.message : "항목을 저장하지 못했습니다.");
      setPending(null);
    }
  }

  async function handleDelete() {
    setPending("delete");
    setError(null);
    try {
      await onDelete(item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "항목을 삭제하지 못했습니다.");
      setPending(null);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="tool-modal edit-modal" aria-modal="true" role="dialog" aria-label="행 또는 열 수정">
        <header className="tool-modal-header">
          <h2>항목 수정</h2>
          <button className="modal-close-button" type="button" aria-label="닫기" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <form className="tool-modal-body edit-form" onSubmit={handleSave}>
          <label>
            이름
            <input maxLength={30} value={label} onChange={(event) => setLabel(event.currentTarget.value)} />
          </label>
          {isTaskItem ? (
            <label>
              체크 색상
              <span className="color-edit-row">
                <input
                  aria-label={`${item.label} 체크 색상`}
                  className="color-edit-input"
                  type="color"
                  value={taskColor}
                  onChange={(event) => setTaskColor(event.currentTarget.value)}
                />
                <span>{taskColor}</span>
              </span>
            </label>
          ) : null}
          <fieldset className="visibility-fieldset">
            <legend>구분선</legend>
            <label className="toggle-row">
              <input
                checked={separatorEnabled}
                type="checkbox"
                onChange={(event) => setSeparatorEnabled(event.currentTarget.checked)}
              />
              이 항목 뒤에 구분선 표시
            </label>
            {separatorEnabled ? (
              <div className="separator-edit-grid">
                <label>
                  두께
                  <input
                    max={8}
                    min={1}
                    type="number"
                    value={separatorWidthPx}
                    onChange={(event) => setSeparatorWidthPx(Number(event.currentTarget.value))}
                  />
                </label>
                <label>
                  종류
                  <select
                    value={separatorStyle}
                    onChange={(event) => setSeparatorStyle(event.currentTarget.value as BoardAxisSeparator["style"])}
                  >
                    <option value="solid">실선</option>
                    <option value="dashed">파선</option>
                    <option value="dotted">점선</option>
                  </select>
                </label>
                <label>
                  색상
                  <input
                    aria-label={`${item.label} 구분선 색상`}
                    className="color-edit-input"
                    type="color"
                    value={separatorColor}
                    onChange={(event) => setSeparatorColor(event.currentTarget.value)}
                  />
                </label>
              </div>
            ) : null}
          </fieldset>
          {error ? <p className="error-text">{error}</p> : null}
          <div className="edit-actions">
            <button className="danger-button" disabled={pending !== null} type="button" onClick={() => void handleDelete()}>
              <Trash2 aria-hidden="true" size={16} />
              항목 삭제
            </button>
            <button className="primary-button" disabled={pending !== null || !normalizedLabel} type="submit">
              <Save aria-hidden="true" size={16} />
              저장
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function AxisSizeInput({
  label,
  onChange,
  value
}: {
  label: string;
  onChange: (sizePx: number) => void;
  value: number;
}) {
  return (
    <input
      aria-label={label}
      className="board-size-input"
      max={1024}
      min={16}
      type="number"
      value={value}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
    />
  );
}
