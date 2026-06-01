import { describe, expect, it } from "vitest";
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
});
