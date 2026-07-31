import { zValidator } from "@hono/zod-validator";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { cleanupErrorCounters } from "../admin/errorCounters";
import { buildAdminHealth } from "../admin/health";
import { getAdminSummaryMetrics } from "../admin/summary";
import { findAdminUserSummary, listAdminAuditLogs, listAdminUsers } from "../admin/userBoardManagement";
import { requireAdmin } from "../auth/admin";
import type { Env } from "../env";
import { ApiError } from "../http/errors";

export const adminRoutes = new Hono<{ Bindings: Env }>();

export const adminUsersQuerySchema = z.object({
  search: z.string().trim().max(80).default(""),
  cursor: z.string().max(512).optional(),
  selectedUserId: z.string().uuid().optional()
});

export const adminAuditQuerySchema = z.object({
  cursor: z.string().max(512).optional()
});

const requirePrivateAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await requireAdmin(c);
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie");
  await next();
};

async function withValidAdminCursor<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid administrator pagination cursor") {
      throw new ApiError(400, "invalid_cursor", "Invalid administrator pagination cursor");
    }
    throw error;
  }
}

adminRoutes.get("/admin/health", async (c) => {
  await requireAdmin(c);
  const health = await buildAdminHealth(c.env);

  const cleanup = cleanupErrorCounters(c.env).catch(() => undefined);
  try {
    c.executionCtx.waitUntil(cleanup);
  } catch {
    // Test environments have no execution context; cleanup stays fire-and-forget.
  }

  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie");
  return c.json(health);
});

adminRoutes.get("/admin/summary", async (c) => {
  const admin = await requireAdmin(c);
  const metrics = await getAdminSummaryMetrics(c.env);

  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie");
  return c.json({
    admin: {
      id: admin.id,
      displayName: admin.displayName
    },
    ...metrics
  });
});

adminRoutes.get("/admin/users", requirePrivateAdmin, zValidator("query", adminUsersQuerySchema), async (c) => {
  const { search, cursor, selectedUserId } = c.req.valid("query");
  const [page, selectedUser] = await withValidAdminCursor(() =>
    Promise.all([
      listAdminUsers(c.env, { search, cursor: cursor ?? null }),
      selectedUserId ? findAdminUserSummary(c.env, selectedUserId) : Promise.resolve(null)
    ])
  );

  return c.json({ ...page, selectedUser });
});

adminRoutes.get("/admin/audit-logs", requirePrivateAdmin, zValidator("query", adminAuditQuerySchema), async (c) => {
  const { cursor } = c.req.valid("query");
  return c.json(await withValidAdminCursor(() => listAdminAuditLogs(c.env, cursor ?? null)));
});
