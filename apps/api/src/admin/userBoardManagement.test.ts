import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import {
  findAdminUserSummary,
  listAdminAuditLogs,
  listAdminUsers,
  recordAdminAuditLog
} from "./userBoardManagement";

type CapturedStatement = { sql: string; values: unknown[] };
type CapturedResult = Record<string, unknown> | Array<Record<string, unknown>> | null;

function createCapturingEnv(rows: CapturedResult[] = []): {
  env: Env;
  statements: CapturedStatement[];
} {
  const statements: CapturedStatement[] = [];
  let resultIndex = 0;
  const database = {
    prepare(sql: string) {
      const statement: CapturedStatement = { sql, values: [] };
      statements.push(statement);
      const result = () => {
        const next = rows[resultIndex++];
        return {
          results: next === null || next === undefined
            ? []
            : Array.isArray(next)
              ? next
              : [next]
        };
      };
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
          createdAt: "2026-07-01T00:00:00.000Z",
          recentActivityAt: "2026-07-02T00:00:00.000Z"
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
      createdAt: "2026-07-01T00:00:00.000Z",
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
          createdAt: "2026-07-02T00:00:00.000Z"
        }
      ],
      nextCursor: null
    });
    expect(statements[0]?.sql).toContain("ORDER BY audit.created_at DESC, audit.id DESC");
    expect(statements[0]?.sql).toContain("audit.created_at < ?1");
    expect(statements[0]?.sql).toContain("audit.id < ?2");
  });

  it("trims 31 users to 30 and decodes the returned cursor for page two", async () => {
    const firstPageRows = Array.from({ length: 31 }, (_, index) => {
      const day = String(31 - index).padStart(2, "0");
      return {
        id: `user-${day}`,
        display_name: `User ${day}`,
        provider: "discord",
        created_at: `2026-07-${day} 00:00:00`,
        recent_activity_at: null
      };
    });
    const { env, statements } = createCapturingEnv([
      firstPageRows,
      [firstPageRows[30] as Record<string, unknown>]
    ]);

    const firstPage = await listAdminUsers(env, { search: "", cursor: null });
    expect(firstPage.users).toHaveLength(30);
    expect(firstPage.users.at(-1)).toMatchObject({
      id: "user-02",
      createdAt: "2026-07-02T00:00:00.000Z"
    });
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await listAdminUsers(env, {
      search: "",
      cursor: firstPage.nextCursor
    });
    expect(statements[1]?.values).toEqual([
      "",
      "2026-07-02 00:00:00",
      "user-02"
    ]);
    expect(secondPage).toEqual({
      users: [
        {
          id: "user-01",
          displayName: "User 01",
          provider: "discord",
          createdAt: "2026-07-01T00:00:00.000Z",
          recentActivityAt: null
        }
      ],
      nextCursor: null
    });
  });

  it("normalizes SQLite UTC and offset ISO timestamps at the API boundary", async () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const { env } = createCapturingEnv([
        {
          id: "user-1",
          display_name: "Rice Player",
          provider: "google",
          created_at: "2026-07-01 12:00:00",
          recent_activity_at: "2026-07-02T03:00:00+09:00"
        },
        {
          id: "audit-1",
          admin_user_id: "admin-1",
          admin_display_name: "Admin",
          target_user_id: "user-1",
          target_display_name: "Rice Player",
          method: "PATCH",
          action: "board.completions.update",
          created_at: "2026-07-03 01:02:03"
        }
      ]);

      const users = await listAdminUsers(env, { search: "", cursor: null });
      const audit = await listAdminAuditLogs(env);

      expect(users.users[0]).toMatchObject({
        createdAt: "2026-07-01T12:00:00.000Z",
        recentActivityAt: "2026-07-01T18:00:00.000Z"
      });
      expect(audit.logs[0]?.createdAt).toBe("2026-07-03T01:02:03.000Z");
    } finally {
      if (previousTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTimezone;
      }
    }
  });
});
