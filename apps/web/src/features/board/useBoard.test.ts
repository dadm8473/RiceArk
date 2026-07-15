import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ApiClientError } from "../../api/client";
import {
  BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS,
  BOARD_VERSION_IDLE_CHECK_INTERVAL_MS,
  BOARD_WRITE_INVALIDATION_COALESCE_MS,
  BOARD_RECOVERY_READ_TIMEOUT_MS,
  buildLocalBoardPeriodFingerprint,
  buildBoardVersionKey,
  canClaimBoardPollingLeadership,
  createBoardInvalidationPublisher,
  createBoardReadGate,
  createBoardRecoveryReadOwner,
  createBoardReloadGate,
  createBoardVersionTracker,
  createBoardWriteCoordinator,
  formatBoardError,
  getBoardPollingDelayMs,
  getNextBoardPeriodBoundaryMs,
  mergeBoardVersionSummary,
  parseBoardPollingLeaderRecord,
  reportBoardReloadErrorIfCurrent,
  shouldReloadForBoardBroadcast
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

  it("does not publish a stale coordinator reload failure into a new account", () => {
    const oldCoordinator = {};
    const currentCoordinator = {};
    const report = vi.fn();

    expect(reportBoardReloadErrorIfCurrent(currentCoordinator, oldCoordinator, new Error("old failure"), report))
      .toBe(false);
    expect(report).not.toHaveBeenCalled();
    expect(reportBoardReloadErrorIfCurrent(currentCoordinator, currentCoordinator, new Error("current failure"), report))
      .toBe(true);
    expect(report).toHaveBeenCalledWith("current failure");
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

describe("board read generation isolation", () => {
  it("ignores an older success after a newer same-user load applies", async () => {
    const first = deferred<BoardPayload>();
    const second = deferred<BoardPayload>();
    const applied: BoardPayload[] = [];
    const failures: unknown[] = [];
    const read = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const gate = createBoardReadGate({
      read,
      onApplied: (payload) => applied.push(payload),
      onFailure: (error) => failures.push(error)
    });
    const older = gate.load(undefined);
    const newer = gate.load(undefined);
    const newerBoard = { ...emptyBoard, userId: "user-1-new" };

    second.resolve(newerBoard);
    await expect(newer).resolves.toMatchObject({ type: "applied", payload: newerBoard });
    first.resolve(emptyBoard);
    await expect(older).resolves.toEqual({ type: "stale" });

    expect(applied).toEqual([newerBoard]);
    expect(failures).toEqual([]);
    gate.dispose();
  });

  it("ignores an older failure after a newer same-user load applies", async () => {
    const first = deferred<BoardPayload>();
    const second = deferred<BoardPayload>();
    const applied = vi.fn();
    const onFailure = vi.fn();
    const gate = createBoardReadGate({
      read: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
      onApplied: applied,
      onFailure
    });
    const older = gate.load(undefined);
    const newer = gate.load(undefined);

    second.resolve(emptyBoard);
    await newer;
    first.reject(new Error("stale failure"));
    await expect(older).resolves.toEqual({ type: "stale" });

    expect(applied).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
    gate.dispose();
  });

  it("prefetches a version lower bound before the board GET", async () => {
    type VersionContext = {
      summary: null | { manifestVersion: number; sheets: Array<{ id: string; version: number }>; periodFingerprint: string };
    };
    const versionSummary = deferred<NonNullable<VersionContext["summary"]>>();
    const boardRead = deferred<BoardPayload>();
    const calls: string[] = [];
    const gate = createBoardReadGate<VersionContext>({
      prepare: async () => {
        calls.push("versions");
        return { summary: await versionSummary.promise };
      },
      read: async () => {
        calls.push("board");
        return boardRead.promise;
      },
      onApplied: vi.fn(),
      onFailure: vi.fn()
    });

    const loading = gate.load({ summary: null });
    expect(calls).toEqual(["versions"]);
    versionSummary.resolve({ manifestVersion: 1, sheets: [], periodFingerprint: "" });
    await vi.waitFor(() => expect(calls).toEqual(["versions", "board"]));
    boardRead.resolve(emptyBoard);
    await expect(loading).resolves.toMatchObject({ type: "applied" });
    gate.dispose();
  });

  it("invalidates a pre-acknowledgment GET before overlay removal and preserves the local mutation version", async () => {
    const oldBoardRead = deferred<BoardPayload>();
    const tracker = createBoardVersionTracker();
    tracker.apply({ manifestVersion: 1, sheets: [{ id: "sheet-1", version: 1 }], periodFingerprint: "" });
    let gate!: ReturnType<typeof createBoardReadGate<{ summary: { manifestVersion: number; sheets: Array<{ id: string; version: number }>; periodFingerprint: string } }>>;
    const coordinator = createBoardWriteCoordinator("user-1", {
      attachLifecycle: false,
      onBeforeAccepted: () => gate.invalidate(),
      onVersions: (versions) => tracker.apply(versions),
      patch: vi.fn(async () => ({
        ok: true as const,
        versions: { manifestVersion: 2, sheets: [{ id: "sheet-1", version: 5 }] }
      }))
    });
    coordinator.setAuthoritativeBase(emptyBoard);
    gate = createBoardReadGate({
      prepare: async (context) => {
        tracker.observe(context.summary);
        return context;
      },
      read: () => oldBoardRead.promise,
      onApplied: (payload, context) => {
        coordinator.setAuthoritativeBase(payload);
        tracker.apply(context.summary);
      },
      onFailure: vi.fn()
    });
    const oldLoad = gate.load({
      summary: { manifestVersion: 1, sheets: [{ id: "sheet-1", version: 2 }], periodFingerprint: "" }
    });
    const localPatch = {
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    };
    coordinator.enqueueCompletion(localPatch);

    await coordinator.flushPendingWrites();
    oldBoardRead.resolve(emptyBoard);
    await expect(oldLoad).resolves.toEqual({ type: "stale" });

    expect(coordinator.getAuthoritativeBase()?.completions).toEqual([
      expect.objectContaining({ row_item_id: "row-1", completed: 1 })
    ]);
    expect(tracker.getState()).toEqual({
      observed: { manifestVersion: 2, sheets: [{ id: "sheet-1", version: 5 }], periodFingerprint: "" },
      applied: { manifestVersion: 2, sheets: [{ id: "sheet-1", version: 5 }], periodFingerprint: "" }
    });
    gate.dispose();
    coordinator.discardAndDispose();
  });
});

describe("exclusive board recovery reads", () => {
  it("invalidates an older normal read and exclusively applies the recovery read", async () => {
    const olderRead = deferred<BoardPayload>();
    const recoveryRead = deferred<BoardPayload>();
    const recoveredBoard = { ...emptyBoard, userId: "recovered-user" };
    const applied: BoardPayload[] = [];
    const read = vi.fn()
      .mockImplementationOnce(() => olderRead.promise)
      .mockImplementationOnce(() => recoveryRead.promise);
    const gate = createBoardReadGate({
      read,
      onApplied: (payload) => applied.push(payload),
      onFailure: vi.fn()
    });
    const owner = createBoardRecoveryReadOwner({ gate });

    const older = owner.load(undefined);
    const recovery = owner.reconcile(undefined);
    recoveryRead.resolve(recoveredBoard);

    await expect(recovery).resolves.toBe(recoveredBoard);
    olderRead.resolve(emptyBoard);
    await expect(older).resolves.toEqual({ type: "stale" });
    expect(applied).toEqual([recoveredBoard]);
    expect(read).toHaveBeenCalledTimes(2);
    owner.dispose();
  });

  it("refuses normal and invalidation reads until recovery settles without superseding it", async () => {
    const recoveryRead = deferred<BoardPayload>();
    const laterRead = deferred<BoardPayload>();
    const read = vi.fn()
      .mockImplementationOnce(() => recoveryRead.promise)
      .mockImplementationOnce(() => laterRead.promise);
    const gate = createBoardReadGate({ read, onApplied: vi.fn(), onFailure: vi.fn() });
    const owner = createBoardRecoveryReadOwner({ gate });

    const recovery = owner.reconcile(undefined);
    await expect(owner.load(undefined)).resolves.toEqual({ type: "blocked" });
    owner.invalidate();
    await expect(owner.load(undefined)).resolves.toEqual({ type: "blocked" });
    expect(read).toHaveBeenCalledTimes(1);

    recoveryRead.resolve(emptyBoard);
    await expect(recovery).resolves.toBe(emptyBoard);

    const retryableInvalidation = owner.load(undefined);
    expect(read).toHaveBeenCalledTimes(2);
    laterRead.resolve(emptyBoard);
    await expect(retryableInvalidation).resolves.toMatchObject({ type: "applied" });
    owner.dispose();
  });

  it("retries a stale recovery generation within the same deadline", async () => {
    const staleRead = deferred<BoardPayload>();
    const retryRead = deferred<BoardPayload>();
    const recoveredBoard = { ...emptyBoard, userId: "retried-recovery" };
    const read = vi.fn()
      .mockImplementationOnce(() => staleRead.promise)
      .mockImplementationOnce(() => retryRead.promise);
    const gate = createBoardReadGate({ read, onApplied: vi.fn(), onFailure: vi.fn() });
    const owner = createBoardRecoveryReadOwner({ gate });

    const recovery = owner.reconcile(undefined);
    gate.invalidate();
    staleRead.resolve(emptyBoard);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    retryRead.resolve(recoveredBoard);

    await expect(recovery).resolves.toBe(recoveredBoard);
    owner.dispose();
  });

  it("times out a hung recovery, invalidates its late response, and restores normal reads", async () => {
    vi.useFakeTimers();
    try {
      const lateRecoveryRead = deferred<BoardPayload>();
      const normalRead = deferred<BoardPayload>();
      const currentBoard = { ...emptyBoard, userId: "current-after-timeout" };
      const applied: BoardPayload[] = [];
      const onTimeout = vi.fn();
      const read = vi.fn()
        .mockImplementationOnce(() => lateRecoveryRead.promise)
        .mockImplementationOnce(() => normalRead.promise);
      const gate = createBoardReadGate({
        read,
        onApplied: (payload) => applied.push(payload),
        onFailure: vi.fn()
      });
      const owner = createBoardRecoveryReadOwner({ gate, onTimeout });

      const recovery = owner.reconcile(undefined);
      const recoveryFailure = expect(recovery).rejects.toThrow(/10초/);
      await vi.advanceTimersByTimeAsync(BOARD_RECOVERY_READ_TIMEOUT_MS);
      await recoveryFailure;
      expect(onTimeout).toHaveBeenCalledTimes(1);

      const afterTimeout = owner.load(undefined);
      normalRead.resolve(currentBoard);
      await expect(afterTimeout).resolves.toMatchObject({ type: "applied", payload: currentBoard });

      lateRecoveryRead.resolve({ ...emptyBoard, userId: "late-recovery" });
      await vi.runAllTimersAsync();
      expect(applied).toEqual([currentBoard]);
      owner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("board observed and applied versions", () => {
  it("does not apply failed observations and never regresses a newer local mutation", () => {
    const tracker = createBoardVersionTracker();
    tracker.apply({ manifestVersion: 1, sheets: [{ id: "sheet-1", version: 1 }], periodFingerprint: "" });
    tracker.observe({ manifestVersion: 2, sheets: [{ id: "sheet-1", version: 2 }], periodFingerprint: "remote" });

    expect(tracker.getState().applied?.sheets).toEqual([{ id: "sheet-1", version: 1 }]);

    tracker.apply({ manifestVersion: 3, sheets: [{ id: "sheet-1", version: 5 }] });
    tracker.apply({ manifestVersion: 2, sheets: [{ id: "sheet-1", version: 2 }], periodFingerprint: "remote" });

    expect(tracker.getState()).toEqual({
      observed: { manifestVersion: 3, sheets: [{ id: "sheet-1", version: 5 }], periodFingerprint: "remote" },
      applied: { manifestVersion: 3, sheets: [{ id: "sheet-1", version: 5 }], periodFingerprint: "remote" }
    });
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

    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });

    expect(coordinator.getVisibleData()?.completions).toEqual([]);
    expect(coordinator.getAuthoritativeBase()?.completions).toEqual([]);
    expect(coordinator.getSnapshot()).toMatchObject({ hasPendingWrites: true, pendingWriteError: "Locked cell" });
    coordinator.discardAndDispose();
  });

  it("preserves a completion error when the cell-state queue succeeds", async () => {
    const patch = vi.fn(async (path: string) => {
      if (path === "/api/board/completions") {
        throw new ApiClientError(422, "invalid_patch", "Completion locked");
      }
      return { ok: true as const, versions: { sheets: [] } };
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
    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });
    coordinator.enqueueCellState({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      markType: "fixed",
      markIcon: "pin",
      memo: "saved"
    });

    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });

    expect(coordinator.getSnapshot().pendingWriteError).toBe("Completion locked");
    coordinator.discardAndDispose();
  });

  it("keeps both permanent queue errors until their retained intents are acknowledged", async () => {
    let completionFails = true;
    const patch = vi.fn(async (path: string) => {
      if (path === "/api/board/completions" && completionFails) {
        throw new ApiClientError(422, "invalid_completion", "Completion failed");
      }
      if (path === "/api/board/cell-states") {
        throw new ApiClientError(422, "invalid_cell_state", "Cell state failed");
      }
      return { ok: true as const, versions: { sheets: [] } };
    });
    const coordinator = createBoardWriteCoordinator("user-1", { attachLifecycle: false, patch });
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
      memo: "failed"
    });
    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });

    expect(coordinator.getSnapshot().pendingWriteError).toContain("Completion failed");
    expect(coordinator.getSnapshot().pendingWriteError).toContain("Cell state failed");

    completionFails = false;
    coordinator.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "row-2",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    });
    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });

    expect(coordinator.getSnapshot().pendingWriteError).toContain("Completion failed");
    expect(coordinator.getSnapshot().pendingWriteError).toContain("Cell state failed");
    coordinator.retryPendingWrites();
    expect(coordinator.getSnapshot().pendingWriteError).toContain("Completion failed");
    expect(coordinator.getSnapshot().pendingWriteError).toContain("Cell state failed");
    coordinator.discardAndDispose();
  });

  it("keeps a partial permanent rejection visible after the same queue accepts its remainder", async () => {
    const rejectedPatch = {
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    };
    const acceptedPatch = { ...rejectedPatch, rowItemId: "row-2" };
    const patch = vi.fn()
      .mockRejectedValueOnce(new ApiClientError(422, "invalid_completion", "Locked row", null, {
        rejectedKeys: [{
          tableId: rejectedPatch.tableId,
          rowItemId: rejectedPatch.rowItemId,
          columnItemId: rejectedPatch.columnItemId,
          periodKey: rejectedPatch.periodKey
        }]
      }))
      .mockResolvedValueOnce({ ok: true as const, versions: { sheets: [] } })
      .mockResolvedValueOnce({ ok: true as const, versions: { sheets: [] } });
    const coordinator = createBoardWriteCoordinator("user-1", { attachLifecycle: false, patch });
    coordinator.setAuthoritativeBase(emptyBoard);
    coordinator.enqueueCompletion(rejectedPatch);
    coordinator.enqueueCompletion(acceptedPatch);

    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });

    expect(patch).toHaveBeenCalledTimes(2);
    expect(coordinator.getSnapshot()).toMatchObject({
      hasPendingWrites: true,
      pendingWriteError: "Locked row"
    });
    expect(coordinator.getAuthoritativeBase()?.completions).toEqual([
      expect.objectContaining({ row_item_id: "row-2", completed: 1 })
    ]);

    coordinator.retryPendingWrites();
    expect(coordinator.getSnapshot()).toMatchObject({
      hasPendingWrites: true,
      pendingWriteError: "Locked row"
    });
    await expect(coordinator.flushPendingWrites()).resolves.toBeUndefined();
    expect(patch).toHaveBeenCalledTimes(3);
    expect(patch.mock.calls[2]?.[1]).toEqual({ patches: [rejectedPatch] });
    expect(coordinator.getSnapshot().pendingWriteError).toBeNull();
    coordinator.discardAndDispose();
  });

  it("keeps a permanently rejected retry blocked after making another network request", async () => {
    const rejectedPatch = {
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    };
    const patch = vi.fn(async (_path: string, _body: { patches: unknown[] }) => {
      throw new ApiClientError(422, "invalid_completion", "Still locked");
    });
    const coordinator = createBoardWriteCoordinator("user-1", { attachLifecycle: false, patch });
    coordinator.setAuthoritativeBase(emptyBoard);
    coordinator.enqueueCompletion(rejectedPatch);
    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });

    coordinator.retryPendingWrites();
    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });

    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1]?.[1]).toEqual({ patches: [rejectedPatch] });
    expect(coordinator.getSnapshot()).toMatchObject({
      hasPendingWrites: true,
      pendingWriteError: "Still locked"
    });
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

