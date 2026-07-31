import { describe, expect, it } from "vitest";
import { ADMIN_TARGET_USER_HEADER, getAdminAuditAction, requireUserAccess, type AppContext } from "./userAccess";
import type { Env } from "../env";

type ContextOptions = {
  admin?: boolean;
  headers?: Record<string, string>;
};

function context(options: ContextOptions = {}): AppContext {
  const values = new Map<string, unknown>();
  const headers = new Headers({
    Cookie: "riceark_session=admin-session",
    ...options.headers
  });
  const actor = { id: "admin-1", display_name: "Admin", avatar_url: null };
  const subject = { id: "user-2", display_name: "User", avatar_url: null };
  let targetReads = 0;
  let adminReads = 0;
  const db = {
    prepare(sql: string) {
      const statement = {
        bind: () => statement,
        first: async () => {
          if (sql.includes("FROM sessions")) return actor;
          if (sql.includes("FROM users")) {
            targetReads += 1;
            return subject;
          }
          return null;
        },
        all: async () => {
          if (sql.includes("FROM oauth_accounts")) {
            adminReads += 1;
            return {
              results: options.admin === false ? [] : [{ provider: "discord", provider_user_id: "admin-provider" }]
            };
          }
          return { results: [] };
        }
      };
      return statement;
    }
  } as unknown as D1Database;
  const c = {
    env: {
      DB: db,
      SESSION_SECRET: "test-secret",
      ADMIN_OAUTH_ALLOWLIST: "discord:admin-provider"
    } as Env,
    req: { header: (name: string) => headers.get(name) },
    set: (key: string, value: unknown) => values.set(key, value),
    get: (key: string) => values.get(key)
  } as unknown as AppContext;

  Object.assign(c, {
    targetReads: () => targetReads,
    adminReads: () => adminReads
  });
  return c;
}

function nonAdminContext(headers: Record<string, string>): AppContext {
  return context({ admin: false, headers });
}

describe("requireUserAccess", () => {
  it("keeps actor and subject equal without a target header", async () => {
    const c = context();
    const access = await requireUserAccess(c, { allowAdminTarget: true });

    expect(access).toMatchObject({
      actor: { id: "admin-1" },
      subject: { id: "admin-1" },
      targeted: false
    });
    expect((c as unknown as { adminReads: () => number }).adminReads()).toBe(0);
  });

  it("resolves an existing target only for an allowlisted actor", async () => {
    const c = context({ headers: { [ADMIN_TARGET_USER_HEADER]: "user-2" } });
    const access = await requireUserAccess(c, { allowAdminTarget: true });

    expect(access).toMatchObject({
      actor: { id: "admin-1" },
      subject: { id: "user-2" },
      targeted: true
    });
    expect(c.get("adminTargetAccess")).toEqual(access);
  });

  it("rejects targeting before disclosing whether the subject exists", async () => {
    const c = nonAdminContext({ [ADMIN_TARGET_USER_HEADER]: "missing" });

    await expect(requireUserAccess(c, { allowAdminTarget: true })).rejects.toMatchObject({
      status: 403,
      code: "forbidden"
    });
    expect((c as unknown as { targetReads: () => number }).targetReads()).toBe(0);
  });

  it("rejects the target header on a route that did not opt in", async () => {
    await expect(
      requireUserAccess(context({ headers: { [ADMIN_TARGET_USER_HEADER]: "user-2" } }), {
        allowAdminTarget: false
      })
    ).rejects.toMatchObject({ status: 403, code: "admin_target_not_allowed" });
  });
});

describe("getAdminAuditAction", () => {
  it("maps table character import and manual mutations", () => {
    expect([
      getAdminAuditAction("POST", "/api/board/tables/table-1/characters/import"),
      getAdminAuditAction("POST", "/api/board/tables/table-1/characters/manual")
    ]).toEqual(["board.update", "board.update"]);
  });

  it("maps direct table settings mutations and excludes the obsolete settings path", () => {
    expect([
      getAdminAuditAction("PATCH", "/api/board/tables/table-1"),
      getAdminAuditAction("PATCH", "/api/board/tables/table-1/settings")
    ]).toEqual(["board.update", null]);
  });

  it("maps only supported user-owned mutations", () => {
    expect([
      getAdminAuditAction("PATCH", "/api/board/completions"),
      getAdminAuditAction("PATCH", "/api/board/cell-states"),
      getAdminAuditAction("POST", "/api/board/tables/table-1/transpose"),
      getAdminAuditAction("POST", "/api/characters/user-2/refresh"),
      getAdminAuditAction("PATCH", "/api/characters/user-2"),
      getAdminAuditAction("DELETE", "/api/tasks/task-1"),
      getAdminAuditAction("PATCH", "/api/settings"),
      getAdminAuditAction("GET", "/api/board/bootstrap"),
      getAdminAuditAction("POST", "/api/board/share-favorites"),
      getAdminAuditAction("POST", "/api/patch-notes"),
      getAdminAuditAction("POST", "/api/admin/health"),
      getAdminAuditAction("POST", "/api/lostark/events/today")
    ]).toEqual([
      "board.completions.update",
      "board.cell_states.update",
      "board.update",
      "characters.refresh",
      "characters.update",
      "tasks.update",
      "settings.update",
      null,
      null,
      null,
      null,
      null
    ]);
  });
});
