import { describe, expect, it } from "vitest";
import { getAuthErrorMessage } from "./App";

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
