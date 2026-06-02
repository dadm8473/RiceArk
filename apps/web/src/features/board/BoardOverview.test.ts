import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  applyBoardTableSettingsToAxisItems,
  BoardAxisItemEditModal,
  BoardDisplayOptions,
  BoardOverview,
  BoardSheetSettingsModal,
  getMixedBoardDisplaySettingKeys,
  shouldSaveBoardCharacterDetails
} from "./BoardOverview";
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
      default_column_width: 132,
      locked: 0
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

    expect(html).toContain('aria-label="시트 설정"');
    expect(html).toContain("표 추가");
    expect(html).not.toContain('aria-label="새 시트 이름"');
    expect(html).not.toContain('aria-label="새 표 이름"');
    expect(html).not.toContain('aria-label="새 표 구조"');
  });

  it("renders sheet creation and deletion inside sheet settings", () => {
    const html = renderToStaticMarkup(
      createElement(BoardSheetSettingsModal, {
        activeSheetId: "sheet-1",
        isPending: false,
        sheets: [
          ...board.sheets,
          { id: "sheet-2", name: "부캐", sort_order: 10, is_default: 0 }
        ],
        onClose: () => undefined,
        onCreate: async () => undefined,
        onDelete: async () => undefined
      })
    );

    expect(html).toContain("시트 설정");
    expect(html).toContain('aria-label="새 시트 이름"');
    expect(html).toContain("시트 추가");
    expect(html).toContain('aria-label="삭제할 시트"');
    expect(html).toContain("부캐");
    expect(html).toContain("시트 삭제");
  });

  it("renders table-scoped character and task action buttons beside the table title", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain('aria-label="숙제 캐릭터 추가 또는 가져오기"');
    expect(html).toContain('aria-label="숙제 숙제 추가"');
    expect(html).toContain('aria-label="숙제 표 잠금"');
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

  it("keeps only checkbox toggles interactive on locked tables", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          tables: board.tables.map((table) => ({ ...table, locked: 1 }))
        }
      })
    );

    expect(html).toContain("잠김");
    expect(html).toContain('aria-label="숙제 표 잠금 해제"');
    expect(html).not.toContain('aria-label="숙제 표 이동"');
    expect(html).toMatch(/disabled=""[^>]+aria-label="숙제 캐릭터 추가 또는 가져오기"|aria-label="숙제 캐릭터 추가 또는 가져오기"[^>]+disabled=""/);
    expect(html).toMatch(/disabled=""[^>]+aria-label="숙제 숙제 추가"|aria-label="숙제 숙제 추가"[^>]+disabled=""/);
    expect(html).not.toContain('aria-label="냠수나이스1 편집"');
    expect(html).not.toContain('aria-label="쿠르잔 전선 편집"');
    expect(html).toContain('aria-label="쿠르잔 전선 / 냠수나이스1"');
    expect(html).not.toContain('aria-label="쿠르잔 전선 / 냠수나이스1" class="board-check" disabled');
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

  it("keeps imported character columns visible before task rows exist", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: [board.axisItems[1]!]
        }
      })
    );

    expect(html).toContain("냠수나이스1");
    expect(html).toContain("행이 없습니다.");
    expect(html).not.toContain("이 표에는 아직 행 또는 열이 없습니다.");
  });

  it("keeps task rows visible before character columns exist", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: [board.axisItems[0]!]
        }
      })
    );

    expect(html).toContain("쿠르잔 전선");
    expect(html).toContain("열이 없습니다.");
    expect(html).not.toContain("이 표에는 아직 행 또는 열이 없습니다.");
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

  it("lets task columns edit their column width from item settings", () => {
    const taskColumn = {
      ...board.axisItems[0]!,
      axis: "column" as const,
      size_px: 96
    };
    const html = renderToStaticMarkup(
      createElement(BoardAxisItemEditModal, {
        item: taskColumn,
        settings: board.settings,
        table: { ...board.tables[0]!, row_role: "character", column_role: "task", task_axis: "columns" },
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onCharacterSave: async () => undefined
      })
    );

    expect(html).toContain("열 너비");
    expect(html).toContain('value="96"');
  });

  it("lets row and column items edit both height and width from item settings", () => {
    const rowHtml = renderToStaticMarkup(
      createElement(BoardAxisItemEditModal, {
        item: { ...board.axisItems[0]!, size_px: 44, cross_size_px: 180 },
        settings: board.settings,
        table: board.tables[0]!,
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onCharacterSave: async () => undefined
      })
    );
    const columnHtml = renderToStaticMarkup(
      createElement(BoardAxisItemEditModal, {
        item: { ...board.axisItems[1]!, size_px: 150, cross_size_px: 48 },
        settings: board.settings,
        table: board.tables[0]!,
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onCharacterSave: async () => undefined
      })
    );

    expect(rowHtml).toContain("행 높이");
    expect(rowHtml).toContain("행 너비");
    expect(rowHtml).toContain('value="44"');
    expect(rowHtml).toContain('value="180"');
    expect(columnHtml).toContain("열 높이");
    expect(columnHtml).toContain("열 너비");
    expect(columnHtml).toContain('value="48"');
    expect(columnHtml).toContain('value="150"');
  });

  it("applies row widths and column heights from axis item settings", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: board.axisItems.map((item) =>
            item.axis === "row" ? { ...item, cross_size_px: 220 } : { ...item, cross_size_px: 48 }
          )
        }
      })
    );

    expect(html).toContain("grid-template-columns:220px 132px");
    expect(html).toContain("min-height:48px");
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

  it("applies bulk table settings to character items even when size settings also apply", () => {
    const displaySettings: BoardPayload["settings"] = {
      show_display_name: 1,
      show_server_name: 1,
      show_class_name: 1,
      show_item_level: 1,
      show_combat_power: 1
    };
    const next = applyBoardTableSettingsToAxisItems(board.axisItems, "table-1", {
      defaultRowHeight: 52,
      defaultColumnWidth: 148,
      displaySettings,
      applyRowSize: true,
      applyColumnSize: true,
      characterSeparator: { widthPx: 4, style: "dashed", color: "#334455" }
    });

    const row = next.find((item) => item.id === "row-task-1");
    const character = next.find((item) => item.id === "column-character-1");

    expect(row?.size_px).toBe(52);
    expect(row?.separator_json).toBeUndefined();
    expect(character?.size_px).toBe(148);
    expect(JSON.parse(character?.separator_json ?? "{}")).toEqual({ widthPx: 4, style: "dashed", color: "#334455" });
    expect(JSON.parse(character?.display_options_json ?? "{}")).toEqual(displaySettings);
  });

  it("detects mixed display option values from character-specific overrides", () => {
    const table = {
      ...board.tables[0]!,
      display_options_json: JSON.stringify({
        show_display_name: 1,
        show_server_name: 0,
        show_class_name: 0,
        show_item_level: 1,
        show_combat_power: 0
      })
    };
    const mixedKeys = getMixedBoardDisplaySettingKeys(
      [
        board.axisItems[0]!,
        {
          ...board.axisItems[1]!,
          display_options_json: JSON.stringify({
            show_display_name: 1,
            show_server_name: 1,
            show_class_name: 0,
            show_item_level: 1,
            show_combat_power: 0
          })
        },
        {
          ...board.axisItems[1]!,
          id: "column-character-2",
          label: "냠수나이스2",
          display_options_json: null
        }
      ],
      table,
      board.settings
    );

    expect(mixedKeys.has("show_server_name")).toBe(true);
    expect(mixedKeys.has("show_item_level")).toBe(false);
  });

  it("renders mixed display options as indeterminate checkboxes", () => {
    const html = renderToStaticMarkup(
      createElement(BoardDisplayOptions, {
        settings: board.settings,
        mixedKeys: new Set<keyof BoardPayload["settings"]>(["show_server_name"]),
        onChange: () => undefined
      })
    );

    expect(html).toContain('aria-checked="mixed"');
  });
});
