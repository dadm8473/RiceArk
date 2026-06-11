import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LOST_ARK_TASK_PRESETS, TaskForm } from "./TaskForm";

describe("TaskForm", () => {
  it("does not repeat the modal title inside the form", () => {
    const html = renderToStaticMarkup(createElement(TaskForm));

    expect(html).not.toContain("<h2");
  });

  it("does not expose a special roster task option", () => {
    const html = renderToStaticMarkup(createElement(TaskForm));

    expect(html).not.toContain("원정대");
    expect(html).not.toContain('value="roster"');
  });

  it("renders task creation as a compact inline form", () => {
    const html = renderToStaticMarkup(createElement(TaskForm));
    const compactFormHtml = html.slice(html.indexOf('class="inline-form compact-task-form"'));

    expect(html).toContain('class="tool-panel compact-task-panel"');
    expect(html).toContain('class="inline-form compact-task-form"');
    expect(html).toContain('aria-label="숙제 색상"');
    expect(html).toContain('type="color"');
    expect(html).toContain('value="#2563eb"');
    expect(html).toContain("초기화 주기");
    expect(compactFormHtml.indexOf("숙제 이름")).toBeLessThan(compactFormHtml.indexOf("일간"));
    expect(compactFormHtml.indexOf("일간")).toBeLessThan(compactFormHtml.indexOf("추가"));
    expect(html).toContain("초기화 안함");
    expect(html).not.toContain("커스텀");
    expect(html).toContain('class="primary-button"');
  });

  it("offers common Lost Ark task presets without event-style roster content", () => {
    const html = renderToStaticMarkup(createElement(TaskForm));

    expect(LOST_ARK_TASK_PRESETS).toEqual([
      { id: "kurzan-chaos", title: "카오스 던전/쿠르잔 전선/혼돈의 균열", label: "카던", resetType: "daily", color: "#2563eb" },
      { id: "guardian", title: "가디언 토벌", label: "가토", resetType: "daily", color: "#13795b" },
      { id: "act-4", title: "4막 : 파멸의 성채", label: "4막", resetType: "weekly", color: "#b45309" },
      { id: "finale", title: "종막 : 최후의 날", label: "종막", resetType: "weekly", color: "#7c3aed" },
      { id: "serka", title: "고통의 마녀, 세르카", label: "세르카", resetType: "weekly", color: "#be123c" },
      { id: "cathedral", title: "지평의 성당", label: "성당", resetType: "weekly", color: "#0f766e" },
      { id: "paradise-heaven", title: "낙원 : 천상", label: "천상", resetType: "weekly", color: "#4f46e5" },
      { id: "paradise-proof", title: "낙원 : 증명", label: "증명", resetType: "weekly", color: "#db2777" }
    ]);
    expect(html).toContain('class="task-preset-grid"');
    expect(html).toContain("카던");
    expect(html).toContain("카오스 던전/쿠르잔 전선/혼돈의 균열");
    expect(html).toContain("가토");
    expect(html).toContain("주간");
    expect(html).not.toContain("카오스 게이트");
    expect(html).not.toContain("필드 보스");
    expect(html).not.toContain("모험섬");
  });

  it("wires task preset buttons to fill the compact task form draft", () => {
    const source = renderToStaticMarkup(createElement(TaskForm));

    expect(source).toContain('aria-label="카던 숙제 프리셋 적용"');
    expect(source).toContain('aria-label="4막 숙제 프리셋 적용"');
    expect(source).toContain('type="button"');
  });

  it("disables task creation until a task name is entered", () => {
    const html = renderToStaticMarkup(createElement(TaskForm));

    expect(html).toMatch(/disabled=""[^>]*title="숙제 이름을 입력해주세요"|title="숙제 이름을 입력해주세요"[^>]*disabled=""/);
  });
});
