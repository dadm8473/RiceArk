import { useEffect, useState } from "react";
import { ApiClientError, apiGet } from "../../api/client";
import type { DashboardPayload } from "./types";

export function formatDashboardError(err: unknown): string {
  if (err instanceof ApiClientError && err.code === "unauthorized") {
    return "로그인이 필요합니다. Discord 또는 Google로 로그인해주세요.";
  }
  return err instanceof Error ? err.message : "대시보드를 불러오지 못했습니다.";
}

export function useDashboard() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<DashboardPayload>("/api/dashboard")
      .then((payload) => {
        if (active) setData(payload);
      })
      .catch((err: unknown) => {
        if (active) setError(formatDashboardError(err));
      });
    return () => {
      active = false;
    };
  }, []);

  return { data, error };
}
