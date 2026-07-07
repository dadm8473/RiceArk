import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildSharedRiceBinLink, extractSharedRiceBinId, openSharedRiceBinInNewTab, SharedRiceBinPanel } from "./SharedRiceBinPanel";
import type { BoardPayload } from "../board/types";

const shareId = "AbCdEfGhIjKlMnOpQrStUv";

const ownerBoard: BoardPayload = {
  userId: "user-1",
  settings: {
    show_display_name: 1,
    show_server_name: 0,
    show_class_name: 0,
    show_item_level: 1,
    show_combat_power: 0
  },
  sheets: [{ id: "sheet-1", name: "숙제", sort_order: 0, is_default: 1 }],
  tables: [],
  notes: [],
  axisItems: [],
  cellStates: [],
  completions: []
};

describe("extractSharedRiceBinId", () => {
  it("accepts raw ids and RiceArk share links", () => {
    expect(extractSharedRiceBinId(shareId)).toBe(shareId);
    expect(extractSharedRiceBinId(`https://riceark.pages.dev/?share=${shareId}`)).toBe(shareId);
    expect(extractSharedRiceBinId(`https://riceark.pages.dev/shared/${shareId}`)).toBe(shareId);
    expect(extractSharedRiceBinId("짧은값")).toBeNull();
  });
});

describe("shared rice bin links", () => {
  it("builds share links from a supplied origin", () => {
    expect(buildSharedRiceBinLink(shareId, "https://riceark.pages.dev")).toBe(`https://riceark.pages.dev/?share=${shareId}`);
  });

  it("opens shared rice bins in a new browser tab", () => {
    const open = vi.fn(() => ({ opener: {} }));

    expect(openSharedRiceBinInNewTab(shareId, { open, origin: "https://riceark.pages.dev" })).toBe(true);
    expect(open).toHaveBeenCalledWith(`https://riceark.pages.dev/?share=${shareId}`, "_blank", "noopener,noreferrer");
  });
});

describe("SharedRiceBinPanel", () => {
  it("renders lookup controls for anonymous visitors", () => {
    const html = renderToStaticMarkup(createElement(SharedRiceBinPanel, { sessionStatus: "anonymous" }));

    expect(html).not.toContain('class="shared-rice-bin-header"');
    expect(html).not.toContain("공유 받은 쌀통은 읽기 전용으로만 조회됩니다.");
    expect(html).toContain('class="shared-rice-bin-hub');
    expect(html).toContain("shared-rice-bin-lookup-panel");
    expect(html).not.toContain('class="shared-rice-bin-view-placeholder"');
    expect(html).not.toContain("조회 중인 쌀통");
    expect(html).not.toContain("열기를 누르면 이 영역에 공유 보드가 표시됩니다.");
    expect(html).toContain("공유 쌀통 조회");
    expect(html).toContain("아이디 또는 링크");
    expect(html).toContain("열기");
    expect(html).toContain("새 탭");
    expect(html).not.toContain("새 탭에서 열기");
    expect(html).not.toContain("내 쌀통 공유");
  });

  it("renders owner share management when the user is logged in", () => {
    const html = renderToStaticMarkup(
      createElement(SharedRiceBinPanel, {
        ownerBoard,
        sessionStatus: "authenticated",
        onOwnerBoardChanged: vi.fn()
      })
    );

    expect(html).toContain("내 쌀통 공유");
    expect(html).toContain("shared-rice-bin-share-panel");
    expect(html).toContain("숙제");
    expect(html).toContain("공유 시작");
    expect(html).not.toContain("공유 시작 시 새 ID");
    expect(html).toContain("즐겨찾기");
    expect(html).toContain("즐겨찾기한 쌀통이 없습니다.");
    expect(html).not.toContain("즐겨찾기한 공유 쌀통이 없습니다.");
  });

  it("uses a board-only layout once a shared rice bin is open", () => {
    const source = readFileSync(new URL("./SharedRiceBinPanel.tsx", import.meta.url), "utf-8");

    expect(source).toContain("if (sharedBoard)");
    expect(source.indexOf("if (sharedBoard)")).toBeLessThan(source.indexOf('className={`shared-rice-bin-hub'));
    expect(source).toContain('className="shared-rice-bin-board shared-rice-bin-board-full"');
    expect(source).toContain("<h3>읽기 전용</h3>");
    expect(source).toContain("onSharedBoardClosed?.()");
    expect(source).not.toContain("공유 쌀통 읽기 전용");
  });

  it("can reset an open shared board back to lookup from the parent tab", () => {
    const source = readFileSync(new URL("./SharedRiceBinPanel.tsx", import.meta.url), "utf-8");

    expect(source).toContain("resetToLookupKey");
    expect(source).toContain("lastResetToLookupKeyRef");
    expect(source).toMatch(/resetToLookupKey[\s\S]{0,500}setSharedBoard\(null\)[\s\S]{0,260}onSharedBoardClosed\?\.\(\)/);
  });
});
