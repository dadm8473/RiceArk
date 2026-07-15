import { useCallback, useEffect, useRef, useState } from "react";
import { getPeriodKey, type ResetRule } from "@riceark/core";
import { ApiClientError, apiGet } from "../../api/client";
import { applyBoardCompletionPatch, type BoardCompletionPatch } from "./completions";
import { applyBoardCellStatePatch, type BoardCellStatePatch } from "./cellStates";
import { buildLocalBoardPeriodFingerprint } from "./boardSheetCache";
import type { BoardDisplaySettings, BoardMutationVersions, BoardPayload } from "./types";
import { attachBoardQueueLifecycle, createBoardCompletionQueue, type BoardPatchApi } from "./useBoardCompletionQueue";
import { createBoardCellStateQueue } from "./useBoardCellStateQueue";
import { ReliablePatchQueueFlushError } from "./reliablePatchQueue";

export { buildLocalBoardPeriodFingerprint };

export const BOARD_VERSION_CHECK_INTERVAL_MS = 120_000;
export const BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS = BOARD_VERSION_CHECK_INTERVAL_MS;
export const BOARD_VERSION_IDLE_CHECK_INTERVAL_MS = 5 * 60_000;
export const BOARD_WRITE_INVALIDATION_COALESCE_MS = 150;
export const BOARD_RECOVERY_READ_TIMEOUT_MS = 10_000;
const BOARD_VERSION_IDLE_AFTER_MS = 5 * 60_000;
const BOARD_VERSION_LEADER_STORAGE_KEY = "riceark-board-polling-leader";
const BOARD_VERSION_LEADER_TTL_MS = 45_000;
const BOARD_VERSION_LEADER_HEARTBEAT_MS = 15_000;
const BOARD_VERSION_BROADCAST_CHANNEL = "riceark-board-polling";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface BoardVersionSummary {
  manifestVersion: number;
  sheets: Array<{ id: string; version: number }>;
  periodFingerprint: string;
  settings?: BoardDisplaySettings | undefined;
}

type BoardVersionUpdate = Pick<BoardMutationVersions, "sheets" | "manifestVersion"> & {
  periodFingerprint?: string | undefined;
  settings?: BoardDisplaySettings | undefined;
};

export function mergeBoardVersionSummary(
  current: BoardVersionSummary | null,
  incoming: BoardVersionUpdate
): BoardVersionSummary {
  const sheetVersions = new Map(current?.sheets.map(({ id, version }) => [id, version]) ?? []);
  for (const sheet of incoming.sheets) {
    sheetVersions.set(sheet.id, Math.max(sheetVersions.get(sheet.id) ?? 0, sheet.version));
  }
  const settings = incoming.settings ?? current?.settings;
  return {
    manifestVersion: Math.max(current?.manifestVersion ?? 0, incoming.manifestVersion ?? 0),
    sheets: [...sheetVersions].map(([id, version]) => ({ id, version })),
    periodFingerprint:
      incoming.periodFingerprint !== undefined
        ? incoming.periodFingerprint
        : (current?.periodFingerprint ?? ""),
    ...(settings === undefined ? {} : { settings })
  };
}

export interface BoardVersionTrackerState {
  observed: BoardVersionSummary | null;
  applied: BoardVersionSummary | null;
}

export interface BoardVersionTracker {
  observe: (summary: BoardVersionUpdate) => BoardVersionSummary;
  apply: (summary: BoardVersionUpdate) => BoardVersionSummary;
  getState: () => BoardVersionTrackerState;
}

export function createBoardVersionTracker(): BoardVersionTracker {
  let observed: BoardVersionSummary | null = null;
  let applied: BoardVersionSummary | null = null;

  return {
    observe: (summary) => {
      observed = mergeBoardVersionSummary(observed, summary);
      return observed;
    },
    apply: (summary) => {
      observed = mergeBoardVersionSummary(observed, summary);
      applied = mergeBoardVersionSummary(applied, summary);
      return applied;
    },
    getState: () => ({ observed, applied })
  };
}

export type BoardReadGateResult =
  | { type: "applied"; payload: BoardPayload }
  | { type: "failed"; error: unknown }
  | { type: "stale" };

export interface BoardReadGate<Context = void> {
  load: (context: Context) => Promise<BoardReadGateResult>;
  invalidate: () => void;
  dispose: () => void;
}

export function createBoardReadGate<Context = void>(options: {
  prepare?: ((context: Context) => Promise<Context>) | undefined;
  read: () => Promise<BoardPayload>;
  onApplied: (payload: BoardPayload, context: Context) => void;
  onFailure: (error: unknown, context: Context) => void;
}): BoardReadGate<Context> {
  let generation = 0;
  let disposed = false;

  return {
    load: async (context) => {
      const requestGeneration = ++generation;
      try {
        const preparedContext = options.prepare ? await options.prepare(context) : context;
        if (disposed || requestGeneration !== generation) return { type: "stale" };
        const payload = await options.read();
        if (disposed || requestGeneration !== generation) return { type: "stale" };
        options.onApplied(payload, preparedContext);
        return { type: "applied", payload };
      } catch (error) {
        if (disposed || requestGeneration !== generation) return { type: "stale" };
        options.onFailure(error, context);
        return { type: "failed", error };
      }
    },
    invalidate: () => {
      generation += 1;
    },
    dispose: () => {
      disposed = true;
      generation += 1;
    }
  };
}

