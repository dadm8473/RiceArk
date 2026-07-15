import type { Env } from "../env";
import { fetchExternal } from "../http/externalFetch";

const D1_ROWS_READ_DAILY_LIMIT = 5_000_000;
const D1_ROWS_WRITTEN_DAILY_LIMIT = 100_000;
const D1_STORAGE_BYTES_LIMIT = 5 * 1024 * 1024 * 1024;
const WORKERS_REQUESTS_DAILY_LIMIT = 100_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

type CloudflareApiResponse<T> = {
  success?: boolean;
  result?: T;
  errors?: Array<{ message?: string }>;
};

type D1DatabaseResult = {
  name?: string;
  file_size?: number;
  database_size?: number | string;
  num_tables?: number;
  read_queries_24h?: number | string;
  write_queries_24h?: number | string;
  rows_read_24h?: number | string;
  rows_written_24h?: number | string;
};

type WorkerInvocation = {
  sum?: {
    requests?: number;
    errors?: number;
    subrequests?: number;
  };
  quantiles?: {
    cpuTimeP50?: number;
    cpuTimeP99?: number;
  };
};

type D1MetricGroup = {
  sum?: {
    readQueries?: number;
    writeQueries?: number;
    rowsRead?: number;
    rowsWritten?: number;
  };
};

type D1Metrics = {
  readQueries: number;
  writeQueries: number;
  rowsRead: number;
  rowsWritten: number;
};

type PagesProjectResult = {
  production_script_name?: string;
};

type D1MetricsGraphqlResponse = {
  data?: {
    viewer?: {
      accounts?: Array<{
        d1AnalyticsAdaptiveGroups?: D1MetricGroup[];
      }>;
    };
  };
  errors?: Array<{ message?: string }>;
};

type WorkersGraphqlResponse = {
  data?: {
    viewer?: {
      accounts?: Array<{
        workersInvocationsAdaptive?: WorkerInvocation[];
      }>;
    };
  };
  errors?: Array<{ message?: string }>;
};

export type CloudflareUsageSummary = {
  status: "ok" | "partial" | "unconfigured" | "error";
  configured: boolean;
  checkedAt: string | null;
  cacheTtlSeconds: number;
  requiredSecrets: string[];
  warnings: string[];
  d1: {
    databaseName: string | null;
    databaseSizeBytes: number | null;
    storagePercent: number | null;
    rowsRead24h: number | null;
    rowsWritten24h: number | null;
    readQueries24h: number | null;
    writeQueries24h: number | null;
    rowsReadPercent: number | null;
    rowsWrittenPercent: number | null;
    numTables: number | null;
  } | null;
  workers: {
    scriptName: string;
    requests24h: number;
    errors24h: number;
    subrequests24h: number;
    requestPercent: number;
    cpuTimeP50Ms: number | null;
    cpuTimeP99Ms: number | null;
  } | null;
  capacity: {
    activeUsers24h: number;
    estimatedDauByD1Reads: number | null;
    estimatedDauByD1Writes: number | null;
    estimatedDauByWorkerRequests: number | null;
    bottleneck: string | null;
  };
};

type CacheEntry = {
  key: string;
  expiresAt: number;
  value: Omit<CloudflareUsageSummary, "capacity">;
};

let usageCache: CacheEntry | null = null;

function tokenFingerprint(token: string | undefined): string {
  if (!token) return "";
  let hash = 2_166_136_261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "알 수 없는 오류";
}

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function percent(value: number | null, limit: number): number | null {
  if (value === null || limit <= 0) return null;
  return (value / limit) * 100;
}

function getMissingSecrets(env: Env): string[] {
  const missing: string[] = [];
  if (!env.CLOUDFLARE_ACCOUNT_ID) missing.push("CLOUDFLARE_ACCOUNT_ID");
  if (!env.CLOUDFLARE_API_TOKEN) missing.push("CLOUDFLARE_API_TOKEN");
  if (!env.CLOUDFLARE_D1_DATABASE_ID) missing.push("CLOUDFLARE_D1_DATABASE_ID");
  return missing;
}

