import { describe, expect, it } from "vitest";
import app from "./index";

const env = {
  APP_ORIGIN: "http://127.0.0.1:5173",
  COOKIE_DOMAIN: "127.0.0.1",
  ENVIRONMENT: "test"
};

describe("api shell", () => {
  it("responds to health checks", async () => {
    const res = await app.request("/api/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "riceark-api" });
  });

  it("returns structured errors for missing routes", async () => {
    const res = await app.request("/api/missing", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "Route not found" }
    });
  });

  it("rejects oversized request bodies before route handling", async () => {
    const body = JSON.stringify({ name: "a".repeat(17_000), resetType: "daily" });
    const res = await app.request(
      "/api/tasks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
        body
      },
      env
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: { code: "payload_too_large", message: "Request body is too large" }
    });
  });
});
