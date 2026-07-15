import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ApiClientError } from "../../api/client";
import {
  BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS,
  BOARD_VERSION_IDLE_CHECK_INTERVAL_MS,
  buildLocalBoardPeriodFingerprint,
  buildBoardVersionKey,
  canClaimBoardPollingLeadership,
  createBoardWriteCoordinator,
  formatBoardError,
  getBoardPollingDelayMs,
  getNextBoardPeriodBoundaryMs,
  mergeBoardVersionSummary,
  parseBoardPollingLeaderRecord
} from "./useBoard";
import type { BoardPayload } from "./types";

const emptyBoard: BoardPayload = {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

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

  it("merges mutation and summary versions monotonically across the initial-summary race", () => {
    const acknowledged = mergeBoardVersionSummary(null, {
      manifestVersion: 8,
      sheets: [{ id: "sheet-1", version: 7 }]
    });
    const initialSummary = mergeBoardVersionSummary(acknowledged, {
      manifestVersion: 6,
      sheets: [
        { id: "sheet-1", version: 5 },
        { id: "sheet-2", version: 3 }
      ],
      periodFingerprint: "server-period"
    });

    expect(initialSummary).toEqual({
      manifestVersion: 8,
      sheets: [
        { id: "sheet-1", version: 7 },
        { id: "sheet-2", version: 3 }
      ],
      periodFingerprint: "server-period"
    });
    expect(mergeBoardVersionSummary(initialSummary, { sheets: [{ id: "sheet-1", version: 4 }] })).toEqual(
      initialSummary
    );
  });

  it("keeps the writing tab on its acknowledged version when a stale poll arrives", () => {
    const board = { axisItems: [] };
    const initial = mergeBoardVersionSummary(null, {
      manifestVersion: 2,
      sheets: [{ id: "sheet-1", version: 5 }],
      periodFingerprint: ""
    });
    const acknowledged = mergeBoardVersionSummary(initial, {
      sheets: [{ id: "sheet-1", version: 6 }]
    });
    const acknowledgedKey = buildBoardVersionKey(acknowledged, board);
    const afterStalePoll = mergeBoardVersionSummary(acknowledged, {
      manifestVersion: 2,
      sheets: [{ id: "sheet-1", version: 5 }],
      periodFingerprint: ""
    });

    expect(buildBoardVersionKey(afterStalePoll, board)).toBe(acknowledgedKey);
  });
});

describe("BoardWriteCoordinator", () => {
  it("reapplies pending completion and cell-state intent over a reloaded authoritative board", () => {
    const coordinator = createBoardWriteCoordinator("user-1", { attachLifecycle: false });
    coordinator.setAuthoritativeBase(emptyBoard);
    coordinator.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    });
    coordinator.enqueueCellState({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      markType: "fixed",
      markIcon: "pin",
      memo: "21:00"
    });

    coordinator.setAuthoritativeBase({ ...emptyBoard, completions: [], cellStates: [] });

    expect(coordinator.getVisibleData()?.completions).toHaveLength(1);
    expect(coordinator.getVisibleData()?.cellStates).toHaveLength(1);
    coordinator.discardAndDispose();
  });

  it("commits an accepted chunk to base while a newer same-key generation remains visible", async () => {
    const first = deferred<{ ok: true; versions: { sheets: [] } }>();
    const second = deferred<{ ok: true; versions: { sheets: [] } }>();
    const patch = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const coordinator = createBoardWriteCoordinator("user-1", { attachLifecycle: false, patch });
    coordinator.setAuthoritativeBase(emptyBoard);
    const oldPatch = {
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    };
    coordinator.enqueueCompletion(oldPatch);
    const flushing = coordinator.flushPendingWrites();
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    coordinator.enqueueCompletion({ ...oldPatch, completed: false });

    first.resolve({ ok: true, versions: { sheets: [] } });
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(2));

    expect(coordinator.getAuthoritativeBase()?.completions[0]?.completed).toBe(1);
    expect(coordinator.getVisibleData()?.completions[0]?.completed).toBe(0);
    coordinator.discardAndDispose();
    second.resolve({ ok: true, versions: { sheets: [] } });
    await flushing.catch(() => undefined);
  });

  it("reverts a permanently rejected current generation to authoritative base without reload", async () => {
    const patch = vi.fn(async () => {
      throw new ApiClientError(422, "invalid_patch", "Locked cell");
    });
    const coordinator = createBoardWriteCoordinator("user-1", { attachLifecycle: false, patch });
    coordinator.setAuthoritativeBase(emptyBoard);
    coordinator.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    });

    await coordinator.flushPendingWrites();

    expect(coordinator.getVisibleData()?.completions).toEqual([]);
    expect(coordinator.getAuthoritativeBase()?.completions).toEqual([]);
    expect(coordinator.getSnapshot()).toMatchObject({ hasPendingWrites: false, pendingWriteError: "Locked cell" });
    coordinator.discardAndDispose();
  });

  it("clears the prior account overlay and queues before another account is constructed", () => {
    const first = createBoardWriteCoordinator("user-1", { attachLifecycle: false });
    first.setAuthoritativeBase(emptyBoard);
    first.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    });

    first.discardAndDispose();
    const second = createBoardWriteCoordinator("user-2", { attachLifecycle: false });

    expect(first.getSnapshot()).toEqual({ data: null, hasPendingWrites: false, pendingWriteError: null });
    expect(second.getSnapshot()).toEqual({ data: null, hasPendingWrites: false, pendingWriteError: null });
    second.discardAndDispose();
  });

  it("waits for both queues to settle before rejecting a failed flush", async () => {
    const completion = deferred<void>();
    const cellState = deferred<void>();
    const coordinator = createBoardWriteCoordinator("user-1", {
      attachLifecycle: false,
      queueOverrides: {
        completion: { flush: () => completion.promise },
        cellState: { flush: () => cellState.promise }
      }
    });
    let settled = false;
    const flushing = coordinator.flushPendingWrites().finally(() => {
      settled = true;
    });

    completion.reject(new Error("offline"));
    await Promise.resolve();
    expect(settled).toBe(false);
    cellState.resolve();

    await expect(flushing).rejects.toThrow("offline");
    coordinator.discardAndDispose();
  });
});
