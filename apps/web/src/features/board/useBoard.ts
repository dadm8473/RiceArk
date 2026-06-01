import { useEffect, useState } from "react";
import { ApiClientError, apiGet } from "../../api/client";
import type { BoardPayload } from "./types";

export function formatBoardError(err: unknown): string {
  if (err instanceof ApiClientError && err.code === "unauthorized") {
    return "로그인이 필요합니다. Discord 또는 Google로 로그인해주세요.";
  }
  return err instanceof Error ? err.message : "보드 데이터를 불러오지 못했습니다.";
}

export function useBoard() {
  const [data, setData] = useState<BoardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<BoardPayload>("/api/board")
      .then((payload) => {
        if (active) setData(payload);
      })
      .catch((err: unknown) => {
        if (active) setError(formatBoardError(err));
      });
    return () => {
      active = false;
    };
  }, []);

  return { data, error };
}
