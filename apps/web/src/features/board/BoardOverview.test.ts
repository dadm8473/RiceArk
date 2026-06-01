import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardOverview } from "./BoardOverview";
import type { BoardPayload } from "./types";

const board: BoardPayload = {
  userId: "user-1",
  sheets: [
    {
      id: "sheet-1",
      name: "기본",
      sort_order: 0,
      is_default: 1
    }
  ],
  tables: [
    {
      id: "table-1",
      sheet_id: "sheet-1",
      name: "숙제",
      sort_order: 0,
      x: 0,
      y: 0,
      width: null,
      height: null,
      row_role: "task",
      column_role: "character",
      task_axis: "rows",
      default_row_height: 40,
      default_column_width: 132
    }
  ],
  axisItems: [
    {
      id: "row-task-1",
      table_id: "table-1",
      axis: "row",
      kind: "task",
      label: "쿠르잔 전선",
      character_id: null,
      task_id: "task-1",
      task_color: "#2563eb",
      size_px: null,
      sort_order: 0,
      visible: 1
    },
    {
      id: "column-character-1",
      table_id: "table-1",
      axis: "column",
      kind: "character",
      label: "냠수나이스1",
      character_id: "character-1",
      task_id: null,
      task_color: null,
      size_px: null,
      sort_order: 0,
      visible: 1
    }
  ],
  cellStates: [],
  completions: []
};

describe("BoardOverview", () => {
  it("renders sheet tabs and content-sized table summaries from board payload", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain("시트");
    expect(html).toContain("기본");
    expect(html).toContain("숙제");
    expect(html).toContain("숙제 행 / 캐릭터 열");
    expect(html).toContain("행 1");
    expect(html).toContain("열 1");
    expect(html).toContain("40px");
    expect(html).toContain("132px");
  });

  it("renders compact checkbox cells from board axis and completion state", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          completions: [
            {
              table_id: "table-1",
              row_item_id: "row-task-1",
              column_item_id: "column-character-1",
              period_key: "daily:2026-06-01",
              completed: 1
            }
          ]
        }
      })
    );

    expect(html).toContain('class="board-check-grid"');
    expect(html).toContain("쿠르잔 전선");
    expect(html).toContain("냠수나이스1");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain("--task-color:#2563eb");
  });

  it("keeps hidden cells present for layout without rendering a checkbox", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          cellStates: [
            {
              table_id: "table-1",
              row_item_id: "row-task-1",
              column_item_id: "column-character-1",
              checkbox_visible: 0
            }
          ]
        }
      })
    );

    expect(html).toContain('class="board-check-placeholder"');
    expect(html).not.toContain('type="checkbox"');
  });

  it("does not render an empty board as a stretching spreadsheet", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          sheets: [],
          tables: [],
          axisItems: []
        }
      })
    );

    expect(html).toContain("보드 데이터를 준비하는 중입니다.");
    expect(html).not.toContain("width:100%");
  });
});
