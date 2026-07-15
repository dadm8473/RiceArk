import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import app from "../index";
import * as CharacterDb from "../db/characters";

const {
  deleteCharacter,
  updateCharacterDetails,
  updateCharacterDisplayName
} = CharacterDb;

vi.mock("../auth/requireUser", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" }))
}));

vi.mock("../db/characters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/characters")>();
  return {
    ...actual,
    deleteCharacter: vi.fn(),
    refreshCharactersFromLostArk: vi.fn(),
    updateCharacterDetails: vi.fn(),
    updateCharacterDisplayName: vi.fn(),
    updateCharacterFromLostArk: vi.fn()
  };
});

function refreshCharactersMock() {
  const candidate = (CharacterDb as unknown as {
    refreshCharactersFromLostArk?: Mock<(...args: unknown[]) => Promise<unknown>>;
  }).refreshCharactersFromLostArk;
  expect(candidate).toBeTypeOf("function");
  if (!candidate) throw new Error("refreshCharactersFromLostArk mock is unavailable");
  return candidate;
}

const env = {
  APP_ORIGIN: "http://127.0.0.1:5173",
  COOKIE_DOMAIN: "127.0.0.1",
  ENVIRONMENT: "test"
};

const versions = {
  sheets: [
    { id: "sheet-1", version: 4 },
    { id: "sheet-2", version: 8 }
  ]
};

describe("versioned character routes", () => {
  beforeEach(() => {
    vi.mocked(deleteCharacter).mockReset();
    vi.mocked(updateCharacterDetails).mockReset();
    vi.mocked(updateCharacterDisplayName).mockReset();
    refreshCharactersMock().mockReset();
  });

  it("returns versions for character details and display-name updates", async () => {
    vi.mocked(updateCharacterDetails).mockResolvedValue({ ok: true, versions });
    vi.mocked(updateCharacterDisplayName).mockResolvedValue({ ok: true, versions });

    const detailsResponse = await app.request(
      "/api/characters/character-1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "레이드", itemLevel: "1,700.00", combatPower: "3,000.00" })
      },
      env
    );
    const displayNameResponse = await app.request(
      "/api/characters/character-1/display-name",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "레이드" })
      },
      env
    );

    expect(detailsResponse.status).toBe(200);
    expect(await detailsResponse.json()).toEqual({ ok: true, versions });
    expect(displayNameResponse.status).toBe(200);
    expect(await displayNameResponse.json()).toEqual({ ok: true, versions });
  });

  it("returns 200 JSON with versions when deleting a character", async () => {
    vi.mocked(deleteCharacter).mockResolvedValue({ ok: true, versions });

    const response = await app.request("/api/characters/character-1", { method: "DELETE" }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, versions });
  });

  it("preserves refreshed profile fields at the top level and adds versions", async () => {
    refreshCharactersMock().mockResolvedValue({
      results: [{
        id: "character-1",
        status: "updated",
        character: {
          id: "character-1",
          name: "냠수나이스1",
          serverName: "아만",
          className: "환수사",
          itemLevel: "1,700.00",
          combatPower: "3,000.00"
        }
      }],
      versions
    });

    const response = await app.request("/api/characters/character-1/refresh", { method: "POST" }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "character-1",
      name: "냠수나이스1",
      serverName: "아만",
      className: "환수사",
      itemLevel: "1,700.00",
      combatPower: "3,000.00",
      versions
    });
  });

  it("returns a structured rate-limit error when refresh is attempted too soon", async () => {
    refreshCharactersMock().mockResolvedValue({
      results: [{ id: "character-1", status: "rate_limited", retryAfterSeconds: 42 }],
      versions: { sheets: [] }
    });

    const response = await app.request("/api/characters/character-1/refresh", { method: "POST" }, env);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(await response.json()).toEqual({
      error: {
        code: "character_refresh_rate_limited",
        message: "캐릭터 갱신은 1분에 한 번만 시도할 수 있습니다. 42초 후 다시 시도해주세요."
      }
    });
  });

  it("returns every batch result in order even when individual refreshes fail", async () => {
    const results = [
      {
        id: "character-updated",
        status: "updated",
        character: {
          id: "character-updated",
          name: "냠수나이스1",
          serverName: "아만",
          className: "환수사",
          itemLevel: "1,700.00",
          combatPower: "3,000.00"
        }
      },
      { id: "character-manual", status: "manual" },
      { id: "character-missing", status: "not_found" },
      { id: "character-unavailable", status: "not_available" },
      { id: "character-rate", status: "rate_limited", retryAfterSeconds: 17 },
      { id: "character-failed", status: "failed", code: "lostark_api_error" }
    ];
    refreshCharactersMock().mockResolvedValue({ results, versions });
    const characterIds = results.map((result) => result.id);

    const response = await app.request(
      "/api/characters/refresh-batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterIds })
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results, versions });
    expect(refreshCharactersMock()).toHaveBeenCalledTimes(1);
    expect(refreshCharactersMock()).toHaveBeenCalledWith(expect.anything(), "user-1", characterIds);
  });

  it.each([
    ["an empty batch", []],
    ["duplicate ids", ["character-1", "character-1"]],
    ["more than 40 ids", Array.from({ length: 41 }, (_, index) => `character-${index}`)]
  ])("rejects %s before calling the refresh service", async (_description, characterIds) => {
    const response = await app.request(
      "/api/characters/refresh-batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterIds })
      },
      env
    );

    expect(response.status).toBe(400);
    expect(refreshCharactersMock()).not.toHaveBeenCalled();
  });

  it("accepts exactly 40 unique ids", async () => {
    const characterIds = Array.from({ length: 40 }, (_, index) => `character-${index}`);
    refreshCharactersMock().mockResolvedValue({
      results: characterIds.map((id) => ({ id, status: "not_found" })),
      versions: { sheets: [] }
    });

    const response = await app.request(
      "/api/characters/refresh-batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterIds })
      },
      env
    );

    expect(response.status).toBe(200);
    expect(refreshCharactersMock()).toHaveBeenCalledWith(expect.anything(), "user-1", characterIds);
  });

  it.each([
    ["manual", 400, "manual_character_refresh_unavailable"],
    ["not_found", 404, "character_not_found"],
    ["not_available", 404, "lostark_character_not_found"]
  ] as const)("preserves the single-route %s response", async (status, expectedHttpStatus, code) => {
    refreshCharactersMock().mockResolvedValue({
      results: [{ id: "character-1", status }],
      versions: { sheets: [] }
    });

    const response = await app.request("/api/characters/character-1/refresh", { method: "POST" }, env);

    expect(response.status).toBe(expectedHttpStatus);
    expect(await response.json()).toMatchObject({ error: { code } });
  });

  it("maps a generic upstream failure to a non-leaking gateway error", async () => {
    refreshCharactersMock().mockResolvedValue({
      results: [{ id: "character-1", status: "failed", code: "lostark_api_error" }],
      versions: { sheets: [] }
    });

    const response = await app.request("/api/characters/character-1/refresh", { method: "POST" }, env);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "lostark_api_error",
        message: "로스트아크 API에서 캐릭터 정보를 갱신하지 못했습니다."
      }
    });
  });

  it("preserves the existing not-found error for an unavailable delete target", async () => {
    vi.mocked(deleteCharacter).mockResolvedValue(null);

    const response = await app.request("/api/characters/character-1", { method: "DELETE" }, env);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "character_not_found", message: "Character not found" }
    });
  });
});
