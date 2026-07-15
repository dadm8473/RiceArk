import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { getCloudflareUsage, resetCloudflareUsageCacheForTests } from "./cloudflareUsage";

type CloudflareSource = "pages" | "d1-info" | "d1-graphql" | "workers-graphql";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    CACHE: {} as KVNamespace,
    APP_ORIGIN: "http://127.0.0.1:5173",
    COOKIE_DOMAIN: "127.0.0.1",
    ENVIRONMENT: "test",
    CLOUDFLARE_ACCOUNT_ID: "account-1",
    CLOUDFLARE_API_TOKEN: "token-1",
    CLOUDFLARE_D1_DATABASE_ID: "database-1",
    CLOUDFLARE_PAGES_PROJECT_NAME: "riceark",
    CLOUDFLARE_WORKER_SCRIPT_NAME: "fallback-worker",
    ...overrides
  };
}

function sourceOf(input: RequestInfo | URL, init?: RequestInit): CloudflareSource {
  const url = String(input);
  if (url.includes("/pages/projects/")) return "pages";
  if (url.includes("/d1/database/")) return "d1-info";
  const operationName = JSON.parse(String(init?.body)).operationName;
  return operationName === "getD1MetricsOverviewQuery" ? "d1-graphql" : "workers-graphql";
}

function d1InfoResponse() {
  return Response.json({ success: true, result: { name: "riceark", file_size: 1_024, num_tables: 7 } });
}

function d1MetricsResponse(rowsRead = 42, rowsWritten = 3) {
  return Response.json({
    data: {
      viewer: {
        accounts: [
          {
            d1AnalyticsAdaptiveGroups: [
              { sum: { readQueries: 9, writeQueries: 2, rowsRead, rowsWritten } }
            ]
          }
        ]
      }
    }
  });
}

function workersResponse(requests = 12) {
  return Response.json({
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptive: [
              { sum: { requests, errors: 1, subrequests: 4 }, quantiles: { cpuTimeP50: 2, cpuTimeP99: 8 } }
            ]
          }
        ]
      }
    }
  });
}