export class BoardRecoveryReadTimeoutError extends Error {
  constructor() {
    super("로그아웃 복구를 위한 보드 새로고침이 10초 안에 완료되지 않았습니다.");
    this.name = "BoardRecoveryReadTimeoutError";
  }
}

export type BoardOwnedReadResult = BoardReadGateResult | { type: "blocked" };

export interface BoardRecoveryReadOwner<Context = void> {
  load: (context: Context) => Promise<BoardOwnedReadResult>;
  invalidate: () => void;
  reconcile: (context: Context) => Promise<BoardPayload>;
  isRecovering: () => boolean;
  dispose: () => void;
}

export function createBoardRecoveryReadOwner<Context = void>(options: {
  gate: BoardReadGate<Context>;
  timeoutMs?: number | undefined;
  onTimeout?: ((error: BoardRecoveryReadTimeoutError) => void) | undefined;
}): BoardRecoveryReadOwner<Context> {
  let disposed = false;
  let recovering = false;
  let activeRecovery: Promise<BoardPayload> | null = null;
  let cancelRecovery: ((error: Error) => void) | null = null;

  const createDisposedError = () => new Error("Board recovery read owner was disposed");

  const reconcile = (context: Context): Promise<BoardPayload> => {
    if (disposed) return Promise.reject(createDisposedError());
    if (activeRecovery) return activeRecovery;

    recovering = true;
    options.gate.invalidate();

    const runRecovery = async () => {
      const timeoutError = new BoardRecoveryReadTimeoutError();
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          options.gate.invalidate();
          try {
            options.onTimeout?.(timeoutError);
          } catch {
            // Recovery state observers cannot extend or break the deadline.
          }
          reject(timeoutError);
        }, options.timeoutMs ?? BOARD_RECOVERY_READ_TIMEOUT_MS);
      });
      const cancellation = new Promise<never>((_resolve, reject) => {
        cancelRecovery = reject;
      });
      const loadUntilApplied = async (): Promise<BoardPayload> => {
        while (!timedOut && !disposed) {
          const result = await options.gate.load(context);
          if (timedOut) throw timeoutError;
          if (disposed) throw createDisposedError();
          if (result.type === "applied") return result.payload;
          if (result.type === "failed") throw result.error;
        }
        throw timedOut ? timeoutError : createDisposedError();
      };
      const loading = loadUntilApplied();
      void loading.catch(() => undefined);

      try {
        return await Promise.race([loading, deadline, cancellation]);
      } finally {
        if (timeout !== null) clearTimeout(timeout);
        cancelRecovery = null;
      }
    };

    activeRecovery = runRecovery().finally(() => {
      recovering = false;
      activeRecovery = null;
    });
    return activeRecovery;
  };

  return {
    load: (context) => {
      if (disposed) return Promise.resolve({ type: "stale" });
      if (recovering) return Promise.resolve({ type: "blocked" });
      return options.gate.load(context);
    },
    invalidate: () => {
      if (!disposed && !recovering) options.gate.invalidate();
    },
    reconcile,
    isRecovering: () => recovering,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      options.gate.dispose();
      cancelRecovery?.(createDisposedError());
    }
  };
}

export interface BoardWriteSnapshot {
  data: BoardPayload | null;
  hasPendingWrites: boolean;
  pendingWriteError: string | null;
}

interface BoardQueueControl<T> {
  enqueue: (patch: T) => void;
  flush: () => Promise<void>;
  retry: () => void;
  discard: () => T[];
  dispose: () => T[];
  getPendingSnapshot: () => T[];
  getRejectedSnapshot: () => T[];
}

interface BoardWriteCoordinatorOptions {
  attachLifecycle?: boolean | undefined;
  onChange?: ((snapshot: BoardWriteSnapshot) => void) | undefined;
  onBeforeAccepted?: (() => void) | undefined;
  onVersions?: ((versions: BoardMutationVersions) => void) | undefined;
  patch?: BoardPatchApi | undefined;
  queueOverrides?: {
    completion?: Partial<BoardQueueControl<BoardCompletionPatch>> | undefined;
    cellState?: Partial<BoardQueueControl<BoardCellStatePatch>> | undefined;
  } | undefined;
}

export interface BoardWriteCoordinator {
  readonly userId: string;
  setAuthoritativeBase: (payload: BoardPayload) => void;
  getAuthoritativeBase: () => BoardPayload | null;
  getVisibleData: () => BoardPayload | null;
  getSnapshot: () => BoardWriteSnapshot;
  enqueueCompletion: (patch: BoardCompletionPatch) => void;
  enqueueCellState: (patch: BoardCellStatePatch) => void;
  flushPendingWrites: () => Promise<void>;
  retryPendingWrites: () => void;
  discardPendingWrites: () => void;
  discardAndDispose: () => void;
}

function applyBoardWriteOverlays(
  base: BoardPayload | null,
  completionPatches: BoardCompletionPatch[],
  cellStatePatches: BoardCellStatePatch[]
): BoardPayload | null {
  if (!base) return null;
  return {
    ...base,
    completions: completionPatches.reduce(
      (completions, patch) => applyBoardCompletionPatch(completions, patch),
      base.completions
    ),
    cellStates: cellStatePatches.reduce(
      (cellStates, patch) => applyBoardCellStatePatch(cellStates, patch),
      base.cellStates
    )
  };
}

function formatPendingWriteError(error: unknown): string {
  return error instanceof Error ? error.message : "변경사항을 저장하지 못했습니다.";
}