describe("board cross-tab invalidation", () => {
  it("reloads for a changed polling version announcement without reloading the same version", () => {
    expect(shouldReloadForBoardBroadcast("board-version-key", "v4", "v5", true)).toBe(true);
    expect(shouldReloadForBoardBroadcast("board-version-key", "v5", "v5", true)).toBe(false);
    expect(shouldReloadForBoardBroadcast("board-version-key", null, "v5", false)).toBe(false);
    expect(shouldReloadForBoardBroadcast("board-reload", null, "v5", false)).toBe(true);
  });

  it("coalesces a sender burst and publishes only the highest merged versions", async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    const publisher = createBoardInvalidationPublisher({
      sourceId: "tab-a",
      userId: "user-1",
      postMessage,
      versionKeyFor: (summary) => JSON.stringify(summary)
    });

    publisher.schedule({ manifestVersion: 2, sheets: [{ id: "sheet-1", version: 4 }], periodFingerprint: "" });
    publisher.schedule({ manifestVersion: 3, sheets: [{ id: "sheet-1", version: 6 }], periodFingerprint: "" });
    publisher.schedule({ manifestVersion: 2, sheets: [{ id: "sheet-1", version: 5 }], periodFingerprint: "" });
    await vi.advanceTimersByTimeAsync(BOARD_WRITE_INVALIDATION_COALESCE_MS - 1);
    expect(postMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "tab-a",
      userId: "user-1",
      type: "board-reload",
      summary: {
        manifestVersion: 3,
        sheets: [{ id: "sheet-1", version: 6 }],
        periodFingerprint: ""
      }
    }));
    publisher.dispose();
    vi.useRealTimers();
  });

  it("cancels a scheduled sender invalidation when disposed", async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    const publisher = createBoardInvalidationPublisher({
      sourceId: "tab-a",
      userId: "user-1",
      postMessage,
      versionKeyFor: (summary) => JSON.stringify(summary)
    });
    publisher.schedule({ manifestVersion: 2, sheets: [], periodFingerprint: "" });

    publisher.dispose();
    await vi.advanceTimersByTimeAsync(BOARD_WRITE_INVALIDATION_COALESCE_MS);

    expect(postMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("deduplicates same-version reload messages", async () => {
    const active = deferred<void>();
    const reload = vi.fn(() => active.promise);
    const gate = createBoardReloadGate({ userId: "user-1", reload });
    const message = {
      sourceId: "tab-a",
      userId: "user-1",
      type: "board-reload" as const,
      summary: { manifestVersion: 2, sheets: [{ id: "sheet-1", version: 4 }], periodFingerprint: "" },
      versionKey: "v4"
    };

    gate.receive(message);
    gate.receive(message);
    expect(reload).toHaveBeenCalledTimes(1);
    active.resolve();
    await Promise.resolve();
    await Promise.resolve();
    gate.receive(message);

    expect(reload).toHaveBeenCalledTimes(1);
    gate.dispose();
  });

  it("runs at most one active reload and one necessary newer trailing reload", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    let activeCount = 0;
    let maximumActive = 0;
    const reload = vi.fn(async () => {
      activeCount += 1;
      maximumActive = Math.max(maximumActive, activeCount);
      await (reload.mock.calls.length === 1 ? first.promise : second.promise);
      activeCount -= 1;
    });
    const gate = createBoardReloadGate({ userId: "user-1", reload });
    const message = (version: number) => ({
      sourceId: "tab-a",
      userId: "user-1",
      type: "board-reload" as const,
      summary: { manifestVersion: version, sheets: [{ id: "sheet-1", version }], periodFingerprint: "" },
      versionKey: `v${version}`
    });

    gate.receive(message(4));
    gate.receive(message(5));
    gate.receive(message(6));
    expect(reload).toHaveBeenCalledTimes(1);

    first.resolve();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(1);
    second.resolve();
    await Promise.resolve();
    gate.dispose();
  });

  it("ignores invalidations for another user", () => {
    const reload = vi.fn(async () => undefined);
    const gate = createBoardReloadGate({ userId: "user-1", reload });

    gate.receive({
      sourceId: "tab-b",
      userId: "user-2",
      type: "board-reload",
      summary: { manifestVersion: 9, sheets: [], periodFingerprint: "" },
      versionKey: "v9"
    });

    expect(reload).not.toHaveBeenCalled();
    gate.dispose();
  });

  it("contains a reload rejection and allows the same invalidation to retry later", async () => {
    const reload = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const gate = createBoardReloadGate({ userId: "user-1", reload });
    const message = {
      sourceId: "tab-a",
      userId: "user-1",
      type: "board-reload" as const,
      summary: { manifestVersion: 2, sheets: [], periodFingerprint: "" },
      versionKey: "v2"
    };

    gate.receive(message);
    await Promise.resolve();
    await Promise.resolve();
    gate.receive(message);

    expect(reload).toHaveBeenCalledTimes(2);
    gate.dispose();
  });

  it("keeps a failed version-key catch-up unapplied, retries it, then deduplicates it", async () => {
    const tracker = createBoardVersionTracker();
    tracker.apply({ manifestVersion: 1, sheets: [], periodFingerprint: "" });
    const appliedVersionKey = () => {
      const applied = tracker.getState().applied;
      return applied ? buildBoardVersionKey(applied, emptyBoard) : null;
    };
    const reload = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const gate = createBoardReloadGate({
      userId: "user-1",
      reload,
      onApplied: (message) => {
        tracker.apply(message.summary);
      }
    });
    const announcement = {
      sourceId: "tab-a",
      userId: "user-1",
      type: "board-version-key" as const,
      summary: { manifestVersion: 2, sheets: [], periodFingerprint: "" },
      versionKey: "v2"
    };
    const receive = () => {
      const observed = tracker.observe(announcement.summary);
      const observedVersionKey = buildBoardVersionKey(observed, emptyBoard);
      if (shouldReloadForBoardBroadcast(announcement.type, appliedVersionKey(), observedVersionKey, true)) {
        gate.receive({ ...announcement, type: "board-reload", summary: observed, versionKey: observedVersionKey });
      }
    };

    receive();
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.getState().applied?.manifestVersion).toBe(1);

    receive();
    await Promise.resolve();
    await Promise.resolve();
    expect(tracker.getState().applied?.manifestVersion).toBe(2);

    receive();
    tracker.apply({ manifestVersion: 3, sheets: [{ id: "sheet-1", version: 5 }] });
    receive();
    expect(tracker.getState().applied).toMatchObject({
      manifestVersion: 3,
      sheets: [{ id: "sheet-1", version: 5 }]
    });
    expect(reload).toHaveBeenCalledTimes(2);
    gate.dispose();
  });
});
