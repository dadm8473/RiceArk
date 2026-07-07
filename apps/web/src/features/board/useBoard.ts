import { useCallback, useEffect, useRef, useState } from "react";
import { getPeriodKey, type ResetRule } from "@riceark/core";
import { ApiClientError, apiGet } from "../../api/client";
import type { BoardPayload } from "./types";

export const BOARD_VERSION_CHECK_INTERVAL_MS = 120_000;
export const BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS = BOARD_VERSION_CHECK_INTERVAL_MS;
export const BOARD_VERSION_IDLE_CHECK_INTERVAL_MS = 5 * 60_000;
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
}

interface BoardPeriodFingerprintSource {
  axisItems: Array<{ kind: string; task_reset_rule_json?: string | null | undefined }>;
}

interface BoardPollingLeaderRecord {
  id: string;
  expiresAt: number;
}

interface BoardPollingBroadcastMessage {
  sourceId: string;
  type: "board-version-key" | "board-reload";
  summary: BoardVersionSummary;
  versionKey: string;
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

export function buildLocalBoardPeriodFingerprint(
  board: BoardPeriodFingerprintSource | null | undefined,
  now = new Date()
): string {
  if (!board) return "";
  const periodKeys = new Set<string>();
  for (const item of board.axisItems) {
    if (item.kind !== "task" || !item.task_reset_rule_json) continue;
    try {
      periodKeys.add(getPeriodKey(JSON.parse(item.task_reset_rule_json) as ResetRule, now));
    } catch {
      // Invalid legacy reset rules should not make lightweight version checks fail.
    }
  }
  return [...periodKeys].join("|");
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

export function useBoard({
  enabled = true,
  pollingEnabled = enabled
}: { enabled?: boolean | undefined; pollingEnabled?: boolean | undefined } = {}) {
  const [data, setData] = useState<BoardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dataRef = useRef<BoardPayload | null>(null);
  const versionKeyRef = useRef<string | null>(null);
  const lastVersionSummaryRef = useRef<BoardVersionSummary | null>(null);
  const lastActivityAtRef = useRef(Date.now());
  const pollingClientIdRef = useRef<string | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);

  function setBoardData(payload: BoardPayload | null) {
    dataRef.current = payload;
    setData(payload);
  }

  async function refreshVersionKey(boardForFingerprint: BoardPayload | null = dataRef.current) {
    const summary = await apiGet<BoardVersionSummary>("/api/board/versions");
    lastVersionSummaryRef.current = summary;
    versionKeyRef.current = buildBoardVersionKey(summary, boardForFingerprint);
    return summary;
  }

  const reload = useCallback(async (options: { refreshVersion?: boolean } = {}) => {
    if (!enabled) return dataRef.current;
    setError(null);
    try {
      const payload = await apiGet<BoardPayload>("/api/board");
      setBoardData(payload);
      const shouldRefreshVersion = options.refreshVersion ?? pollingEnabled;
      if (shouldRefreshVersion) void refreshVersionKey(payload).catch(() => {
        // Version checks are an optimization; the full board payload remains authoritative.
      });
      return payload;
    } catch (err) {
      setError(formatBoardError(err));
      throw err;
    }
  }, [enabled, pollingEnabled]);

  useEffect(() => {
    let active = true;
    setError(null);
    if (!enabled) {
      setBoardData(null);
      versionKeyRef.current = null;
      lastVersionSummaryRef.current = null;
      return () => {
        active = false;
      };
    }
    apiGet<BoardPayload>("/api/board")
      .then((payload) => {
        if (active) {
          setBoardData(payload);
          if (pollingEnabled) void refreshVersionKey(payload).catch(() => {
            // Version checks are an optimization; the loaded board can still be used.
          });
        }
      })
      .catch((err: unknown) => {
        if (active) setError(formatBoardError(err));
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !pollingEnabled) return;
    if (typeof window === "undefined") return;
    let active = true;
    let timer: number | null = null;
    const clientId = pollingClientIdRef.current ?? createBoardPollingClientId();
    pollingClientIdRef.current = clientId;
    const storage = getBrowserLocalStorage();

    function clearTimer() {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    }

    function postBoardPollingMessage(message: Omit<BoardPollingBroadcastMessage, "sourceId">) {
      broadcastChannelRef.current?.postMessage({ ...message, sourceId: clientId } satisfies BoardPollingBroadcastMessage);
    }

    async function checkForRemoteChanges() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (!claimBoardPollingLeadership(storage, clientId)) return;
      try {
        const summary = await apiGet<BoardVersionSummary>("/api/board/versions");
        if (!active) return;
        const nextVersionKey = buildBoardVersionKey(summary, dataRef.current);
        lastVersionSummaryRef.current = summary;
        if (versionKeyRef.current && versionKeyRef.current !== nextVersionKey) {
          versionKeyRef.current = nextVersionKey;
          postBoardPollingMessage({ type: "board-reload", summary, versionKey: nextVersionKey });
          await reload({ refreshVersion: false });
          return;
        }
        versionKeyRef.current = nextVersionKey;
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
  }, [enabled, pollingEnabled, reload]);

  useEffect(() => {
    if (!enabled || !pollingEnabled) return;
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
    const clientId = pollingClientIdRef.current ?? createBoardPollingClientId();
    pollingClientIdRef.current = clientId;
    const channel = new BroadcastChannel(BOARD_VERSION_BROADCAST_CHANNEL);
    broadcastChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent<BoardPollingBroadcastMessage>) => {
      const message = event.data;
      if (!message || message.sourceId === clientId) return;
      lastVersionSummaryRef.current = message.summary;
      versionKeyRef.current = message.versionKey;
      if (message.type === "board-reload") void reload({ refreshVersion: false });
    };
    return () => {
      if (broadcastChannelRef.current === channel) broadcastChannelRef.current = null;
      channel.close();
    };
  }, [enabled, pollingEnabled, reload]);

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
      if (lastVersionSummaryRef.current) {
        versionKeyRef.current = buildBoardVersionKey(lastVersionSummaryRef.current, current);
      }
      setBoardData({ ...current });
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [enabled, data]);

  return { data, error, reload };
}
