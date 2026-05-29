import { describe, expect, it } from "vitest";
import app from "../index";

const env = {
  APP_ORIGIN: "http://127.0.0.1:5173",
  COOKIE_DOMAIN: "127.0.0.1",
  ENVIRONMENT: "test",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  DISCORD_CLIENT_ID: "discord-client",
  DISCORD_CLIENT_SECRET: "discord-secret",
  SESSION_SECRET: "test-secret"
};

describe("auth routes", () => {
  it("redirects to Google OAuth", async () => {
    const res = await app.request("/api/auth/google/start", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("accounts.google.com");
  });

  it("rejects unknown providers", async () => {
    const res = await app.request("/api/auth/unknown/start", {}, env);
    expect(res.status).toBe(404);
  });
});