export function createBoardWriteCoordinator(
  userId: string,
  options: BoardWriteCoordinatorOptions = {}
): BoardWriteCoordinator {
  let authoritativeBase: BoardPayload | null = null;
  let pendingCompletions: BoardCompletionPatch[] = [];
  let pendingCellStates: BoardCellStatePatch[] = [];
  let completionWriteError: string | null = null;
  let completionPermanentWriteError: string | null = null;
  let cellStateWriteError: string | null = null;
  let cellStatePermanentWriteError: string | null = null;
  let disposed = false;

  const getVisibleData = () => applyBoardWriteOverlays(authoritativeBase, pendingCompletions, pendingCellStates);
  const getPendingWriteError = () => {
    const errors = [
      completionPermanentWriteError,
      completionWriteError,
      cellStatePermanentWriteError,
      cellStateWriteError
    ].filter(
      (error): error is string => error !== null
    );
    return [...new Set(errors)].join(" ") || null;
  };
  const getSnapshot = (): BoardWriteSnapshot => ({
    data: getVisibleData(),
    hasPendingWrites:
      pendingCompletions.length > 0 ||
      pendingCellStates.length > 0 ||
      completionQueue.getRejectedSnapshot().length > 0 ||
      cellStateQueue.getRejectedSnapshot().length > 0,
    pendingWriteError: getPendingWriteError()
  });
  const emit = () => {
    if (!disposed) options.onChange?.(getSnapshot());
  };
  const reportCompletionFailure = (message: string) => {
    if (disposed) return;
    completionWriteError = message;
    emit();
  };
  const reportCellStateFailure = (message: string) => {
    if (disposed) return;
    cellStateWriteError = message;
    emit();
  };
  const reportCompletionPermanentFailure = (message: string) => {
    if (disposed) return;
    completionPermanentWriteError = message;
    emit();
  };
  const reportCellStatePermanentFailure = (message: string) => {
    if (disposed) return;
    cellStatePermanentWriteError = message;
    emit();
  };

  const completionQueue = createBoardCompletionQueue({
    ...(options.patch ? { patch: options.patch } : {}),
    onPendingChange: (patches) => {
      pendingCompletions = patches;
      emit();
    },
    onAccepted: (patches) => {
      if (disposed) return;
      try {
        options.onBeforeAccepted?.();
      } catch {
        // Read invalidation is isolated from the accepted base commit.
      }
      if (authoritativeBase) {
        authoritativeBase = {
          ...authoritativeBase,
          completions: patches.reduce(
            (completions, patch) => applyBoardCompletionPatch(completions, patch),
            authoritativeBase.completions
          )
        };
      }
      completionWriteError = null;
      if (completionQueue.getRejectedSnapshot().length === 0) {
        completionPermanentWriteError = null;
      }
      emit();
    },
    onPermanentFailure: (outcome) => reportCompletionPermanentFailure(outcome.message),
    onAuthPause: (error) => reportCompletionFailure(error.message),
    ...(options.onVersions ? { onVersions: options.onVersions } : {})
  });
  const cellStateQueue = createBoardCellStateQueue({
    ...(options.patch ? { patch: options.patch } : {}),
    onPendingChange: (patches) => {
      pendingCellStates = patches;
      emit();
    },
    onAccepted: (patches) => {
      if (disposed) return;
      try {
        options.onBeforeAccepted?.();
      } catch {
        // Read invalidation is isolated from the accepted base commit.
      }
      if (authoritativeBase) {
        authoritativeBase = {
          ...authoritativeBase,
          cellStates: patches.reduce(
            (cellStates, patch) => applyBoardCellStatePatch(cellStates, patch),
            authoritativeBase.cellStates
          )
        };
      }
      cellStateWriteError = null;
      if (cellStateQueue.getRejectedSnapshot().length === 0) {
        cellStatePermanentWriteError = null;
      }
      emit();
    },
    onPermanentFailure: (outcome) => reportCellStatePermanentFailure(outcome.message),
    onAuthPause: (error) => reportCellStateFailure(error.message),
    ...(options.onVersions ? { onVersions: options.onVersions } : {})
  });
  Object.assign(completionQueue, options.queueOverrides?.completion);
  Object.assign(cellStateQueue, options.queueOverrides?.cellState);
  const detachLifecycle = options.attachLifecycle === false
    ? () => undefined
    : attachBoardQueueLifecycle({ queues: [completionQueue, cellStateQueue] });

  const discardPendingWrites = () => {
    completionQueue.discard();
    cellStateQueue.discard();
    pendingCompletions = [];
    pendingCellStates = [];
    completionWriteError = null;
    completionPermanentWriteError = null;
    cellStateWriteError = null;
    cellStatePermanentWriteError = null;
    emit();
  };

  return {
    userId,
    setAuthoritativeBase: (payload) => {
      if (disposed) return;
      authoritativeBase = payload;
      emit();
    },
    getAuthoritativeBase: () => authoritativeBase,
    getVisibleData,
    getSnapshot,
    enqueueCompletion: (patch) => completionQueue.enqueue(patch),
    enqueueCellState: (patch) => cellStateQueue.enqueue(patch),
    flushPendingWrites: async () => {
      const results = await Promise.allSettled([completionQueue.flush(), cellStateQueue.flush()]);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (
        results[0].status === "rejected" &&
        !(results[0].reason instanceof ReliablePatchQueueFlushError && results[0].reason.reason === "rejected")
      ) {
        completionWriteError = formatPendingWriteError(results[0].reason);
      }
      if (
        results[1].status === "rejected" &&
        !(results[1].reason instanceof ReliablePatchQueueFlushError && results[1].reason.reason === "rejected")
      ) {
        cellStateWriteError = formatPendingWriteError(results[1].reason);
      }
      if (failure) {
        emit();
        throw failure.reason;
      }
      const permanentWriteError = getPendingWriteError();
      if (completionPermanentWriteError || cellStatePermanentWriteError) {
        emit();
        throw new ReliablePatchQueueFlushError(
          "rejected",
          permanentWriteError ? new Error(permanentWriteError) : undefined
        );
      }
    },
    retryPendingWrites: () => {
      completionWriteError = null;
      cellStateWriteError = null;
      completionQueue.retry();
      cellStateQueue.retry();
      emit();
    },
    discardPendingWrites,
    discardAndDispose: () => {
      if (disposed) return;
      disposed = true;
      detachLifecycle();
      completionQueue.discard();
      cellStateQueue.discard();
      completionQueue.dispose();
      cellStateQueue.dispose();
      authoritativeBase = null;
      pendingCompletions = [];
      pendingCellStates = [];
      completionWriteError = null;
      completionPermanentWriteError = null;
      cellStateWriteError = null;
      cellStatePermanentWriteError = null;
    }
  };
}

