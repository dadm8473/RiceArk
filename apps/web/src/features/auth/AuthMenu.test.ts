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
});
