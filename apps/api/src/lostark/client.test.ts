import { afterEach, describe, expect, it, vi } from "vitest";
import { searchRosterCharacters } from "./client";
import type { Env } from "../env";

function createEnv(initialCache: Record<string, unknown> = {}): Env {
  const cache = new Map<string, string>();
  for (const [key, value] of Object.entries(initialCache)) {
    cache.set(key, JSON.stringify(value));
  }
  return {
    LOSTARK_API_KEY: "lostark-key",
    CACHE: {
      async get(key: string) {
        const value = cache.get(key);
        return value ? JSON.parse(value) : null;
      },
      async put(key: string, value: string) {
        cache.set(key, value);
      }
    } as unknown as KVNamespace
  } as Env;
}

describe("searchRosterCharacters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enriches characters with combat power and sorts by item level descending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
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
      })
    );

    await expect(searchRosterCharacters(createEnv(), "main")).resolves.toEqual([
      { name: "가가", serverName: "카단", className: "도화가", itemLevel: "1,640.00", combatPower: "11,111,111" },
      { name: "나나", serverName: "루페온", className: "바드", itemLevel: "1,640.00", combatPower: "22,222,222" },
      { name: "저렙", serverName: "루페온", className: "바드", itemLevel: "1,580.00", combatPower: "9,999,999" }
    ]);
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
        "lostark:roster:v2:고래나이스1": [
          { name: "고래나이스2", serverName: "카단", className: "바드", itemLevel: "정보 없음", combatPower: "정보 없음" },
          { name: "고래나이스1", serverName: "아만", className: "브레이커", itemLevel: "1,640.00", combatPower: null }
        ]
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
});
