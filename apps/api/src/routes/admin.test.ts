import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAdminSummaryMetricsCacheForTests } from "../admin/summary";
import app from "../index";
import type { Env } from "../env";

const envBase = {
  APP_ORIGIN: "http://127.0.0.1:5173",
  COOKIE_DOMAIN: "127.0.0.1",
  ENVIRONMENT: "test",
  SESSION_SECRET: "test-secret",
  CACHE: {} as KVNamespace
};

type FakeDbOptions = {
  providerUserId: string;
};

const todayUtc = new Date().toISOString().slice(0, 10);
const yesterdayUtc = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function createAdminDb({ providerUserId }: FakeDbOptions): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        first: async () => {
          if (sql.includes("total_users")) {
            return {
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
          }
          if (sql.includes("board_tables")) {
            return {
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
          }
          if (sql.includes("FROM sessions")) {
            return { id: "user-admin", display_name: "수빈", avatar_url: null };
          }
          return null;
        },
        all: async () => {
          if (sql.includes("FROM oauth_accounts")) {
            return { results: [{ provider: "discord", provider_user_id: providerUserId }] };
          }
          if (sql.includes("FROM admin_error_counters")) {
            return {
              results: [
                { day: todayUtc, status: 401, code: "unauthorized", route_group: "board", count: 4 },
                { day: yesterdayUtc, status: 502, code: "lostark_api_error", route_group: "lostark", count: 3 }
              ]
            };
          }
          return { results: [] };
        },
        run: async () => ({ success: true })
      };
      return {
        ...statement,
        bind: () => statement
      };
    }
  } as unknown as D1Database;
}

function envWithAdminDb(providerUserId: string): Env {
  return {
    ...envBase,
    ADMIN_OAUTH_ALLOWLIST: "discord:326685778656755713",
    DB: createAdminDb({ providerUserId })
  } as unknown as Env;
}

function envWithCloudflare(providerUserId: string): Env {
  return {
    ...envWithAdminDb(providerUserId),
    CLOUDFLARE_ACCOUNT_ID: "account-1",
    CLOUDFLARE_API_TOKEN: "token-1",
    CLOUDFLARE_D1_DATABASE_ID: "d1-1",
    CLOUDFLARE_WORKER_SCRIPT_NAME: "riceark"
  } as unknown as Env;
}