interface BoardPeriodFingerprintSource {
  axisItems: Array<{ kind: string; task_reset_rule_json?: string | null | undefined }>;
}

interface BoardPollingLeaderRecord {
  id: string;
  expiresAt: number;
}

export interface BoardPollingBroadcastMessage {
  sourceId: string;
  userId: string;
  type: "board-version-key" | "board-reload";
  summary: BoardVersionSummary;
  versionKey: string;
}

export function shouldReloadForBoardBroadcast(
  type: BoardPollingBroadcastMessage["type"],
  previousVersionKey: string | null,
  nextVersionKey: string,
  hasLoadedBoard: boolean
): boolean {
  return type === "board-reload" || (hasLoadedBoard && previousVersionKey !== nextVersionKey);
}

interface BoardInvalidationPublisher {
  schedule: (summary: BoardVersionSummary) => void;
  dispose: () => void;
}

export function createBoardInvalidationPublisher(options: {
  sourceId: string;
  userId: string;
  postMessage: (message: BoardPollingBroadcastMessage) => void;
  versionKeyFor: (summary: BoardVersionSummary) => string;
}): BoardInvalidationPublisher {
  let pendingSummary: BoardVersionSummary | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  return {
    schedule: (summary) => {
      if (disposed) return;
      pendingSummary = mergeBoardVersionSummary(pendingSummary, summary);
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        const nextSummary = pendingSummary;
        pendingSummary = null;
        if (disposed || !nextSummary) return;
        options.postMessage({
          sourceId: options.sourceId,
          userId: options.userId,
          type: "board-reload",
          summary: nextSummary,
          versionKey: options.versionKeyFor(nextSummary)
        });
      }, BOARD_WRITE_INVALIDATION_COALESCE_MS);
    },
    dispose: () => {
      disposed = true;
      pendingSummary = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }
  };
}

function invalidationAdvances(
  candidate: BoardPollingBroadcastMessage,
  baseline: BoardPollingBroadcastMessage
): boolean {
  if (candidate.summary.manifestVersion > baseline.summary.manifestVersion) return true;
  const baselineSheets = new Map(baseline.summary.sheets.map(({ id, version }) => [id, version]));
  if (candidate.summary.sheets.some(({ id, version }) => version > (baselineSheets.get(id) ?? 0))) return true;
  return candidate.versionKey !== baseline.versionKey
    && candidate.summary.manifestVersion >= baseline.summary.manifestVersion
    && candidate.summary.sheets.every(({ id, version }) => version >= (baselineSheets.get(id) ?? 0));
}

function mergeBoardInvalidations(
  current: BoardPollingBroadcastMessage,
  incoming: BoardPollingBroadcastMessage
): BoardPollingBroadcastMessage {
  const useIncomingVersionKey = invalidationAdvances(incoming, current);
  return {
    ...current,
    summary: mergeBoardVersionSummary(current.summary, incoming.summary),
    versionKey: useIncomingVersionKey ? incoming.versionKey : current.versionKey
  };
}

export function createBoardReloadGate(options: {
  userId: string;
  reload: (message: BoardPollingBroadcastMessage) => Promise<unknown>;
  onApplied?: ((message: BoardPollingBroadcastMessage) => void) | undefined;
}): { receive: (message: BoardPollingBroadcastMessage) => void; dispose: () => void } {
  let active: BoardPollingBroadcastMessage | null = null;
  let trailing: BoardPollingBroadcastMessage | null = null;
  let completed: BoardPollingBroadcastMessage | null = null;
  let disposed = false;

  const start = (message: BoardPollingBroadcastMessage) => {
    if (disposed) return;
    active = message;
    let reloadPromise: Promise<unknown>;
    try {
      reloadPromise = Promise.resolve(options.reload(message));
    } catch (error) {
      reloadPromise = Promise.reject(error);
    }
    reloadPromise.then(
      () => finish(message, true),
      () => finish(message, false)
    );
  };

  const finish = (message: BoardPollingBroadcastMessage, succeeded: boolean) => {
    if (disposed || active !== message) return;
    if (succeeded) {
      try {
        options.onApplied?.(message);
      } catch {
        // Applied-state observers must not turn a completed reload into another request.
      }
      completed = completed ? mergeBoardInvalidations(completed, message) : message;
    }
    active = null;
    const next = trailing;
    trailing = null;
    if (next && (!completed || invalidationAdvances(next, completed))) start(next);
  };

  return {
    receive: (message) => {
      if (disposed || message.userId !== options.userId || message.type !== "board-reload") return;
      if (active) {
        if (!invalidationAdvances(message, active)) return;
        trailing = trailing ? mergeBoardInvalidations(trailing, message) : message;
        return;
      }
      if (completed && !invalidationAdvances(message, completed)) return;
      start(message);
    },
    dispose: () => {
      disposed = true;
      active = null;
      trailing = null;
      completed = null;
    }
  };
}

