import { useCallback, useEffect, useRef, useState } from "react";
import { getPeriodKey, type ResetRule } from "@riceark/core";
import { ApiClientError, apiGet } from "../../api/client";
import { applyBoardCompletionPatch, type BoardCompletionPatch } from "./completions";
import { applyBoardCellStatePatch, type BoardCellStatePatch } from "./cellStates";
import {
  buildLocalBoardPeriodFingerprint,
  composeActiveBoardView,
  getBoardSheetCacheEntry
} from "./boardSheetCache";
import type {
  BoardBootstrapPayload,
  BoardDisplaySettings,
  BoardMutationVersions,
  BoardPayload,
  BoardSheetPayload,
  BoardVersionSummary
} from "./types";
import {
  createBoardDataController,
  type BoardDataApi,
  type BoardDataEffect,
  type BoardDataState
} from "./boardDataController";
import { attachBoardQueueLifecycle, createBoardCompletionQueue, type BoardPatchApi } from "./useBoardCompletionQueue";
import { createBoardCellStateQueue } from "./useBoardCellStateQueue";
import { ReliablePatchQueueFlushError } from "./reliablePatchQueue";

export { buildLocalBoardPeriodFingerprint };
export type { BoardVersionSummary } from "./types";

type BoardApiGet = (path: string) => Promise<unknown>;

export function createBoardDataApi(get: BoardApiGet = apiGet): BoardDataApi {
  return {
    getBootstrap: (sheetId) =>
      get(
        sheetId === undefined
          ? "/api/board/bootstrap"
          : `/api/board/bootstrap?sheetId=${encodeURIComponent(sheetId)}`
      ) as Promise<BoardBootstrapPayload>,
    getSheet: (sheetId) =>
      get(`/api/board/sheets/${encodeURIComponent(sheetId)}`) as Promise<BoardSheetPayload>,
    getVersions: () => get("/api/board/versions") as Promise<BoardVersionSummary>
  };
}

export const BOARD_VERSION_CHECK_INTERVAL_MS = 120_000;
export const BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS = BOARD_VERSION_CHECK_INTERVAL_MS;
export const BOARD_VERSION_IDLE_CHECK_INTERVAL_MS = 5 * 60_000;
export const BOARD_WRITE_INVALIDATION_COALESCE_MS = 150;
export const BOARD_RECOVERY_READ_TIMEOUT_MS = 10_000;
const BOARD_VERSION_IDLE_AFTER_MS = 5 * 60_000;
const BOARD_VERSION_LEADER_TTL_MS = 45_000;
const BOARD_VERSION_LEADER_HEARTBEAT_MS = 15_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

type BoardVersionUpdate = Pick<BoardMutationVersions, "sheets" | "manifestVersion"> & {
  periodFingerprint?: string | undefined;
  settings?: BoardDisplaySettings | undefined;
};

export interface BoardTrackedVersionSummary {
  manifestVersion: number;
  sheets: Array<{ id: string; version: number }>;
  periodFingerprint: string;
  settings?: BoardDisplaySettings | undefined;
}

export function mergeBoardVersionSummary(
  current: BoardTrackedVersionSummary | null,
  incoming: BoardVersionUpdate
): BoardTrackedVersionSummary {
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
  observed: BoardTrackedVersionSummary | null;
  applied: BoardTrackedVersionSummary | null;
}

export interface BoardVersionTracker {
  observe: (summary: BoardVersionUpdate) => BoardTrackedVersionSummary;
  apply: (summary: BoardVersionUpdate) => BoardTrackedVersionSummary;
  getState: () => BoardVersionTrackerState;
}

