import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardAxisItemEditModal, BoardOverview, shouldSaveBoardCharacterDetails } from "./BoardOverview";
import type { BoardAxisItem, BoardPayload } from "./types";

const board: BoardPayload = {
  userId: "user-1",
  settings: {
    show_display_name: 1,
    show_server_name: 0,
    show_class_name: 0,
    show_item_level: 1,
    show_combat_power: 0
  },
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
      task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
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
    expect(html).not.toContain("숙제 행 / 캐릭터 열");
    expect(html).not.toContain("행 1");
    expect(html).not.toContain("열 1");
    expect(html).not.toContain("행 높이 40px");
    expect(html).not.toContain("열 너비 132px");
  });

  it("renders sheet controls and opens table creation from a single button", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain('aria-label="새 시트 이름"');
    expect(html).toContain("시트 추가");
    expect(html).toContain("표 추가");
    expect(html).not.toContain('aria-label="새 표 이름"');
    expect(html).not.toContain('aria-label="새 표 구조"');
  });

  it("renders table-scoped character and task action buttons beside the table title", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain('aria-label="숙제 캐릭터 추가 또는 가져오기"');
    expect(html).toContain('aria-label="숙제 숙제 추가"');
    expect(html).toContain('aria-label="숙제 표 설정"');
    expect(html).not.toContain('aria-label="숙제 행 이름"');
    expect(html).not.toContain('aria-label="숙제 열 이름"');
    expect(html).not.toContain("순서 변경");
    expect(html).not.toContain("표시 편집");
    expect(html).not.toContain("표시 옵션");
  });

  it("renders editable axis labels outside reorder mode", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain('aria-label="쿠르잔 전선 편집"');
    expect(html).toContain('aria-label="냠수나이스1 편집"');
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

  it("renders task color swatches on task axis labels", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain('aria-label="쿠르잔 전선 색상 #2563eb"');
    expect(html).toContain("background:#2563eb");
  });

  it("renders character axis labels from board display settings", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          settings: {
            show_display_name: 1,
            show_server_name: 1,
            show_class_name: 1,
            show_item_level: 1,
            show_combat_power: 1
          },
          axisItems: board.axisItems.map((item) =>
            item.kind === "character"
              ? {
                  ...item,
                  character_display_name: "냠1",
                  character_server_name: "아만",
                  character_class_name: "브레이커",
                  character_item_level: "1,780.00",
                  character_combat_power: "2,500"
                }
              : item
          )
        }
      })
    );

    expect(html).toContain("냠1");
    expect(html).toContain("아만 · 브레이커 · 1,780.00 · 2,500");
    expect(html).toContain("아만 / 냠수나이스1 / 브레이커 / 1,780.00 / 2,500");
  });

  it("renders custom row and column separators from axis settings", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: board.axisItems.map((item) =>
            item.axis === "row"
              ? { ...item, separator_json: '{"widthPx":3,"style":"dashed","color":"#334455"}' }
              : { ...item, separator_json: '{"widthPx":2,"style":"dotted","color":"#be123c"}' }
          )
        }
      })
    );

    expect(html).toContain("border-bottom:3px dashed #334455");
    expect(html).toContain("border-right:2px dotted #be123c");
  });

  it("keeps row and column size controls out of the table surface", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: board.axisItems.map((item) =>
            item.axis === "row" ? { ...item, size_px: 44 } : { ...item, size_px: 150 }
          )
        }
      })
    );

    expect(html).not.toContain('aria-label="쿠르잔 전선 행 높이"');
    expect(html).not.toContain('aria-label="냠수나이스1 열 너비"');
  });

  it("does not render direct table layout controls", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          tables: board.tables.map((table) => ({ ...table, x: 18, y: 24, width: 420, height: 260 }))
        }
      })
    );

    expect(html).not.toContain('aria-label="숙제 X 위치"');
    expect(html).not.toContain('aria-label="숙제 Y 위치"');
    expect(html).not.toContain('aria-label="숙제 너비"');
    expect(html).not.toContain('aria-label="숙제 높이"');
  });

  it("renders table movement without direct resize handles", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain('aria-label="숙제 표 이동"');
    expect(html).not.toContain('aria-label="숙제 표 크기 조절"');
  });

  it("uses table settings instead of a direct transpose control", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain('aria-label="숙제 표 설정"');
    expect(html).not.toContain('aria-label="숙제 행/열 전환 미리보기"');
    expect(html).not.toContain("행/열 전환");
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
    expect(html).not.toContain('aria-label="쿠르잔 전선 / 냠수나이스1" class="board-check"');
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

  it("sizes the board canvas to include all visible rows", () => {
    const manyRows: BoardAxisItem[] = Array.from({ length: 8 }, (_, index) => ({
      ...board.axisItems[0]!,
      id: `row-task-${index + 1}`,
      label: `숙제 ${index + 1}`,
      sort_order: index * 10,
      size_px: 40
    }));
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: [...manyRows, board.axisItems[1]!]
        }
      })
    );

    expect(html).toContain("--board-canvas-height:416px");
  });

  it("renders imported character identity as read-only while editing mutable details", () => {
    const characterItem = {
      ...board.axisItems[1]!,
      character_display_name: "냠1",
      character_server_name: "아만",
      character_class_name: "브레이커",
      character_item_level: "1,778.33",
      character_combat_power: "2,549.41"
    };
    const html = renderToStaticMarkup(
      createElement(BoardAxisItemEditModal, {
        item: characterItem,
        settings: board.settings,
        table: board.tables[0]!,
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onCharacterSave: async () => undefined
      })
    );

    expect(html).not.toContain("캐릭터 정보");
    expect(html).toContain("서버 아만");
    expect(html).toContain("닉네임 냠수나이스1");
    expect(html).toContain("직업 브레이커");
    expect(html).toContain("축약 이름");
    expect(html).toContain('value="냠1"');
    expect(html).toContain('value="1,778.33"');
    expect(html).toContain('value="2,549.41"');
    expect(html).not.toContain('value="아만"');
    expect(html).not.toContain('value="브레이커"');
  });

  it("does not save character details when only display options change", () => {
    const characterItem = {
      ...board.axisItems[1]!,
      character_display_name: "냠1",
      character_item_level: "1,778.33",
      character_combat_power: "2,549.41"
    };

    expect(shouldSaveBoardCharacterDetails(characterItem, "냠1", "1,778.33", "2,549.41")).toBe(false);
    expect(shouldSaveBoardCharacterDetails(characterItem, "냠2", "1,778.33", "2,549.41")).toBe(true);
    expect(shouldSaveBoardCharacterDetails(characterItem, "냠1", "1,779.00", "2,549.41")).toBe(true);
  });
});
