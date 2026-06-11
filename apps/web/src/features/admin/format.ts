export function formatNumber(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}

export function formatOptionalNumber(value: number | null): string {
  return value === null ? "정보 없음" : formatNumber(value);
}

export function formatOptionalPeople(value: number | null): string {
  return value === null ? "정보 없음" : `${formatNumber(value)}명`;
}

export function formatPercent(value: number | null): string {
  if (value === null) return "정보 없음";
  return `${value.toFixed(1)}%`;
}

export function formatBytes(value: number | null): string {
  if (value === null) return "정보 없음";
  if (value < 1024) return `${formatNumber(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatLimit(value: number | string): string {
  return typeof value === "number" ? `${formatNumber(value)} / day` : value;
}

export function formatGeneratedAt(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul"
  }).format(new Date(value));
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "정보 없음";
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`;
  return `${Math.floor(seconds / 86400)}일`;
}

export type UsageToneValue = "ok" | "warn" | "danger" | "unknown";

export function usageTone(value: number | null): UsageToneValue {
  if (value === null) return "unknown";
  if (value >= 80) return "danger";
  if (value >= 50) return "warn";
  return "ok";
}

export function usageStatusLabel(value: number | null): string {
  const tone = usageTone(value);
  if (tone === "danger") return "위험";
  if (tone === "warn") return "주의";
  if (tone === "unknown") return "확인 필요";
  return "안정";
}
