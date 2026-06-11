import { CloudflareSetupBox, MetricCard, StatusDot, UsageBar } from "./AdminPrimitives";
import { formatDuration, formatNumber, formatPercent, usageTone, type UsageToneValue } from "./format";
import { buildUsageMetrics, worstUsagePercent } from "./usageMetrics";
import type { AdminHealth, AdminSummary } from "./types";

function serviceStatus(health: AdminHealth | null): { tone: UsageToneValue; label: string; detail?: string } {
  if (!health) return { tone: "unknown", label: "서비스 확인 불가" };
  const failing = [
    health.checks.d1.status === "error" ? "D1" : null,
    health.checks.kv.status === "error" ? "KV" : null
  ].filter((name): name is string => name !== null);
  if (failing.length > 0) return { tone: "danger", label: "서비스 이상", detail: `${failing.join(", ")} 오류` };
  return { tone: "ok", label: "서비스 정상", detail: "API · D1 · KV" };
}

function lostarkStatus(health: AdminHealth | null): { tone: UsageToneValue; label: string; detail?: string } {
  if (!health) return { tone: "unknown", label: "로아 캐시 확인 불가" };
  const lostark = health.checks.lostark;
  if (!lostark.configured) return { tone: "unknown", label: "로아 API 미설정" };
  if (lostark.lastFailureAt && (!lostark.lastSuccessAt || lostark.lastFailureAt > lostark.lastSuccessAt)) {
    return { tone: "danger", label: "로아 API 실패", ...(lostark.lastFailureCode ? { detail: lostark.lastFailureCode } : {}) };
  }
  if (lostark.cacheAgeSeconds === null) return { tone: "unknown", label: "로아 캐시 기록 없음" };
  return { tone: "ok", label: "로아 캐시 정상", detail: `${formatDuration(lostark.cacheAgeSeconds)} 전 갱신` };
}

function usageStatus(summary: AdminSummary): { tone: UsageToneValue; label: string; detail?: string } {
  if (!summary.cloudflare.configured) return { tone: "unknown", label: "한도 확인 불가", detail: "Cloudflare 미설정" };
  const worst = worstUsagePercent(buildUsageMetrics(summary));
  const tone = usageTone(worst);
  const label = tone === "danger" ? "한도 위험" : tone === "warn" ? "한도 주의" : tone === "unknown" ? "한도 확인 불가" : "한도 안정";
  return { tone, label, ...(worst === null ? {} : { detail: `최대 ${formatPercent(worst)}` }) };
}

function errorStatus(health: AdminHealth | null): { tone: UsageToneValue; label: string; detail?: string } {
  if (!health) return { tone: "unknown", label: "오류 확인 불가" };
  const { today, serverErrorsToday } = health.errors.totals;
  if (serverErrorsToday > 0) {
    return { tone: "danger", label: `오늘 오류 ${formatNumber(today)}건`, detail: `5xx ${formatNumber(serverErrorsToday)}건` };
  }
  if (today > 0) return { tone: "warn", label: `오늘 오류 ${formatNumber(today)}건`, detail: "전부 4xx" };
  return { tone: "ok", label: "오늘 오류 0건" };
}

export function OverviewTab({ summary, health }: { summary: AdminSummary; health: AdminHealth | null }) {
  const service = serviceStatus(health);
  const lostark = lostarkStatus(health);
  const usage = usageStatus(summary);
  const errors = errorStatus(health);
  const metrics = buildUsageMetrics(summary);

  return (
    <div className="admin-tab-panel">
      <div className="admin-status-strip">
        <StatusDot tone={service.tone} label={service.label} {...(service.detail ? { detail: service.detail } : {})} />
        <StatusDot tone={lostark.tone} label={lostark.label} {...(lostark.detail ? { detail: lostark.detail } : {})} />
        <StatusDot tone={usage.tone} label={usage.label} {...(usage.detail ? { detail: usage.detail } : {})} />
        <StatusDot tone={errors.tone} label={errors.label} {...(errors.detail ? { detail: errors.detail } : {})} />
      </div>

      <section className="admin-section" aria-labelledby="admin-overview-metrics-heading">
        <h3 id="admin-overview-metrics-heading">핵심 지표</h3>
        <div className="admin-overview-grid">
          <MetricCard
            label="전체 가입"
            value={summary.users.total}
            helper={`최근 24시간 +${formatNumber(summary.users.created24h)}명`}
          />
          <MetricCard
            label="로그인 유지"
            value={summary.users.activeLoggedIn}
            helper={`${formatNumber(summary.users.activeSessions)}개 세션`}
          />
          <MetricCard label="최근 24시간 체크 유저" value={summary.activity.completionUsers24h} />
          <MetricCard label="최근 24시간 체크 변경" value={summary.activity.completionUpdates24h} />
        </div>
      </section>

      <section className="admin-section" aria-labelledby="admin-overview-usage-heading">
        <h3 id="admin-overview-usage-heading">무료 한도 사용률</h3>
        {summary.cloudflare.configured ? (
          <div className="admin-usage-grid">
            {metrics.map((metric) => (
              <UsageBar key={metric.key} metric={metric} />
            ))}
          </div>
        ) : (
          <CloudflareSetupBox requiredSecrets={summary.cloudflare.requiredSecrets} />
        )}
      </section>
    </div>
  );
}
