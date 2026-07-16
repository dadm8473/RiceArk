import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import {
  CALENDAR_CACHE_TTL_SECONDS,
  fetchLostArkEventCalendarSummary,
  normalizeLostArkEventCalendar,
  parseLostArkRewardFilters
} from "./events";

const now = new Date("2026-06-07T17:38:00+09:00");
const CALENDAR_CACHE_KEY = "lostark:gamecontents:calendar:v1";
const CALENDAR_STATUS_KEY = "lostark:gamecontents:calendar:status:v1";

type CalendarEnv = Env & {
  cacheGets: string[];
  cachePuts: Array<{ key: string; options: KVNamespacePutOptions | undefined; value: string }>;
  cacheStore: Map<string, string>;
};

function createCalendarEnv(): CalendarEnv {
  const cacheStore = new Map<string, string>();
  const cacheGets: string[] = [];
  const cachePuts: CalendarEnv["cachePuts"] = [];
  return {
    APP_ORIGIN: "http://127.0.0.1:5173",
    CACHE: {
      async get(key: string) {
        cacheGets.push(key);
        const value = cacheStore.get(key);
        return value ? JSON.parse(value) : null;
      },
      async put(key: string, value: string, options?: KVNamespacePutOptions) {
        cachePuts.push({ key, options, value });
        cacheStore.set(key, value);
      }
    } as unknown as KVNamespace,
    COOKIE_DOMAIN: "127.0.0.1",
    ENVIRONMENT: "test",
    LOSTARK_API_KEY: "lostark-key",
    cacheGets,
    cachePuts,
    cacheStore
  } as CalendarEnv;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseLostArkRewardFilters", () => {
  it("deduplicates valid filters into the fixed public cache order", () => {
    expect(parseLostArkRewardFilters("cardXp,gold,card,gold,coin,silver")).toEqual([
      "gold",
      "card",
      "coin",
      "silver",
      "cardXp"
    ]);
    expect(parseLostArkRewardFilters("card, gold, card")).toEqual(["gold", "card"]);
    expect(parseLostArkRewardFilters("unknown")).toEqual(["gold", "card", "coin", "silver", "cardXp"]);
  });
});

describe("fetchLostArkEventCalendarSummary", () => {
  it("uses one eight-second origin attempt and reuses the raw KV payload for fifteen minutes", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);
    const env = createCalendarEnv();

    await fetchLostArkEventCalendarSummary(env, { now });
    await fetchLostArkEventCalendarSummary(env, { now });

    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(env.cacheGets.filter((key) => key === CALENDAR_CACHE_KEY)).toHaveLength(2);
    expect(env.cachePuts.filter((entry) => entry.key === CALENDAR_CACHE_KEY)).toEqual([
      expect.objectContaining({ options: { expirationTtl: CALENDAR_CACHE_TTL_SECONDS } })
    ]);
    expect(env.cachePuts.filter((entry) => entry.key === CALENDAR_STATUS_KEY)).toHaveLength(1);
  });

  it("deduplicates concurrent raw cache misses into one KV read, origin fetch, and KV write", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const env = createCalendarEnv();

    const first = fetchLostArkEventCalendarSummary(env, { now });
    const second = fetchLostArkEventCalendarSummary(env, { now });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    response.resolve(Response.json([]));
    await Promise.all([first, second]);

    expect(env.cacheGets.filter((key) => key === CALENDAR_CACHE_KEY)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(env.cachePuts.filter((entry) => entry.key === CALENDAR_CACHE_KEY)).toHaveLength(1);
  });

  it("propagates upstream 429 Retry-After metadata without retrying or caching the failure", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "17" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = createCalendarEnv();

    await expect(fetchLostArkEventCalendarSummary(env, { now })).rejects.toMatchObject({
      status: 429,
      code: "lostark_api_error",
      options: { headers: { "Retry-After": "17" } }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(env.cachePuts.filter((entry) => entry.key === CALENDAR_CACHE_KEY)).toHaveLength(0);
    expect(env.cachePuts.filter((entry) => entry.key === CALENDAR_STATUS_KEY)).toHaveLength(1);
  });

  it("cleans up a failed in-flight origin attempt so the next request can recover", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal("fetch", fetchMock);
    const env = createCalendarEnv();

    await expect(fetchLostArkEventCalendarSummary(env, { now })).rejects.toMatchObject({
      status: 502,
      code: "lostark_fetch_failed"
    });
    await expect(fetchLostArkEventCalendarSummary(env, { now })).resolves.toMatchObject({
      generatedAt: now.toISOString()
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(env.cachePuts.filter((entry) => entry.key === CALENDAR_CACHE_KEY)).toHaveLength(1);
    expect(env.cachePuts.filter((entry) => entry.key === CALENDAR_STATUS_KEY)).toHaveLength(2);
  });
});