export function getBoardPollingDelayMs(lastActivityAtMs: number, nowMs = Date.now()): number {
  return nowMs - lastActivityAtMs >= BOARD_VERSION_IDLE_AFTER_MS
    ? BOARD_VERSION_IDLE_CHECK_INTERVAL_MS
    : BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS;
}

export function parseBoardPollingLeaderRecord(value: string | null | undefined): BoardPollingLeaderRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<BoardPollingLeaderRecord>;
    return typeof parsed.id === "string" && typeof parsed.expiresAt === "number"
      ? { id: parsed.id, expiresAt: parsed.expiresAt }
      : null;
  } catch {
    return null;
  }
}

export function canClaimBoardPollingLeadership(
  current: BoardPollingLeaderRecord | null,
  clientId: string,
  nowMs = Date.now()
): boolean {
  return current === null || current.id === clientId || current.expiresAt <= nowMs;
}

function createBoardPollingClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readBoardPollingLeader(storage: Storage | null | undefined): BoardPollingLeaderRecord | null {
  try {
    return parseBoardPollingLeaderRecord(storage?.getItem(BOARD_VERSION_LEADER_STORAGE_KEY));
  } catch {
    return null;
  }
}

function claimBoardPollingLeadership(storage: Storage | null | undefined, clientId: string, nowMs = Date.now()): boolean {
  if (!storage) return true;
  try {
    const current = readBoardPollingLeader(storage);
    if (!canClaimBoardPollingLeadership(current, clientId, nowMs)) return false;
    storage.setItem(
      BOARD_VERSION_LEADER_STORAGE_KEY,
      JSON.stringify({ id: clientId, expiresAt: nowMs + BOARD_VERSION_LEADER_TTL_MS })
    );
    return readBoardPollingLeader(storage)?.id === clientId;
  } catch {
    return true;
  }
}

function releaseBoardPollingLeadership(storage: Storage | null | undefined, clientId: string): void {
  if (!storage) return;
  try {
    if (readBoardPollingLeader(storage)?.id === clientId) storage.removeItem(BOARD_VERSION_LEADER_STORAGE_KEY);
  } catch {
    // If storage is unavailable, the tab simply falls back to local polling.
  }
}

function getBrowserLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseResetRuleValue(value: string | null | undefined): ResetRule | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ResetRule;
  } catch {
    return null;
  }
}

function kstDateParts(date: Date): { year: number; month: number; day: number; weekday: number } {
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay()
  };
}

function kstDateAtHourUtcMs(parts: { year: number; month: number; day: number }, hour: number): number {
  return Date.UTC(parts.year, parts.month, parts.day, hour - 9, 0, 0, 0);
}

function parseDateKeyUtcMs(value: string, hour: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour - 9, 0, 0, 0);
}

function getNextResetBoundaryMs(rule: ResetRule, now: Date): number | null {
  if (rule.type === "none") return null;

  const nowMs = now.getTime();
  const parts = kstDateParts(now);

  if (rule.type === "daily") {
    const todayResetMs = kstDateAtHourUtcMs(parts, rule.hour);
    return todayResetMs > nowMs ? todayResetMs : todayResetMs + DAY_MS;
  }

  if (rule.type === "weekly") {
    const daysUntilReset = (rule.weekday - parts.weekday + 7) % 7;
    const resetMs = kstDateAtHourUtcMs(
      { year: parts.year, month: parts.month, day: parts.day + daysUntilReset },
      rule.hour
    );
    return resetMs > nowMs ? resetMs : resetMs + 7 * DAY_MS;
  }

  if (rule.type === "biweekly") {
    const weeklyRule: ResetRule = { type: "weekly", weekday: rule.weekday, hour: rule.hour, timezone: rule.timezone };
    let candidate = getNextResetBoundaryMs(weeklyRule, now);
    if (candidate === null) return null;
    for (let index = 0; index < 4; index += 1) {
      const before = new Date(candidate - 1);
      const after = new Date(candidate + 1);
      if (getPeriodKey(rule, before) !== getPeriodKey(rule, after)) return candidate;
      candidate += 7 * DAY_MS;
    }
    return candidate;
  }

  const anchorMs = parseDateKeyUtcMs(rule.anchorDate, rule.hour);
  if (anchorMs === null) return null;
  const intervalMs = Math.max(1, rule.intervalDays) * DAY_MS;
  const intervalsSinceAnchor = Math.floor((nowMs - anchorMs) / intervalMs) + 1;
  const candidate = anchorMs + intervalsSinceAnchor * intervalMs;
  return candidate > nowMs ? candidate : candidate + intervalMs;
}