describe("admin routes", () => {
  beforeEach(() => {
    resetAdminSummaryMetricsCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAdminSummaryMetricsCacheForTests();
  });

  it("marks the session as admin when the Discord provider id is allowlisted", async () => {
    const res = await app.request(
      "/api/session",
      { headers: { cookie: "riceark_session=test-session" } },
      envWithAdminDb("326685778656755713")
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      user: { id: "user-admin", displayName: "수빈", isAdmin: true }
    });
  });

  it("returns the admin summary only to an allowlisted Discord account", async () => {
    const res = await app.request(
      "/api/admin/summary",
      { headers: { cookie: "riceark_session=test-session" } },
      envWithAdminDb("326685778656755713")
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")?.split(/,\s*/)).toContain("Cookie");
    await expect(res.json()).resolves.toMatchObject({
      users: {
        total: 8,
        activeLoggedIn: 7,
        activeSessions: 25
      },
      activity: {
        completionUsers24h: 2,
        completionUpdates24h: 42
      },
      data: {
        sheets: 10,
        tables: 20,
        boardCompletions: 425
      },
      cloudflare: {
        status: "unconfigured",
        configured: false,
        requiredSecrets: expect.arrayContaining(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"])
      }
    });
  });

  it("includes Cloudflare usage and estimated capacity when usage secrets are configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      expect(init?.headers).toMatchObject({ Authorization: "Bearer token-1" });

      if (url.includes("/d1/database/d1-1")) {
        return Response.json({
          success: true,
          result: {
            name: "riceark",
            file_size: 995_328,
            num_tables: 22
          }
        });
      }

      if (url.endsWith("/graphql")) {
        const body = JSON.parse(String(init?.body));
        if (body.operationName === "getD1MetricsOverviewQuery") {
          expect(body.variables.filter.AND[0].databaseId).toBe("d1-1");
          return Response.json({
            data: {
              viewer: {
                accounts: [
                  {
                    d1AnalyticsAdaptiveGroups: [
                      { sum: { readQueries: 2_000, writeQueries: 80, rowsRead: 70_000, rowsWritten: 200 } },
                      { sum: { readQueries: 507, writeQueries: 13, rowsRead: 5_962, rowsWritten: 61 } }
                    ]
                  }
                ]
              }
            },
            errors: null
          });
        }

        expect(body.variables.scriptName).toBe("riceark");
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  workersInvocationsAdaptive: [
                    { sum: { requests: 128, errors: 2, subrequests: 64 }, quantiles: { cpuTimeP50: 4, cpuTimeP99: 12 } },
                    { sum: { requests: 72, errors: 0, subrequests: 30 }, quantiles: { cpuTimeP50: 3, cpuTimeP99: 10 } }
                  ]
                }
              ]
            }
          },
          errors: null
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const res = await app.request(
      "/api/admin/summary",
      { headers: { cookie: "riceark_session=test-session" } },
      envWithCloudflare("326685778656755713")
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      cloudflare: {
        status: "ok",
        configured: true,
        d1: {
          databaseName: "riceark",
          databaseSizeBytes: 995_328,
          rowsRead24h: 75_962,
          rowsWritten24h: 261,
          rowsReadPercent: expect.closeTo(1.51924, 4),
          rowsWrittenPercent: expect.closeTo(0.261, 4)
        },
        workers: {
          requests24h: 200,
          errors24h: 2,
          requestPercent: expect.closeTo(0.2, 4),
          cpuTimeP99Ms: 12
        },
        capacity: {
          activeUsers24h: 2,
          activeUserSampleSize: 2,
          sampleLimited: true,
          fixedAdminReads: 1559,
          observedEndUserReads: 74403,
          observedEndUserWrites: 261,
          estimatedDauByD1Reads: null,
          estimatedDauByD1Writes: null,
          estimatedDauByWorkerRequests: null,
          bottleneck: null,
          guaranteedMultiplier: null,
          uncertaintyReasons: expect.any(Array)
        }
      }
    });
  });

  it("authorizes every cached summary request while keeping each admin identity isolated", async () => {
    const admins = [
      { id: "admin-a", display_name: "Admin A", avatar_url: null, provider_user_id: "provider-a" },
      { id: "admin-b", display_name: "Admin B", avatar_url: null, provider_user_id: "provider-b" }
    ];
    let sessionReads = 0;
    let authorizationReads = 0;
    let metricsDbReads = 0;

    const db = {
      prepare(sql: string) {
        let boundValues: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) {
            boundValues = values;
            return statement;
          },
          async first() {
            if (sql.includes("total_users")) {
              metricsDbReads += 1;
              return {
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
            }
            if (sql.includes("board_tables")) {
              return {
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
            }
            if (sql.includes("FROM sessions")) {
              const admin = admins[sessionReads];
              sessionReads += 1;
              return admin;
            }
            return null;
          },
          async all() {
            if (sql.includes("FROM oauth_accounts")) {
              authorizationReads += 1;
              const admin = admins.find((candidate) => candidate.id === boundValues[0]);
              return { results: admin ? [{ provider: "discord", provider_user_id: admin.provider_user_id }] : [] };
            }
            return { results: [] };
          },
          async run() {
            return { success: true };
          }
        };
        return statement;
      }
    } as unknown as D1Database;
    const env = {
      ...envBase,
      ADMIN_OAUTH_ALLOWLIST: "discord:provider-a,discord:provider-b",
      DB: db
    } as unknown as Env;

    const firstResponse = await app.request(
      "/api/admin/summary",
      { headers: { cookie: "riceark_session=admin-a-session" } },
      env
    );
    const secondResponse = await app.request(
      "/api/admin/summary",
      { headers: { cookie: "riceark_session=admin-b-session" } },
      env
    );
    const first = (await firstResponse.json()) as { admin: { id: string; displayName: string } };
    const second = (await secondResponse.json()) as { admin: { id: string; displayName: string } };

    expect(first.admin).toEqual({ id: "admin-a", displayName: "Admin A" });
    expect(second.admin).toEqual({ id: "admin-b", displayName: "Admin B" });
    expect(metricsDbReads).toBe(1);
    expect(sessionReads).toBe(2);
    expect(authorizationReads).toBe(2);
  });

  it("rejects the admin summary when the Discord provider id is not allowlisted", async () => {
    const res = await app.request(
      "/api/admin/summary",
      { headers: { cookie: "riceark_session=test-session" } },
      envWithAdminDb("other-discord-user")
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: { code: "forbidden", message: "Admin access required" }
    });
  });

  it("returns service health, secret booleans and error aggregates without secret values", async () => {
    const env = {
      ...envWithAdminDb("326685778656755713"),
      LOSTARK_API_KEY: "lostark-secret-value",
      CACHE: {
        async get() {
          return {
            lastSuccessAt: "2026-06-11T02:00:00.000Z",
            lastFailureAt: null,
            lastFailureCode: null
          };
        }
      } as unknown as KVNamespace
    } as Env;

    const res = await app.request("/api/admin/health", { headers: { cookie: "riceark_session=test-session" } }, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")?.split(/,\s*/)).toContain("Cookie");
    const body = await res.json();
    expect(body).toMatchObject({
      checks: {
        api: { status: "ok" },
        d1: { status: "ok", errorCode: null },
        kv: { status: "ok", errorCode: null },
        lostark: {
          configured: true,
          lastSuccessAt: "2026-06-11T02:00:00.000Z",
          lastFailureCode: null,
          cacheTtlSeconds: 900
        }
      },
      deployment: { environment: "test" },
      errors: {
        totals: { today: 4, last7d: 7, clientErrorsToday: 4, serverErrorsToday: 0 },
        byCode: [
          { code: "unauthorized", statusClass: "4xx", today: 4, last7d: 4 },
          { code: "lostark_api_error", statusClass: "5xx", today: 0, last7d: 3 }
        ],
        byRouteGroup: [
          { routeGroup: "board", today: 4, last7d: 4, serverErrors7d: 0 },
          { routeGroup: "lostark", today: 0, last7d: 3, serverErrors7d: 3 }
        ]
      }
    });

    const secrets = (body as { deployment: { secrets: Array<{ name: string; configured: boolean }> } }).deployment.secrets;
    expect(secrets).toContainEqual({ name: "LOSTARK_API_KEY", configured: true });
    expect(secrets).toContainEqual({ name: "CLOUDFLARE_API_TOKEN", configured: false });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("lostark-secret-value");
    expect(raw).not.toContain("test-secret");
    expect(raw).not.toContain("326685778656755713");
  });

  it("degrades the KV check instead of failing when the cache read throws", async () => {
    const env = {
      ...envWithAdminDb("326685778656755713"),
      CACHE: {
        async get() {
          throw new Error("kv unavailable");
        }
      } as unknown as KVNamespace
    } as Env;

    const res = await app.request("/api/admin/health", { headers: { cookie: "riceark_session=test-session" } }, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      checks: {
        d1: { status: "ok" },
        kv: { status: "error", errorCode: "kv_read_failed" },
        lostark: { configured: false, lastSuccessAt: null, cacheAgeSeconds: null }
      }
    });
  });

  it("rejects the admin health endpoint when not allowlisted", async () => {
    const res = await app.request(
      "/api/admin/health",
      { headers: { cookie: "riceark_session=test-session" } },
      envWithAdminDb("other-discord-user")
    );

    expect(res.status).toBe(403);
  });
});
