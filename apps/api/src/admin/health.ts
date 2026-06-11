import type { Env } from "../env";
import { CALENDAR_CACHE_TTL_SECONDS, getLostArkCalendarStatus } from "../lostark/events";
import { readErrorCounters, summarizeErrorCounters, utcDayKey, type AdminErrorSummary } from "./errorCounters";

const SECRET_NAMES = [
  "LOSTARK_API_KEY",
  "ADMIN_OAUTH_ALLOWLIST",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_D1_DATABASE_ID",
  "CLOUDFLARE_WORKER_SCRIPT_NAME",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "SESSION_SECRET"
] as const;

type CheckResult = {
  status: "ok" | "error";
  latencyMs: number | null;
  errorCode: string | null;
};

export type AdminHealth = {
  generatedAt: string;
  checks: {
    api: { status: "ok" };
    d1: CheckResult;
    kv: CheckResult;
    lostark: {
      configured: boolean;
      lastSuccessAt: string | null;
      lastFailureAt: string | null;
      lastFailureCode: string | null;
      cacheAgeSeconds: number | null;
      cacheTtlSeconds: number;
    };
  };
  deployment: {
    environment: string;
    secrets: Array<{ name: string; configured: boolean }>;
  };
  errors: AdminErrorSummary;
};

async function timedCheck<T>(run: () => Promise<T>, errorCode: string): Promise<{ check: CheckResult; value: T | null }> {
  const startedAt = Date.now();
  try {
    const value = await run();
    return { check: { status: "ok", latencyMs: Date.now() - startedAt, errorCode: null }, value };
  } catch {
    return { check: { status: "error", latencyMs: null, errorCode }, value: null };
  }
}

export async function buildAdminHealth(env: Env): Promise<AdminHealth> {
  const now = new Date();
  const [d1Result, kvResult, errorRowsResult] = await Promise.all([
    timedCheck(async () => {
      await env.DB.prepare("SELECT 1").first();
    }, "d1_query_failed"),
    timedCheck(() => getLostArkCalendarStatus(env), "kv_read_failed"),
    timedCheck(() => readErrorCounters(env), "error_counters_read_failed")
  ]);

  const calendarStatus = kvResult.value;
  const lastSuccessAt = calendarStatus?.lastSuccessAt ?? null;
  const cacheAgeSeconds = lastSuccessAt
    ? Math.max(0, Math.floor((now.getTime() - new Date(lastSuccessAt).getTime()) / 1000))
    : null;

  return {
    generatedAt: now.toISOString(),
    checks: {
      api: { status: "ok" },
      d1: d1Result.check,
      kv: kvResult.check,
      lostark: {
        configured: Boolean(env.LOSTARK_API_KEY),
        lastSuccessAt,
        lastFailureAt: calendarStatus?.lastFailureAt ?? null,
        lastFailureCode: calendarStatus?.lastFailureCode ?? null,
        cacheAgeSeconds,
        cacheTtlSeconds: CALENDAR_CACHE_TTL_SECONDS
      }
    },
    deployment: {
      environment: env.ENVIRONMENT,
      secrets: SECRET_NAMES.map((name) => ({ name, configured: Boolean(env[name]) }))
    },
    errors: summarizeErrorCounters(errorRowsResult.value ?? [], utcDayKey(now))
  };
}
