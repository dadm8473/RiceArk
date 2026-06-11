import { AdminSimpleTable, CapacitySummary, CloudflareSetupBox, StatusBadge, UsageDetailTable } from "./AdminPrimitives";
import { formatGeneratedAt, formatNumber, formatOptionalNumber } from "./format";
import { buildUsageMetrics } from "./usageMetrics";
import type { AdminSummary } from "./types";

const CLOUDFLARE_STATUS_LABELS: Record<AdminSummary["cloudflare"]["status"], string> = {
  ok: "정상",
  partial: "일부 표시",
  unconfigured: "미설정",
  error: "오류"
};

export function UsageTab({ summary }: { summary: AdminSummary }) {
  const { cloudflare } = summary;
  const checkedAt = cloudflare.checkedAt ? formatGeneratedAt(cloudflare.checkedAt) : null;
  const metrics = buildUsageMetrics(summary);

  const detailRows = [
    {
      key: "d1-queries",
      label: "D1 쿼리 (read / write)",
      values: [
        formatOptionalNumber(cloudflare.d1?.readQueries24h ?? null),
        formatOptionalNumber(cloudflare.d1?.writeQueries24h ?? null)
      ]
    },
    {
      key: "workers-errors",
      label: "Workers (에러 / 서브요청)",
      values: [
        formatOptionalNumber(cloudflare.workers?.errors24h ?? null),
        formatOptionalNumber(cloudflare.workers?.subrequests24h ?? null)
      ]
    },
    {
      key: "workers-cpu",
      label: "Workers CPU (P50 / P99)",
      values: [
        cloudflare.workers?.cpuTimeP50Ms === null || cloudflare.workers === null
          ? "정보 없음"
          : `${cloudflare.workers.cpuTimeP50Ms} ms`,
        cloudflare.workers?.cpuTimeP99Ms === null || cloudflare.workers === null
          ? "정보 없음"
          : `${cloudflare.workers.cpuTimeP99Ms} ms`
      ]
    },
    {
      key: "d1-tables",
      label: "D1 테이블 수",
      values: [formatOptionalNumber(cloudflare.d1?.numTables ?? null), ""]
    }
  ];

  return (
    <div className="admin-tab-panel">
      <section className="admin-section" aria-labelledby="admin-usage-detail-heading">
        <div className="admin-section-title-row">
          <h3 id="admin-usage-detail-heading">Cloudflare 사용량</h3>
          <StatusBadge tone={cloudflare.status} label={CLOUDFLARE_STATUS_LABELS[cloudflare.status]} />
        </div>
        <p className="admin-section-helper">
          {checkedAt
            ? `Cloudflare 기준 시각 ${checkedAt}. ${cloudflare.cacheTtlSeconds}초 동안 캐시됩니다.`
            : "사용량 조회 설정 후 표시됩니다."}
        </p>

        {cloudflare.configured ? (
          <>
            <UsageDetailTable metrics={metrics} />
            <div className="admin-usage-panel">
              <h4>상세 지표</h4>
              <AdminSimpleTable columns={["값 1", "값 2"]} rows={detailRows} />
            </div>
          </>
        ) : (
          <CloudflareSetupBox requiredSecrets={cloudflare.requiredSecrets} />
        )}

        <CapacitySummary cloudflare={cloudflare} />

        {cloudflare.warnings.length ? (
          <div className="admin-warning-list">
            {cloudflare.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        ) : null}
      </section>

      <section className="admin-section subtle" aria-labelledby="admin-reference-heading">
        <h3 id="admin-reference-heading">무료 한도 참고</h3>
        <p>
          D1 무료 기준 rows read {formatNumber(summary.freePlanReference.d1RowsReadDaily)} / day, rows written{" "}
          {formatNumber(summary.freePlanReference.d1RowsWrittenDaily)} / day, Workers 요청{" "}
          {formatNumber(summary.freePlanReference.workersRequestsDaily)} / day.
        </p>
        <p>한도 수치는 Cloudflare 요금 정책 변경 시 달라질 수 있으므로 주기적으로 공식 문서와 대조해야 합니다.</p>
      </section>
    </div>
  );
}
