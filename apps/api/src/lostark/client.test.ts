import { afterEach, describe, expect, it, vi } from "vitest";
import * as LostArkClient from "./client";
import type { Env } from "../env";

const { searchRosterCharacters } = LostArkClient;

type FetchLostArkCharacterProfile = (
  env: Env,
  characterName: string
) => Promise<{
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  combatPower: string | null;
} | null>;

type MapWithConcurrency = <Item, Result>(
  items: Item[],
  concurrency: number,
  worker: (item: Item, index: number) => Promise<Result>
) => Promise<Result[]>;

function getFetchLostArkCharacterProfile(): FetchLostArkCharacterProfile {
  const candidate = (LostArkClient as unknown as {
    fetchLostArkCharacterProfile?: FetchLostArkCharacterProfile;
  }).fetchLostArkCharacterProfile;
  expect(candidate).toBeTypeOf("function");
  if (!candidate) throw new Error("fetchLostArkCharacterProfile is unavailable");
  return candidate;
}

function getMapWithConcurrency(): MapWithConcurrency {
  const candidate = (LostArkClient as unknown as {
    mapWithConcurrency?: MapWithConcurrency;
  }).mapWithConcurrency;
  expect(candidate).toBeTypeOf("function");
  if (!candidate) throw new Error("mapWithConcurrency is unavailable");
  return candidate;
}

type TrackingEnv = Env & {
  cacheGets: string[];
  cachePuts: Array<{ key: string; options: KVNamespacePutOptions | undefined; value: string }>;
  cacheStore: Map<string, string>;
};

