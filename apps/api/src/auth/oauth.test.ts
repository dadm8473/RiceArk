import { describe, expect, it } from "vitest";
import { extractOAuthState, normalizeProviderProfile } from "./oauth";

describe("oauth helpers", () => {
  it("extracts the stored oauth state cookie", () => {
    expect(extractOAuthState("other=1; riceark_oauth_state=abc; next=2")).toBe("abc");
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
