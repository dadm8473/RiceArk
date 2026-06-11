import { formatBytes, formatLimit, formatOptionalNumber } from "./format";
import type { AdminSummary } from "./types";

export type UsageMetric = {
  key: string;
  label: string;
  value: string;
  limit: string;
  percent: number | null;
  helper?: string;
};

export function buildUsageMetrics(summary: AdminSummary): UsageMetric[] {
  const { cloudflare } = summary;
  return [
    {
      key: "d1-read",
      label: "D1 rows read",
      value: formatOptionalNumber(cloudflare.d1?.rowsRead24h ?? null),
      limit: formatLimit(summary.freePlanReference.d1RowsReadDaily),
      percent: cloudflare.d1?.rowsReadPercent ?? null
    },
    {
      key: "d1-write",
      label: "D1 rows written",
      value: formatOptionalNumber(cloudflare.d1?.rowsWritten24h ?? null),
      limit: formatLimit(summary.freePlanReference.d1RowsWrittenDaily),
      percent: cloudflare.d1?.rowsWrittenPercent ?? null
    },
    {
      key: "d1-storage",
      label: "D1 DB 크기",
      value: formatBytes(cloudflare.d1?.databaseSizeBytes ?? null),
      limit: "5 GB",
      percent: cloudflare.d1?.storagePercent ?? null,
      ...(cloudflare.d1?.databaseName ? { helper: cloudflare.d1.databaseName } : {})
    },
    {
      key: "workers-requests",
      label: "Workers 요청",
      value: formatOptionalNumber(cloudflare.workers?.requests24h ?? null),
      limit: formatLimit(summary.freePlanReference.workersRequestsDaily),
      percent: cloudflare.workers?.requestPercent ?? null,
      ...(cloudflare.workers?.scriptName ? { helper: cloudflare.workers.scriptName } : {})
    }
  ];
}

export function worstUsagePercent(metrics: UsageMetric[]): number | null {
  const percents = metrics.map((metric) => metric.percent).filter((value): value is number => value !== null);
  if (percents.length === 0) return null;
  return Math.max(...percents);
}
