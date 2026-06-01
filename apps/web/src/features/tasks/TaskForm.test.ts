import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskForm } from "./TaskForm";

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

    expect(html).toContain('class="tool-panel compact-task-panel"');
    expect(html).toContain('class="inline-form compact-task-form"');
    expect(html.indexOf("숙제 이름")).toBeLessThan(html.indexOf("일간"));
    expect(html.indexOf("일간")).toBeLessThan(html.indexOf("추가"));
    expect(html).toContain('class="primary-button"');
  });
});
