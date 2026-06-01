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
          </article>
        ))}
      </div>
    </section>
  );
}
