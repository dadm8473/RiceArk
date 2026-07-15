import { getCloudflareUsage, type CloudflareUsageSummary } from "./cloudflareUsage";
import type { Env } from "../env";

const CACHE_TTL_MS = 5 * 60 * 1000;

export const USER_METRICS_SQL = `WITH completion_activity AS (
  SELECT
    COUNT(DISTINCT CASE WHEN datetime(updated_at) >= datetime('now','-1 day') THEN user_id END) AS completion_users_24h,
    COUNT(DISTINCT CASE WHEN datetime(updated_at) >= datetime('now','-7 days') THEN user_id END) AS completion_users_7d,
    SUM(CASE WHEN datetime(updated_at) >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS completion_updates_24h,
    SUM(CASE WHEN datetime(updated_at) >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS completion_updates_7d
  FROM board_cell_completions
)
SELECT
  (SELECT COUNT(*) FROM users) AS total_users,
  (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE datetime(expires_at) > CURRENT_TIMESTAMP) AS active_logged_in_users,
  (SELECT COUNT(*) FROM sessions WHERE datetime(expires_at) > CURRENT_TIMESTAMP) AS active_sessions,
  (SELECT COUNT(*) FROM users WHERE datetime(created_at) >= datetime('now','-1 day')) AS users_created_24h,
  (SELECT COUNT(*) FROM users WHERE datetime(created_at) >= datetime('now','-7 days')) AS users_created_7d,
  completion_activity.*
FROM completion_activity`;

const DATA_METRICS_SQL = `SELECT
  (SELECT COUNT(*) FROM sheets) AS sheets,
  (SELECT COUNT(*) FROM board_tables) AS board_tables,
  (SELECT COUNT(*) FROM board_axis_items) AS board_axis_items,
  (SELECT COUNT(*) FROM board_cell_states) AS board_cell_states,
  (SELECT COUNT(*) FROM board_cell_completions) AS board_cell_completions,
  (SELECT COUNT(*) FROM board_notes) AS board_notes,
  (SELECT COUNT(*) FROM board_shares) AS board_shares,
  (SELECT COUNT(*) FROM board_share_favorites) AS board_share_favorites,
  (SELECT COUNT(*) FROM characters) AS characters,
  (SELECT COUNT(*) FROM tasks) AS tasks`;

type UserMetricsRow = {
  total_users: number;
  active_logged_in_users: number;
  active_sessions: number;
  users_created_24h: number;
  users_created_7d: number;
  completion_users_24h: number;
  completion_users_7d: number;
  completion_updates_24h: number;
  completion_updates_7d: number;
};

type DataMetricsRow = {
  sheets: number;
  board_tables: number;
  board_axis_items: number;
  board_cell_states: number;
  board_cell_completions: number;
  board_notes: number;
  board_shares: number;
  board_share_favorites: number;
  characters: number;
  tasks: number;
};

type SummaryCapacity = CloudflareUsageSummary["capacity"] & {
  sampleLimited: true;
  fixedAdminReads: number;
  fixedAdminReadsScope: "one-uncached-metrics-refresh-estimate";
  observedTotalD1Reads: number | null;
  observedTotalD1Writes: number | null;
  observedEndUserReads: number | null;
  observedEndUserWrites: number | null;
  activeUserSampleSize: number;
  observedEndUserReadsPerActiveUser: number | null;
  observedEndUserWritesPerActiveUser: number | null;
  uncertaintyReasons: string[];
  guaranteedMultiplier: null;
};

export type AdminSummaryMetrics = {
  users: {
    total: number;
    activeLoggedIn: number;
    activeSessions: number;
    created24h: number;
    created7d: number;
  };
  activity: {
    completionUsers24h: number;
    completionUsers7d: number;
    completionUpdates24h: number;
    completionUpdates7d: number;
  };
  data: {
    sheets: number;
    tables: number;
    axisItems: number;
    cellStates: number;
    boardCompletions: number;
    notes: number;
    shares: number;
    shareFavorites: number;
    characters: number;
    tasks: number;
  };
  freePlanReference: {
    d1RowsReadDaily: number;
    d1RowsWrittenDaily: number;
    workersRequestsDaily: number;
  };
  cloudflare: Omit<CloudflareUsageSummary, "capacity"> & { capacity: SummaryCapacity };
};

type CacheEntry = {
  expiresAt: number;
  value: AdminSummaryMetrics;
};

const metricsCache = new Map<string, CacheEntry>();
const inFlightMetrics = new Map<string, Promise<AdminSummaryMetrics>>();
let databaseIds = new WeakMap<object, number>();
let nextDatabaseId = 1;

function value(row: Record<string, number> | null | undefined, key: string): number {
  return Number(row?.[key] ?? 0);
}

function databaseIdentity(database: D1Database): number {
  const existing = databaseIds.get(database);
  if (existing !== undefined) return existing;
  const identity = nextDatabaseId;
  nextDatabaseId += 1;
  databaseIds.set(database, identity);
  return identity;
}

function cacheKey(env: Env): string {
  const database = env.CLOUDFLARE_D1_DATABASE_ID ?? `binding-${databaseIdentity(env.DB)}`;
  return JSON.stringify([
    env.ENVIRONMENT,
    env.CLOUDFLARE_ACCOUNT_ID ?? "",
    database,
    env.CLOUDFLARE_WORKER_SCRIPT_NAME ?? "",
    Boolean(env.CLOUDFLARE_API_TOKEN)
  ]);
}