export function createBoardVersionTracker(): BoardVersionTracker {
  let observed: BoardTrackedVersionSummary | null = null;
  let applied: BoardTrackedVersionSummary | null = null;

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

export interface BoardWriteCoordinatorOptions {
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
  summary: BoardTrackedVersionSummary,
  board: BoardPeriodFingerprintSource | null | undefined,
  now = new Date()
): string {
  return JSON.stringify({
    ...summary,
    periodFingerprint: buildLocalBoardPeriodFingerprint(board, now)
  });
}

export interface BoardPollingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BoardPollingChannelPort {
  postMessage(message: BoardPollingV2Message): void;
  close(): void;
}

export type BoardPollingRuntimeEvent = "focus" | "visibilitychange" | "activity";

export interface BoardPollingRuntime {
  nowMs(): number;
  isVisible(): boolean;
  storage: BoardPollingStorage | null;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
  addEventListener(event: BoardPollingRuntimeEvent, callback: () => void): () => void;
  openChannel(
    name: string,
    onMessage: (message: unknown) => void
  ): BoardPollingChannelPort | null;
}

export interface BoardPollingV2Message {
  protocolVersion: 2;
  userId: string;
  sourceId: string;
  summary: BoardVersionSummary;
}

export function getBoardPollingStorageKey(userId: string): string {
  return `riceark-board-polling:v2:${userId}`;
}

export function getBoardPollingChannelName(userId: string): string {
  return `riceark-board-polling:v2:${userId}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoardDisplaySettings(value: unknown): value is BoardDisplaySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Partial<BoardDisplaySettings>;
  return (
    isFiniteNumber(settings.show_display_name) &&
    isFiniteNumber(settings.show_server_name) &&
    isFiniteNumber(settings.show_class_name) &&
    isFiniteNumber(settings.show_item_level) &&
    isFiniteNumber(settings.show_combat_power)
  );
}

function isBoardVersionSummary(value: unknown): value is BoardVersionSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Partial<BoardVersionSummary>;
  if (
    !isFiniteNumber(summary.manifestVersion) ||
    typeof summary.periodFingerprint !== "string" ||
    !Array.isArray(summary.sheets) ||
    (summary.settings !== undefined && !isBoardDisplaySettings(summary.settings))
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const candidate of summary.sheets) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const sheet = candidate as Partial<BoardVersionSummary["sheets"][number]>;
    if (
      typeof sheet.id !== "string" ||
      typeof sheet.name !== "string" ||
      !isFiniteNumber(sheet.sort_order) ||
      !isFiniteNumber(sheet.is_default) ||
      !isFiniteNumber(sheet.version) ||
      ids.has(sheet.id)
    ) {
      return false;
    }
    ids.add(sheet.id);
  }
  return true;
}

export function parseBoardPollingMessage(
  value: unknown,
  expectedUserId: string,
  ownSourceId: string
): BoardPollingV2Message | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Partial<BoardPollingV2Message>;
  if (
    message.protocolVersion !== 2 ||
    message.userId !== expectedUserId ||
    typeof message.sourceId !== "string" ||
    message.sourceId === ownSourceId ||
    !isBoardVersionSummary(message.summary)
  ) {
    return null;
  }
  return message as BoardPollingV2Message;
}

function readBoardPollingLeaderForKey(
  storage: BoardPollingStorage | null,
  key: string
): BoardPollingLeaderRecord | null {
  if (!storage) return null;
  try {
    return parseBoardPollingLeaderRecord(storage.getItem(key));
  } catch {
    return null;
  }
}

function claimBoardPollingLeadershipForKey(
  storage: BoardPollingStorage | null,
  key: string,
  sourceId: string,
  nowMs: number
): boolean {
  if (!storage) return true;
  try {
    const current = readBoardPollingLeaderForKey(storage, key);
    if (!canClaimBoardPollingLeadership(current, sourceId, nowMs)) return false;
    storage.setItem(
      key,
      JSON.stringify({ id: sourceId, expiresAt: nowMs + BOARD_VERSION_LEADER_TTL_MS })
    );
    return readBoardPollingLeaderForKey(storage, key)?.id === sourceId;
  } catch {
    return true;
  }
}

function releaseBoardPollingLeadershipForKey(
  storage: BoardPollingStorage | null,
  key: string,
  sourceId: string
): void {
  if (!storage) return;
  try {
    if (readBoardPollingLeaderForKey(storage, key)?.id === sourceId) storage.removeItem(key);
  } catch {
    // Storage failure falls back to independent polling without breaking the board.
  }
}

function mergeCanonicalBoardVersionSummary(
  current: BoardVersionSummary | null,
  incoming: BoardVersionSummary
): BoardVersionSummary {
  if (current === null) return incoming;
  const metadataSource =
    incoming.manifestVersion >= current.manifestVersion ? incoming : current;
  const versions = new Map(current.sheets.map((sheet) => [sheet.id, sheet.version]));
  for (const sheet of incoming.sheets) {
    versions.set(sheet.id, Math.max(versions.get(sheet.id) ?? 0, sheet.version));
  }
  return {
    manifestVersion: Math.max(current.manifestVersion, incoming.manifestVersion),
    sheets: metadataSource.sheets.map((sheet) => ({
      ...sheet,
      version: Math.max(sheet.version, versions.get(sheet.id) ?? 0)
    })),
    periodFingerprint: incoming.periodFingerprint,
    ...(incoming.settings !== undefined
      ? { settings: incoming.settings }
      : current.settings !== undefined
        ? { settings: current.settings }
        : {})
  };
}

interface BoardPollingOwner {
  start(immediate: boolean): void;
  stop(): void;
  publish(summary: BoardVersionSummary): void;
  isRunning(): boolean;
}

function createBoardPollingOwner(options: {
  runtime: BoardPollingRuntime;
  userId: string;
  sourceId: string;
  revalidate: () => Promise<void>;
  applyRemoteSummary: (summary: BoardVersionSummary) => Promise<void>;
  getSummary: () => BoardVersionSummary | null;
  onVisible: () => void;
  onHidden: () => void;
}): BoardPollingOwner {
  const leaderKey = getBoardPollingStorageKey(options.userId);
  let running = false;
  let generation = 0;
  let lastActivityAtMs = options.runtime.nowMs();
  let pollingTimer: unknown = null;
  let pollingDueAtMs: number | null = null;
  let heartbeatTimer: unknown = null;
  let invalidationTimer: unknown = null;
  let pendingInvalidation: BoardVersionSummary | null = null;
  let channel: BoardPollingChannelPort | null = null;
  let activeCheck: Promise<void> | null = null;
  let removeListeners: Array<() => void> = [];

  const clearTimer = (timer: unknown) => {
    if (timer !== null) options.runtime.clearTimeout(timer);
  };

  const postSummary = (summary: BoardVersionSummary) => {
    channel?.postMessage({
      protocolVersion: 2,
      userId: options.userId,
      sourceId: options.sourceId,
      summary
    });
  };

  const check = (): Promise<void> => {
    if (!running || !options.runtime.isVisible()) return Promise.resolve();
    if (activeCheck) return activeCheck;
    if (
      !claimBoardPollingLeadershipForKey(
        options.runtime.storage,
        leaderKey,
        options.sourceId,
        options.runtime.nowMs()
      )
    ) {
      return Promise.resolve();
    }
    const checkGeneration = generation;
    activeCheck = options
      .revalidate()
      .then(() => {
        if (
          !running ||
          checkGeneration !== generation ||
          !options.runtime.isVisible()
        ) {
          return;
        }
        const summary = options.getSummary();
        if (summary) postSummary(summary);
      })
      .catch(() => undefined)
      .finally(() => {
        activeCheck = null;
      });
    return activeCheck;
  };

  const scheduleNextCheck = () => {
    clearTimer(pollingTimer);
    pollingTimer = null;
    pollingDueAtMs = null;
    if (!running || !options.runtime.isVisible()) return;
    const nowMs = options.runtime.nowMs();
    const delay = getBoardPollingDelayMs(lastActivityAtMs, nowMs);
    pollingDueAtMs = nowMs + delay;
    pollingTimer = options.runtime.setTimeout(() => {
      pollingTimer = null;
      pollingDueAtMs = null;
      void check().finally(scheduleNextCheck);
    }, delay);
  };

  const runCheckAndReschedule = () => {
    clearTimer(pollingTimer);
    pollingTimer = null;
    pollingDueAtMs = null;
    if (!running || !options.runtime.isVisible()) return;
    void check().finally(scheduleNextCheck);
  };

  const scheduleHeartbeat = () => {
    clearTimer(heartbeatTimer);
    heartbeatTimer = null;
    if (!running) return;
    heartbeatTimer = options.runtime.setTimeout(() => {
      heartbeatTimer = null;
      if (!running) return;
      if (options.runtime.isVisible()) {
        claimBoardPollingLeadershipForKey(
          options.runtime.storage,
          leaderKey,
          options.sourceId,
          options.runtime.nowMs()
        );
      } else {
        releaseBoardPollingLeadershipForKey(
          options.runtime.storage,
          leaderKey,
          options.sourceId
        );
      }
      scheduleHeartbeat();
    }, BOARD_VERSION_LEADER_HEARTBEAT_MS);
  };

  const stop = () => {
    if (!running && channel === null && removeListeners.length === 0) return;
    running = false;
    generation += 1;
    clearTimer(pollingTimer);
    clearTimer(heartbeatTimer);
    clearTimer(invalidationTimer);
    pollingTimer = null;
    pollingDueAtMs = null;
    heartbeatTimer = null;
    invalidationTimer = null;
    pendingInvalidation = null;
    for (const removeListener of removeListeners) removeListener();
    removeListeners = [];
    channel?.close();
    channel = null;
    releaseBoardPollingLeadershipForKey(
      options.runtime.storage,
      leaderKey,
      options.sourceId
    );
  };

  return {
    start: (immediate) => {
      if (running) {
        if (immediate) runCheckAndReschedule();
        return;
      }
      running = true;
      generation += 1;
      lastActivityAtMs = options.runtime.nowMs();
      channel = options.runtime.openChannel(
        getBoardPollingChannelName(options.userId),
        (value) => {
          const message = parseBoardPollingMessage(
            value,
            options.userId,
            options.sourceId
          );
          if (!message || !running || !options.runtime.isVisible()) return;
          void options.applyRemoteSummary(message.summary).catch(() => undefined);
        }
      );
      removeListeners = [
        options.runtime.addEventListener("focus", () => {
          if (!running || !options.runtime.isVisible()) return;
          lastActivityAtMs = options.runtime.nowMs();
          runCheckAndReschedule();
        }),
        options.runtime.addEventListener("visibilitychange", () => {
          if (!running) return;
          if (!options.runtime.isVisible()) {
            clearTimer(pollingTimer);
            pollingTimer = null;
            pollingDueAtMs = null;
            releaseBoardPollingLeadershipForKey(
              options.runtime.storage,
              leaderKey,
              options.sourceId
            );
            options.onHidden();
            return;
          }
          lastActivityAtMs = options.runtime.nowMs();
          options.onVisible();
          runCheckAndReschedule();
        }),
        options.runtime.addEventListener("activity", () => {
          if (!running) return;
          lastActivityAtMs = options.runtime.nowMs();
          const activeDueAtMs = lastActivityAtMs + BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS;
          if (pollingDueAtMs === null || pollingDueAtMs > activeDueAtMs) {
            scheduleNextCheck();
          }
        })
      ];
      scheduleHeartbeat();
      if (!options.runtime.isVisible()) {
        options.onHidden();
        releaseBoardPollingLeadershipForKey(
          options.runtime.storage,
          leaderKey,
          options.sourceId
        );
      } else if (immediate) {
        runCheckAndReschedule();
      } else {
        scheduleNextCheck();
      }
    },
    stop,
    publish: (summary) => {
      if (!running) return;
      pendingInvalidation = mergeCanonicalBoardVersionSummary(
        pendingInvalidation,
        summary
      );
      if (invalidationTimer !== null) return;
      invalidationTimer = options.runtime.setTimeout(() => {
        invalidationTimer = null;
        const pending = pendingInvalidation;
        pendingInvalidation = null;
        if (running && pending) postSummary(pending);
      }, BOARD_WRITE_INVALIDATION_COALESCE_MS);
    },
    isRunning: () => running
  };
}

export interface BoardSessionSnapshot {
  userId: string | null;
  data: BoardPayload | null;
  error: string | null;
  activeSheetId: string | null;
  loading: boolean;
  hasPendingWrites: boolean;
  pendingWriteError: string | null;
}

export interface BoardSessionConfiguration {
  enabled: boolean;
  pollingEnabled: boolean;
  requestedSheetId: string | null;
  onReplaceSheetId?: ((sheetId: string | null) => void) | undefined;
}

export interface BoardSession {
  configure(configuration: BoardSessionConfiguration): Promise<void>;
  snapshot(): BoardSessionSnapshot;
  subscribe(listener: (snapshot: BoardSessionSnapshot) => void): () => void;
  reload(options?: {
    refreshVersion?: boolean | undefined;
    onApplied?: ((payload: BoardPayload) => void) | undefined;
  }): Promise<BoardPayload | null>;
  reconcileAfterLogoutFailure(): Promise<BoardPayload | null>;
  selectSheet(sheetId: string): Promise<void>;
  markSheetStale(sheetId: string): Promise<void>;
  enqueueCompletion(patch: BoardCompletionPatch): void;
  enqueueCellState(patch: BoardCellStatePatch): void;
  flushPendingWrites(): Promise<void>;
  retryPendingWrites(): void;
  discardPendingWrites(): void;
  dispose(): void;
}

export interface CreateBoardSessionOptions {
  userId: string;
  api?: BoardDataApi | undefined;
  runtime?: BoardPollingRuntime | null | undefined;
  sourceId?: string | undefined;
  writeCoordinatorOptions?: BoardWriteCoordinatorOptions | undefined;
}

function compareBoardSheetLabels(
  left: { id: string; name: string; sort_order: number },
  right: { id: string; name: string; sort_order: number }
): number {
  const nameComparison = left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  const idComparison = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  return (
    left.sort_order - right.sort_order ||
    nameComparison ||
    idComparison
  );
}

function getDefaultBoardSheetId(state: BoardDataState): string | null {
  const sorted = [...state.manifest].sort(compareBoardSheetLabels);
  return sorted.find((sheet) => sheet.is_default === 1)?.id ?? sorted[0]?.id ?? null;
}

function getActiveBoardSheetPayload(state: BoardDataState): BoardSheetPayload | null {
  if (state.userId === null || state.activeSheetId === null) return null;
  return getBoardSheetCacheEntry(state.cache, state.userId, state.activeSheetId)?.payload ?? null;
}

function buildCanonicalBoardVersionSummary(state: BoardDataState): BoardVersionSummary | null {
  if (state.userId === null || state.settings === null) return null;
  return {
    manifestVersion: state.manifestVersion,
    sheets: state.manifest,
    periodFingerprint: getActiveBoardSheetPayload(state)?.periodFingerprint ?? "",
    settings: state.settings
  };
}

export function createBoardSession(options: CreateBoardSessionOptions): BoardSession {
  const runtime = options.runtime ?? null;
  const sourceId = options.sourceId ?? createBoardPollingClientId();
  const controller = createBoardDataController(options.api ?? createBoardDataApi(), {
    userId: options.userId,
    ...(runtime
      ? {
          now: () => new Date(runtime.nowMs()),
          nowMs: () => runtime.nowMs()
        }
      : {})
  });
  const listeners = new Set<(snapshot: BoardSessionSnapshot) => void>();
  let disposed = false;
  let configurationGeneration = 0;
  let enabled = false;
  let bootstrapped = false;
  let bootstrapPromise: Promise<void> | null = null;
  let requestedSheetId: string | null = null;
  let hasRequestedSheetId = false;
  let invalidReplacementSent = false;
  let onReplaceSheetId: ((sheetId: string | null) => void) | undefined;
  let controllerState = controller.snapshot();
  let activePayloadIdentity: BoardSheetPayload | null = null;
  let activePayloadSheetId: string | null = null;
  let pollingOwner: BoardPollingOwner | null = null;
  let boundaryTimer: unknown = null;
  let coordinatorSnapshot: BoardWriteSnapshot = {
    data: null,
    hasPendingWrites: false,
    pendingWriteError: null
  };

  const buildSnapshot = (): BoardSessionSnapshot => {
    if (disposed) {
      return {
        userId: null,
        data: null,
        error: null,
        activeSheetId: null,
        loading: false,
        hasPendingWrites: false,
        pendingWriteError: null
      };
    }
    const activePayload = getActiveBoardSheetPayload(controllerState);
    const canShowCoordinatorData =
      enabled &&
      activePayload !== null &&
      activePayload === activePayloadIdentity &&
      controllerState.activeSheetId === activePayloadSheetId;
    return {
      userId: options.userId,
      data: canShowCoordinatorData ? coordinatorSnapshot.data : null,
      error: enabled ? controllerState.error : null,
      activeSheetId: controllerState.activeSheetId,
      loading: enabled ? controllerState.loading : false,
      hasPendingWrites: coordinatorSnapshot.hasPendingWrites,
      pendingWriteError: coordinatorSnapshot.pendingWriteError
    };
  };

  const publishSnapshot = () => {
    if (disposed) return;
    const next = buildSnapshot();
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // A React observer cannot interrupt controller or queue progress.
      }
    }
  };

  const clearBoundaryTimer = () => {
    if (runtime && boundaryTimer !== null) runtime.clearTimeout(boundaryTimer);
    boundaryTimer = null;
  };

  const scheduleBoundary = () => {
    clearBoundaryTimer();
    if (
      disposed ||
      !runtime ||
      !pollingOwner?.isRunning() ||
      !runtime.isVisible()
    ) {
      return;
    }
    const activePayload = getActiveBoardSheetPayload(controllerState);
    const boundaryMs = getNextBoardPeriodBoundaryMs(
      activePayload,
      new Date(runtime.nowMs())
    );
    if (boundaryMs === null) return;
    const delay = Math.max(
      1_000,
      Math.min(boundaryMs - runtime.nowMs() + 1_000, MAX_TIMEOUT_MS)
    );
    boundaryTimer = runtime.setTimeout(() => {
      boundaryTimer = null;
      if (
        disposed ||
        !pollingOwner?.isRunning() ||
        !runtime.isVisible()
      ) {
        return;
      }
      const activeSheetId = controller.snapshot().activeSheetId;
      if (activeSheetId !== null) {
        void controller.invalidatePeriod(activeSheetId).catch(() => undefined);
      }
    }, delay);
  };

  const reconcileVisiblePeriod = () => {
    if (disposed || !runtime || !pollingOwner?.isRunning()) return;
    const state = controller.snapshot();
    const activePayload = getActiveBoardSheetPayload(state);
    if (
      state.activeSheetId !== null &&
      activePayload !== null &&
      activePayload.periodFingerprint !==
        buildLocalBoardPeriodFingerprint(activePayload, new Date(runtime.nowMs()))
    ) {
      void controller
        .invalidatePeriod(state.activeSheetId)
        .catch(() => undefined)
        .finally(scheduleBoundary);
      return;
    }
    scheduleBoundary();
  };

  const suppliedCoordinatorOptions = options.writeCoordinatorOptions;
  const coordinator = createBoardWriteCoordinator(options.userId, {
    ...suppliedCoordinatorOptions,
    onChange: (next) => {
      coordinatorSnapshot = next;
      suppliedCoordinatorOptions?.onChange?.(next);
      publishSnapshot();
    },
    onBeforeAccepted: suppliedCoordinatorOptions?.onBeforeAccepted,
    onVersions: (versions) => {
      controller.applyMutationVersions(versions);
      const summary = buildCanonicalBoardVersionSummary(controller.snapshot());
      if (summary) pollingOwner?.publish(summary);
      suppliedCoordinatorOptions?.onVersions?.(versions);
    }
  });
  coordinatorSnapshot = coordinator.getSnapshot();

  const applyControllerState = (next: BoardDataState, effect?: BoardDataEffect) => {
    if (disposed) return;
    controllerState = next;
    if (effect?.type === "replace-url-with-sheet") {
      onReplaceSheetId?.(effect.replaceUrlWithSheetId);
    }
    scheduleBoundary();

    const activePayload = getActiveBoardSheetPayload(next);
    if (activePayload === null || next.settings === null || next.userId === null) {
      activePayloadIdentity = null;
      activePayloadSheetId = next.activeSheetId;
      publishSnapshot();
      return;
    }

    const samePayload =
      activePayload === activePayloadIdentity && next.activeSheetId === activePayloadSheetId;
    activePayloadIdentity = activePayload;
    activePayloadSheetId = next.activeSheetId;
    if (samePayload) {
      const authoritative = coordinator.getAuthoritativeBase();
      if (authoritative) {
        coordinator.setAuthoritativeBase({
          ...authoritative,
          userId: next.userId,
          settings: next.settings,
          sheets: next.manifest
        });
        return;
      }
    }
    coordinator.setAuthoritativeBase(
      composeActiveBoardView(next.userId, next.settings, next.manifest, activePayload)
    );
  };

  const unsubscribeController = controller.subscribe(applyControllerState);
  if (runtime) {
    pollingOwner = createBoardPollingOwner({
      runtime,
      userId: options.userId,
      sourceId,
      revalidate: () => controller.revalidate("poll"),
      applyRemoteSummary: (summary) => controller.applyRemoteSummary(summary, "broadcast"),
      getSummary: () => buildCanonicalBoardVersionSummary(controller.snapshot()),
      onVisible: reconcileVisiblePeriod,
      onHidden: clearBoundaryTimer
    });
  }

  const reconcileRequestedRoute = async (routeChanged: boolean) => {
    if (disposed || !enabled || !bootstrapped) return;
    const state = controller.snapshot();
    const fallbackId = getDefaultBoardSheetId(state);
    const targetId =
      requestedSheetId === null
        ? fallbackId
        : state.manifest.some((sheet) => sheet.id === requestedSheetId)
          ? requestedSheetId
          : fallbackId;

    if (targetId !== null && state.activeSheetId !== targetId) {
      await controller.selectSheet(targetId);
    }
    if (requestedSheetId !== null && targetId !== requestedSheetId && !invalidReplacementSent) {
      invalidReplacementSent = true;
      onReplaceSheetId?.(targetId);
    } else if (routeChanged && requestedSheetId === null) {
      invalidReplacementSent = false;
    }
  };

  const configure = async (configuration: BoardSessionConfiguration) => {
    if (disposed) return;
    const generation = ++configurationGeneration;
    const hadBootstrapped = bootstrapped;
    const wasPolling = pollingOwner?.isRunning() ?? false;
    const shouldPoll = configuration.enabled && configuration.pollingEnabled;
    if (!shouldPoll) {
      pollingOwner?.stop();
      clearBoundaryTimer();
    }
    const routeChanged =
      !hasRequestedSheetId || requestedSheetId !== configuration.requestedSheetId;
    if (routeChanged) invalidReplacementSent = false;
    requestedSheetId = configuration.requestedSheetId;
    hasRequestedSheetId = true;
    onReplaceSheetId = configuration.onReplaceSheetId;
    enabled = configuration.enabled;
    publishSnapshot();
    if (!enabled) return;

    if (!bootstrapped) {
      if (bootstrapPromise === null) {
        bootstrapPromise = controller
          .bootstrap(requestedSheetId ?? undefined)
          .then(() => {
            if (!disposed) bootstrapped = true;
          })
          .finally(() => {
            bootstrapPromise = null;
          });
      }
      await bootstrapPromise;
    }
    if (disposed || generation !== configurationGeneration || !enabled) return;
    await reconcileRequestedRoute(routeChanged);
    if (disposed || generation !== configurationGeneration || !enabled) return;
    if (shouldPoll && pollingOwner && !wasPolling) {
      pollingOwner.start(hadBootstrapped);
      scheduleBoundary();
    }
  };

  const reload = async (reloadOptions: {
    refreshVersion?: boolean | undefined;
    onApplied?: ((payload: BoardPayload) => void) | undefined;
  } = {}) => {
    void reloadOptions.refreshVersion;
    if (disposed || !enabled || !bootstrapped) return buildSnapshot().data;
    await controller.revalidate("reload");
    const payload = buildSnapshot().data;
    if (payload) reloadOptions.onApplied?.(payload);
    return payload;
  };

  return {
    configure,
    snapshot: buildSnapshot,
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload,
    reconcileAfterLogoutFailure: async () => {
      if (disposed || !bootstrapped) return buildSnapshot().data;
      const before = getActiveBoardSheetPayload(controller.snapshot());
      await controller.revalidate("logout-recovery");
      const afterState = controller.snapshot();
      const after = getActiveBoardSheetPayload(afterState);
      if (afterState.activeSheetId !== null && before === after) {
        await controller.markSheetStale(afterState.activeSheetId);
      }
      return buildSnapshot().data;
    },
    selectSheet: (sheetId) => controller.selectSheet(sheetId),
    markSheetStale: (sheetId) => controller.markSheetStale(sheetId),
    enqueueCompletion: (patch) => coordinator.enqueueCompletion(patch),
    enqueueCellState: (patch) => coordinator.enqueueCellState(patch),
    flushPendingWrites: () => coordinator.flushPendingWrites(),
    retryPendingWrites: () => coordinator.retryPendingWrites(),
    discardPendingWrites: () => coordinator.discardPendingWrites(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      enabled = false;
      pollingOwner?.stop();
      clearBoundaryTimer();
      unsubscribeController();
      controller.dispose();
      coordinator.discardAndDispose();
      controllerState = {
        userId: null,
        settings: null,
        manifestVersion: 0,
        manifest: [],
        activeSheetId: null,
        cache: new Map(),
        loading: false,
        error: null
      };
      activePayloadIdentity = null;
      activePayloadSheetId = null;
      coordinatorSnapshot = {
        data: null,
        hasPendingWrites: false,
        pendingWriteError: null
      };
      listeners.clear();
    }
  };
}

export function createBrowserBoardPollingRuntime(): BoardPollingRuntime | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const storage = getBrowserLocalStorage();

  return {
    nowMs: () => Date.now(),
    isVisible: () => document.visibilityState !== "hidden",
    storage,
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timer) => {
      if (typeof timer === "number") window.clearTimeout(timer);
    },
    addEventListener: (event, callback) => {
      if (event === "focus") {
        window.addEventListener("focus", callback);
        return () => window.removeEventListener("focus", callback);
      }
      if (event === "visibilitychange") {
        document.addEventListener("visibilitychange", callback);
        return () => document.removeEventListener("visibilitychange", callback);
      }

      const activityEvents: Array<keyof WindowEventMap> = [
        "pointerdown",
        "keydown",
        "wheel",
        "touchstart"
      ];
      for (const activityEvent of activityEvents) {
        window.addEventListener(activityEvent, callback, { passive: true });
      }
      return () => {
        for (const activityEvent of activityEvents) {
          window.removeEventListener(activityEvent, callback);
        }
      };
    },
    openChannel: (name, onMessage) => {
      if (typeof BroadcastChannel === "undefined") return null;
      const channel = new BroadcastChannel(name);
      channel.onmessage = (event: MessageEvent<unknown>) => onMessage(event.data);
      return {
        postMessage: (message) => channel.postMessage(message),
        close: () => channel.close()
      };
    }
  };
}

function emptyBoardSessionSnapshot(): BoardSessionSnapshot {
  return {
    userId: null,
    data: null,
    error: null,
    activeSheetId: null,
    loading: false,
    hasPendingWrites: false,
    pendingWriteError: null
  };
}

export interface UseBoardOptions {
  enabled?: boolean | undefined;
  pollingEnabled?: boolean | undefined;
  userId?: string | null | undefined;
  requestedSheetId?: string | null | undefined;
  onReplaceSheetId?: ((sheetId: string | null) => void) | undefined;
}

export function useBoard({
  enabled = true,
  pollingEnabled = enabled,
  userId = null,
  requestedSheetId = null,
  onReplaceSheetId
}: UseBoardOptions = {}) {
  const [snapshot, setSnapshot] = useState<BoardSessionSnapshot>(
    emptyBoardSessionSnapshot
  );
  const sessionRef = useRef<{
    userId: string;
    session: BoardSession;
  } | null>(null);

  useEffect(() => {
    sessionRef.current?.session.dispose();
    sessionRef.current = null;
    setSnapshot(emptyBoardSessionSnapshot());
    if (!userId) return;

    const session = createBoardSession({
      userId,
      runtime: createBrowserBoardPollingRuntime()
    });
    sessionRef.current = { userId, session };
    setSnapshot(session.snapshot());
    const unsubscribe = session.subscribe((next) => {
      if (sessionRef.current?.session === session) setSnapshot(next);
    });

    return () => {
      unsubscribe();
      if (sessionRef.current?.session === session) sessionRef.current = null;
      session.dispose();
    };
  }, [userId]);

  useEffect(() => {
    const current = sessionRef.current;
    if (!current || current.userId !== userId) return;
    void current.session
      .configure({
        enabled,
        pollingEnabled,
        requestedSheetId,
        ...(onReplaceSheetId ? { onReplaceSheetId } : {})
      })
      .catch(() => undefined);
  }, [enabled, onReplaceSheetId, pollingEnabled, requestedSheetId, userId]);

  const getCurrentSession = useCallback(() => {
    const current = sessionRef.current;
    return current && current.userId === userId ? current.session : null;
  }, [userId]);

  const reload = useCallback(
    (options: Parameters<BoardSession["reload"]>[0] = {}) =>
      getCurrentSession()?.reload(options) ?? Promise.resolve(null),
    [getCurrentSession]
  );
  const reconcileAfterLogoutFailure = useCallback(() => {
    const current = getCurrentSession();
    if (!current) {
      return Promise.reject(
        new Error("로그아웃 복구를 위한 보드 상태를 찾지 못했습니다.")
      );
    }
    return current.reconcileAfterLogoutFailure();
  }, [getCurrentSession]);
  const selectSheet = useCallback(
    (sheetId: string) =>
      getCurrentSession()?.selectSheet(sheetId) ?? Promise.resolve(),
    [getCurrentSession]
  );
  const markSheetStale = useCallback(
    (sheetId: string) =>
      getCurrentSession()?.markSheetStale(sheetId) ?? Promise.resolve(),
    [getCurrentSession]
  );
  const enqueueCompletion = useCallback(
    (patch: BoardCompletionPatch) => getCurrentSession()?.enqueueCompletion(patch),
    [getCurrentSession]
  );
  const enqueueCellState = useCallback(
    (patch: BoardCellStatePatch) => getCurrentSession()?.enqueueCellState(patch),
    [getCurrentSession]
  );
  const flushPendingWrites = useCallback(
    () => getCurrentSession()?.flushPendingWrites() ?? Promise.resolve(),
    [getCurrentSession]
  );
  const retryPendingWrites = useCallback(
    () => getCurrentSession()?.retryPendingWrites(),
    [getCurrentSession]
  );
  const discardPendingWrites = useCallback(
    () => getCurrentSession()?.discardPendingWrites(),
    [getCurrentSession]
  );

  const matchesCurrentUser =
    userId !== null && snapshot.userId === userId && sessionRef.current?.userId === userId;

  return {
    data: matchesCurrentUser ? snapshot.data : null,
    error: matchesCurrentUser ? snapshot.error : null,
    activeSheetId: matchesCurrentUser ? snapshot.activeSheetId : null,
    loading: matchesCurrentUser ? snapshot.loading : false,
    reload,
    reconcileAfterLogoutFailure,
    selectSheet,
    markSheetStale,
    enqueueCompletion,
    enqueueCellState,
    flushPendingWrites,
    retryPendingWrites,
    discardPendingWrites,
    hasPendingWrites: matchesCurrentUser ? snapshot.hasPendingWrites : false,
    pendingWriteError: matchesCurrentUser ? snapshot.pendingWriteError : null
  };
}
