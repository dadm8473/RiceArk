import type { Env } from "../env";

const ROUTE_GROUPS: Record<string, string> = {
  auth: "auth",
  session: "auth",
  board: "board",
  "shared-rice-bins": "board",
  dashboard: "dashboard",
  completions: "dashboard",
  characters: "characters",
  tasks: "tasks",
  settings: "settings",
  lostark: "lostark",
  admin: "admin",
  health: "health"
};

export type AdminErrorCounterRow = {
  day: string;
  status: number;
  code: string;
  route_group: string;
  count: number;
};

export type AdminErrorSummary = {
  totals: {
    today: number;
    last7d: number;
    clientErrorsToday: number;
    serverErrorsToday: number;
  };
  byCode: Array<{ code: string; statusClass: "4xx" | "5xx"; today: number; last7d: number }>;
  byRouteGroup: Array<{ routeGroup: string; today: number; last7d: number; serverErrors7d: number }>;
};

export function classifyRouteGroup(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const first = segments[0] === "api" ? segments[1] : segments[0];
  if (!first) return "other";
  return ROUTE_GROUPS[first] ?? "other";
}

export function shouldRecordApiError(input: { status: number; code: string; path: string }): boolean {
  return input.status >= 400 && !(input.status === 401 && input.code === "unauthorized" && input.path === "/api/session");
}

export async function recordApiError(
  env: Env,
  input: { status: number; code: string; path: string }
): Promise<void> {
  if (!shouldRecordApiError(input) || !env.DB) return;
  await env.DB.prepare(
    `INSERT INTO admin_error_counters (day, status, code, route_group, count)
     VALUES (date('now'), ?1, ?2, ?3, 1)
     ON CONFLICT (day, status, code, route_group)
     DO UPDATE SET count = count + 1, updated_at = CURRENT_TIMESTAMP`
  )
    .bind(input.status, input.code, classifyRouteGroup(input.path))
    .run();
}

export async function readErrorCounters(env: Env): Promise<AdminErrorCounterRow[]> {
  const result = await env.DB.prepare(
    `SELECT day, status, code, route_group, count
     FROM admin_error_counters
     WHERE day >= date('now','-7 days')`
  ).all<AdminErrorCounterRow>();
  return result.results ?? [];
}

export function summarizeErrorCounters(rows: AdminErrorCounterRow[], todayKey: string): AdminErrorSummary {
  const totals = { today: 0, last7d: 0, clientErrorsToday: 0, serverErrorsToday: 0 };
  const byCode = new Map<string, { code: string; statusClass: "4xx" | "5xx"; today: number; last7d: number }>();
  const byRouteGroup = new Map<string, { routeGroup: string; today: number; last7d: number; serverErrors7d: number }>();

  for (const row of rows) {
    const count = Number(row.count) || 0;
    const isToday = row.day === todayKey;
    const isServerError = row.status >= 500;
    totals.last7d += count;
    if (isToday) {
      totals.today += count;
      if (isServerError) totals.serverErrorsToday += count;
      else totals.clientErrorsToday += count;
    }

    const codeKey = `${row.code}:${isServerError ? "5xx" : "4xx"}`;
    const codeEntry = byCode.get(codeKey) ?? {
      code: row.code,
      statusClass: isServerError ? ("5xx" as const) : ("4xx" as const),
      today: 0,
      last7d: 0
    };
    codeEntry.last7d += count;
    if (isToday) codeEntry.today += count;
    byCode.set(codeKey, codeEntry);

    const groupEntry = byRouteGroup.get(row.route_group) ?? {
      routeGroup: row.route_group,
      today: 0,
      last7d: 0,
      serverErrors7d: 0
    };
    groupEntry.last7d += count;
    if (isToday) groupEntry.today += count;
    if (isServerError) groupEntry.serverErrors7d += count;
    byRouteGroup.set(row.route_group, groupEntry);
  }

  return {
    totals,
    byCode: [...byCode.values()].sort((a, b) => b.last7d - a.last7d),
    byRouteGroup: [...byRouteGroup.values()].sort((a, b) => b.last7d - a.last7d)
  };
}

export async function cleanupErrorCounters(env: Env): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare(`DELETE FROM admin_error_counters WHERE day < date('now','-14 days')`).run();
}

export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
