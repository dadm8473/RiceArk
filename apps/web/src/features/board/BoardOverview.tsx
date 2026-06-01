import type { CSSProperties } from "react";
import type { BoardAxisItem, BoardAxisRole, BoardPayload, BoardTable } from "./types";

interface Props {
  board: BoardPayload;
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

export function BoardOverview({ board }: Props) {
  const activeSheet = board.sheets.find((sheet) => sheet.is_default === 1) ?? board.sheets[0];

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
        {board.sheets
          .slice()
          .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name))
          .map((sheet) => (
            <button
              key={sheet.id}
              type="button"
              className={`sheet-tab${sheet.id === activeSheet.id ? " active" : ""}`}
              aria-current={sheet.id === activeSheet.id ? "page" : undefined}
            >
              {sheet.name}
            </button>
          ))}
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
              <span>행 {axisCount(board.axisItems, table.id, "row")}</span>
              <span>열 {axisCount(board.axisItems, table.id, "column")}</span>
              <span>행 높이 {table.default_row_height}px</span>
              <span>열 너비 {table.default_column_width}px</span>
            </div>
            <BoardTableGrid board={board} table={table} />
          </article>
        ))}
      </div>
    </section>
  );
}

function BoardTableGrid({ board, table }: { board: BoardPayload; table: BoardTable }) {
  const rows = board.axisItems
    .filter((item) => item.table_id === table.id && item.axis === "row" && item.visible === 1)
    .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label));
  const columns = board.axisItems
    .filter((item) => item.table_id === table.id && item.axis === "column" && item.visible === 1)
    .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label));
  const hiddenCells = new Set(
    board.cellStates
      .filter((cell) => cell.table_id === table.id && cell.checkbox_visible === 0)
      .map((cell) => cellKey(cell.row_item_id, cell.column_item_id))
  );
  const completedCells = new Set(
    board.completions
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
          {column.label}
        </div>
      ))}
      {rows.map((row) => (
        <BoardGridRow
          key={row.id}
          columns={columns}
          completedCells={completedCells}
          hiddenCells={hiddenCells}
          row={row}
          rowHeight={row.size_px ?? table.default_row_height}
        />
      ))}
    </div>
  );
}

function BoardGridRow({
  columns,
  completedCells,
  hiddenCells,
  row,
  rowHeight
}: {
  columns: BoardAxisItem[];
  completedCells: Set<string>;
  hiddenCells: Set<string>;
  row: BoardAxisItem;
  rowHeight: number;
}) {
  return (
    <>
      <div className="board-axis-label board-row-label" style={{ minHeight: `${rowHeight}px` }}>
        {row.label}
      </div>
      {columns.map((column) => {
        const key = cellKey(row.id, column.id);
        const taskColor = getTaskColor(row, column);
        const colorStyle = taskColor ? ({ "--task-color": taskColor } as CSSProperties) : undefined;

        return (
          <div key={column.id} className="board-check-cell" style={{ minHeight: `${rowHeight}px` }}>
            {hiddenCells.has(key) ? (
              <span className="board-check-placeholder" aria-label={`${row.label} / ${column.label} 숨김`} />
            ) : (
              <input
                aria-label={`${row.label} / ${column.label}`}
                checked={completedCells.has(key)}
                className="board-check"
                readOnly
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
