import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, apiGet } from "../../api/client";
import type { BoardPayload } from "./types";

const BOARD_VERSION_CHECK_INTERVAL_MS = 120_000;

interface BoardVersionSummary {
  manifestVersion: number;
  sheets: Array<{ id: string; version: number }>;
  periodFingerprint: string;
}

export function formatBoardError(err: unknown): string {
  if (err instanceof ApiClientError && err.code === "unauthorized") {
    return "로그인이 필요합니다. Discord 또는 Google로 로그인해주세요.";
  }
  return err instanceof Error ? err.message : "보드 데이터를 불러오지 못했습니다.";
}

export function useBoard({ enabled = true }: { enabled?: boolean | undefined } = {}) {
  const [data, setData] = useState<BoardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dataRef = useRef<BoardPayload | null>(null);
  const versionKeyRef = useRef<string | null>(null);

  function setBoardData(payload: BoardPayload | null) {
    dataRef.current = payload;
    setData(payload);
  }

  async function refreshVersionKey() {
    const summary = await apiGet<BoardVersionSummary>("/api/board/versions");
    versionKeyRef.current = JSON.stringify(summary);
    return summary;
  }

  const reload = useCallback(async () => {
    if (!enabled) return dataRef.current;
    setError(null);
    try {
      const payload = await apiGet<BoardPayload>("/api/board");
      setBoardData(payload);
      void refreshVersionKey().catch(() => {
        // Version checks are an optimization; the full board payload remains authoritative.
      });
      return payload;
    } catch (err) {
      setError(formatBoardError(err));
      throw err;
    }
  }, [enabled]);

  useEffect(() => {
    let active = true;
    setError(null);
    if (!enabled) {
      setBoardData(null);
      versionKeyRef.current = null;
      return () => {
        active = false;
      };
    }
    apiGet<BoardPayload>("/api/board")
      .then((payload) => {
        if (active) {
          setBoardData(payload);
          void refreshVersionKey().catch(() => {
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
    if (!enabled) return;
    let active = true;

    async function checkForRemoteChanges() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const summary = await apiGet<BoardVersionSummary>("/api/board/versions");
        if (!active) return;
        const nextVersionKey = JSON.stringify(summary);
        if (versionKeyRef.current && versionKeyRef.current !== nextVersionKey) {
          await reload();
          return;
        }
        versionKeyRef.current = nextVersionKey;
      } catch {
        // Keep the current board visible; manual refresh/login handling remains available.
      }
    }

    function handleFocus() {
      void checkForRemoteChanges();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void checkForRemoteChanges();
      }
    }

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const timer = window.setInterval(() => {
      void checkForRemoteChanges();
    }, BOARD_VERSION_CHECK_INTERVAL_MS);

    return () => {
      active = false;
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearInterval(timer);
    };
  }, [enabled, reload]);

  return { data, error, reload };
}