function createEnv(initialCache: Record<string, unknown> = {}): TrackingEnv {
  const cache = new Map<string, string>();
  const cacheGets: string[] = [];
  const cachePuts: TrackingEnv["cachePuts"] = [];
  for (const [key, value] of Object.entries(initialCache)) {
    cache.set(key, JSON.stringify(value));
  }
  return {
    LOSTARK_API_KEY: "lostark-key",
    CACHE: {
      async get(key: string) {
        cacheGets.push(key);
        const value = cache.get(key);
        return value ? JSON.parse(value) : null;
      },
      async put(key: string, value: string, options?: KVNamespacePutOptions) {
        cachePuts.push({ key, options, value });
        cache.set(key, value);
      }
    } as unknown as KVNamespace,
    cacheGets,
    cachePuts,
    cacheStore: cache
  } as TrackingEnv;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("fetchLostArkCharacterProfile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and normalizes one fresh profile without touching KV", async () => {
    const cacheGet = vi.fn();
    const cachePut = vi.fn();
    const env = {
      LOSTARK_API_KEY: "lostark-key",
      CACHE: { get: cacheGet, put: cachePut }
    } as unknown as Env;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      CharacterName: "냠 수/나이스1",
      ServerName: "아만",
      CharacterClassName: "환수사",
      ItemAvgLevel: "1,700.00",
      CombatPower: "3,000.00"
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getFetchLostArkCharacterProfile()(env, "냠 수/나이스1")).resolves.toEqual({
      name: "냠 수/나이스1",
      serverName: "아만",
      className: "환수사",
      itemLevel: "1,700.00",
      combatPower: "3,000.00"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://developer-lostark.game.onstove.com/armories/characters/%EB%83%A0%20%EC%88%98%2F%EB%82%98%EC%9D%B4%EC%8A%A41/profiles"
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        accept: "application/json",
        authorization: "bearer lostark-key"
      },
      signal: expect.any(AbortSignal)
    });
    expect(cacheGet).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("requires the Lost Ark API key before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getFetchLostArkCharacterProfile()({ LOSTARK_API_KEY: "" } as Env, "냠수나이스1")
    ).rejects.toMatchObject({
      status: 500,
      code: "lostark_key_missing"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null for an upstream 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    await expect(getFetchLostArkCharacterProfile()(createEnv(), "없는캐릭터")).resolves.toBeNull();
  });

  it("returns null for a successful JSON null profile", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(null)));

    await expect(getFetchLostArkCharacterProfile()(createEnv(), "없는캐릭터")).resolves.toBeNull();
  });

  it("rejects malformed profile JSON without leaking the response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("sensitive malformed profile {", {
      headers: { "Content-Type": "application/json" }
    })));

    await expect(getFetchLostArkCharacterProfile()(createEnv(), "냠수나이스1")).rejects.toMatchObject({
      status: 502,
      code: "lostark_profile_invalid",
      message: "Lost Ark profile response was invalid"
    });
  });

  it.each([
    ["missing character name", { ServerName: "아만", CharacterClassName: "환수사", ItemAvgLevel: "1,700.00" }],
    ["empty character name", { CharacterName: " ", ServerName: "아만", CharacterClassName: "환수사", ItemAvgLevel: "1,700.00" }],
    ["missing server name", { CharacterName: "냠수나이스1", CharacterClassName: "환수사", ItemAvgLevel: "1,700.00" }],
    ["empty server name", { CharacterName: "냠수나이스1", ServerName: "", CharacterClassName: "환수사", ItemAvgLevel: "1,700.00" }],
    ["missing class name", { CharacterName: "냠수나이스1", ServerName: "아만", ItemAvgLevel: "1,700.00" }],
    ["empty class name", { CharacterName: "냠수나이스1", ServerName: "아만", CharacterClassName: " ", ItemAvgLevel: "1,700.00" }],
    ["missing item level", { CharacterName: "냠수나이스1", ServerName: "아만", CharacterClassName: "환수사" }],
    ["unusable item level", { CharacterName: "냠수나이스1", ServerName: "아만", CharacterClassName: "환수사", ItemAvgLevel: "정보 없음" }],
    ["zero item level", { CharacterName: "냠수나이스1", ServerName: "아만", CharacterClassName: "환수사", ItemAvgLevel: "0.00" }]
  ])("rejects a profile with %s", async (_description, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));

    await expect(getFetchLostArkCharacterProfile()(createEnv(), "냠수나이스1")).rejects.toMatchObject({
      status: 502,
      code: "lostark_profile_invalid",
      message: "Lost Ark profile response was invalid"
    });
  });

  it.each([
    ["read failure", new Error("sensitive body failure")],
    ["read timeout", new DOMException("sensitive timeout detail", "TimeoutError")]
  ])("maps a profile body %s to a structured non-leaking error", async (_description, bodyError) => {
    const response = Response.json({
      CharacterName: "냠수나이스1",
      ServerName: "아만",
      CharacterClassName: "환수사",
      ItemAvgLevel: "1,700.00"
    });
    vi.spyOn(response, "json").mockRejectedValue(bodyError);
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(getFetchLostArkCharacterProfile()(createEnv(), "냠수나이스1")).rejects.toMatchObject({
      status: 502,
      code: "lostark_profile_invalid",
      message: "Lost Ark profile response was invalid"
    });
  });

  it("throws a structured error for non-404 upstream failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    await expect(getFetchLostArkCharacterProfile()(createEnv(), "냠수나이스1")).rejects.toMatchObject({
      status: 503,
      code: "lostark_api_error"
    });
  });

  it.each([
    ["delay seconds", "17"],
    ["HTTP date", "Thu, 16 Jul 2026 00:00:17 GMT"]
  ])("preserves 429 Retry-After %s metadata", async (_description, retryAfter) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", {
      status: 429,
      headers: { "Retry-After": retryAfter }
    })));

    await expect(getFetchLostArkCharacterProfile()(createEnv(), "냠수나이스1")).rejects.toMatchObject({
      status: 429,
      code: "lostark_api_error",
      options: { headers: { "Retry-After": retryAfter } }
    });
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order while keeping four workers active", async () => {
    const mapWithConcurrency = getMapWithConcurrency();
    const items = Array.from({ length: 20 }, (_, index) => index);
    const releases = items.map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    });
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;

    const resultPromise = mapWithConcurrency(items, 4, async (item) => {
      started.push(item);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await releases[item]!.promise;
      active -= 1;
      return `result-${item}`;
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases[1]!.resolve();
    await vi.waitFor(() => expect(started).toContain(4));
    expect(active).toBe(4);
    for (const release of releases) release.resolve();

    await expect(resultPromise).resolves.toEqual(items.map((item) => `result-${item}`));
    expect(maxActive).toBe(4);
  });

  it("handles an empty input without invoking the worker", async () => {
    const worker = vi.fn();

    await expect(getMapWithConcurrency()([], 4, worker)).resolves.toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it("stops dequeuing after the first rejection and drains active workers before rejecting", async () => {
    const items = Array.from({ length: 8 }, (_, index) => index);
    const firstError = new Error("first worker failure");
    const releases = [0, 1, 2, 3].map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    });
    const started: number[] = [];
    let active = 0;

    const result = getMapWithConcurrency()(items, 4, async (item) => {
      started.push(item);
      active += 1;
      try {
        await releases[item]!.promise;
        if (item === 0) throw firstError;
        return item;
      } finally {
        active -= 1;
      }
    });
    const observed = result.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    );

    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases[0]!.resolve();
    await vi.waitFor(() => expect(active).toBe(3));
    expect(started).toEqual([0, 1, 2, 3]);
    releases[1]!.resolve();
    releases[2]!.resolve();
    releases[3]!.resolve();

    await expect(observed).resolves.toEqual({ status: "rejected", reason: firstError });
    expect(active).toBe(0);
    expect(started).toEqual([0, 1, 2, 3]);
  });
});