export function getNextBoardPeriodBoundaryMs(
  board: BoardPeriodFingerprintSource | null | undefined,
  now = new Date()
): number | null {
  if (!board) return null;
  const boundaries = board.axisItems.flatMap((item) => {
    if (item.kind !== "task") return [];
    const rule = parseResetRuleValue(item.task_reset_rule_json);
    if (!rule) return [];
    const boundary = getNextResetBoundaryMs(rule, now);
    return boundary === null ? [] : [boundary];
  });
  return boundaries.length === 0 ? null : Math.min(...boundaries);
}

export function formatBoardError(err: unknown): string {
  if (err instanceof ApiClientError && err.code === "unauthorized") {
    return "로그인이 필요합니다. Discord 또는 Google로 로그인해주세요.";
  }
  return err instanceof Error ? err.message : "보드 데이터를 불러오지 못했습니다.";
}

export function reportBoardReloadErrorIfCurrent(
  currentCoordinator: object | null,
  expectedCoordinator: object,
  error: unknown,
  report: (message: string) => void
): boolean {
  if (currentCoordinator !== expectedCoordinator) return false;
  report(formatBoardError(error));
  return true;
}

export function buildBoardVersionKey(
  summary: BoardVersionSummary,
  board: BoardPeriodFingerprintSource | null | undefined,
  now = new Date()
): string {
  return JSON.stringify({
    ...summary,
    periodFingerprint: buildLocalBoardPeriodFingerprint(board, now)
  });
}

interface BoardReadContext {
  refreshVersion: boolean;
  lowerBoundSummary?: BoardVersionSummary | null | undefined;
}

interface BoardReadScope {
  userId: string;
  coordinator: BoardWriteCoordinator;
  owner: BoardRecoveryReadOwner<BoardReadContext>;
}

