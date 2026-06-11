import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import {
  classifyRouteGroup,
  cleanupErrorCounters,
  recordApiError,
  summarizeErrorCounters,
  utcDayKey
} from "./errorCounters";

type CapturedStatement = { sql: string; binds: unknown[] };

function createCapturingDb(captured: CapturedStatement[]): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        bind: (...binds: unknown[]) => ({
          run: async () => {
            captured.push({ sql, binds });
            return { success: true };
          }
        }),
        run: async () => {
          captured.push({ sql, binds: [] });
          return { success: true };
        }
      };
      return statement;
    }
  } as unknown as D1Database;
}

describe("classifyRouteGroup", () => {
  it("maps known route families to stable groups", () => {
    expect(classifyRouteGroup("/api/auth/google/start")).toBe("auth");
    expect(classifyRouteGroup("/api/session")).toBe("auth");
    expect(classifyRouteGroup("/api/board/sheets/abc-123")).toBe("board");
    expect(classifyRouteGroup("/api/shared-rice-bins/xyz")).toBe("board");
    expect(classifyRouteGroup("/api/dashboard")).toBe("dashboard");
    expect(classifyRouteGroup("/api/completions/toggle")).toBe("dashboard");
    expect(classifyRouteGroup("/api/characters/refresh")).toBe("characters");
    expect(classifyRouteGroup("/api/tasks/task-1")).toBe("tasks");
    expect(classifyRouteGroup("/api/settings")).toBe("settings");
    expect(classifyRouteGroup("/api/lostark/events/today")).toBe("lostark");
    expect(classifyRouteGroup("/api/admin/summary")).toBe("admin");
    expect(classifyRouteGroup("/api/health")).toBe("health");
  });

  it("collapses unknown paths to other without keeping the raw path", () => {
    expect(classifyRouteGroup("/api/wp-admin/setup.php?token=secret")).toBe("other");
    expect(classifyRouteGroup("/api/")).toBe("other");
    expect(classifyRouteGroup("")).toBe("other");
  });
});

describe("recordApiError", () => {
  it("upserts one counter row keyed by day, status, code and route group", async () => {
    const captured: CapturedStatement[] = [];
    const env = { DB: createCapturingDb(captured) } as unknown as Env;

    await recordApiError(env, { status: 401, code: "unauthorized", path: "/api/board/sheets/abc" });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toContain("INSERT INTO admin_error_counters");
    expect(captured[0]?.sql).toContain("ON CONFLICT (day, status, code, route_group)");
    expect(captured[0]?.sql).toContain("count = count + 1");
    expect(captured[0]?.binds).toEqual([401, "unauthorized", "board"]);
  });

  it("never stores the request path itself", async () => {
    const captured: CapturedStatement[] = [];
    const env = { DB: createCapturingDb(captured) } as unknown as Env;

    await recordApiError(env, { status: 500, code: "internal_error", path: "/api/board/sheets/user-private-id" });

    expect(JSON.stringify(captured[0]?.binds)).not.toContain("user-private-id");
    expect(JSON.stringify(captured[0]?.binds)).not.toContain("/api");
  });

  it("ignores non-error statuses", async () => {
    const captured: CapturedStatement[] = [];
    const env = { DB: createCapturingDb(captured) } as unknown as Env;

    await recordApiError(env, { status: 302, code: "redirect", path: "/api/auth/google/start" });

    expect(captured).toHaveLength(0);
  });

  it("does not throw when the DB binding is missing", async () => {
    const env = {} as unknown as Env;

    await expect(recordApiError(env, { status: 500, code: "internal_error", path: "/api/board" })).resolves.toBeUndefined();
  });
});

describe("cleanupErrorCounters", () => {
  it("deletes rows older than 14 days and tolerates a missing DB", async () => {
    const captured: CapturedStatement[] = [];
    const env = { DB: createCapturingDb(captured) } as unknown as Env;

    await cleanupErrorCounters(env);
    await expect(cleanupErrorCounters({} as unknown as Env)).resolves.toBeUndefined();

    expect(captured[0]?.sql).toContain("DELETE FROM admin_error_counters");
    expect(captured[0]?.sql).toContain("-14 days");
  });
});

describe("summarizeErrorCounters", () => {
  const today = "2026-06-11";
  const rows = [
    { day: "2026-06-11", status: 401, code: "unauthorized", route_group: "board", count: 5 },
    { day: "2026-06-11", status: 500, code: "internal_error", route_group: "board", count: 2 },
    { day: "2026-06-10", status: 401, code: "unauthorized", route_group: "auth", count: 7 },
    { day: "2026-06-08", status: 502, code: "lostark_api_error", route_group: "lostark", count: 3 }
  ];

  it("aggregates totals for today and the last 7 days", () => {
    const summary = summarizeErrorCounters(rows, today);

    expect(summary.totals).toEqual({
      today: 7,
      last7d: 17,
      clientErrorsToday: 5,
      serverErrorsToday: 2
    });
  });

  it("groups by code with a status class and by route group", () => {
    const summary = summarizeErrorCounters(rows, today);

    expect(summary.byCode).toEqual([
      { code: "unauthorized", statusClass: "4xx", today: 5, last7d: 12 },
      { code: "lostark_api_error", statusClass: "5xx", today: 0, last7d: 3 },
      { code: "internal_error", statusClass: "5xx", today: 2, last7d: 2 }
    ]);
    expect(summary.byRouteGroup).toEqual([
      { routeGroup: "board", today: 7, last7d: 7, serverErrors7d: 2 },
      { routeGroup: "auth", today: 0, last7d: 7, serverErrors7d: 0 },
      { routeGroup: "lostark", today: 0, last7d: 3, serverErrors7d: 3 }
    ]);
  });

  it("returns empty aggregates for no rows", () => {
    const summary = summarizeErrorCounters([], today);

    expect(summary.totals).toEqual({ today: 0, last7d: 0, clientErrorsToday: 0, serverErrorsToday: 0 });
    expect(summary.byCode).toEqual([]);
    expect(summary.byRouteGroup).toEqual([]);
  });
});

describe("utcDayKey", () => {
  it("formats a date as a UTC YYYY-MM-DD key", () => {
    expect(utcDayKey(new Date("2026-06-11T23:59:59.000Z"))).toBe("2026-06-11");
    expect(utcDayKey(new Date("2026-06-11T00:00:00.000Z"))).toBe("2026-06-11");
  });
});
