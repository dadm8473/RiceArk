import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { apiPatch, apiPost } from "../../api/client";
import { applyBoardCompletionPatch, getBoardCellPeriodKey, type BoardCompletionPatch } from "./completions";
import type { BoardAxisItem, BoardAxisRole, BoardOrientation, BoardPayload, BoardTable } from "./types";
import { useBoardCompletionQueue } from "./useBoardCompletionQueue";

interface Props {
  board: BoardPayload;
  onBoardChanged?: () => Promise<BoardPayload> | void;
}

const roleLabels: Record<BoardAxisRole, string> = {
  character: "캐릭터",
  task: "숙제",
  custom: "사용자"
};

function tableOrientationLabel(table: BoardTable): string {
  return `${roleLabels[table.row_role]} 행 / ${roleLabels[table.column_role]} 열`;
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

function normalizeAxisSize(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.min(1024, Math.max(16, Math.round(value)));
}

export function BoardOverview({ board, onBoardChanged }: Props) {
  const { enqueue } = useBoardCompletionQueue();
  const [completions, setCompletions] = useState(board.completions);
  const [axisItems, setAxisItems] = useState(board.axisItems);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [tableName, setTableName] = useState("");
  const [tableOrientation, setTableOrientation] = useState<BoardOrientation>("custom");
  const [pendingAction, setPendingAction] = useState<"sheet" | "table" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const sortedSheets = useMemo(
    () => board.sheets.slice().sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name)),
    [board.sheets]
  );
  const activeSheet =
    sortedSheets.find((sheet) => sheet.id === activeSheetId) ??
    sortedSheets.find((sheet) => sheet.is_default === 1) ??
    sortedSheets[0];

  useEffect(() => {
    setCompletions(board.completions);
  }, [board.completions]);

  useEffect(() => {
    setAxisItems(board.axisItems);
  }, [board.axisItems]);

  function handleCompletionToggle(patch: BoardCompletionPatch) {
    setCompletions((current) => applyBoardCompletionPatch(current, patch));
    enqueue(patch);
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

  if (!activeSheet) {
    return (
      <section className="board-overview" aria-label="보드">
        <p className="board-empty">보드 데이터를 준비하는 중입니다.</p>
      </section>
    );
  }

  const tables = board.tables
    .filter((table) => table.sheet_id === activeSheet.id)
    .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name));

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
      <div className="board-canvas">
        {tables.length === 0 ? <p className="board-empty">이 시트에는 아직 표가 없습니다.</p> : null}
        {tables.map((table) => (
          <article key={table.id} className="board-table-summary">
            <div className="board-table-heading">
              <strong>{table.name}</strong>
              <span>{tableOrientationLabel(table)}</span>
            </div>
            <div className="board-table-metrics">
              <span>행 {axisCount(axisItems, table.id, "row")}</span>
              <span>열 {axisCount(axisItems, table.id, "column")}</span>
              <span>행 높이 {table.default_row_height}px</span>
              <span>열 너비 {table.default_column_width}px</span>
            </div>
            <BoardTableGrid
              axisItems={axisItems}
              board={board}
              completions={completions}
              table={table}
              onAxisSizeChange={handleAxisSizeChange}
              onToggle={handleCompletionToggle}
            />
          </article>
        ))}
      </div>
    </section>
  );
}

function BoardTableGrid({
  axisItems,
  board,
  completions,
  table,
  onAxisSizeChange,
  onToggle
}: {
  axisItems: BoardAxisItem[];
  board: BoardPayload;
  completions: BoardPayload["completions"];
  table: BoardTable;
  onAxisSizeChange: (axisItemId: string, sizePx: number) => void;
  onToggle: (patch: BoardCompletionPatch) => void;
}) {
  const rows = axisItems
    .filter((item) => item.table_id === table.id && item.axis === "row" && item.visible === 1)
    .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label));
  const columns = axisItems
    .filter((item) => item.table_id === table.id && item.axis === "column" && item.visible === 1)
    .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label));
  const hiddenCells = new Set(
    board.cellStates
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
      {columns.map((column) => (
        <div key={column.id} className="board-axis-label board-column-label">
          <span>{column.label}</span>
          <AxisSizeInput
            label={`${column.label} 열 너비`}
            value={column.size_px ?? table.default_column_width}
            onChange={(sizePx) => onAxisSizeChange(column.id, sizePx)}
          />
        </div>
      ))}
      {rows.map((row) => (
        <BoardGridRow
          key={row.id}
          columns={columns}
          completedCells={completedCells}
          hiddenCells={hiddenCells}
          onToggle={onToggle}
          onAxisSizeChange={onAxisSizeChange}
          row={row}
          rowHeight={row.size_px ?? table.default_row_height}
          tableId={table.id}
        />
      ))}
    </div>
  );
}

function BoardGridRow({
  columns,
  completedCells,
  hiddenCells,
  onAxisSizeChange,
  onToggle,
  row,
  rowHeight,
  tableId
}: {
  columns: BoardAxisItem[];
  completedCells: Set<string>;
  hiddenCells: Set<string>;
  onAxisSizeChange: (axisItemId: string, sizePx: number) => void;
  onToggle: (patch: BoardCompletionPatch) => void;
  row: BoardAxisItem;
  rowHeight: number;
  tableId: string;
}) {
  return (
    <>
      <div className="board-axis-label board-row-label" style={{ minHeight: `${rowHeight}px` }}>
        <span>{row.label}</span>
        <AxisSizeInput
          label={`${row.label} 행 높이`}
          value={row.size_px ?? rowHeight}
          onChange={(sizePx) => onAxisSizeChange(row.id, sizePx)}
        />
      </div>
      {columns.map((column) => {
        const key = cellKey(row.id, column.id);
        const taskColor = getTaskColor(row, column);
        const colorStyle = taskColor ? ({ "--task-color": taskColor } as CSSProperties) : undefined;
        const periodKey = getBoardCellPeriodKey(row, column);

        return (
          <div key={column.id} className="board-check-cell" style={{ minHeight: `${rowHeight}px` }}>
            {hiddenCells.has(key) ? (
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