function estimateFixedAdminReads(metrics: Pick<AdminSummaryMetrics, "users" | "data">): number {
  const dataRows = Object.values(metrics.data).reduce((total, count) => total + count, 0);
  return metrics.users.total + metrics.users.activeSessions + metrics.data.boardCompletions + dataRows;
}

function buildCapacity(
  cloudflare: CloudflareUsageSummary,
  metrics: Pick<AdminSummaryMetrics, "users" | "activity" | "data">
): SummaryCapacity {
  const activeUserSampleSize = metrics.activity.completionUsers24h;
  const fixedAdminReads = estimateFixedAdminReads(metrics);
  const rowsRead24h = cloudflare.d1?.rowsRead24h ?? null;
  const rowsWritten24h = cloudflare.d1?.rowsWritten24h ?? null;
  const uncertaintyReasons = [
    "Capacity is sample-limited; completion-active users may not represent all end-user traffic.",
    "Fixed admin reads are an estimate for one uncached admin metrics refresh.",
    "The 24-hour admin refresh count and attribution are unavailable. No admin-read subtraction was applied to observed total D1 reads.",
    "Admin write attribution is unavailable; observed total D1 writes are not labeled as end-user writes."
  ];

  if (rowsRead24h === null) {
    uncertaintyReasons.push("Cloudflare D1 rows read counter is unavailable; observed end-user reads cannot be derived.");
  }

  if (rowsWritten24h === null) {
    uncertaintyReasons.push("Cloudflare D1 rows written counter is unavailable; observed end-user writes cannot be derived.");
  }
  if (cloudflare.workers?.requests24h === undefined || cloudflare.workers === null) {
    uncertaintyReasons.push("Workers requests counter is unavailable; request-based capacity cannot be derived.");
  }
  if (activeUserSampleSize === 0) {
    uncertaintyReasons.push("No completion-active users were observed in the 24-hour sample.");
  } else if (activeUserSampleSize < 30) {
    uncertaintyReasons.push("The active-user sample is too small for a confident capacity projection.");
  }

  return {
    activeUsers24h: activeUserSampleSize,
    activeUserSampleSize,
    sampleLimited: true,
    fixedAdminReads,
    fixedAdminReadsScope: "one-uncached-metrics-refresh-estimate",
    observedTotalD1Reads: rowsRead24h,
    observedTotalD1Writes: rowsWritten24h,
    observedEndUserReads: null,
    observedEndUserWrites: null,
    observedEndUserReadsPerActiveUser: null,
    observedEndUserWritesPerActiveUser: null,
    uncertaintyReasons,
    guaranteedMultiplier: null,
    estimatedDauByD1Reads: null,
    estimatedDauByD1Writes: null,
    estimatedDauByWorkerRequests: null,
    bottleneck: null
  };
}

async function readAdminSummaryMetrics(env: Env): Promise<AdminSummaryMetrics> {
  const userMetrics = await env.DB.prepare(USER_METRICS_SQL).first<UserMetricsRow>();
  const dataMetrics = await env.DB.prepare(DATA_METRICS_SQL).first<DataMetricsRow>();
  const completionUsers24h = value(userMetrics, "completion_users_24h");
  const cloudflareUsage = await getCloudflareUsage(env, completionUsers24h);

  const metrics: Omit<AdminSummaryMetrics, "cloudflare"> = {
    users: {
      total: value(userMetrics, "total_users"),
      activeLoggedIn: value(userMetrics, "active_logged_in_users"),
      activeSessions: value(userMetrics, "active_sessions"),
      created24h: value(userMetrics, "users_created_24h"),
      created7d: value(userMetrics, "users_created_7d")
    },
    activity: {
      completionUsers24h,
      completionUsers7d: value(userMetrics, "completion_users_7d"),
      completionUpdates24h: value(userMetrics, "completion_updates_24h"),
      completionUpdates7d: value(userMetrics, "completion_updates_7d")
    },
    data: {
      sheets: value(dataMetrics, "sheets"),
      tables: value(dataMetrics, "board_tables"),
      axisItems: value(dataMetrics, "board_axis_items"),
      cellStates: value(dataMetrics, "board_cell_states"),
      boardCompletions: value(dataMetrics, "board_cell_completions"),
      notes: value(dataMetrics, "board_notes"),
      shares: value(dataMetrics, "board_shares"),
      shareFavorites: value(dataMetrics, "board_share_favorites"),
      characters: value(dataMetrics, "characters"),
      tasks: value(dataMetrics, "tasks")
    },
    freePlanReference: {
      d1RowsReadDaily: 5_000_000,
      d1RowsWrittenDaily: 100_000,
      workersRequestsDaily: 100_000
    }
  };

  return {
    ...metrics,
    cloudflare: {
      ...cloudflareUsage,
      capacity: buildCapacity(cloudflareUsage, metrics)
    }
  };
}

export function getAdminSummaryMetrics(env: Env): Promise<AdminSummaryMetrics> {
  const key = cacheKey(env);
  const now = Date.now();
  const cached = metricsCache.get(key);
  if (cached && cached.expiresAt > now) return Promise.resolve(cached.value);

  const existing = inFlightMetrics.get(key);
  if (existing) return existing;

  const pending = readAdminSummaryMetrics(env)
    .then((metrics) => {
      metricsCache.set(key, { expiresAt: now + CACHE_TTL_MS, value: metrics });
      return metrics;
    })
    .finally(() => {
      inFlightMetrics.delete(key);
    });
  inFlightMetrics.set(key, pending);
  return pending;
}

export function resetAdminSummaryMetricsCacheForTests(): void {
  metricsCache.clear();
  inFlightMetrics.clear();
  databaseIds = new WeakMap<object, number>();
  nextDatabaseId = 1;
}
