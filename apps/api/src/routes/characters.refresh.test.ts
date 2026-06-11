import { describe, expect, it, vi } from "vitest";
import app from "../index";
import { updateCharacterFromLostArk } from "../db/characters";

vi.mock("../auth/requireUser", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" }))
}));

vi.mock("../db/characters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/characters")>();
  return {
    ...actual,
    updateCharacterFromLostArk: vi.fn()
  };
});

const env = {
  APP_ORIGIN: "http://127.0.0.1:5173",
  COOKIE_DOMAIN: "127.0.0.1",
  ENVIRONMENT: "test"
};

describe("character refresh route", () => {
  it("returns a structured rate-limit error when refresh is attempted too soon", async () => {
    vi.mocked(updateCharacterFromLostArk).mockResolvedValue({ type: "rate_limited", retryAfterSeconds: 42 });

    const response = await app.request("/api/characters/character-1/refresh", { method: "POST" }, env);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        code: "character_refresh_rate_limited",
        message: "캐릭터 갱신은 1분에 한 번만 시도할 수 있습니다. 42초 후 다시 시도해주세요."
      }
    });
  });
});