describe("normalizeLostArkEventCalendar", () => {
  it("splits adventure island rewards into two claims only on days with a 09:00 reward window", () => {
    const summary = normalizeLostArkEventCalendar(
      [
        {
          CategoryName: "모험 섬",
          ContentsName: "우거진 갈대의 섬",
          StartTimes: ["2026-06-07T09:00:00", "2026-06-07T11:00:00", "2026-06-07T13:00:00"],
          Location: "우거진 갈대의 섬",
          RewardItems: [
            {
              Items: [
                {
                  Name: "전설 ~ 고급 카드 팩 IV",
                  StartTimes: ["2026-06-07T09:00:00", "2026-06-07T11:00:00", "2026-06-07T13:00:00"]
                }
              ]
            }
          ]
        },
        {
          CategoryName: "모험 섬",
          ContentsName: "블루홀 섬",
          StartTimes: ["2026-06-07T19:00:00", "2026-06-07T21:00:00", "2026-06-07T23:00:00"],
          Location: "블루홀 섬",
          RewardItems: [
            {
              Items: [
                {
                  Name: "골드",
                  StartTimes: ["2026-06-07T19:00:00", "2026-06-07T21:00:00", "2026-06-07T23:00:00"]
                }
              ]
            }
          ]
        }
      ],
      { now, rewardFilters: ["gold", "card"] }
    );

    expect(summary.adventureIsland.rule).toBe("9/11/13 중 1회, 19/21/23 중 1회 획득 가능");
    expect(summary.adventureIsland.entries).toEqual([
      {
        claimLabel: "2회차",
        continent: "베른 남부",
        futureTimes: ["19:00", "21:00", "23:00"],
        islandName: "블루홀 섬",
        rewards: ["쌀(골드)"],
        slotLabel: "저녁 보상"
      }
    ]);
    expect(summary.adventureIsland.endedRewardLabels).toEqual(["1회차 카드 팩"]);
  });

  it("keeps adventure island rewards as one daily claim on days without a 09:00 reward window", () => {
    const summary = normalizeLostArkEventCalendar(
      [
        {
          CategoryName: "모험 섬",
          ContentsName: "죽음의 협곡",
          StartTimes: ["2026-06-07T11:00:00", "2026-06-07T13:00:00", "2026-06-07T19:00:00", "2026-06-07T21:00:00"],
          Location: "죽음의 협곡",
          RewardItems: [
            {
              Items: [
                {
                  Name: "전설 ~ 고급 카드 팩 IV",
                  StartTimes: ["2026-06-07T11:00:00", "2026-06-07T13:00:00", "2026-06-07T19:00:00", "2026-06-07T21:00:00"]
                },
                {
                  Name: "골드",
                  StartTimes: ["2026-06-07T11:00:00", "2026-06-07T13:00:00", "2026-06-07T19:00:00", "2026-06-07T21:00:00"]
                }
              ]
            }
          ]
        }
      ],
      { now, rewardFilters: ["gold", "card"] }
    );

    expect(summary.adventureIsland.rule).toBe("11/13/19/21/23 전체에서 하루 1회 획득 가능");
    expect(summary.adventureIsland.entries).toEqual([
      {
        claimLabel: "일일 1회",
        continent: "아르데타인",
        futureTimes: ["19:00", "21:00"],
        islandName: "죽음의 협곡",
        rewards: ["쌀(골드)", "카드 팩"],
        slotLabel: "일일 보상"
      }
    ]);
    expect(summary.adventureIsland.endedRewardLabels).toEqual([]);
  });

  it("maps phantom butterfly island to Rohendel as the closest continent", () => {
    const summary = normalizeLostArkEventCalendar(
      [
        {
          CategoryName: "모험 섬",
          ContentsName: "환영 나비 섬",
          StartTimes: ["2026-06-07T19:00:00", "2026-06-07T21:00:00"],
          Location: "환영 나비 섬",
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
      ],
      { now, rewardFilters: ["gold"] }
    );

    expect(summary.adventureIsland.entries[0]?.continent).toBe("로헨델");
  });

  it("maps Monte Island with the API spacing to South Vern as the closest continent", () => {
    const summary = normalizeLostArkEventCalendar(
      [
        {
          CategoryName: "모험 섬",
          ContentsName: "몬테 섬",
          StartTimes: ["2026-06-07T19:00:00", "2026-06-07T21:00:00"],
          Location: "몬테 섬",
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
      ],
      { now, rewardFilters: ["gold"] }
    );

    expect(summary.adventureIsland.entries[0]?.continent).toBe("베른 남부");
  });

  it("summarizes chaos gate and field boss using game-rule times for the active day", () => {
    const summary = normalizeLostArkEventCalendar(
      [
        {
          CategoryName: "카오스게이트",
          ContentsName: "일렁이는 악마군단 (쿠르잔 북부)",
          StartTimes: ["2026-06-07T11:50:00", "2026-06-07T19:50:00", "2026-06-07T21:50:00"],
          Location: "아비도스 주둔지",
          RewardItems: []
        },
        {
          CategoryName: "필드보스",
          ContentsName: "세베크 아툰",
          StartTimes: ["2026-06-07T11:03:00"],
          Location: "아비도스 주둔지",
          RewardItems: []
        }
      ],
      { now, rewardFilters: ["gold"] }
    );

    expect(summary.chaosGate).toEqual({
      available: true,
      detail: "일렁이는 악마군단 (쿠르잔 북부) · 아비도스 주둔지",
      futureTimes: ["18:00", "19:00", "20:00", "21:00", "22:00"],
      nextTime: "18:00",
      remainingMinutes: 22
    });
    expect(summary.fieldBoss).toEqual({
      available: true,
      detail: "세베크 아툰 · 아비도스 주둔지",
      futureTimes: ["18:03", "19:03", "20:03", "21:03", "22:03"],
      nextTime: "18:03",
      remainingMinutes: 25
    });
  });

  it("keeps chaos gate and field boss available after the last slot until the 06:00 reset", () => {
    const summary = normalizeLostArkEventCalendar([], {
      now: new Date("2026-06-08T05:30:00+09:00"),
      rewardFilters: ["gold"]
    });

    expect(summary.today).toBe("2026-06-07");
    expect(summary.chaosGate).toMatchObject({
      available: true,
      futureTimes: [],
      nextTime: null,
      remainingMinutes: null
    });
    expect(summary.fieldBoss).toMatchObject({
      available: true,
      futureTimes: [],
      nextTime: null,
      remainingMinutes: null
    });
  });

  it("keeps chaos gate and field boss unavailable on days without that content", () => {
    const summary = normalizeLostArkEventCalendar([], {
      now: new Date("2026-06-10T12:00:00+09:00"),
      rewardFilters: ["gold"]
    });

    expect(summary.today).toBe("2026-06-10");
    expect(summary.chaosGate.available).toBe(false);
    expect(summary.fieldBoss.available).toBe(false);
  });

  it("keeps the event day on the previous KST date until the 06:00 reset", () => {
    const summary = normalizeLostArkEventCalendar(
      [
        {
          CategoryName: "필드보스",
          ContentsName: "일요일 필드보스",
          StartTimes: ["2026-06-07T19:03:00"],
          Location: "일요일 지역",
          RewardItems: []
        },
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
        },
        {
          CategoryName: "모험 섬",
          ContentsName: "죽음의 협곡",
          StartTimes: ["2026-06-08T11:00:00", "2026-06-08T19:00:00"],
          Location: "죽음의 협곡",
          RewardItems: [
            {
              Items: [
                {
                  Name: "전설 ~ 고급 카드 팩 IV",
                  StartTimes: ["2026-06-08T11:00:00", "2026-06-08T19:00:00"]
                }
              ]
            }
          ]
        }
      ],
      { now: new Date("2026-06-08T00:30:00+09:00"), rewardFilters: ["gold", "card"] }
    );

    expect(summary.today).toBe("2026-06-07");
    expect(summary.fieldBoss).toMatchObject({
      available: true,
      detail: "일요일 필드보스 · 일요일 지역",
      nextTime: "01:03",
      remainingMinutes: 33
    });
    expect(summary.adventureIsland.entries).toEqual([]);
    expect(summary.adventureIsland.endedRewardLabels).toEqual(["일일 1회 쌀(골드)"]);
  });

  it("starts using the new KST date at 06:00", () => {
    const summary = normalizeLostArkEventCalendar(
      [
        {
          CategoryName: "모험 섬",
          ContentsName: "죽음의 협곡",
          StartTimes: ["2026-06-08T11:00:00", "2026-06-08T19:00:00"],
          Location: "죽음의 협곡",
          RewardItems: [
            {
              Items: [
                {
                  Name: "전설 ~ 고급 카드 팩 IV",
                  StartTimes: ["2026-06-08T11:00:00", "2026-06-08T19:00:00"]
                }
              ]
            }
          ]
        }
      ],
      { now: new Date("2026-06-08T06:00:00+09:00"), rewardFilters: ["card"] }
    );

    expect(summary.today).toBe("2026-06-08");
    expect(summary.adventureIsland.entries).toEqual([
      {
        claimLabel: "일일 1회",
        continent: "아르데타인",
        futureTimes: ["11:00", "19:00"],
        islandName: "죽음의 협곡",
        rewards: ["카드 팩"],
        slotLabel: "일일 보상"
      }
    ]);
  });
});
