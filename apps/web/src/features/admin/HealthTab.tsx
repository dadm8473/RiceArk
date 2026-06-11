import { AdminSimpleTable, StatusDot } from "./AdminPrimitives";
import { formatDuration, formatGeneratedAt, formatNumber } from "./format";
import type { AdminHealth, AdminHealthCheck } from "./types";

function checkTone(check: AdminHealthCheck): "ok" | "danger" {
  return check.status === "ok" ? "ok" : "danger";
}

function checkDetail(check: AdminHealthCheck): string {
  if (check.status === "ok") return check.latencyMs === null ? "정상" : `${check.latencyMs} ms`;
  return check.errorCode ?? "오류";
}

export function HealthTab({ health, healthError }: { health: AdminHealth | null; healthError: string | null }) {
  if (!health) {
    return (
      <div className="admin-tab-panel">
        <section className="admin-section" aria-labelledby="admin-health-unavailable-heading">
          <h3 id="admin-health-unavailable-heading">서비스 헬스</h3>
          <p className="admin-section-helper">헬스 정보를 불러오지 못했습니다. 새로고침으로 다시 시도할 수 있습니다.</p>
          {healthError ? <p className="error-text">{healthError}</p> : null}
        </section>
      </div>
    );
  }

  const lostark = health.checks.lostark;
  const lostarkTone = !lostark.configured
    ? ("unknown" as const)
    : lostark.lastFailureAt && (!lostark.lastSuccessAt || lostark.lastFailureAt > lostark.lastSuccessAt)
      ? ("danger" as const)
      : ("ok" as const);

  return (
    <div className="admin-tab-panel">
      <section className="admin-section" aria-labelledby="admin-health-checks-heading">
        <h3 id="admin-health-checks-heading">서비스 헬스</h3>
        <p className="admin-section-helper">기준 시각 {formatGeneratedAt(health.generatedAt)}</p>
        <div className="admin-status-strip">
          <StatusDot tone="ok" label="API" detail="응답 정상" />
          <StatusDot tone={checkTone(health.checks.d1)} label="D1 데이터베이스" detail={checkDetail(health.checks.d1)} />
          <StatusDot tone={checkTone(health.checks.kv)} label="KV 캐시" detail={checkDetail(health.checks.kv)} />
          <StatusDot
            tone={lostarkTone}
            label="로스트아크 API"
            detail={lostark.configured ? (lostark.lastFailureCode ?? "정상") : "미설정"}
          />
        </div>
      </section>

      <section className="admin-section" aria-labelledby="admin-health-lostark-heading">
        <h3 id="admin-health-lostark-heading">로스트아크 캘린더 캐시</h3>
        <AdminSimpleTable
          columns={["값"]}
          rows={[
            {
              key: "cache-age",
              label: "캐시 나이",
              values: [lostark.cacheAgeSeconds === null ? "기록 없음" : `${formatDuration(lostark.cacheAgeSeconds)} 전 갱신`]
            },
            {
              key: "cache-ttl",
              label: "캐시 TTL",
              values: [formatDuration(lostark.cacheTtlSeconds)]
            },
            {
              key: "last-success",
              label: "마지막 성공",
              values: [lostark.lastSuccessAt ? formatGeneratedAt(lostark.lastSuccessAt) : "기록 없음"]
            },
            {
              key: "last-failure",
              label: "마지막 실패",
              values: [
                lostark.lastFailureAt
                  ? `${formatGeneratedAt(lostark.lastFailureAt)} (${lostark.lastFailureCode ?? "코드 없음"})`
                  : "기록 없음"
              ]
            }
          ]}
        />
      </section>

      <section className="admin-section" aria-labelledby="admin-health-errors-heading">
        <h3 id="admin-health-errors-heading">에러 집계</h3>
        <p className="admin-section-helper">에러 응답에서만 집계합니다. 날짜 기준은 UTC입니다.</p>
        <div className="admin-overview-grid compact">
          <div className="admin-metric-card">
            <span>오늘 오류</span>
            <strong>{formatNumber(health.errors.totals.today)}</strong>
            <small>
              4xx {formatNumber(health.errors.totals.clientErrorsToday)} · 5xx{" "}
              {formatNumber(health.errors.totals.serverErrorsToday)}
            </small>
          </div>
          <div className="admin-metric-card">
            <span>최근 7일 오류</span>
            <strong>{formatNumber(health.errors.totals.last7d)}</strong>
          </div>
        </div>
        {health.errors.byCode.length ? (
          <div className="admin-usage-panel">
            <h4>오류 코드별</h4>
            <AdminSimpleTable
              columns={["구분", "오늘(UTC)", "최근 7일"]}
              rows={health.errors.byCode.map((entry) => ({
                key: `${entry.code}-${entry.statusClass}`,
                label: entry.code,
                values: [entry.statusClass, entry.today, entry.last7d]
              }))}
            />
          </div>
        ) : null}
        {health.errors.byRouteGroup.length ? (
          <div className="admin-usage-panel">
            <h4>기능 영역별</h4>
            <AdminSimpleTable
              columns={["오늘(UTC)", "최근 7일", "7일 5xx"]}
              rows={health.errors.byRouteGroup.map((entry) => ({
                key: entry.routeGroup,
                label: entry.routeGroup,
                values: [entry.today, entry.last7d, entry.serverErrors7d]
              }))}
            />
          </div>
        ) : null}
      </section>

      <section className="admin-section" aria-labelledby="admin-health-deployment-heading">
        <h3 id="admin-health-deployment-heading">배포 · 환경</h3>
        <p className="admin-section-helper">환경 {health.deployment.environment}. 시크릿은 설정 여부만 표시합니다.</p>
        <div className="admin-secret-grid">
          {health.deployment.secrets.map((secret) => (
            <div key={secret.name} className="admin-secret-item">
              <code>{secret.name}</code>
              <span className={`admin-usage-state ${secret.configured ? "ok" : "unknown"}`}>
                {secret.configured ? "설정됨" : "미설정"}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