describe("getCloudflareUsage", () => {
  beforeEach(() => {
    resetCloudflareUsageCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetCloudflareUsageCacheForTests();
  });

  it("prefers the Pages production script and bounds every Cloudflare request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      switch (sourceOf(input, init)) {
        case "pages":
          expect(String(input)).toBe("https://api.cloudflare.com/client/v4/accounts/account-1/pages/projects/riceark");
          return Response.json({ success: true, result: { production_script_name: "pages-worker-production" } });
        case "d1-info":
          return d1InfoResponse();
        case "d1-graphql":
          return d1MetricsResponse();
        case "workers-graphql": {
          const body = JSON.parse(String(init?.body));
          expect(body.variables.scriptName).toBe("pages-worker-production");
          return workersResponse();
        }
      }
    });

    const summary = await getCloudflareUsage(createEnv(), 2);

    expect(summary.status).toBe("ok");
    expect(summary.workers?.scriptName).toBe("pages-worker-production");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the configured worker when Pages has no production script", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      switch (sourceOf(input, init)) {
        case "pages":
          return Response.json({ success: true, result: {} });
        case "d1-info":
          return d1InfoResponse();
        case "d1-graphql":
          return d1MetricsResponse();
        case "workers-graphql":
          expect(JSON.parse(String(init?.body)).variables.scriptName).toBe("fallback-worker");
          return workersResponse();
      }
    });

    const summary = await getCloudflareUsage(createEnv(), 2);

    expect(summary.workers?.scriptName).toBe("fallback-worker");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns no Workers metrics when neither Pages nor the fallback resolves a script", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      switch (sourceOf(input, init)) {
        case "pages":
          return Response.json({ success: true, result: {} });
        case "d1-info":
          return d1InfoResponse();
        case "d1-graphql":
          return d1MetricsResponse();
        case "workers-graphql":
          throw new Error("Workers must not be queried without a script");
      }
    });

    const env = createEnv();
    delete env.CLOUDFLARE_WORKER_SCRIPT_NAME;
    const summary = await getCloudflareUsage(env, 2);

    expect(summary.status).toBe("partial");
    expect(summary.workers).toBeNull();
    expect(summary.warnings).toContain(
      "Pages production script 이름과 CLOUDFLARE_WORKER_SCRIPT_NAME이 없어 Workers 요청 수는 표시하지 않습니다."
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves D1 GraphQL and fallback Workers metrics when Pages and D1 info fail", async () => {
    const sourceCalls: CloudflareSource[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const source = sourceOf(input, init);
      sourceCalls.push(source);
      switch (source) {
        case "pages":
          throw new Error("pages unavailable");
        case "d1-info":
          throw new Error("database info unavailable");
        case "d1-graphql":
          return d1MetricsResponse(91, 5);
        case "workers-graphql":
          expect(JSON.parse(String(init?.body)).variables.scriptName).toBe("fallback-worker");
          return workersResponse(17);
      }
    });

    const summary = await getCloudflareUsage(createEnv(), 2);

    expect(summary.status).toBe("partial");
    expect(summary.d1).toMatchObject({ databaseName: null, rowsRead24h: 91, rowsWritten24h: 5 });
    expect(summary.workers).toMatchObject({ scriptName: "fallback-worker", requests24h: 17 });
    expect(summary.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Pages 프로젝트 정보를 불러오지 못했습니다: pages unavailable"),
        expect.stringContaining("D1 데이터베이스 정보를 불러오지 못했습니다: database info unavailable")
      ])
    );
    expect(sourceCalls.filter((source) => source === "pages")).toHaveLength(1);
    expect(sourceCalls.filter((source) => source === "d1-info")).toHaveLength(1);
  });

  it("degrades GraphQL timeouts independently without retrying either failed source", async () => {
    const sourceCalls: CloudflareSource[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const source = sourceOf(input, init);
      sourceCalls.push(source);
      switch (source) {
        case "pages":
          return Response.json({ success: true, result: { production_script_name: "pages-worker" } });
        case "d1-info":
          return d1InfoResponse();
        case "d1-graphql":
          throw new DOMException("The operation timed out", "TimeoutError");
        case "workers-graphql":
          throw new DOMException("The operation timed out", "TimeoutError");
      }
    });

    const summary = await getCloudflareUsage(createEnv(), 2);

    expect(summary.status).toBe("partial");
    expect(summary.d1).toMatchObject({ databaseName: "riceark", databaseSizeBytes: 1_024 });
    expect(summary.workers).toBeNull();
    expect(summary.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("D1 GraphQL 사용량을 불러오지 못했습니다: The operation timed out"),
        expect.stringContaining("Workers GraphQL 사용량을 불러오지 못했습니다: The operation timed out")
      ])
    );
    expect(sourceCalls.filter((source) => source === "d1-graphql")).toHaveLength(1);
    expect(sourceCalls.filter((source) => source === "workers-graphql")).toHaveLength(1);
    expect(sourceCalls).toHaveLength(4);
  });

  it("bounds the full collection to eight seconds and skips dependent Workers after budget expiry", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-15T00:00:00.000Z").getTime();
    vi.setSystemTime(startedAt);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    const sourceCalls: CloudflareSource[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const source = sourceOf(input, init);
      sourceCalls.push(source);
      if (source === "d1-info") return Promise.resolve(d1InfoResponse());
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    let settledAt: number | null = null;
    const request = getCloudflareUsage(createEnv(), 2).then((summary) => {
      settledAt = Date.now();
      return summary;
    });

    await vi.advanceTimersByTimeAsync(8_000);
    if (settledAt === null) await vi.advanceTimersByTimeAsync(8_000);
    const summary = await request;

    expect(settledAt).toBe(startedAt + 8_000);
    expect(sourceCalls).toEqual(expect.arrayContaining(["pages", "d1-info", "d1-graphql"]));
    expect(sourceCalls).toHaveLength(3);
    expect(sourceCalls).not.toContain("workers-graphql");
    expect(summary.d1).toMatchObject({ databaseName: "riceark", databaseSizeBytes: 1_024 });
    expect(summary.workers).toBeNull();
    expect(summary.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Workers GraphQL 사용량을 불러오지 못했습니다")])
    );
  });

  it("warns exactly when D1 has traffic but resolved Workers requests are zero", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      switch (sourceOf(input, init)) {
        case "pages":
          return Response.json({ success: true, result: { production_script_name: "pages-worker" } });
        case "d1-info":
          return d1InfoResponse();
        case "d1-graphql":
          return d1MetricsResponse(1, 0);
        case "workers-graphql":
          return workersResponse(0);
      }
    });

    const summary = await getCloudflareUsage(createEnv(), 2);

    expect(summary.warnings).toContain(
      "Workers 요청 수가 0이지만 D1 사용량이 있습니다. Pages production script 이름을 확인해주세요."
    );
  });

  it("isolates the internal cache when Pages project or API token changes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      switch (sourceOf(input, init)) {
        case "pages": {
          const projectName = String(input).split("/").at(-1);
          return Response.json({ success: true, result: { production_script_name: `worker-${projectName}` } });
        }
        case "d1-info":
          return d1InfoResponse();
        case "d1-graphql":
          return d1MetricsResponse();
        case "workers-graphql":
          return workersResponse();
      }
    });
    const base = createEnv({ CLOUDFLARE_PAGES_PROJECT_NAME: "project-a" });

    const first = await getCloudflareUsage(base, 2);
    await getCloudflareUsage(base, 3);
    const projectChanged = await getCloudflareUsage({ ...base, CLOUDFLARE_PAGES_PROJECT_NAME: "project-b" }, 2);
    await getCloudflareUsage({ ...base, CLOUDFLARE_PAGES_PROJECT_NAME: "project-b", CLOUDFLARE_API_TOKEN: "token-2" }, 2);

    expect(first.workers?.scriptName).toBe("worker-project-a");
    expect(projectChanged.workers?.scriptName).toBe("worker-project-b");
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it("starts checkedAt and the five-minute cache TTL when collection completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    let resolvePages: (response: Response) => void = () => {};
    const pagesResponse = new Promise<Response>((resolve) => {
      resolvePages = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      switch (sourceOf(input, init)) {
        case "pages":
          return pagesResponse;
        case "d1-info":
          return d1InfoResponse();
        case "d1-graphql":
          return d1MetricsResponse();
        case "workers-graphql":
          return workersResponse();
      }
    });

    const pending = getCloudflareUsage(createEnv(), 2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.setSystemTime(new Date("2026-07-15T00:02:00.000Z"));
    resolvePages(Response.json({ success: true, result: { production_script_name: "pages-worker" } }));
    const first = await pending;

    expect(first.checkedAt).toBe("2026-07-15T00:02:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    vi.setSystemTime(new Date("2026-07-15T00:06:59.999Z"));
    const hot = await getCloudflareUsage(createEnv(), 3);
    expect(hot.checkedAt).toBe(first.checkedAt);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    vi.setSystemTime(new Date("2026-07-15T00:07:00.000Z"));
    const refreshed = await getCloudflareUsage(createEnv(), 2);
    expect(refreshed.checkedAt).toBe("2026-07-15T00:07:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });
});