function estimateCapacity(params: {
  activeUsers24h: number;
  rowsRead24h: number | null;
  rowsWritten24h: number | null;
  workerRequests24h: number | null;
}): CloudflareUsageSummary["capacity"] {
  const activeUsers = Math.max(0, params.activeUsers24h);
  if (activeUsers === 0) {
    return {
      activeUsers24h: activeUsers,
      estimatedDauByD1Reads: null,
      estimatedDauByD1Writes: null,
      estimatedDauByWorkerRequests: null,
      bottleneck: null
    };
  }

  const estimate = (value: number | null, limit: number) => {
    if (!value || value <= 0) return null;
    return Math.floor(limit / (value / activeUsers));
  };

  const estimatedDauByD1Reads = estimate(params.rowsRead24h, D1_ROWS_READ_DAILY_LIMIT);
  const estimatedDauByD1Writes = estimate(params.rowsWritten24h, D1_ROWS_WRITTEN_DAILY_LIMIT);
  const estimatedDauByWorkerRequests = estimate(params.workerRequests24h, WORKERS_REQUESTS_DAILY_LIMIT);
  const estimates = [
    { label: "D1 rows read", value: estimatedDauByD1Reads },
    { label: "D1 rows written", value: estimatedDauByD1Writes },
    { label: "Workers requests", value: estimatedDauByWorkerRequests }
  ];
  const bottleneck = estimates.reduce<{ label: string; value: number } | null>((lowest, item) => {
    if (item.value === null) return lowest;
    if (!lowest || item.value < lowest.value) return { label: item.label, value: item.value };
    return lowest;
  }, null);

  return {
    activeUsers24h: activeUsers,
    estimatedDauByD1Reads,
    estimatedDauByD1Writes,
    estimatedDauByWorkerRequests,
    bottleneck: bottleneck?.label ?? null
  };
}

function buildD1Usage(
  database: D1DatabaseResult | null,
  metrics: D1Metrics | null
): NonNullable<CloudflareUsageSummary["d1"]> | null {
  if (!database && !metrics) return null;
  const databaseSizeBytes = toNumber(database?.file_size) ?? toNumber(database?.database_size);
  const rowsRead24h = metrics?.rowsRead ?? toNumber(database?.rows_read_24h);
  const rowsWritten24h = metrics?.rowsWritten ?? toNumber(database?.rows_written_24h);
  return {
    databaseName: database?.name ?? null,
    databaseSizeBytes,
    storagePercent: percent(databaseSizeBytes, D1_STORAGE_BYTES_LIMIT),
    rowsRead24h,
    rowsWritten24h,
    readQueries24h: metrics?.readQueries ?? toNumber(database?.read_queries_24h),
    writeQueries24h: metrics?.writeQueries ?? toNumber(database?.write_queries_24h),
    rowsReadPercent: percent(rowsRead24h, D1_ROWS_READ_DAILY_LIMIT),
    rowsWrittenPercent: percent(rowsWritten24h, D1_ROWS_WRITTEN_DAILY_LIMIT),
    numTables: toNumber(database?.num_tables)
  };
}

