import { useEffect, useState } from "react";
import { apiGet } from "../../api/client";
import type { DashboardPayload } from "./types";

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
        if (active) setError(err instanceof Error ? err.message : "대시보드를 불러오지 못했습니다.");
      });
    return () => {
      active = false;
    };
  }, []);

  return { data, error };
}
