import { Hono } from "hono";
import { getCloudflareUsage } from "../admin/cloudflareUsage";
import { cleanupErrorCounters } from "../admin/errorCounters";
import { buildAdminHealth } from "../admin/health";
import { requireAdmin } from "../auth/admin";
import type { Env } from "../env";

type UserMetricsRow = {
  total_users: number;
  active_logged_in_users: number;
  active_sessions: number;
  users_created_24h: number;
  users_created_7d: number;
  completion_users_24h: number;
  completion_users_7d: number;
  completion_updates_24h: number;
  completion_updates_7d: number;
};

type DataMetricsRow = {
  sheets: number;
  board_tables: number;
  board_axis_items: number;
  board_cell_states: number;
  board_cell_completions: number;
  board_notes: number;
  board_shares: number;
  board_share_favorites: number;
  characters: number;
  tasks: number;
};

export const adminRoutes = new Hono<{ Bindings: Env }>();

function value(row: Record<string, number> | null | undefined, key: string): number {
  return Number(row?.[key] ?? 0);
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

  return c.json(health);
});

adminRoutes.get("/admin/summary", async (c) => {
  const admin = await requireAdmin(c);
  const userMetrics = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users) AS total_users,
       (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE datetime(expires_at) > CURRENT_TIMESTAMP) AS active_logged_in_users,
       (SELECT COUNT(*) FROM sessions WHERE datetime(expires_at) > CURRENT_TIMESTAMP) AS active_sessions,
       (SELECT COUNT(*) FROM users WHERE datetime(created_at) >= datetime('now','-1 day')) AS users_created_24h,
       (SELECT COUNT(*) FROM users WHERE datetime(created_at) >= datetime('now','-7 days')) AS users_created_7d,
       (SELECT COUNT(DISTINCT user_id) FROM board_cell_completions WHERE datetime(updated_at) >= datetime('now','-1 day')) AS completion_users_24h,
       (SELECT COUNT(DISTINCT user_id) FROM board_cell_completions WHERE datetime(updated_at) >= datetime('now','-7 days')) AS completion_users_7d,
       (SELECT COUNT(*) FROM board_cell_completions WHERE datetime(updated_at) >= datetime('now','-1 day')) AS completion_updates_24h,
       (SELECT COUNT(*) FROM board_cell_completions WHERE datetime(updated_at) >= datetime('now','-7 days')) AS completion_updates_7d`
  ).first<UserMetricsRow>();
  const dataMetrics = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM sheets) AS sheets,
       (SELECT COUNT(*) FROM board_tables) AS board_tables,
       (SELECT COUNT(*) FROM board_axis_items) AS board_axis_items,
       (SELECT COUNT(*) FROM board_cell_states) AS board_cell_states,
       (SELECT COUNT(*) FROM board_cell_completions) AS board_cell_completions,
       (SELECT COUNT(*) FROM board_notes) AS board_notes,
       (SELECT COUNT(*) FROM board_shares) AS board_shares,
       (SELECT COUNT(*) FROM board_share_favorites) AS board_share_favorites,
       (SELECT COUNT(*) FROM characters) AS characters,
       (SELECT COUNT(*) FROM tasks) AS tasks`
  ).first<DataMetricsRow>();
  const completionUsers24h = value(userMetrics, "completion_users_24h");
  const cloudflare = await getCloudflareUsage(c.env, completionUsers24h);

  return c.json({
    generatedAt: new Date().toISOString(),
    admin: {
      id: admin.id,
      displayName: admin.displayName
    },
    users: {
      total: value(userMetrics, "total_users"),
      activeLoggedIn: value(userMetrics, "active_logged_in_users"),
      activeSessions: value(userMetrics, "active_sessions"),
      created24h: value(userMetrics, "users_created_24h"),
      created7d: value(userMetrics, "users_created_7d")
    },
    activity: {
      completionUsers24h,
      completionUsers7d: value(userMetrics, "completion_users_7d"),
      completionUpdates24h: value(userMetrics, "completion_updates_24h"),
      completionUpdates7d: value(userMetrics, "completion_updates_7d")
    },
    data: {
      sheets: value(dataMetrics, "sheets"),
      tables: value(dataMetrics, "board_tables"),
      axisItems: value(dataMetrics, "board_axis_items"),
      cellStates: value(dataMetrics, "board_cell_states"),
      boardCompletions: value(dataMetrics, "board_cell_completions"),
      notes: value(dataMetrics, "board_notes"),
      shares: value(dataMetrics, "board_shares"),
      shareFavorites: value(dataMetrics, "board_share_favorites"),
      characters: value(dataMetrics, "characters"),
      tasks: value(dataMetrics, "tasks")
    },
    freePlanReference: {
      d1RowsReadDaily: 5_000_000,
      d1RowsWrittenDaily: 100_000,
      workersRequestsDaily: 100_000
    },
    cloudflare
  });
});
