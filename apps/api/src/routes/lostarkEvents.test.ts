import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../index";
import type { Env } from "../env";

function createEnv(): Env & { cacheStore: Map<string, string>; cachePuts: string[] } {
  const cache = new Map<string, string>();
  const puts: string[] = [];
  return {
    APP_ORIGIN: "http://127.0.0.1:5173",
    CACHE: {
      async get(key: string) {
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
    cacheStore: cache,
    cachePuts: puts
  } as Env & { cacheStore: Map<string, string>; cachePuts: string[] };
}

const CALENDAR_STATUS_KEY = "lostark:gamecontents:calendar:status:v1";

describe("lostark event routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});
