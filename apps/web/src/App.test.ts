import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, getAuthErrorMessage, getUrlWithoutSharedRiceBinId } from "./App";

const hooks = vi.hoisted(() => ({
  useBoard: vi.fn(),
  useSession: vi.fn()
}));

vi.mock("./features/board/BoardOverview", () => ({
  BoardOverview: () => "board overview"
}));

vi.mock("./features/shared-rice-bin/SharedRiceBinPanel", () => ({
  SharedRiceBinPanel: () => "shared rice bin panel",
  extractSharedRiceBinId: () => null
}));

vi.mock("./features/admin/AdminDashboard", () => ({
  AdminDashboard: () => "admin dashboard"
}));

vi.mock("./features/dashboard/ChecklistMatrix", () => ({
  ChecklistMatrix: () => "legacy checklist matrix"
}));

vi.mock("./features/board/useBoard", () => ({
  useBoard: hooks.useBoard
}));

vi.mock("./features/auth/useSession", () => ({
  useSession: hooks.useSession
}));

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
  notes: [],
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

describe("getUrlWithoutSharedRiceBinId", () => {
  it("removes shared rice bin ids from query and path links while preserving the rest of the URL", () => {
    expect(getUrlWithoutSharedRiceBinId("https://riceark.pages.dev/?share=AbCdEfGhIjKlMnOpQrStUv&foo=1#memo")).toBe("/?foo=1#memo");
    expect(getUrlWithoutSharedRiceBinId("https://riceark.pages.dev/shared/AbCdEfGhIjKlMnOpQrStUv?foo=1")).toBe("/?foo=1");
  });
});

describe("App", () => {
  beforeEach(() => {
    hooks.useBoard.mockReturnValue({ data: board, error: null, reload: vi.fn() });
    hooks.useSession.mockReturnValue({ status: "anonymous", user: null, error: null });
  });

  it("uses the board builder as the only checklist surface on the main screen", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("board overview");
    expect(html).not.toContain("legacy checklist matrix");
  });

  it("does not load the legacy dashboard payload for the board-only main screen", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf-8");

    expect(source).not.toContain("useDashboard");
    expect(source).not.toContain("/api/dashboard");
  });

  it("renders the RiceArk icon in the top-left brand", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain('class="brand-mark"');
    expect(html).toContain('src="/icons/icon-192.png"');
    expect(html).toContain('alt=""');
    expect(html.indexOf('class="brand-mark"')).toBeLessThan(html.indexOf("RiceArk"));
  });

  it("renders a shared rice bin entry beside the brand", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("공유 쌀통");
    expect(html.indexOf("RiceArk")).toBeLessThan(html.indexOf("공유 쌀통"));
  });

  it("renders the auction distribution calculator next to the main rice bin entries", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("분배금 계산기");
    expect(html.indexOf("공유 쌀통")).toBeLessThan(html.indexOf("분배금 계산기"));
  });

  it("renders a patch notes board entry next to the calculator", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("패치노트");
    expect(html.indexOf("분배금 계산기")).toBeLessThan(html.indexOf("패치노트"));
  });

  it("shows the operations dashboard entry only to admin users", () => {
    hooks.useSession.mockReturnValue({
      status: "authenticated",
      user: { id: "user-admin", displayName: "수빈", avatarUrl: null, isAdmin: true },
      error: null
    });
    const adminHtml = renderToStaticMarkup(createElement(App));

    hooks.useSession.mockReturnValue({
      status: "authenticated",
      user: { id: "user-user", displayName: "쌀먹", avatarUrl: null, isAdmin: false },
      error: null
    });
    const userHtml = renderToStaticMarkup(createElement(App));

    expect(adminHtml).toContain("운영 현황");
    expect(adminHtml.indexOf("분배금 계산기")).toBeLessThan(adminHtml.indexOf("운영 현황"));
    expect(userHtml).not.toContain("운영 현황");
  });

  it("renders a support Discord link before the profile or login controls", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("문의하기");
    expect(html).toContain('href="https://discord.gg/yanCxtrBTc"');
    expect(html).toContain('target="_blank"');
    expect(html.indexOf("문의하기")).toBeLessThan(html.indexOf("Discord로 로그인"));
  });

  it("passes separate load and polling flags to the board hook so shared lookup does not keep polling", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf-8");

    expect(source).toContain("const isBoardEnabled =");
    expect(source).toContain("const isBoardPollingEnabled = activeView === \"board\"");
    expect(source).toContain("useBoard({ enabled: isBoardEnabled, pollingEnabled: isBoardPollingEnabled })");
  });

  it("clears shared rice bin link state when the user switches back to their own rice bin", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf-8");

    expect(source).toContain("const handleOwnBoardSelected = () =>");
    expect(source).toMatch(/handleOwnBoardSelected[\s\S]{0,220}setActiveView\("board"\)[\s\S]{0,220}clearSharedRiceBinEntryState\(\)/);
    expect(source).toContain('onClick={handleOwnBoardSelected}');
  });

  it("turns a shared rice bin tab reselect into a lookup reset signal", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf-8");

    expect(source).toContain("sharedRiceBinLookupResetKey");
    expect(source).toMatch(/handleSharedRiceBinSelected[\s\S]{0,260}activeView === "shared"[\s\S]{0,260}setSharedRiceBinLookupResetKey/);
    expect(source).toContain("resetToLookupKey={sharedRiceBinLookupResetKey}");
  });
});

describe("app metadata", () => {
  it("links the web icon assets from the document head", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf-8");

    expect(html).toContain('rel="icon"');
    expect(html).toContain('href="/icons/favicon-32.png"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('href="/icons/icon-192.png"');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/site.webmanifest"');
  });
});
