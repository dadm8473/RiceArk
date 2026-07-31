import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AdminAuditTable,
  AdminAuditToolbar,
  getAdminAuditActionLabel
} from "./AdminAuditTab";
import type { AdminAuditLog } from "./types";

const log: AdminAuditLog = {
  id: "audit-1",
  adminUserId: "12345678-1234-1234-1234-123456780001",
  adminDisplayName: "Admin",
  targetUserId: "12345678-1234-1234-1234-123456789012",
  targetDisplayName: "Rice",
  method: "PATCH",
  action: "board.completions.update",
  createdAt: "2026-07-31T03:00:00.000Z"
};

function render(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(element);
}

describe("AdminAuditTab", () => {
  it("maps approved action labels and leaves unknown normalized actions visible", () => {
    expect(getAdminAuditActionLabel("board.completions.update")).toBe("체크 상태 변경");
    expect(getAdminAuditActionLabel("board.cell_states.update")).toBe("체크칸 설정 변경");
    expect(getAdminAuditActionLabel("characters.refresh")).toBe("캐릭터 정보 갱신");
    expect(getAdminAuditActionLabel("settings.update")).toBe("보드 표시 설정 변경");
    expect(getAdminAuditActionLabel("board.future_action")).toBe("board.future_action");
  });

  it("renders an unknown normalized action once", () => {
    const html = render(
      createElement(AdminAuditTable, {
        logs: [{ ...log, action: "board.future_action" }],
        loading: false,
        loadingMore: false,
        error: null,
        nextCursor: null,
        onRetry: () => undefined,
        onLoadMore: () => undefined
      })
    );

    expect(html.match(/board\.future_action/g)).toHaveLength(1);
  });

  it("renders content-free audit rows", () => {
    const html = render(
      createElement(AdminAuditTable, {
        logs: [log],
        loading: false,
        loadingMore: false,
        error: null,
        nextCursor: null,
        onRetry: () => undefined,
        onLoadMore: () => undefined
      })
    );

    expect(html).toContain("체크 상태 변경");
    expect(html).toContain("PATCH");
    expect(html).toContain("Admin");
    expect(html).toContain("Rice");
    expect(html).toContain("9012");
    expect(html).not.toMatch(/\b(?:memo|payload|body)\b/i);
  });

  it("renders loading, empty, error, retry, and cursor pagination states", () => {
    const loading = render(
      createElement(AdminAuditTable, {
        logs: [],
        loading: true,
        loadingMore: false,
        error: null,
        nextCursor: null,
        onRetry: () => undefined,
        onLoadMore: () => undefined
      })
    );
    const empty = render(
      createElement(AdminAuditTable, {
        logs: [],
        loading: false,
        loadingMore: false,
        error: null,
        nextCursor: null,
        onRetry: () => undefined,
        onLoadMore: () => undefined
      })
    );
    const error = render(
      createElement(AdminAuditTable, {
        logs: [],
        loading: false,
        loadingMore: false,
        error: "관리 기록을 불러오지 못했습니다.",
        nextCursor: null,
        onRetry: () => undefined,
        onLoadMore: () => undefined
      })
    );
    const nextPage = render(
      createElement(AdminAuditTable, {
        logs: [log],
        loading: true,
        loadingMore: false,
        error: null,
        nextCursor: "next-page",
        onRetry: () => undefined,
        onLoadMore: () => undefined
      })
    );

    expect(loading).toContain("관리 기록을 불러오는 중");
    expect(empty).toContain("관리 기록이 없습니다");
    expect(error).toContain("관리 기록을 불러오지 못했습니다.");
    expect(error).toContain("다시 시도");
    expect(nextPage).toContain("이전 기록 더 보기");
    expect(nextPage).toContain("disabled");
  });

  it("uses a refresh icon button with an accessible tooltip", () => {
    const html = render(
      createElement(AdminAuditToolbar, {
        refreshing: false,
        onRefresh: () => undefined
      })
    );

    expect(html).toContain('aria-label="관리 기록 새로고침"');
    expect(html).toContain('title="관리 기록 새로고침"');
    expect(html).not.toMatch(/>새로고침</);
  });
});
