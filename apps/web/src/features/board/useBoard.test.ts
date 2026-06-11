import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ApiClientError } from "../../api/client";
import { formatBoardError } from "./useBoard";

describe("formatBoardError", () => {
  it("uses a Korean login prompt for unauthorized API errors", () => {
    const error = new ApiClientError(401, "unauthorized", "Login required");

    expect(formatBoardError(error)).toBe("로그인이 필요합니다. Discord 또는 Google로 로그인해주세요.");
  });

  it("uses a board-specific fallback for unknown errors", () => {
    expect(formatBoardError("bad")).toBe("보드 데이터를 불러오지 못했습니다.");
  });

  it("checks lightweight board versions on focus and visibility changes", () => {
    const source = readFileSync(new URL("./useBoard.ts", import.meta.url), "utf-8");

    expect(source).toContain("/api/board/versions");
    expect(source).toContain('window.addEventListener("focus", handleFocus);');
    expect(source).toContain('document.addEventListener("visibilitychange", handleVisibilityChange);');
    expect(source).toContain("BOARD_VERSION_CHECK_INTERVAL_MS");
  });

  it("keeps completion save failures visible by reloading instead of swallowing them", () => {
    const source = readFileSync(new URL("./useBoardCompletionQueue.ts", import.meta.url), "utf-8");

    expect(source).toContain("void flush().catch(() => window.location.reload());");
  });
});