describe("searchRosterCharacters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stores one enriched v3 roster value without per-character KV writes", async () => {
    const env = createEnv();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/characters/main/siblings")) {
        return Response.json([
          { CharacterName: "저렙", ServerName: "루페온", CharacterClassName: "바드", ItemAvgLevel: "1,580.00" },
          { CharacterName: "나나", ServerName: "루페온", CharacterClassName: "바드", ItemAvgLevel: "1,640.00" },
          { CharacterName: "가가", ServerName: "카단", CharacterClassName: "도화가", ItemAvgLevel: "1,640.00" }
        ]);
      }
      if (url.includes("/armories/characters/%EC%A0%80%EB%A0%99/profiles")) {
        return Response.json({ CombatPower: "9,999,999" });
      }
      if (url.includes("/armories/characters/%EB%82%98%EB%82%98/profiles")) {
        return Response.json({ CombatPower: "22,222,222" });
      }
      if (url.includes("/armories/characters/%EA%B0%80%EA%B0%80/profiles")) {
        return Response.json({ CombatPower: "11,111,111" });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const expected = [
      { name: "가가", serverName: "카단", className: "도화가", itemLevel: "1,640.00", combatPower: "11,111,111" },
      { name: "나나", serverName: "루페온", className: "바드", itemLevel: "1,640.00", combatPower: "22,222,222" },
      { name: "저렙", serverName: "루페온", className: "바드", itemLevel: "1,580.00", combatPower: "9,999,999" }
    ];

    await expect(searchRosterCharacters(env, "main")).resolves.toEqual(expected);
    expect(env.cacheGets).toEqual(["lostark:roster:v3:main"]);
    expect(env.cachePuts).toHaveLength(1);
    expect(env.cachePuts[0]).toMatchObject({
      key: "lostark:roster:v3:main",
      options: { expirationTtl: 60 * 30 }
    });
    expect(JSON.parse(env.cachePuts[0]?.value ?? "{}")).toEqual({ characters: expected });
    expect(env.cachePuts.some((entry) => entry.key.startsWith("lostark:combat-power:"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("normalizes query keys and shares one in-flight roster request", async () => {
    const siblings = deferred<Response>();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => siblings.promise);
    vi.stubGlobal("fetch", fetchMock);
    const env = createEnv();

    const first = searchRosterCharacters(env, " Main ");
    const second = searchRosterCharacters(env, "main");
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    siblings.resolve(Response.json([]));
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);

    expect(env.cacheGets).toEqual(["lostark:roster:v3:main"]);
    expect(env.cachePuts).toHaveLength(1);
    expect(env.cachePuts[0]?.key).toBe("lostark:roster:v3:main");
  });

  it("limits profile enrichment to four concurrent requests", async () => {
    const releases = Array.from({ length: 8 }, () => deferred<void>());
    let activeProfiles = 0;
    let maxActiveProfiles = 0;
    let profileIndex = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/characters/main/siblings")) {
        return Response.json(
          Array.from({ length: 8 }, (_, index) => ({
            CharacterName: `캐릭터${index}`,
            ServerName: "아만",
            CharacterClassName: "바드",
            ItemAvgLevel: `1,60${index}.00`
          }))
        );
      }

      const index = profileIndex;
      profileIndex += 1;
      activeProfiles += 1;
      maxActiveProfiles = Math.max(maxActiveProfiles, activeProfiles);
      await releases[index]?.promise;
      activeProfiles -= 1;
      return Response.json({ CombatPower: `${index + 1},000` });
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = createEnv();

    const result = searchRosterCharacters(env, "main");
    await vi.waitFor(() => {
      expect(profileIndex).toBe(4);
    });
    releases.slice(0, 4).forEach((release) => release.resolve());
    await vi.waitFor(() => {
      expect(profileIndex).toBe(8);
    });
    releases.slice(4).forEach((release) => release.resolve());

    await expect(result).resolves.toHaveLength(8);
    expect(maxActiveProfiles).toBe(4);
    expect(env.cachePuts).toHaveLength(1);
  });

  it("does not let non-numeric combat power text break character imports", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/characters/main/siblings")) {
          return Response.json([
            { CharacterName: "고래나이스1", ServerName: "아만", CharacterClassName: "브레이커", ItemAvgLevel: "1,640.00" }
          ]);
        }
        if (url.includes("/armories/characters/%EA%B3%A0%EB%9E%98%EB%82%98%EC%9D%B4%EC%8A%A41/profiles")) {
          return Response.json({ CombatPower: "정보 없음" });
        }
        return new Response(null, { status: 404 });
      })
    );

    await expect(searchRosterCharacters(createEnv(), "main")).resolves.toEqual([
      { name: "고래나이스1", serverName: "아만", className: "브레이커", itemLevel: "1,640.00", combatPower: null }
    ]);
  });

  it("does not let unavailable item levels break roster search or import payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/characters/%EA%B3%A0%EB%9E%98%EB%82%98%EC%9D%B4%EC%8A%A41/siblings")) {
          return Response.json([
            { CharacterName: "고래나이스1", ServerName: "아만", CharacterClassName: "브레이커", ItemAvgLevel: "1,640.00" },
            { CharacterName: "고래나이스2", ServerName: "카단", CharacterClassName: "바드", ItemAvgLevel: "정보 없음" },
            { CharacterName: "고래나이스3", ServerName: "루페온", CharacterClassName: "도화가" }
          ]);
        }
        return Response.json({ CombatPower: "정보 없음" });
      })
    );

    await expect(searchRosterCharacters(createEnv(), "고래나이스1")).resolves.toEqual([
      { name: "고래나이스1", serverName: "아만", className: "브레이커", itemLevel: "1,640.00", combatPower: null },
      { name: "고래나이스2", serverName: "카단", className: "바드", itemLevel: "0", combatPower: null },
      { name: "고래나이스3", serverName: "루페온", className: "도화가", itemLevel: "0", combatPower: null }
    ]);
  });

  it("normalizes cached roster payloads before returning them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("cache hit should not fetch Lost Ark API");
      })
    );

    await expect(
      searchRosterCharacters(createEnv({
        "lostark:roster:v3:고래나이스1": {
          characters: [
            { name: "고래나이스2", serverName: "카단", className: "바드", itemLevel: "정보 없음", combatPower: "정보 없음" },
            { name: "고래나이스1", serverName: "아만", className: "브레이커", itemLevel: "1,640.00", combatPower: null }
          ]
        }
      }), "고래나이스1")
    ).resolves.toEqual([
      { name: "고래나이스1", serverName: "아만", className: "브레이커", itemLevel: "1,640.00", combatPower: null },
      { name: "고래나이스2", serverName: "카단", className: "바드", itemLevel: "0", combatPower: null }
    ]);
  });

  it("does not let null profile responses break roster search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/characters/%EA%B3%A0%EB%9E%98%EB%82%98%EC%9D%B4%EC%8A%A41/siblings")) {
          return Response.json([
            { CharacterName: "고래나이스1", ServerName: "아만", CharacterClassName: "브레이커", ItemAvgLevel: "1,640.00" }
          ]);
        }
        if (url.includes("/armories/characters/%EA%B3%A0%EB%9E%98%EB%82%98%EC%9D%B4%EC%8A%A41/profiles")) {
          return Response.json(null);
        }
        return new Response(null, { status: 404 });
      })
    );

    await expect(searchRosterCharacters(createEnv(), "고래나이스1")).resolves.toEqual([
      { name: "고래나이스1", serverName: "아만", className: "브레이커", itemLevel: "1,640.00", combatPower: null }
    ]);
  });

  it("returns an empty roster instead of failing when siblings payload is not an array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/characters/%EA%B3%A0%EB%9E%98%EB%82%98%EC%9D%B4%EC%8A%A41/siblings")) {
          return Response.json(null);
        }
        return new Response(null, { status: 404 });
      })
    );

    await expect(searchRosterCharacters(createEnv(), "고래나이스1")).resolves.toEqual([]);
  });

  it("keeps only the failed profile's combat power null and still caches the roster once", async () => {
    const env = createEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/characters/main/siblings")) {
          return Response.json([
            { CharacterName: "성공", ServerName: "아만", CharacterClassName: "바드", ItemAvgLevel: "1,640.00" },
            { CharacterName: "실패", ServerName: "카단", CharacterClassName: "도화가", ItemAvgLevel: "1,630.00" }
          ]);
        }
        if (url.includes("/armories/characters/%EC%8B%A4%ED%8C%A8/profiles")) {
          throw new DOMException("timed out", "TimeoutError");
        }
        return Response.json({ CombatPower: "12,345" });
      })
    );

    await expect(searchRosterCharacters(env, "main")).resolves.toEqual([
      { name: "성공", serverName: "아만", className: "바드", itemLevel: "1,640.00", combatPower: "12,345" },
      { name: "실패", serverName: "카단", className: "도화가", itemLevel: "1,630.00", combatPower: null }
    ]);
    expect(env.cachePuts).toHaveLength(1);
  });

  it("writes nothing on a siblings failure and cleans the in-flight entry for retry", async () => {
    const env = createEnv();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("siblings unavailable"))
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchRosterCharacters(env, "main")).rejects.toThrow("siblings unavailable");
    expect(env.cachePuts).toHaveLength(0);
    await expect(searchRosterCharacters(env, "main")).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(env.cachePuts).toHaveLength(1);
  });
});
