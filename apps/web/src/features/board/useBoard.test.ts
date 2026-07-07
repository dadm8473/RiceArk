import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ApiClientError } from "../../api/client";
import {
  BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS,
  BOARD_VERSION_IDLE_CHECK_INTERVAL_MS,
  buildLocalBoardPeriodFingerprint,
  buildBoardVersionKey,
  canClaimBoardPollingLeadership,
  formatBoardError,
  getBoardPollingDelayMs,
  getNextBoardPeriodBoundaryMs,
  parseBoardPollingLeaderRecord
} from "./useBoard";

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
    expect(source).toContain("buildBoardVersionKey");
    expect(source).toContain("pollingEnabled");
    expect(source).toContain("BroadcastChannel");
    expect(source).toContain("localStorage");
    expect(source).toContain("getNextBoardPeriodBoundaryMs");
    expect(source).toContain('window.addEventListener("focus", handleFocus);');
    expect(source).toContain('document.addEventListener("visibilitychange", handleVisibilityChange);');
    expect(source).toContain("BOARD_VERSION_CHECK_INTERVAL_MS");
  });

  it("builds reset period fingerprints locally from the loaded board payload", () => {
    const board = {
      axisItems: [
        { kind: "character", task_reset_rule_json: null },
        { kind: "task", task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}' },
        { kind: "task", task_reset_rule_json: '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}' },
        { kind: "task", task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}' }
      ]
    };
    const summary = { manifestVersion: 3, sheets: [{ id: "sheet-1", version: 5 }], periodFingerprint: "" };

    expect(buildLocalBoardPeriodFingerprint(board, new Date("2026-06-05T03:00:00.000Z"))).toBe(
      "daily:2026-06-05|weekly:2026-06-03"
    );
    expect(buildBoardVersionKey(summary, board, new Date("2026-06-05T03:00:00.000Z"))).toContain(
      "daily:2026-06-05|weekly:2026-06-03"
    );
  });

  it("backs off board version polling after the user is idle", () => {
    const nowMs = Date.parse("2026-06-05T03:00:00.000Z");

    expect(getBoardPollingDelayMs(nowMs - 60_000, nowMs)).toBe(BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS);
    expect(getBoardPollingDelayMs(nowMs - 6 * 60_000, nowMs)).toBe(BOARD_VERSION_IDLE_CHECK_INTERVAL_MS);
  });

  it("calculates the next local reset boundary without asking the server", () => {
    const board = {
      axisItems: [
        { kind: "task", task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}' },
        { kind: "task", task_reset_rule_json: '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}' }
      ]
    };

    expect(getNextBoardPeriodBoundaryMs(board, new Date("2026-06-05T20:50:00.000Z"))).toBe(
      Date.parse("2026-06-05T21:00:00.000Z")
    );
    expect(getNextBoardPeriodBoundaryMs(board, new Date("2026-06-03T21:00:01.000Z"))).toBe(
      Date.parse("2026-06-04T21:00:00.000Z")
    );
  });

  it("lets only the current or expired board polling leader claim polling work", () => {
    expect(parseBoardPollingLeaderRecord('{"id":"tab-a","expiresAt":1000}')).toEqual({ id: "tab-a", expiresAt: 1000 });
    expect(parseBoardPollingLeaderRecord("bad")).toBeNull();
    expect(canClaimBoardPollingLeadership(null, "tab-a", 100)).toBe(true);
    expect(canClaimBoardPollingLeadership({ id: "tab-a", expiresAt: 1000 }, "tab-a", 200)).toBe(true);
    expect(canClaimBoardPollingLeadership({ id: "tab-a", expiresAt: 1000 }, "tab-b", 200)).toBe(false);
    expect(canClaimBoardPollingLeadership({ id: "tab-a", expiresAt: 1000 }, "tab-b", 1001)).toBe(true);
  });

  it("keeps completion save failures visible by reloading instead of swallowing them", () => {
    const source = readFileSync(new URL("./useBoardCompletionQueue.ts", import.meta.url), "utf-8");

    expect(source).toContain("void flush().catch(() => window.location.reload());");
  });

  it("flushes pending completion saves when the tab is hidden or the page is leaving", () => {
    const source = readFileSync(new URL("./useBoardCompletionQueue.ts", import.meta.url), "utf-8");

    expect(source).toContain('document.addEventListener("visibilitychange", handleVisibilityChange);');
    expect(source).toContain('window.addEventListener("pagehide", handlePageHide);');
    expect(source).toContain('document.visibilityState === "hidden"');
    expect(source).toContain("onPendingPatchesChange");
  });
});
