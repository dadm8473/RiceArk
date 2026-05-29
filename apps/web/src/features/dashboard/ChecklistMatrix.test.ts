import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChecklistMatrix } from "./ChecklistMatrix";
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
      checklist_orientation: checklistOrientation
    }
  };
}

describe("ChecklistMatrix", () => {
  it("uses optional character display names in the task-row orientation", () => {
    const html = renderToStaticMarkup(createElement(ChecklistMatrix, { dashboard: createDashboard("tasks_rows") }));

    expect(html.indexOf("숙제")).toBeLessThan(html.indexOf("냠1"));
    expect(html).toContain("냠1");
    expect(html).not.toContain(">냠수나이스1<");
  });

  it("can render tasks as columns without changing character identity", () => {
    const html = renderToStaticMarkup(createElement(ChecklistMatrix, { dashboard: createDashboard("tasks_columns") }));

    expect(html.indexOf("캐릭터")).toBeLessThan(html.indexOf("쿠르잔 전선"));
    expect(html).toContain('title="루페온 / 냠수나이스1 / 소서리스 / 1,640.00 / 2,549.41"');
  });
});
