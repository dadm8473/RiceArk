import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ADMIN_TARGET_USER_HEADER, requireUserAccess } from "./auth/userAccess";
import app, { adminTargetAuditMiddleware } from "./index";
import type { AppEnv } from "./env";

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
    const body = JSON.stringify({ name: "a".repeat(70_000), resetType: "daily" });
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

  it("allows moderate request bodies used by large character imports", async () => {
    const body = JSON.stringify({ name: "a".repeat(20_000), resetType: "daily" });
    const res = await app.request(
      "/api/missing",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
        body
      },
      env
    );

    expect(res.status).not.toBe(413);
  });

  it("allows the administrator target header on CORS preflights", async () => {
    const res = await app.request(
      "/api/board/bootstrap",
      {
        method: "OPTIONS",
        headers: {
          Origin: env.APP_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": ADMIN_TARGET_USER_HEADER
        }
      },
      env
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(ADMIN_TARGET_USER_HEADER);
  });

  it.each([
    "/api/board/bootstrap",
    "/api/board/versions",
    "/api/board",
    "/api/board/sheets/sheet-1"
  ])(
    "registers authenticated owner read route %s",
    async (path) => {
      const res = await app.request(path, {}, env);

      expect(res.status).toBe(401);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("Vary")?.split(",").map((value) => value.trim()).sort()).toEqual([
        "Cookie",
        "Origin"
      ]);
      expect(await res.json()).toEqual({
        error: { code: "unauthorized", message: "Login required" }
      });
    }
  );
});

const auditEntries: unknown[][] = [];
const TARGET_USER_ID = "12345678-1234-4abc-8def-123456789012";

describe("administrator target audit middleware", () => {
  it("records successful targeted direct table settings mutations without request content", async () => {
    const auditApp = new Hono<AppEnv>().basePath("/api");
    auditApp.use("*", adminTargetAuditMiddleware);
    auditApp.patch("/board/tables/_audit-test", async (c) => {
      const access = await requireUserAccess(c, { allowAdminTarget: true });
      return c.json({ actorId: access.actor.id, subjectId: access.subject.id });
    });
    const db = {
      prepare(sql: string) {
        const statement = {
          bind(...values: unknown[]) {
            return {
              first: async () => {
                if (sql.includes("FROM sessions")) {
                  return { id: "admin-1", display_name: "Admin", avatar_url: null };
                }
                if (sql.includes("FROM users")) {
                  return { id: TARGET_USER_ID, display_name: "User", avatar_url: null };
                }
                return null;
              },
              all: async () => {
                if (sql.includes("FROM oauth_accounts")) {
                  return { results: [{ provider: "discord", provider_user_id: "admin-provider" }] };
                }
                return { results: [] };
              },
              run: async () => {
                if (sql.includes("INSERT INTO admin_audit_logs")) auditEntries.push(values);
                return { success: true };
              }
            };
          }
        };
        return statement;
      }
    } as unknown as D1Database;
    auditEntries.length = 0;

    const res = await auditApp.request(
      "/api/board/tables/_audit-test",
      {
        method: "PATCH",
        headers: {
          Cookie: "riceark_session=admin-session",
          [ADMIN_TARGET_USER_HEADER]: TARGET_USER_ID
        }
      },
      {
        ...env,
        DB: db,
        SESSION_SECRET: "test-secret",
        ADMIN_OAUTH_ALLOWLIST: "discord:admin-provider"
      }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actorId: "admin-1", subjectId: TARGET_USER_ID });
    expect(auditEntries).toEqual([[expect.any(String), "admin-1", TARGET_USER_ID, "PATCH", "board.update"]]);
  });
});
