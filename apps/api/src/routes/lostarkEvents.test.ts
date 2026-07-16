import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../index";
import type { Env } from "../env";

type CacheDouble = {
  match: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  store: Map<string, Response>;
};

function createCacheDouble(): CacheDouble {
  const store = new Map<string, Response>();
  return {
    store,
    match: vi.fn(async (request: RequestInfo | URL) => {
      const key = request instanceof Request ? request.url : request.toString();
      return store.get(key) ?? null;
    }),
    put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
      const key = request instanceof Request ? request.url : request.toString();
      store.set(key, response);
    })
  };
}

function createEnv(): Env & { cacheGets: string[]; cacheStore: Map<string, string>; cachePuts: string[] } {
  const cache = new Map<string, string>();
  const gets: string[] = [];
  const puts: string[] = [];
  return {
    APP_ORIGIN: "http://127.0.0.1:5173",
    CACHE: {
      async get(key: string) {
        gets.push(key);
        const value = cache.get(key);
        return value ? JSON.parse(value) : null;
      },
      async put(key: string, value: string) {
        puts.push(key);
        cache.set(key, value);
      }
    } as unknown as KVNamespace,
    COOKIE_DOMAIN: "127.0.0.1",
    ENVIRONMENT: "test",
    LOSTARK_API_KEY: "lostark-key",
    cacheGets: gets,
    cacheStore: cache,
    cachePuts: puts
  } as Env & { cacheGets: string[]; cacheStore: Map<string, string>; cachePuts: string[] };
}

const CALENDAR_CACHE_KEY = "lostark:gamecontents:calendar:v1";
const CALENDAR_STATUS_KEY = "lostark:gamecontents:calendar:status:v1";

describe("lostark event routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns today's event summary and caches the official calendar payload", async () => {
    vi.setSystemTime(new Date("2026-06-07T17:38:00+09:00"));
    const fetchMock = vi.fn(async () =>
      Response.json([
        {
          CategoryName: "모험 섬",
          ContentsName: "블루홀 섬",
          StartTimes: ["2026-06-07T19:00:00", "2026-06-07T21:00:00"],
          Location: "블루홀 섬",
          RewardItems: [
            {
              Items: [
                {
                  Name: "골드",
                  StartTimes: ["2026-06-07T19:00:00", "2026-06-07T21:00:00"]
                }
              ]
            }
          ]
        }
      ])
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = createEnv();

    const first = await app.request("/api/lostark/events/today?rewards=gold", {}, env);
    const second = await app.request("/api/lostark/events/today?rewards=gold", {}, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(second.headers.get("Cache-Control")).toBe("public, max-age=60");
    await expect(first.json()).resolves.toMatchObject({
      adventureIsland: {
        entries: [
          {
            continent: "베른 남부",
            islandName: "블루홀 섬",
            rewards: ["쌀(골드)"]
          }
        ]
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes equivalent reward filters into one credential-free normalized cache entry", async () => {
    vi.setSystemTime(new Date("2026-06-07T17:38:00+09:00"));
    const cache = createCacheDouble();
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal("caches", { default: cache });
    vi.stubGlobal("fetch", fetchMock);
    const env = createEnv();

    const first = await app.request(
      "/api/lostark/events/today?rewards=card,gold,card",
      {},
      env
    );
    const second = await app.request(
      "/api/lostark/events/today?rewards=gold,card",
      { headers: { cookie: "riceark_session=another-user" } },
      env
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(env.cacheGets.filter((key) => key === CALENDAR_CACHE_KEY)).toHaveLength(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect([...cache.store.keys()]).toEqual([
      "http://localhost/__riceark-cache/lostark-events:v1?rewards=gold%2Ccard"
    ]);
    await expect(first.json()).resolves.toEqual(await second.json());
  });

  it("regenerates an expired normalized response from raw KV without another origin fetch", async () => {
    vi.setSystemTime(new Date("2026-06-07T17:38:00+09:00"));
    const cache = createCacheDouble();
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal("caches", { default: cache });
    vi.stubGlobal("fetch", fetchMock);
    const env = createEnv();

    const first = await app.request("/api/lostark/events/today?rewards=gold", {}, env);
    const firstPayload = await first.json() as { generatedAt: string };
    cache.store.clear();
    vi.setSystemTime(new Date("2026-06-07T17:39:01+09:00"));

    const second = await app.request("/api/lostark/events/today?rewards=gold", {}, env);
    const secondPayload = await second.json() as { generatedAt: string };

    expect(firstPayload.generatedAt).toBe("2026-06-07T08:38:00.000Z");
    expect(secondPayload.generatedAt).toBe("2026-06-07T08:39:01.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(env.cacheGets.filter((key) => key === CALENDAR_CACHE_KEY)).toHaveLength(2);
    expect(env.cachePuts.filter((key) => key === CALENDAR_STATUS_KEY)).toHaveLength(1);
    expect(cache.put).toHaveBeenCalledTimes(2);
  });

  it("records a calendar status timestamp only on origin fetches", async () => {
    vi.setSystemTime(new Date("2026-06-07T17:38:00+09:00"));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    const env = createEnv();

    const first = await app.request("/api/lostark/events/today", {}, env);
    const statusWritesAfterFirst = env.cachePuts.filter((key) => key === CALENDAR_STATUS_KEY).length;
    const second = await app.request("/api/lostark/events/today", {}, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(statusWritesAfterFirst).toBe(1);
    expect(env.cachePuts.filter((key) => key === CALENDAR_STATUS_KEY)).toHaveLength(1);
    expect(JSON.parse(env.cacheStore.get(CALENDAR_STATUS_KEY) ?? "{}")).toMatchObject({
      lastSuccessAt: "2026-06-07T08:38:00.000Z",
      lastFailureAt: null,
      lastFailureCode: null
    });
  });

  it("records a failure code when the Lost Ark API responds with an error", async () => {
    vi.setSystemTime(new Date("2026-06-07T17:38:00+09:00"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream error", { status: 502 }))
    );
    const env = createEnv();

    const res = await app.request("/api/lostark/events/today", {}, env);

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "lostark_api_error" } });
    expect(JSON.parse(env.cacheStore.get(CALENDAR_STATUS_KEY) ?? "{}")).toMatchObject({
      lastSuccessAt: null,
      lastFailureAt: "2026-06-07T08:38:00.000Z",
      lastFailureCode: "lostark_api_error"
    });
  });

  it("propagates 429 Retry-After and never caches or retries an error response", async () => {
    vi.setSystemTime(new Date("2026-06-07T17:38:00+09:00"));
    const cache = createCacheDouble();
    const fetchMock = vi.fn(async () =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "23" } })
    );
    vi.stubGlobal("caches", { default: cache });
    vi.stubGlobal("fetch", fetchMock);
    const env = createEnv();

    const first = await app.request("/api/lostark/events/today?rewards=gold", {}, env);
    const second = await app.request("/api/lostark/events/today?rewards=gold", {}, env);

    expect(first.status).toBe(429);
    expect(second.status).toBe(429);
    expect(first.headers.get("Retry-After")).toBe("23");
    await expect(first.json()).resolves.toMatchObject({ error: { code: "lostark_api_error" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cache.put).not.toHaveBeenCalled();
    expect(env.cachePuts.filter((key) => key === CALENDAR_CACHE_KEY)).toHaveLength(0);
  });
});
