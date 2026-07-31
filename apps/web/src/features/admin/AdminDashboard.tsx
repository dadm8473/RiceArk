import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ApiClientError, apiGet } from "../../api/client";
import { DataTab } from "./DataTab";
import { HealthTab } from "./HealthTab";
import { OverviewTab } from "./OverviewTab";
import { UsageTab } from "./UsageTab";
import { formatGeneratedAt } from "./format";
import type { AdminHealth, AdminSummary, AdminTab } from "./types";

export type { AdminHealth, AdminSummary, AdminTab } from "./types";

const TAB_LABELS: Array<{ key: AdminTab; label: string }> = [
  { key: "overview", label: "개요" },
  { key: "usage", label: "사용량·비용" },
  { key: "health", label: "헬스·에러" },
  { key: "data", label: "데이터" },
  { key: "users", label: "사용자 보드" },
  { key: "audit", label: "관리 기록" }
];

type AdminDashboardContentProps = {
  summary: AdminSummary;
  health: AdminHealth | null;
  healthError?: string | null;
  activeTab?: AdminTab;
  refreshing?: boolean;
  onRefresh?: () => void;
  onTabSelected?: (tab: AdminTab) => void;
};

export function AdminDashboardContent({
  summary,
  health,
  healthError = null,
  activeTab = "overview",
  refreshing = false,
  onRefresh,
  onTabSelected = () => undefined
}: AdminDashboardContentProps) {
  return (
    <div className="admin-dashboard">
      <div className="admin-dashboard-header">
        <div>
          <h2>운영 현황</h2>
          <p>개인정보 없이 집계 지표만 표시합니다. 기준 시각 {formatGeneratedAt(summary.generatedAt)}</p>
        </div>
        {onRefresh ? (
          <button className="secondary-button admin-refresh-button" disabled={refreshing} type="button" onClick={onRefresh}>
            <RefreshCw aria-hidden="true" size={15} />
            {refreshing ? "새로고침 중" : "새로고침"}
          </button>
        ) : null}
      </div>

      <div className="admin-tab-bar" role="tablist" aria-label="운영 현황 탭">
        {TAB_LABELS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            className={`admin-tab${activeTab === tab.key ? " active" : ""}`}
            onClick={() => onTabSelected(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "overview" ? <OverviewTab summary={summary} health={health} /> : null}
      {activeTab === "usage" ? <UsageTab summary={summary} /> : null}
      {activeTab === "health" ? <HealthTab health={health} healthError={healthError} /> : null}
      {activeTab === "data" ? <DataTab summary={summary} /> : null}
    </div>
  );
}

export type AdminDashboardProps = {
  activeTab: AdminTab | null;
  selectedUserId: string | null;
  selectedSheetId: string | null;
  onTabSelected: (tab: AdminTab) => void;
  onUserSelected: (userId: string | null) => void;
  onSheetSelected: (sheetId: string) => void;
  onReplaceSheetId: (sheetId: string | null) => void;
};

function getAdminErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError && err.code === "forbidden") return "관리자 권한이 없습니다.";
  if (err instanceof ApiClientError && err.code === "unauthorized") return "로그인이 필요합니다.";
  return err instanceof Error ? err.message : "운영 현황을 불러오지 못했습니다.";
}

export function AdminDashboard({ activeTab, onTabSelected }: AdminDashboardProps) {
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [summaryResult, healthResult] = await Promise.allSettled([
      apiGet<AdminSummary>("/api/admin/summary"),
      apiGet<AdminHealth>("/api/admin/health")
    ]);

    if (summaryResult.status === "fulfilled") {
      setSummary(summaryResult.value);
    } else {
      setError(getAdminErrorMessage(summaryResult.reason));
    }
    if (healthResult.status === "fulfilled") {
      setHealth(healthResult.value);
      setHealthError(null);
    } else {
      setHealth(null);
      setHealthError(getAdminErrorMessage(healthResult.reason));
    }
    setLoading(false);
  };

  useEffect(() => {
    void loadAll();
  }, []);

  if (summary) {
    return (
      <AdminDashboardContent
        summary={summary}
        health={health}
        healthError={healthError}
        activeTab={activeTab ?? "overview"}
        refreshing={loading}
        onRefresh={loadAll}
        onTabSelected={onTabSelected}
      />
    );
  }

  return (
    <div className="admin-dashboard">
      <div className="admin-dashboard-header">
        <div>
          <h2>운영 현황</h2>
          <p>{loading ? "운영 지표를 불러오는 중입니다." : "운영 지표를 표시할 수 없습니다."}</p>
        </div>
        <button className="secondary-button admin-refresh-button" disabled={loading} type="button" onClick={loadAll}>
          <RefreshCw aria-hidden="true" size={15} />
          다시 불러오기
        </button>
      </div>
      {error ? <p className="error-text">{error}</p> : null}
    </div>
  );
}
