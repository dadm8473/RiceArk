import { describe, expect, it } from "vitest";
import { ApiClientError } from "../../api/client";
import { formatDashboardError } from "./useDashboard";

describe("formatDashboardError", () => {
  it("uses a Korean login prompt for unauthorized API errors", () => {
    const error = new ApiClientError(401, "unauthorized", "Login required");

    expect(formatDashboardError(error)).toBe("로그인이 필요합니다. Discord 또는 Google로 로그인해주세요.");
  });
});
