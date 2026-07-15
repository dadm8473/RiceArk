import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { getAdminSummaryMetrics, resetAdminSummaryMetricsCacheForTests, USER_METRICS_SQL } from "./summary";

const userMetrics = {
  total_users: 8,
  active_logged_in_users: 7,
  active_sessions: 25,
  users_created_24h: 0,
  users_created_7d: 5,
  completion_users_24h: 2,
  completion_users_7d: 4,
  completion_updates_24h: 42,
  completion_updates_7d: 360
};

const dataMetrics = {
  sheets: 10,
  board_tables: 20,
  board_axis_items: 279,
  board_cell_states: 44,
  board_cell_completions: 425,
  board_notes: 3,
  board_shares: 2,
  board_share_favorites: 2,
  characters: 197,
  tasks: 119
};

function createMetricsDb(
  options: {
    waitForFirstRead?: Promise<void>;
    failFirstRead?: boolean;
    userRowsRead?: number | null;
    dataRowsRead?: number | null;
  } = {}
) {
  let userReads = 0;
  let dataReads = 0;
  let shouldFail = options.failFirstRead ?? false;

  const database = {
    prepare(sql: string) {
      const execute = async () => {
        if (sql.includes("total_users")) {
          userReads += 1;
          await options.waitForFirstRead;
          if (shouldFail) {
            shouldFail = false;
            throw new Error("metrics unavailable");
          }
          return {
            results: [userMetrics],
            meta: options.userRowsRead === null ? {} : { rows_read: options.userRowsRead ?? 600 }
          };
        }
        if (sql.includes("board_tables")) {
          dataReads += 1;
          return {
            results: [dataMetrics],
            meta: options.dataRowsRead === null ? {} : { rows_read: options.dataRowsRead ?? 900 }
          };
        }
        return { results: [], meta: {} };
      };
      return {
        async first() {
          return (await execute()).results[0] ?? null;
        },
        all: execute
      };
    }
  } as unknown as D1Database;

  return {
    database,
    get userReads() {
      return userReads;
    },
    get dataReads() {
      return dataReads;
    }
  };
}

function createEnv(database: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: database,
    CACHE: {} as KVNamespace,
    APP_ORIGIN: "http://127.0.0.1:5173",
    COOKIE_DOMAIN: "127.0.0.1",
    ENVIRONMENT: "test",
    SESSION_SECRET: "test-secret",
    ...overrides
  };
}

