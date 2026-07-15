import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuthMenu } from "./AuthMenu";

describe("AuthMenu", () => {
  it("shows login options when the visitor is anonymous", () => {
    const html = renderToStaticMarkup(
      createElement(AuthMenu, { menuOpen: false, status: "anonymous", onLogout: vi.fn() })
    );

    expect(html).toContain("Discord로 로그인");
    expect(html).toContain("Google로 로그인");
  });

  it("shows the user profile when authenticated", () => {
    const html = renderToStaticMarkup(
      createElement(AuthMenu, {
        menuOpen: false,
        status: "authenticated",
        user: { id: "user-1", displayName: "쌀먹도사", avatarUrl: null },
        onLogout: vi.fn()
      })
    );

    expect(html).toContain("쌀먹도사");
    expect(html).not.toContain("Google로 로그인");
  });

  it("shows logout in the profile menu when open", () => {
    const html = renderToStaticMarkup(
      createElement(AuthMenu, {
        menuOpen: true,
        status: "authenticated",
        user: { id: "user-1", displayName: "쌀먹도사", avatarUrl: null },
        onLogout: vi.fn()
      })
    );

    expect(html).toContain("로그아웃");
  });

  it("offers a nickname edit button in the profile menu when a save handler exists", () => {
    const html = renderToStaticMarkup(
      createElement(AuthMenu, {
        menuOpen: true,
        status: "authenticated",
        user: { id: "user-1", displayName: "쌀먹도사", avatarUrl: null },
        onDisplayNameSave: async () => undefined,
        onLogout: vi.fn()
      })
    );

    expect(html).toContain('aria-label="닉네임 수정"');
    expect(html).toContain("공유 쌀통에 표시되는 이름");
  });

  it("hides the nickname edit button without a save handler", () => {
    const html = renderToStaticMarkup(
      createElement(AuthMenu, {
        menuOpen: true,
        status: "authenticated",
        user: { id: "user-1", displayName: "쌀먹도사", avatarUrl: null },
        onLogout: vi.fn()
      })
    );

    expect(html).not.toContain('aria-label="닉네임 수정"');
  });

  it("limits nickname edits to 12 characters", () => {
    const source = readFileSync(new URL("./AuthMenu.tsx", import.meta.url), "utf8");

    expect(source).toContain("DISPLAY_NAME_MAX_CHARS = 12");
    expect(source).toContain("maxLength={DISPLAY_NAME_MAX_CHARS}");
  });

  it("shows a theme toggle in the profile menu", () => {
    const html = renderToStaticMarkup(
      createElement(AuthMenu, {
        menuOpen: true,
        status: "authenticated",
        theme: "light",
        user: { id: "user-1", displayName: "쌀먹도사", avatarUrl: null },
        onLogout: vi.fn(),
        onThemeToggle: vi.fn()
      })
    );

    expect(html).toContain("다크모드(Beta)");
  });

  it("reserves a compact profile status and labels pending writes accessibly", () => {
    const idleHtml = renderToStaticMarkup(
      createElement(AuthMenu, {
        menuOpen: false,
        status: "authenticated",
        user: { id: "user-1", displayName: "쌀먹도사", avatarUrl: null },
        onLogout: vi.fn()
      })
    );
    const pendingHtml = renderToStaticMarkup(
      createElement(AuthMenu, {
        hasPendingWrites: true,
        menuOpen: false,
        status: "authenticated",
        user: { id: "user-1", displayName: "쌀먹도사", avatarUrl: null },
        onLogout: vi.fn()
      })
    );

    expect(idleHtml).toContain('class="profile-write-status-slot"');
    expect(pendingHtml).toContain("변경사항 저장 대기 중");
  });

  it("shows retry and discard logout commands only while logout is blocked", () => {
    const baseProps = {
      menuOpen: true,
      status: "authenticated" as const,
      user: { id: "user-1", displayName: "쌀먹도사", avatarUrl: null },
      onLogout: vi.fn(),
      onRetryLogout: vi.fn(),
      onDiscardLogout: vi.fn()
    };
    const normalHtml = renderToStaticMarkup(createElement(AuthMenu, baseProps));
    const blockedHtml = renderToStaticMarkup(createElement(AuthMenu, { ...baseProps, logoutBlocked: true }));

    expect(normalHtml).not.toContain("저장 재시도 후 로그아웃");
    expect(normalHtml).not.toContain("저장 대기 변경사항 버리고 로그아웃");
    expect(blockedHtml).toContain("저장 대기 변경사항을 저장하지 못했습니다");
    expect(blockedHtml).toContain("이미 저장된 변경사항은 유지됩니다");
    expect(blockedHtml).toContain("저장 재시도 후 로그아웃");
    expect(blockedHtml).toContain("저장 대기 변경사항 버리고 로그아웃");
    expect(blockedHtml).not.toContain(">로그아웃<");
  });

  it("shows a logout API failure as a visible menu alert without blocked commands", () => {
    const html = renderToStaticMarkup(createElement(AuthMenu, {
      logoutError: "로그아웃 요청에 실패했습니다. 다시 시도해주세요.",
      menuOpen: true,
      status: "authenticated",
      user: { id: "user-1", displayName: "쌀먹도사", avatarUrl: null },
      onLogout: vi.fn(),
      onRetryLogout: vi.fn(),
      onDiscardLogout: vi.fn()
    }));

    expect(html).toContain('role="alert"');
    expect(html).toContain("로그아웃 요청에 실패했습니다. 다시 시도해주세요.");
    expect(html).not.toContain("저장 재시도 후 로그아웃");
    expect(html).not.toContain("저장 대기 변경사항 버리고 로그아웃");
  });
});
