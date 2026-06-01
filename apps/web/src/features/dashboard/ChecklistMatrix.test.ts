import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CharacterEditModal, ChecklistMatrix, TaskEditModal } from "./ChecklistMatrix";
import type { DashboardPayload } from "./types";

function createDashboard(checklistOrientation: "tasks_rows" | "tasks_columns"): DashboardPayload {
  return {
    characters: [
      {
        id: "character-1",
        name: "냠수나이스1",
        display_name: "냠1",
        server_name: "루페온",
        class_name: "소서리스",
        item_level: "1,640.00",
        combat_power: "2,549.41"
      }
    ],
    tasks: [
      {
        id: "task-1",
        name: "쿠르잔 전선",
        scope: "character",
        reset_type: "daily",
        reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}'
      }
    ],
    completions: [],
    settings: {
      density: "default",
      row_height: 40,
      column_width: 132,
      checklist_orientation: checklistOrientation,
      show_display_name: 1,
      show_server_name: 0,
      show_class_name: 0,
      show_item_level: 1,
      show_combat_power: 0
    }
  };
}

describe("ChecklistMatrix", () => {
  it("uses optional character display names in the task-row orientation", () => {
    const html = renderToStaticMarkup(createElement(ChecklistMatrix, { dashboard: createDashboard("tasks_rows") }));

    expect(html.indexOf("숙제")).toBeLessThan(html.indexOf("냠1"));
    expect(html).toContain("냠1");
    expect(html).not.toContain(">냠수나이스1<");
    expect(html).not.toContain("원정대");
    expect(html).toContain("냠1 편집");
    expect(html).toContain("일간");
  });

  it("can render tasks as columns without changing character identity", () => {
    const html = renderToStaticMarkup(createElement(ChecklistMatrix, { dashboard: createDashboard("tasks_columns") }));

    expect(html.indexOf("캐릭터")).toBeLessThan(html.indexOf("쿠르잔 전선"));
    expect(html).toContain('title="루페온 / 냠수나이스1 / 소서리스 / 1,640.00 / 2,549.41"');
    expect(html).not.toContain("원정대");
    expect(html).toContain("쿠르잔 전선 편집");
  });

  it("renders reorder as an explicit mode instead of always-visible drag handles", () => {
    const html = renderToStaticMarkup(createElement(ChecklistMatrix, { dashboard: createDashboard("tasks_rows") }));

    expect(html).toContain("순서 변경");
    expect(html).not.toContain("drag-handle");
    expect(html).not.toContain('data-reorder-target="true"');
    expect(html).not.toContain('data-reorder-id="roster"');
  });

  it("uses character display visibility settings in matrix cells", () => {
    const dashboard = createDashboard("tasks_rows");
    dashboard.settings.show_display_name = 0;
    dashboard.settings.show_server_name = 1;
    dashboard.settings.show_class_name = 1;
    dashboard.settings.show_item_level = 0;
    dashboard.settings.show_combat_power = 1;
    const html = renderToStaticMarkup(createElement(ChecklistMatrix, { dashboard }));

    expect(html).toContain(">냠수나이스1<");
    expect(html).toContain("루페온");
    expect(html).toContain("소서리스");
    expect(html).toContain("2,549.41");
    expect(html).not.toContain(">냠1<");
    expect(html).not.toContain(">1,640.00</small>");
  });

  it("renders character edit actions and visibility toggles clearly", () => {
    const dashboard = createDashboard("tasks_rows");
    const html = renderToStaticMarkup(
      createElement(CharacterEditModal, {
        character: dashboard.characters[0]!,
        settings: dashboard.settings,
        onClose: () => undefined
      })
    );

    expect(html).toContain('aria-label="닫기"');
    expect(html).toContain('class="primary-button"');
    expect(html).toContain("저장");
    expect(html).toContain('class="danger-button"');
    expect(html).toContain("캐릭터 삭제");
    for (const label of ["축약 이름 표시", "서버 표시", "직업 표시", "레벨 표시", "전투력 표시"]) {
      expect(html).toContain(label);
    }
  });

  it("renders task edit actions clearly", () => {
    const dashboard = createDashboard("tasks_rows");
    const html = renderToStaticMarkup(
      createElement(TaskEditModal, {
        task: dashboard.tasks[0]!,
        onClose: () => undefined
      })
    );

    expect(html).toContain('aria-label="닫기"');
    expect(html).toContain('class="primary-button"');
    expect(html).toContain("저장");
    expect(html).toContain('class="danger-button"');
    expect(html).toContain("숙제 삭제");
  });
});
