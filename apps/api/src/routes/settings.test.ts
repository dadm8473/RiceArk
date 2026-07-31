import { describe, expect, it } from "vitest";
import app from "../index";
import { settingsPatchSchema } from "./settings";

const TARGET_USER_ID = "12345678-1234-4abc-8def-123456789012";

function createTargetedUserRouteEnv() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const runs: Array<{ sql: string; values: unknown[] }> = [];
  const env = {
    APP_ORIGIN: "http://127.0.0.1:5173",
    COOKIE_DOMAIN: "127.0.0.1",
    ENVIRONMENT: "test",
    SESSION_SECRET: "test-secret",
    ADMIN_OAUTH_ALLOWLIST: "discord:admin-provider",
    DB: {
      prepare(sql: string) {
        const statement = {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            this.values = values;
            return this;
          },
          async first() {
            if (sql.includes("FROM sessions")) {
              return { id: "admin-1", display_name: "Admin", avatar_url: null };
            }
            if (sql.includes("SELECT id, display_name, avatar_url FROM users WHERE id = ?")) {
              return { id: TARGET_USER_ID, display_name: "Target", avatar_url: null };
            }
            return null;
          },
          async all() {
            if (sql.includes("FROM oauth_accounts")) {
              return { results: [{ provider: "discord", provider_user_id: "admin-provider" }] };
            }
            return { results: [] };
          },
          async run() {
            runs.push({ sql, values: this.values });
            return { success: true, meta: { changes: 1 } };
          }
        };
        statements.push(statement);
        return statement;
      }
    }
  };
  return { env, statements, runs };
}

describe("settingsPatchSchema", () => {
  it("accepts checklist orientation updates", () => {
    expect(settingsPatchSchema.safeParse({ checklistOrientation: "tasks_rows" }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ checklistOrientation: "tasks_columns" }).success).toBe(true);
  });

  it("rejects unknown checklist orientations", () => {
    expect(settingsPatchSchema.safeParse({ checklistOrientation: "wrong" }).success).toBe(false);
  });

  it("still accepts density settings", () => {
    expect(
      settingsPatchSchema.safeParse({
        density: "compact",
        rowHeight: 32,
        columnWidth: 120
      }).success
    ).toBe(true);
  });

  it("accepts character display visibility updates", () => {
    expect(
      settingsPatchSchema.safeParse({
        characterDisplay: {
          displayName: true,
          serverName: false,
          className: true,
          itemLevel: true,
          combatPower: false
        }
      }).success
    ).toBe(true);
  });
});

describe("settings route targeting", () => {
  const targetHeaders = {
    Cookie: "riceark_session=admin-session",
    "X-RiceArk-Admin-Target-User": TARGET_USER_ID
  };

  it("updates settings for the targeted user", async () => {
    const { env, runs } = createTargetedUserRouteEnv();
    const response = await app.request(
      "/api/settings",
      {
        method: "PATCH",
        headers: { ...targetHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ checklistOrientation: "tasks_rows" })
      },
      env
    );

    expect(response.status).toBe(200);
    const settingsBindings = runs
      .filter((statement) => statement.sql.includes("INSERT INTO user_settings"))
      .flatMap((statement) => statement.values);
    expect(settingsBindings).toContain(TARGET_USER_ID);
    expect(settingsBindings).not.toContain("admin-1");
  });

  it("keeps profile updates actor-owned when a target header is present", async () => {
    const { env, statements, runs } = createTargetedUserRouteEnv();
    const response = await app.request(
      "/api/profile",
      {
        method: "PATCH",
        headers: { ...targetHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Admin" })
      },
      env
    );

    expect(response.status).toBe(200);
    const profileBindings = runs
      .filter((statement) => statement.sql.includes("UPDATE users SET display_name"))
      .flatMap((statement) => statement.values);
    expect(profileBindings).toContain("admin-1");
    expect(profileBindings).not.toContain(TARGET_USER_ID);
    const adminCheckBindings = statements
      .filter((statement) => statement.sql.includes("FROM oauth_accounts"))
      .flatMap((statement) => statement.values);
    expect(adminCheckBindings).toContain("admin-1");
    expect(adminCheckBindings).not.toContain(TARGET_USER_ID);
    expect(statements.some((statement) => statement.sql.includes("FROM users WHERE id = ?"))).toBe(false);
  });
});
