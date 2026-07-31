import { useCallback, useEffect, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { ApiClientError, apiGet } from "../../api/client";
import type { AdminAuditLog, AdminAuditLogPage } from "./types";

const ACTION_LABELS: Record<string, string> = {
  "board.completions.update": "체크 상태 변경",
  "board.cell_states.update": "체크칸 설정 변경",
  "characters.refresh": "캐릭터 정보 갱신",
  "settings.update": "보드 표시 설정 변경"
};

function formatAuditDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul"
  }).format(new Date(value));
}

function userIdSuffix(userId: string): string {
  return userId.slice(-4);
}

function getAuditErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.code === "forbidden") {
    return "관리자 권한이 없습니다.";
  }
  if (error instanceof ApiClientError && error.code === "unauthorized") {
    return "로그인이 필요합니다.";
  }
  return "관리 기록을 불러오지 못했습니다.";
}

function mergeAuditLogs(
  current: AdminAuditLog[],
  incoming: AdminAuditLog[]
): AdminAuditLog[] {
  const logs = new Map(current.map((log) => [log.id, log]));
  for (const log of incoming) logs.set(log.id, log);
  return [...logs.values()];
}

export function getAdminAuditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export function AdminAuditToolbar({
  refreshing,
  onRefresh
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="admin-audit-toolbar">
      <div>
        <h3>관리 기록</h3>
        <span>관리자 보드 변경 이력</span>
      </div>
      <button
        className="secondary-button admin-icon-button"
        aria-label="관리 기록 새로고침"
        title="관리 기록 새로고침"
        disabled={refreshing}
        type="button"
        onClick={onRefresh}
      >
        <RefreshCw aria-hidden="true" size={17} />
      </button>
    </div>
  );
}

export function AdminAuditTable({
  logs,
  loading,
  loadingMore,
  error,
  nextCursor,
  onRetry,
  onLoadMore
}: {
  logs: AdminAuditLog[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  if (loading && logs.length === 0) {
    return <p className="admin-management-state">관리 기록을 불러오는 중입니다.</p>;
  }

  if (error && logs.length === 0) {
    return (
      <div className="admin-management-state error" role="alert">
        <p>{error}</p>
        <button className="secondary-button" type="button" onClick={onRetry}>
          <RefreshCw aria-hidden="true" size={15} />
          다시 시도
        </button>
      </div>
    );
  }

  if (logs.length === 0) {
    return <p className="admin-management-state">관리 기록이 없습니다.</p>;
  }

  return (
    <div className="admin-audit-content">
      <div className="admin-audit-table-wrap">
        <table className="admin-audit-table">
          <thead>
            <tr>
              <th scope="col">시각</th>
              <th scope="col">관리자</th>
              <th scope="col">대상 사용자</th>
              <th scope="col">작업</th>
              <th scope="col">방식</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td>
                  <time dateTime={log.createdAt}>{formatAuditDate(log.createdAt)}</time>
                </td>
                <td>
                  <strong title={log.adminDisplayName}>{log.adminDisplayName}</strong>
                  <small>ID 끝자리 {userIdSuffix(log.adminUserId)}</small>
                </td>
                <td>
                  <strong title={log.targetDisplayName}>{log.targetDisplayName}</strong>
                  <small>ID 끝자리 {userIdSuffix(log.targetUserId)}</small>
                </td>
                <td>
                  <span>{getAdminAuditActionLabel(log.action)}</span>
                </td>
                <td>
                  <span className="admin-audit-method">{log.method}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? (
        <div className="admin-management-state error compact" role="alert">
          <p>{error}</p>
          <button className="secondary-button" type="button" onClick={onRetry}>
            <RefreshCw aria-hidden="true" size={15} />
            다시 시도
          </button>
        </div>
      ) : null}
      {nextCursor ? (
        <button
          className="secondary-button admin-load-more-button"
          disabled={loading || loadingMore}
          type="button"
          onClick={onLoadMore}
        >
          <ChevronDown aria-hidden="true" size={16} />
          {loadingMore ? "불러오는 중" : "이전 기록 더 보기"}
        </button>
      ) : null}
    </div>
  );
}

export function AdminAuditTab() {
  const [logs, setLogs] = useState<AdminAuditLog[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLogs = useCallback(async (cursor: string | null, append: boolean) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const path = cursor
        ? `/api/admin/audit-logs?cursor=${encodeURIComponent(cursor)}`
        : "/api/admin/audit-logs";
      const page = await apiGet<AdminAuditLogPage>(path);
      setLogs((current) => append ? mergeAuditLogs(current, page.logs) : page.logs);
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      setError(getAuditErrorMessage(loadError));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void loadLogs(null, false);
  }, [loadLogs]);

  return (
    <section className="admin-audit-management">
      <AdminAuditToolbar
        refreshing={loading || loadingMore}
        onRefresh={() => void loadLogs(null, false)}
      />
      <AdminAuditTable
        logs={logs}
        loading={loading}
        loadingMore={loadingMore}
        error={error}
        nextCursor={nextCursor}
        onRetry={() => void loadLogs(null, false)}
        onLoadMore={() => void loadLogs(nextCursor, true)}
      />
    </section>
  );
}
