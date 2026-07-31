import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import {
  findAdminUserSummary,
  listAdminAuditLogs,
  listAdminUsers,
  recordAdminAuditLog
} from "./userBoardManagement";

type CapturedStatement = { sql: string; values: unknown[] };

function createCapturingEnv(rows: Array<Record<string, unknown> | null> = []): {
  env: Env;
  statements: CapturedStatement[];
} {
  const statements: CapturedStatement[] = [];
  let resultIndex = 0;
  const database = {
    prepare(sql: string) {
      const statement: CapturedStatement = { sql, values: [] };
      statements.push(statement);
      const result = () => ({
        results: rows[resultIndex++] === null ? [] : rows[resultIndex - 1] ? [rows[resultIndex - 1]] : []
      });
      return {
        bind: (...values: unknown[]) => {
          statement.values = values;
          return {
            all: async () => result(),
            first: async () => result().results[0] ?? null,
            run: async () => ({ success: true })
          };
        },
        all: async () => result(),
        first: async () => result().results[0] ?? null,
        run: async () => ({ success: true })
      };
    }
  } as unknown as D1Database;

  return { env: { DB: database } as Env, statements };
}

describe("administrator user board management data access", () => {
  it("records only actor, subject, method, action, and timestamp", async () => {
    const { env, statements } = createCapturingEnv();

    await recordAdminAuditLog(env, {
      adminUserId: "admin-1",
      targetUserId: "user-1",
      method: "PATCH",
      action: "board.completions.update"
    });

    expect(statements).toHaveLength(1);
    expect(statements[0]?.values).toEqual([
      expect.any(String),
      "admin-1",
      "user-1",
      "PATCH",
      "board.completions.update"
    ]);
  });

  it("limits user and audit pages at their fixed bounds", async () => {
    const { env, statements } = createCapturingEnv();

    await listAdminUsers(env, { search: "rice", cursor: null });
    await listAdminAuditLogs(env, null);

    const sqlText = statements.map((statement) => statement.sql).join("\n");
    expect(sqlText).toContain("LIMIT 31");
    expect(sqlText).toContain("LIMIT 51");
  });

  it("uses opaque keyset cursors and returns only user-safe identity fields", async () => {
    const { env, statements } = createCapturingEnv([
      {
        id: "user-1",
        display_name: "Rice Player",
        provider: "google",
        created_at: "2026-07-01 00:00:00",
        recent_activity_at: "2026-07-02 00:00:00"
      }
    ]);

    const page = await listAdminUsers(env, { search: "rice", cursor: null });

    expect(page).toEqual({
      users: [
        {
          id: "user-1",
          displayName: "Rice Player",
          provider: "google",
          createdAt: "2026-07-01 00:00:00",
          recentActivityAt: "2026-07-02 00:00:00"
        }
      ],
      nextCursor: null
    });
    expect(statements[0]?.sql).toContain("WITH page_users AS");
    expect(statements[0]?.sql).not.toContain("OFFSET");
    expect(statements[0]?.sql).not.toContain("oauth_accounts.email");
    expect(statements[0]?.sql).not.toContain("provider_user_id");
  });

  it("looks up one user summary without exposing OAuth identifiers", async () => {
    const { env, statements } = createCapturingEnv([
      {
        id: "user-1",
        display_name: "Rice Player",
        provider: "discord",
        created_at: "2026-07-01 00:00:00",
        recent_activity_at: null
      }
    ]);

    await expect(findAdminUserSummary(env, "user-1")).resolves.toEqual({
      id: "user-1",
      displayName: "Rice Player",
      provider: "discord",
      createdAt: "2026-07-01 00:00:00",
      recentActivityAt: null
    });
    expect(statements[0]?.values).toEqual(["user-1"]);
    expect(statements[0]?.sql).not.toContain("oauth_accounts.email");
    expect(statements[0]?.sql).not.toContain("provider_user_id");
  });

  it("orders audit logs by timestamp and id with a cursor tuple", async () => {
    const { env, statements } = createCapturingEnv([
      {
        id: "audit-1",
        admin_user_id: "admin-1",
        admin_display_name: "Admin",
        target_user_id: "user-1",
        target_display_name: "Rice Player",
        method: "PATCH",
        action: "board.completions.update",
        created_at: "2026-07-02 00:00:00"
      }
    ]);

    const page = await listAdminAuditLogs(env, null);

    expect(page).toEqual({
      logs: [
        {
          id: "audit-1",
          adminUserId: "admin-1",
          adminDisplayName: "Admin",
          targetUserId: "user-1",
          targetDisplayName: "Rice Player",
          method: "PATCH",
          action: "board.completions.update",
          createdAt: "2026-07-02 00:00:00"
        }
      ],
      nextCursor: null
    });
    expect(statements[0]?.sql).toContain("ORDER BY audit.created_at DESC, audit.id DESC");
    expect(statements[0]?.sql).toContain("audit.created_at < ?1");
    expect(statements[0]?.sql).toContain("audit.id < ?2");
  });
});
