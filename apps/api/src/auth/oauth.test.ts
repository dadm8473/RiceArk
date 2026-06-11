import { describe, expect, it } from "vitest";
import { createOAuthState, extractOAuthState, normalizeProviderProfile, verifyOAuthState } from "./oauth";

describe("oauth helpers", () => {
  it("extracts the stored oauth state cookie", () => {
    expect(extractOAuthState("other=1; riceark_oauth_state=abc; next=2")).toBe("abc");
  });

  it("creates a signed oauth state that can be verified without a browser cookie", async () => {
    const state = await createOAuthState("discord", "secret", new Date("2026-06-05T00:00:00.000Z"));

    await expect(verifyOAuthState(state, "discord", "secret", new Date("2026-06-05T00:05:00.000Z"))).resolves.toBe(true);
    await expect(verifyOAuthState(state, "google", "secret", new Date("2026-06-05T00:05:00.000Z"))).resolves.toBe(false);
    await expect(verifyOAuthState(state, "discord", "wrong", new Date("2026-06-05T00:05:00.000Z"))).resolves.toBe(false);
    await expect(verifyOAuthState(state, "discord", "secret", new Date("2026-06-05T00:11:00.000Z"))).resolves.toBe(false);
  });

  it("normalizes Google profile fields", () => {
    expect(
      normalizeProviderProfile("google", {
        sub: "google-1",
        name: "쌀먹",
        email: "user@example.com",
        picture: "https://example.com/avatar.png"
      })
    ).toEqual({
      provider: "google",
      providerUserId: "google-1",
      displayName: "쌀먹",
      email: "user@example.com",
      avatarUrl: "https://example.com/avatar.png"
    });
  });

  it("normalizes Discord profile fields", () => {
    expect(
      normalizeProviderProfile("discord", {
        id: "discord-1",
        username: "rice",
        global_name: "쌀먹",
        email: "user@example.com",
        avatar: null
      })
    ).toEqual({
      provider: "discord",
      providerUserId: "discord-1",
      displayName: "쌀먹",
      email: "user@example.com",
      avatarUrl: null
    });
  });
});
