import { Hono } from "hono";
import { cleanupErrorCounters } from "../admin/errorCounters";
import { buildAdminHealth } from "../admin/health";
import { getAdminSummaryMetrics } from "../admin/summary";
import { requireAdmin } from "../auth/admin";
import type { Env } from "../env";

export const adminRoutes = new Hono<{ Bindings: Env }>();

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
    generatedAt: new Date().toISOString(),
    admin: {
      id: admin.id,
      displayName: admin.displayName
    },
    ...metrics
  });
});