export function useBoard({
  enabled = true,
  pollingEnabled = enabled,
  userId = null
}: { enabled?: boolean | undefined; pollingEnabled?: boolean | undefined; userId?: string | null | undefined } = {}) {
  const [data, setData] = useState<BoardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasPendingWrites, setHasPendingWrites] = useState(false);
  const [pendingWriteError, setPendingWriteError] = useState<string | null>(null);
  const dataRef = useRef<BoardPayload | null>(null);
  const enabledRef = useRef(enabled);
  const coordinatorRef = useRef<BoardWriteCoordinator | null>(null);
  const boardReadScopeRef = useRef<BoardReadScope | null>(null);
  const appliedVersionKeyRef = useRef<string | null>(null);
  const versionTrackerRef = useRef<BoardVersionTracker>(createBoardVersionTracker());
  const lastActivityAtRef = useRef(Date.now());
  const pollingClientIdRef = useRef<string | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);
  const invalidationPublisherRef = useRef<BoardInvalidationPublisher | null>(null);
  enabledRef.current = enabled;

  function setBoardData(payload: BoardPayload | null) {
    dataRef.current = payload;
    setData(payload);
  }

  const handleMutationVersions = useCallback((versions: BoardMutationVersions) => {
    const summary = versionTrackerRef.current.apply(versions);
    const versionKey = buildBoardVersionKey(summary, dataRef.current);
    appliedVersionKeyRef.current = versionKey;
    invalidationPublisherRef.current?.schedule(summary);
  }, []);

  useEffect(() => {
    boardReadScopeRef.current?.owner.dispose();
    boardReadScopeRef.current = null;
    const previous = coordinatorRef.current;
    if (previous) {
      previous.discardAndDispose();
      coordinatorRef.current = null;
    }
    invalidationPublisherRef.current?.dispose();
    invalidationPublisherRef.current = null;
    setBoardData(null);
    setHasPendingWrites(false);
    setPendingWriteError(null);
    appliedVersionKeyRef.current = null;
    const versionTracker = createBoardVersionTracker();
    versionTrackerRef.current = versionTracker;
    if (!userId) return;

    const clientId = pollingClientIdRef.current ?? createBoardPollingClientId();
    pollingClientIdRef.current = clientId;
    const invalidationPublisher = createBoardInvalidationPublisher({
      sourceId: clientId,
      userId,
      postMessage: (message) => broadcastChannelRef.current?.postMessage(message),
      versionKeyFor: (summary) => buildBoardVersionKey(summary, dataRef.current)
    });
    invalidationPublisherRef.current = invalidationPublisher;
    let readGate: BoardReadGate<BoardReadContext> | null = null;
    const coordinator = createBoardWriteCoordinator(userId, {
      onChange: (snapshot) => {
        setHasPendingWrites(snapshot.hasPendingWrites);
        setPendingWriteError(snapshot.pendingWriteError);
        setBoardData(enabledRef.current ? snapshot.data : null);
      },
      onBeforeAccepted: () => readGate?.invalidate(),
      onVersions: handleMutationVersions
    });
    coordinatorRef.current = coordinator;
    readGate = createBoardReadGate<BoardReadContext>({
      prepare: async (context) => {
        if (!context.refreshVersion) return { ...context, lowerBoundSummary: null };
        try {
          const summary = await apiGet<BoardVersionSummary>("/api/board/versions");
          versionTracker.observe(summary);
          return { ...context, lowerBoundSummary: summary };
        } catch {
          return { ...context, lowerBoundSummary: null };
        }
      },
      read: () => apiGet<BoardPayload>("/api/board"),
      onApplied: (payload, context) => {
        coordinator.setAuthoritativeBase(payload);
        if (context.lowerBoundSummary) {
          const applied = versionTracker.apply(context.lowerBoundSummary);
          appliedVersionKeyRef.current = buildBoardVersionKey(applied, payload);
        }
      },
      onFailure: (readError) => {
        setError(formatBoardError(readError));
      }
    });
    const readOwner = createBoardRecoveryReadOwner({
      gate: readGate,
      onTimeout: (recoveryError) => {
        reportBoardReloadErrorIfCurrent(coordinatorRef.current, coordinator, recoveryError, setError);
      }
    });
    const readScope = { userId, coordinator, owner: readOwner };
    boardReadScopeRef.current = readScope;
    return () => {
      if (boardReadScopeRef.current === readScope) boardReadScopeRef.current = null;
      readOwner.dispose();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
      if (invalidationPublisherRef.current === invalidationPublisher) {
        invalidationPublisherRef.current = null;
      }
      invalidationPublisher.dispose();
      coordinator.discardAndDispose();
    };
  }, [handleMutationVersions, userId]);

  const reload = useCallback(async (options: {
    refreshVersion?: boolean;
    onApplied?: ((payload: BoardPayload) => void) | undefined;
  } = {}) => {
    const coordinator = coordinatorRef.current;
    const readScope = boardReadScopeRef.current;
    if (
      !enabled ||
      !coordinator ||
      coordinator.userId !== userId ||
      !readScope ||
      readScope.userId !== userId ||
      readScope.coordinator !== coordinator
    ) return dataRef.current;
    setError(null);
    const result = await readScope.owner.load({ refreshVersion: options.refreshVersion ?? pollingEnabled });
    if (result.type === "failed") throw result.error;
    if (result.type === "applied") options.onApplied?.(result.payload);
    return coordinator.getVisibleData();
  }, [enabled, pollingEnabled, userId]);

  const reconcileAfterLogoutFailure = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    const readScope = boardReadScopeRef.current;
    if (
      !userId ||
      !coordinator ||
      coordinator.userId !== userId ||
      !readScope ||
      readScope.userId !== userId ||
      readScope.coordinator !== coordinator
    ) {
      throw new Error("로그아웃 복구를 위한 보드 상태를 찾지 못했습니다.");
    }

    setError(null);
    try {
      await readScope.owner.reconcile({ refreshVersion: true });
      return coordinator.getVisibleData();
    } catch (recoveryError) {
      reportBoardReloadErrorIfCurrent(coordinatorRef.current, coordinator, recoveryError, setError);
      throw recoveryError;
    }
  }, [userId]);

  const reloadBoardForInvalidation = useCallback(async () => {
    let appliedPayload: BoardPayload | null = null;
    await reload({
      refreshVersion: false,
      onApplied: (payload) => {
        appliedPayload = payload;
      }
    });
    if (!appliedPayload) throw new Error("Board reload was superseded before it could apply");
    return appliedPayload;
  }, [reload]);

  useEffect(() => {
    setError(null);
    const coordinator = coordinatorRef.current;
    const readScope = boardReadScopeRef.current;
    if (
      !enabled ||
      !userId ||
      !coordinator ||
      coordinator.userId !== userId ||
      !readScope ||
      readScope.userId !== userId ||
      readScope.coordinator !== coordinator
    ) {
      readScope?.owner.invalidate();
      setBoardData(null);
      return;
    }
    setBoardData(coordinator.getVisibleData());
    void readScope.owner.load({ refreshVersion: pollingEnabled });
  }, [enabled, pollingEnabled, userId]);

  useEffect(() => {
    if (!enabled || !pollingEnabled || !userId) return;
    if (typeof window === "undefined") return;
    const currentUserId = userId;
    let active = true;
    let timer: number | null = null;
    const clientId = pollingClientIdRef.current ?? createBoardPollingClientId();
    pollingClientIdRef.current = clientId;
    const storage = getBrowserLocalStorage();
    const versionTracker = versionTrackerRef.current;

    function clearTimer() {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    }

    function postBoardPollingMessage(message: Omit<BoardPollingBroadcastMessage, "sourceId" | "userId">) {
      broadcastChannelRef.current?.postMessage({
        ...message,
        sourceId: clientId,
        userId: currentUserId
      } satisfies BoardPollingBroadcastMessage);
    }

    async function checkForRemoteChanges() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (!claimBoardPollingLeadership(storage, clientId)) return;
      try {
        const responseSummary = await apiGet<BoardVersionSummary>("/api/board/versions");
        if (!active) return;
        const summary = versionTracker.observe(responseSummary);
        const nextVersionKey = buildBoardVersionKey(summary, dataRef.current);
        if (dataRef.current && appliedVersionKeyRef.current !== nextVersionKey) {
          postBoardPollingMessage({ type: "board-reload", summary, versionKey: nextVersionKey });
          const payload = await reloadBoardForInvalidation();
          if (!active) return;
          const applied = versionTracker.apply(summary);
          appliedVersionKeyRef.current = buildBoardVersionKey(applied, payload);
          return;
        }
        postBoardPollingMessage({ type: "board-version-key", summary, versionKey: nextVersionKey });
      } catch {
        // Keep the current board visible; manual refresh/login handling remains available.
      }
    }

    function scheduleNextCheck() {
      clearTimer();
      if (!active) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      timer = window.setTimeout(() => {
        void checkForRemoteChanges().finally(scheduleNextCheck);
      }, getBoardPollingDelayMs(lastActivityAtRef.current));
    }

    function runCheckAndReschedule() {
      clearTimer();
      void checkForRemoteChanges().finally(scheduleNextCheck);
    }

    function handleFocus() {
      lastActivityAtRef.current = Date.now();
      runCheckAndReschedule();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        lastActivityAtRef.current = Date.now();
        runCheckAndReschedule();
      } else {
        clearTimer();
        releaseBoardPollingLeadership(storage, clientId);
      }
    }

    function handleUserActivity() {
      lastActivityAtRef.current = Date.now();
      scheduleNextCheck();
    }

    window.addEventListener("focus", handleFocus);
    window.addEventListener("pointerdown", handleUserActivity);
    window.addEventListener("keydown", handleUserActivity);
    window.addEventListener("wheel", handleUserActivity, { passive: true });
    window.addEventListener("touchstart", handleUserActivity, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    runCheckAndReschedule();

    return () => {
      active = false;
      clearTimer();
      releaseBoardPollingLeadership(storage, clientId);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pointerdown", handleUserActivity);
      window.removeEventListener("keydown", handleUserActivity);
      window.removeEventListener("wheel", handleUserActivity);
      window.removeEventListener("touchstart", handleUserActivity);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, pollingEnabled, reloadBoardForInvalidation, userId]);

  useEffect(() => {
    if (!userId) return;
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
    const clientId = pollingClientIdRef.current ?? createBoardPollingClientId();
    pollingClientIdRef.current = clientId;
    const versionTracker = versionTrackerRef.current;
    const channel = new BroadcastChannel(BOARD_VERSION_BROADCAST_CHANNEL);
    const reloadGate = createBoardReloadGate({
      userId,
      reload: reloadBoardForInvalidation,
      onApplied: (message) => {
        const applied = versionTracker.apply(message.summary);
        appliedVersionKeyRef.current = buildBoardVersionKey(applied, dataRef.current);
      }
    });
    broadcastChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent<BoardPollingBroadcastMessage>) => {
      const message = event.data;
      if (!message || message.sourceId === clientId || message.userId !== userId) return;
      const previousVersionKey = appliedVersionKeyRef.current;
      const hasLoadedBoard = dataRef.current !== null;
      const summary = versionTracker.observe(message.summary);
      const nextVersionKey = buildBoardVersionKey(summary, dataRef.current);
      if (shouldReloadForBoardBroadcast(message.type, previousVersionKey, nextVersionKey, hasLoadedBoard)) {
        reloadGate.receive({ ...message, type: "board-reload", summary, versionKey: nextVersionKey });
      }
    };
    return () => {
      if (broadcastChannelRef.current === channel) broadcastChannelRef.current = null;
      reloadGate.dispose();
      channel.close();
    };
  }, [reloadBoardForInvalidation, userId]);

  useEffect(() => {
    if (!enabled || !pollingEnabled) return;
    if (typeof window === "undefined") return;
    const clientId = pollingClientIdRef.current ?? createBoardPollingClientId();
    pollingClientIdRef.current = clientId;
    const storage = getBrowserLocalStorage();
    const heartbeat = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        releaseBoardPollingLeadership(storage, clientId);
        return;
      }
      void claimBoardPollingLeadership(storage, clientId);
    }, BOARD_VERSION_LEADER_HEARTBEAT_MS);
    return () => {
      window.clearInterval(heartbeat);
      releaseBoardPollingLeadership(storage, clientId);
    };
  }, [enabled, pollingEnabled]);

  useEffect(() => {
    if (!enabled || !data) return;
    if (typeof window === "undefined") return;
    const boundaryMs = getNextBoardPeriodBoundaryMs(data);
    if (boundaryMs === null) return;
    const delay = Math.max(1_000, Math.min(boundaryMs - Date.now() + 1_000, MAX_TIMEOUT_MS));
    const timer = window.setTimeout(() => {
      const current = dataRef.current;
      if (!current) return;
      const appliedSummary = versionTrackerRef.current.getState().applied;
      if (appliedSummary) {
        appliedVersionKeyRef.current = buildBoardVersionKey(appliedSummary, current);
      }
      setBoardData({ ...current });
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [enabled, data]);

  const enqueueCompletion = useCallback((patch: BoardCompletionPatch) => {
    coordinatorRef.current?.enqueueCompletion(patch);
  }, []);
  const enqueueCellState = useCallback((patch: BoardCellStatePatch) => {
    coordinatorRef.current?.enqueueCellState(patch);
  }, []);
  const flushPendingWrites = useCallback(async () => {
    await coordinatorRef.current?.flushPendingWrites();
  }, []);
  const retryPendingWrites = useCallback(() => {
    coordinatorRef.current?.retryPendingWrites();
  }, []);
  const discardPendingWrites = useCallback(() => {
    coordinatorRef.current?.discardPendingWrites();
  }, []);

  const matchesCurrentUser = Boolean(userId && coordinatorRef.current?.userId === userId);

  return {
    data: matchesCurrentUser ? data : null,
    error,
    reload,
    reconcileAfterLogoutFailure,
    enqueueCompletion,
    enqueueCellState,
    flushPendingWrites,
    retryPendingWrites,
    discardPendingWrites,
    hasPendingWrites: matchesCurrentUser ? hasPendingWrites : false,
    pendingWriteError: matchesCurrentUser ? pendingWriteError : null
  };
}
