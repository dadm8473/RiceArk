import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, getAuthErrorMessage } from "./App";

const hooks = vi.hoisted(() => ({
  useBoard: vi.fn(),
  useDashboard: vi.fn(),
  useSession: vi.fn()
}));

vi.mock("./features/board/BoardOverview", () => ({
  BoardOverview: () => "board overview"
}));

vi.mock("./features/dashboard/ChecklistMatrix", () => ({
  ChecklistMatrix: () => "legacy checklist matrix"
}));

vi.mock("./features/board/useBoard", () => ({
  useBoard: hooks.useBoard
}));

vi.mock("./features/dashboard/useDashboard", () => ({
  useDashboard: hooks.useDashboard
}));

vi.mock("./features/auth/useSession", () => ({
  useSession: hooks.useSession
}));

const dashboard = {
  characters: [],
  tasks: [],
  completions: [],
  settings: {
    density: "default",
    row_height: 40,
    column_width: 132,
    checklist_orientation: "tasks_rows",
    show_display_name: 1,
    show_server_name: 0,
    show_class_name: 0,
    show_item_level: 1,
    show_combat_power: 0
  }
};

const board = {
  userId: "user-1",
  settings: {
    show_display_name: 1,
    show_server_name: 0,
    show_class_name: 0,
    show_item_level: 1,
    show_combat_power: 0
  },
  sheets: [],
  tables: [],
  axisItems: [],
  cellStates: [],
  completions: []
};

describe("getAuthErrorMessage", () => {
  it("wraps login start errors in a Korean app message", () => {
    expect(getAuthErrorMessage("?authError=oauth_unavailable&provider=discord")).toBe(
      "Discord 로그인 설정이 아직 완료되지 않았습니다. 배포 환경에서 다시 시도해주세요."
    );
  });

  it("ignores normal URLs", () => {
    expect(getAuthErrorMessage("")).toBeNull();
  });
});

describe("App", () => {
  beforeEach(() => {
    hooks.useDashboard.mockReturnValue({ data: dashboard, error: null });
    hooks.useBoard.mockReturnValue({ data: board, error: null, reload: vi.fn() });
    hooks.useSession.mockReturnValue({ status: "anonymous", user: null, error: null });
  });

  it("uses the board builder as the only checklist surface on the main screen", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("board overview");
    expect(html).not.toContain("legacy checklist matrix");
  });
});
