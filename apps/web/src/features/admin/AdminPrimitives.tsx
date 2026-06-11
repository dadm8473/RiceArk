import { formatNumber, formatOptionalPeople, formatPercent, usageStatusLabel, usageTone, type UsageToneValue } from "./format";
import type { UsageMetric } from "./usageMetrics";
import type { AdminSummary } from "./types";

export function MetricCard({ label, value, helper }: { label: string; value: number; helper?: string }) {
  return (
    <div className="admin-metric-card">
      <span>{label}</span>
      <strong>{formatNumber(value)}</strong>
      {helper ? <small>{helper}</small> : null}
    </div>
  );
}

export function StatusBadge({ tone, label }: { tone: string; label: string }) {
  return <span className={`admin-status-badge ${tone}`}>{label}</span>;
}

export function StatusDot({ tone, label, detail }: { tone: UsageToneValue; label: string; detail?: string }) {
  return (
    <div className={`admin-status-item ${tone}`}>
      <i className="admin-status-dot" aria-hidden="true" />
      <div>
        <span>{label}</span>
        {detail ? <small>{detail}</small> : null}
      </div>
    </div>
  );
}

export function UsageBar({ metric }: { metric: UsageMetric }) {
  const tone = usageTone(metric.percent);
  const width = metric.percent === null ? 0 : Math.min(100, Math.max(0, metric.percent));
  return (
    <div className={`admin-usage-row ${tone}`}>
      <div>
        <span>{metric.label}</span>
        <strong>{formatPercent(metric.percent)}</strong>
      </div>
      <small>
        {metric.value} / {metric.limit}
      </small>
      <div className="admin-usage-bar" aria-hidden="true">
        <i style={{ width: `${width}%` }} />
      </div>
      {metric.helper ? <em>{metric.helper}</em> : null}
    </div>
  );
}

export function UsageDetailTable({ metrics }: { metrics: UsageMetric[] }) {
  return (
    <div className="admin-usage-table-wrap">
      <table className="admin-usage-table">
        <thead>
          <tr>
            <th scope="col">항목</th>
            <th scope="col">최근 24시간 사용량</th>
            <th scope="col">무료 한도</th>
            <th scope="col">사용률</th>
            <th scope="col">상태</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((metric) => (
            <tr key={metric.key}>
              <th scope="row">{metric.label}</th>
              <td>{metric.value}</td>
              <td>{metric.limit}</td>
              <td>{formatPercent(metric.percent)}</td>
              <td>
                <span className={`admin-usage-state ${usageTone(metric.percent)}`}>{usageStatusLabel(metric.percent)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminSimpleTable({
  columns,
  rows
}: {
  columns: string[];
  rows: Array<{ key: string; label: string; values: Array<string | number> }>;
}) {
  return (
    <div className="admin-usage-table-wrap">
      <table className="admin-usage-table admin-simple-table">
        <thead>
          <tr>
            <th scope="col">항목</th>
            {columns.map((column) => (
              <th scope="col" key={column}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              {row.values.map((value, index) => (
                <td key={`${row.key}-${index}`}>{typeof value === "number" ? formatNumber(value) : value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CapacitySummary({ cloudflare }: { cloudflare: AdminSummary["cloudflare"] }) {
  const capacityItems = [
    { label: "D1 read 기준", value: cloudflare.capacity.estimatedDauByD1Reads },
    { label: "D1 write 기준", value: cloudflare.capacity.estimatedDauByD1Writes },
    { label: "Workers 기준", value: cloudflare.capacity.estimatedDauByWorkerRequests }
  ];

  return (
    <div className="admin-capacity-box">
      <div>
        <strong>예상 DAU 여유</strong>
        {cloudflare.capacity.bottleneck ? <small>병목 {cloudflare.capacity.bottleneck}</small> : null}
      </div>
      <div className="admin-capacity-grid">
        {capacityItems.map((item) => (
          <span key={item.label}>
            <b>{formatOptionalPeople(item.value)}</b>
            <small>{item.label}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

export function CloudflareSetupBox({ requiredSecrets }: { requiredSecrets: string[] }) {
  return (
    <div className="admin-setup-box">
      <strong>Cloudflare 사용량 미설정</strong>
      <p>서버 환경 변수에 다음 값을 추가하면 관리자 화면에서 실제 사용량을 볼 수 있습니다.</p>
      <code>{requiredSecrets.join(", ")}</code>
    </div>
  );
}