async function fetchD1DatabaseInfo(env: Env, accountId: string, databaseId: string): Promise<D1DatabaseResult> {
  const response = await fetchExternal(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`, {
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) throw new Error(`Cloudflare D1 API returned ${response.status}`);

  const payload = (await response.json()) as CloudflareApiResponse<D1DatabaseResult>;
  if (payload.success === false) {
    const message = payload.errors?.map((error) => error.message).filter(Boolean).join(", ");
    throw new Error(message || "Cloudflare D1 API returned an error");
  }

  const result = payload.result ?? {};
  return result;
}

async function fetchD1Metrics(env: Env): Promise<D1Metrics> {
  const datetimeEnd = new Date().toISOString();
  const datetimeStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const response = await fetchExternal("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: `query getD1MetricsOverviewQuery($accountTag: string, $filter: ZoneWorkersRequestsFilter_InputObject) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            d1AnalyticsAdaptiveGroups(limit: 10000, filter: $filter) {
              sum {
                readQueries
                writeQueries
                rowsRead
                rowsWritten
              }
            }
          }
        }
      }`,
      operationName: "getD1MetricsOverviewQuery",
      variables: {
        accountTag: env.CLOUDFLARE_ACCOUNT_ID,
        filter: {
          AND: [
            {
              datetimeHour_geq: datetimeStart,
              datetimeHour_leq: datetimeEnd,
              databaseId: env.CLOUDFLARE_D1_DATABASE_ID
            }
          ]
        }
      }
    })
  });
  if (!response.ok) throw new Error(`Cloudflare D1 GraphQL API returned ${response.status}`);

  const payload = (await response.json()) as D1MetricsGraphqlResponse;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).filter(Boolean).join(", ") || "Cloudflare D1 GraphQL API returned an error");
  }

  return (payload.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? []).reduce(
    (acc, row) => {
      acc.readQueries += toNumber(row.sum?.readQueries) ?? 0;
      acc.writeQueries += toNumber(row.sum?.writeQueries) ?? 0;
      acc.rowsRead += toNumber(row.sum?.rowsRead) ?? 0;
      acc.rowsWritten += toNumber(row.sum?.rowsWritten) ?? 0;
      return acc;
    },
    {
      readQueries: 0,
      writeQueries: 0,
      rowsRead: 0,
      rowsWritten: 0
    }
  );
}

async function fetchWorkersUsage(env: Env, scriptName: string): Promise<NonNullable<CloudflareUsageSummary["workers"]>> {
  const datetimeEnd = new Date().toISOString();
  const datetimeStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const response = await fetchExternal("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: `query GetWorkersAnalytics($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            workersInvocationsAdaptive(limit: 10000, filter: {
              scriptName: $scriptName,
              datetime_geq: $datetimeStart,
              datetime_leq: $datetimeEnd
            }) {
              sum {
                subrequests
                requests
                errors
              }
              quantiles {
                cpuTimeP50
                cpuTimeP99
              }
            }
          }
        }
      }`,
      variables: {
        accountTag: env.CLOUDFLARE_ACCOUNT_ID,
        datetimeStart,
        datetimeEnd,
        scriptName
      }
    })
  });
  if (!response.ok) throw new Error(`Cloudflare GraphQL API returned ${response.status}`);

  const payload = (await response.json()) as WorkersGraphqlResponse;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).filter(Boolean).join(", ") || "Cloudflare GraphQL API returned an error");
  }

  const invocations = payload.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  const totals = invocations.reduce(
    (acc, invocation) => {
      acc.requests += toNumber(invocation.sum?.requests) ?? 0;
      acc.errors += toNumber(invocation.sum?.errors) ?? 0;
      acc.subrequests += toNumber(invocation.sum?.subrequests) ?? 0;
      acc.cpuTimeP50Ms = Math.max(acc.cpuTimeP50Ms ?? 0, toNumber(invocation.quantiles?.cpuTimeP50) ?? 0);
      acc.cpuTimeP99Ms = Math.max(acc.cpuTimeP99Ms ?? 0, toNumber(invocation.quantiles?.cpuTimeP99) ?? 0);
      return acc;
    },
    { requests: 0, errors: 0, subrequests: 0, cpuTimeP50Ms: null as number | null, cpuTimeP99Ms: null as number | null }
  );

  return {
    scriptName,
    requests24h: totals.requests,
    errors24h: totals.errors,
    subrequests24h: totals.subrequests,
    requestPercent: percent(totals.requests, WORKERS_REQUESTS_DAILY_LIMIT) ?? 0,
    cpuTimeP50Ms: totals.cpuTimeP50Ms,
    cpuTimeP99Ms: totals.cpuTimeP99Ms
  };
}

async function fetchPagesProductionScriptName(env: Env, accountId: string, projectName: string): Promise<string | null> {
  const response = await fetchExternal(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}`,
    {
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        Accept: "application/json"
      }
    }
  );
  if (!response.ok) throw new Error(`Cloudflare Pages API returned ${response.status}`);

  const payload = (await response.json()) as CloudflareApiResponse<PagesProjectResult>;
  if (payload.success === false) {
    const message = payload.errors?.map((error) => error.message).filter(Boolean).join(", ");
    throw new Error(message || "Cloudflare Pages API returned an error");
  }
  return payload.result?.production_script_name || null;
}