describe("admin summary metrics", () => {
  beforeEach(() => {
    resetAdminSummaryMetricsCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetAdminSummaryMetricsCacheForTests();
  });

  it("scans board_cell_completions once for all user activity aggregates", () => {
    expect(USER_METRICS_SQL.match(/FROM board_cell_completions/g)).toHaveLength(1);
  });

  it("deduplicates cold reads and starts the five-minute TTL when the snapshot resolves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    let releaseFirstRead: () => void = () => {};
    const waitForFirstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const metricsDb = createMetricsDb({ waitForFirstRead });
    const env = createEnv(metricsDb.database);

    const first = getAdminSummaryMetrics(env);
    const second = getAdminSummaryMetrics(env);
    await vi.waitFor(() => expect(metricsDb.userReads).toBe(1));
    vi.setSystemTime(new Date("2026-07-15T00:02:00.000Z"));
    releaseFirstRead();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.generatedAt).toBe("2026-07-15T00:02:00.000Z");
    expect(metricsDb.userReads).toBe(1);
    expect(metricsDb.dataReads).toBe(1);

    vi.setSystemTime(new Date("2026-07-15T00:06:59.999Z"));
    const hotResult = await getAdminSummaryMetrics(env);
    expect(metricsDb.userReads).toBe(1);
    expect(hotResult.generatedAt).toBe(firstResult.generatedAt);

    vi.setSystemTime(new Date("2026-07-15T00:07:00.000Z"));
    await getAdminSummaryMetrics(env);
    expect(metricsDb.userReads).toBe(2);
  });

  it("keys cached metrics by Cloudflare account, database, and script configuration", async () => {
    const metricsDb = createMetricsDb();
    const base = createEnv(metricsDb.database, {
      CLOUDFLARE_ACCOUNT_ID: "account-a",
      CLOUDFLARE_D1_DATABASE_ID: "database-a"
    });

    await getAdminSummaryMetrics({ ...base, CLOUDFLARE_WORKER_SCRIPT_NAME: "script-a" });
    await getAdminSummaryMetrics({ ...base, CLOUDFLARE_WORKER_SCRIPT_NAME: "script-a" });
    await getAdminSummaryMetrics({ ...base, CLOUDFLARE_WORKER_SCRIPT_NAME: "script-b" });
    await getAdminSummaryMetrics({ ...base, CLOUDFLARE_ACCOUNT_ID: "account-b", CLOUDFLARE_WORKER_SCRIPT_NAME: "script-a" });
    await getAdminSummaryMetrics({ ...base, CLOUDFLARE_D1_DATABASE_ID: "database-b", CLOUDFLARE_WORKER_SCRIPT_NAME: "script-a" });

    expect(metricsDb.userReads).toBe(4);
    expect(metricsDb.dataReads).toBe(4);
  });

  it("invalidates cached metrics when a present Cloudflare API token rotates", async () => {
    const metricsDb = createMetricsDb();
    const base = createEnv(metricsDb.database);

    const first = await getAdminSummaryMetrics({ ...base, CLOUDFLARE_API_TOKEN: "token-a" });
    await getAdminSummaryMetrics({ ...base, CLOUDFLARE_API_TOKEN: "token-a" });
    await getAdminSummaryMetrics({ ...base, CLOUDFLARE_API_TOKEN: "token-b" });

    expect(metricsDb.userReads).toBe(2);
    expect(JSON.stringify(first)).not.toContain("token-a");
  });

  it("retries after a failed metrics read instead of caching the rejection", async () => {
    const metricsDb = createMetricsDb({ failFirstRead: true });
    const env = createEnv(metricsDb.database);

    await expect(getAdminSummaryMetrics(env)).rejects.toThrow("metrics unavailable");
    await expect(getAdminSummaryMetrics(env)).resolves.toMatchObject({ users: { total: 8 } });
    expect(metricsDb.userReads).toBe(2);
    expect(metricsDb.dataReads).toBe(1);
  });

  it("reports missing Cloudflare counters as uncertainty without capacity projections", async () => {
    const metricsDb = createMetricsDb();
    const summary = await getAdminSummaryMetrics(createEnv(metricsDb.database));

    expect(summary.cloudflare.capacity).toMatchObject({
      sampleLimited: true,
      fixedAdminReads: 1_500,
      fixedAdminReadsScope: "one-uncached-metrics-refresh",
      fixedAdminReadsSource: "d1-query-metadata",
      observedTotalD1Reads: null,
      observedTotalD1Writes: null,
      observedEndUserReads: null,
      observedEndUserWrites: null,
      activeUserSampleSize: 2,
      observedEndUserReadsPerActiveUser: null,
      observedEndUserWritesPerActiveUser: null,
      guaranteedMultiplier: null,
      estimatedDauByD1Reads: null,
      estimatedDauByD1Writes: null,
      estimatedDauByWorkerRequests: null,
      bottleneck: null
    });
    expect(summary.cloudflare.capacity.uncertaintyReasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Cloudflare D1 rows read"),
        expect.stringContaining("Cloudflare D1 rows written"),
        expect.stringContaining("Workers requests")
      ])
    );
  });

  it("leaves fixed admin reads unavailable when either query omits rows_read metadata", async () => {
    const metricsDb = createMetricsDb({ dataRowsRead: null });
    const summary = await getAdminSummaryMetrics(createEnv(metricsDb.database));

    expect(summary.cloudflare.capacity).toMatchObject({
      fixedAdminReads: null,
      fixedAdminReadsScope: "one-uncached-metrics-refresh",
      fixedAdminReadsSource: "d1-query-metadata"
    });
    expect(summary.cloudflare.capacity.uncertaintyReasons).toContain(
      "D1 rows_read metadata is unavailable for one or both admin aggregate queries; fixed admin reads cannot be measured."
    );
  });

  it("keeps total Cloudflare counters separate from unavailable end-user attribution", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/d1/database/database-capacity")) {
        return Response.json({ success: true, result: { name: "riceark", file_size: 995_328, num_tables: 22 } });
      }

      const body = JSON.parse(String(init?.body));
      if (body.operationName === "getD1MetricsOverviewQuery") {
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  d1AnalyticsAdaptiveGroups: [
                    { sum: { readQueries: 2_507, writeQueries: 93, rowsRead: 75_962, rowsWritten: 261 } }
                  ]
                }
              ]
            }
          },
          errors: null
        });
      }

      return Response.json({
        data: {
          viewer: {
            accounts: [
              {
                workersInvocationsAdaptive: [
                  { sum: { requests: 200, errors: 2, subrequests: 94 }, quantiles: { cpuTimeP50: 4, cpuTimeP99: 12 } }
                ]
              }
            ]
          }
        },
        errors: null
      });
    });

    const metricsDb = createMetricsDb();
    const summary = await getAdminSummaryMetrics(
      createEnv(metricsDb.database, {
        CLOUDFLARE_ACCOUNT_ID: "account-capacity",
        CLOUDFLARE_API_TOKEN: "token-capacity",
        CLOUDFLARE_D1_DATABASE_ID: "database-capacity",
        CLOUDFLARE_WORKER_SCRIPT_NAME: "script-capacity"
      })
    );

    expect(summary.cloudflare.d1).toMatchObject({ rowsRead24h: 75_962, rowsWritten24h: 261 });
    expect(summary.cloudflare.workers).toMatchObject({ requests24h: 200 });
    expect(summary.cloudflare.capacity).toMatchObject({
      sampleLimited: true,
      fixedAdminReads: 1_500,
      fixedAdminReadsScope: "one-uncached-metrics-refresh",
      fixedAdminReadsSource: "d1-query-metadata",
      observedTotalD1Reads: 75_962,
      observedTotalD1Writes: 261,
      observedEndUserReads: null,
      observedEndUserWrites: null,
      activeUserSampleSize: 2,
      observedEndUserReadsPerActiveUser: null,
      observedEndUserWritesPerActiveUser: null,
      guaranteedMultiplier: null,
      estimatedDauByD1Reads: null,
      estimatedDauByD1Writes: null,
      estimatedDauByWorkerRequests: null,
      bottleneck: null
    });
    expect(summary.cloudflare.capacity.uncertaintyReasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sample"),
        expect.stringContaining("24-hour admin refresh count and attribution are unavailable"),
        expect.stringContaining("No admin-read subtraction was applied"),
        expect.stringContaining("Admin write attribution is unavailable")
      ])
    );
  });
});
