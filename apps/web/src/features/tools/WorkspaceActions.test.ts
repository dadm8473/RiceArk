import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceActions } from "./WorkspaceActions";

describe("WorkspaceActions", () => {
  it("shows character and task action buttons without screen settings", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceActions, {
        activeTool: null,
        onOpen: vi.fn(),
        onClose: vi.fn()
      })
    );

    expect(html).toContain("캐릭터 가져오기");
    expect(html).toContain("숙제 추가");
    expect(html).not.toContain("표 방향");
    expect(html).not.toContain("캐릭터를 열로");
    expect(html).not.toContain("숙제를 열로");
    expect(html).not.toContain("화면 설정");
  });

  it("renders the selected tool inside a dialog", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceActions, {
        activeTool: "characters",
        onOpen: vi.fn(),
        onClose: vi.fn()
      })
    );

    expect(html).toContain("dialog");
    expect(html).toContain("대표 캐릭터명");
  });

  it("uses a narrower dialog for task creation", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceActions, {
        activeTool: "tasks",
        onOpen: vi.fn(),
        onClose: vi.fn()
      })
    );

    expect(html).toContain('class="tool-modal task-tool-modal"');
    expect(html).toContain("숙제 이름");
  });
});