export async function getCloudflareUsage(env: Env, activeUsers24h: number): Promise<CloudflareUsageSummary> {
  const requiredSecrets = getMissingSecrets(env);
  if (requiredSecrets.length > 0) {
    return {
      status: "unconfigured",
      configured: false,
      checkedAt: null,
      cacheTtlSeconds: CACHE_TTL_MS / 1000,
      requiredSecrets,
      warnings: ["Cloudflare 사용량 조회에 필요한 서버 환경 변수가 아직 설정되지 않았습니다."],
      d1: null,
      workers: null,
      capacity: estimateCapacity({ activeUsers24h, rowsRead24h: null, rowsWritten24h: null, workerRequests24h: null })
    };
  }

  const cacheKey = JSON.stringify([
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_D1_DATABASE_ID,
    env.CLOUDFLARE_PAGES_PROJECT_NAME ?? "",
    env.CLOUDFLARE_WORKER_SCRIPT_NAME ?? "",
    tokenFingerprint(env.CLOUDFLARE_API_TOKEN)
  ]);
  const now = Date.now();
  if (usageCache?.key === cacheKey && usageCache.expiresAt > now) {
    return {
      ...usageCache.value,
      capacity: estimateCapacity({
        activeUsers24h,
        rowsRead24h: usageCache.value.d1?.rowsRead24h ?? null,
        rowsWritten24h: usageCache.value.d1?.rowsWritten24h ?? null,
        workerRequests24h: usageCache.value.workers?.requests24h ?? null
      })
    };
  }

  const warnings: string[] = [];
  const accountId = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID ?? "");
  const databaseId = encodeURIComponent(env.CLOUDFLARE_D1_DATABASE_ID ?? "");
  const d1InfoResultPromise = settle(fetchD1DatabaseInfo(env, accountId, databaseId));
  const d1MetricsResultPromise = settle(fetchD1Metrics(env));
  const pagesResult = env.CLOUDFLARE_PAGES_PROJECT_NAME
    ? await settle(fetchPagesProductionScriptName(env, accountId, env.CLOUDFLARE_PAGES_PROJECT_NAME))
    : ({ status: "fulfilled", value: null } satisfies PromiseFulfilledResult<null>);

  if (pagesResult.status === "rejected") {
    warnings.push(`Pages 프로젝트 정보를 불러오지 못했습니다: ${errorMessage(pagesResult.reason)}`);
  }
  const scriptName = (pagesResult.status === "fulfilled" ? pagesResult.value : null) ?? env.CLOUDFLARE_WORKER_SCRIPT_NAME ?? null;
  if (!scriptName) {
    warnings.push("Pages production script 이름과 CLOUDFLARE_WORKER_SCRIPT_NAME이 없어 Workers 요청 수는 표시하지 않습니다.");
  }

  const workersResultPromise = scriptName ? settle(fetchWorkersUsage(env, scriptName)) : Promise.resolve(null);
  const [d1InfoResult, d1MetricsResult, workersResult] = await Promise.all([
    d1InfoResultPromise,
    d1MetricsResultPromise,
    workersResultPromise
  ]);

  if (d1InfoResult.status === "rejected") {
    warnings.push(`D1 데이터베이스 정보를 불러오지 못했습니다: ${errorMessage(d1InfoResult.reason)}`);
  }
  if (d1MetricsResult.status === "rejected") {
    warnings.push(`D1 GraphQL 사용량을 불러오지 못했습니다: ${errorMessage(d1MetricsResult.reason)}`);
  }
  if (workersResult?.status === "rejected") {
    warnings.push(`Workers GraphQL 사용량을 불러오지 못했습니다: ${errorMessage(workersResult.reason)}`);
  }

  const d1 = buildD1Usage(
    d1InfoResult.status === "fulfilled" ? d1InfoResult.value : null,
    d1MetricsResult.status === "fulfilled" ? d1MetricsResult.value : null
  );
  const workers = workersResult?.status === "fulfilled" ? workersResult.value : null;
  if (d1 && d1.rowsRead24h === null) warnings.push("Cloudflare D1 API 응답에 24시간 rows read 값이 없어 DB 크기만 표시합니다.");
  if (d1 && d1.rowsWritten24h === null) warnings.push("Cloudflare D1 API 응답에 24시간 rows written 값이 없어 DB 크기만 표시합니다.");
  const hasD1Traffic = [d1?.rowsRead24h, d1?.rowsWritten24h, d1?.readQueries24h, d1?.writeQueries24h].some(
    (metric) => typeof metric === "number" && metric > 0
  );
  if (hasD1Traffic && workers?.requests24h === 0) {
    warnings.push("Workers 요청 수가 0이지만 D1 사용량이 있습니다. Pages production script 이름을 확인해주세요.");
  }

  const status: CloudflareUsageSummary["status"] = d1 || workers ? (warnings.length ? "partial" : "ok") : "error";
  const value: Omit<CloudflareUsageSummary, "capacity"> = {
    status,
    configured: true,
    checkedAt: new Date(now).toISOString(),
    cacheTtlSeconds: CACHE_TTL_MS / 1000,
    requiredSecrets: [],
    warnings,
    d1,
    workers
  };

  usageCache = { key: cacheKey, expiresAt: now + CACHE_TTL_MS, value };
  return {
    ...value,
    capacity: estimateCapacity({
      activeUsers24h,
      rowsRead24h: d1?.rowsRead24h ?? null,
      rowsWritten24h: d1?.rowsWritten24h ?? null,
      workerRequests24h: workers?.requests24h ?? null
    })
  };
}

export function resetCloudflareUsageCacheForTests(): void {
  usageCache = null;
}
