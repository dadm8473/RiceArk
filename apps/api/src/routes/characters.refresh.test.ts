import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../index";
import {
  deleteCharacter,
  updateCharacterDetails,
  updateCharacterDisplayName,
  updateCharacterFromLostArk
} from "../db/characters";

vi.mock("../auth/requireUser", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" }))
}));

vi.mock("../db/characters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/characters")>();
  return {
    ...actual,
    deleteCharacter: vi.fn(),
    updateCharacterDetails: vi.fn(),
    updateCharacterDisplayName: vi.fn(),
    updateCharacterFromLostArk: vi.fn()
  };
});

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
    vi.mocked(updateCharacterFromLostArk).mockReset();
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
    vi.mocked(updateCharacterFromLostArk).mockResolvedValue({
      character: {
        id: "character-1",
        name: "냠수나이스1",
        serverName: "아만",
        className: "환수사",
        itemLevel: "1,700.00",
        combatPower: "3,000.00"
      },
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
    vi.mocked(updateCharacterFromLostArk).mockResolvedValue({ type: "rate_limited", retryAfterSeconds: 42 });

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

  it("preserves the existing not-found error for an unavailable delete target", async () => {
    vi.mocked(deleteCharacter).mockResolvedValue(null);

    const response = await app.request("/api/characters/character-1", { method: "DELETE" }, env);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "character_not_found", message: "Character not found" }
    });
  });
});
