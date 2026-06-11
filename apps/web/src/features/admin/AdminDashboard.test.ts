import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminDashboardContent, type AdminHealth, type AdminSummary, type AdminTab } from "./AdminDashboard";

const summary: AdminSummary = {
  generatedAt: "2026-06-10T07:34:00.000Z",
  admin: { id: "user-admin", displayName: "수빈" },
  users: {
    total: 8,
    activeLoggedIn: 7,
    activeSessions: 25,
    created24h: 0,
    created7d: 5
  },
  activity: {
    completionUsers24h: 2,
    completionUsers7d: 4,
    completionUpdates24h: 42,
    completionUpdates7d: 360
  },
  data: {
    sheets: 10,
    tables: 20,
    axisItems: 279,
    cellStates: 44,
    boardCompletions: 425,
    notes: 3,
    shares: 2,
    shareFavorites: 2,
    characters: 197,
    tasks: 119
  },
  freePlanReference: {
    d1RowsReadDaily: 5_000_000,
    d1RowsWrittenDaily: 100_000,
    workersRequestsDaily: 100_000
  },
  cloudflare: {
    status: "unconfigured",
    configured: false,
    checkedAt: null,
    cacheTtlSeconds: 300,
    requiredSecrets: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_D1_DATABASE_ID"],
    warnings: ["Cloudflare 사용량 조회에 필요한 서버 환경 변수가 아직 설정되지 않았습니다."],
    d1: null,
    workers: null,
    capacity: {
      activeUsers24h: 2,
      estimatedDauByD1Reads: null,
      estimatedDauByD1Writes: null,
      estimatedDauByWorkerRequests: null,
      bottleneck: null
    }
  }
};

const cloudflareSummary: AdminSummary = {
  ...summary,
  cloudflare: {
    status: "ok",
    configured: true,
    checkedAt: "2026-06-10T07:36:00.000Z",
    cacheTtlSeconds: 300,
    requiredSecrets: [],
    warnings: [],
    d1: {
      databaseName: "riceark",
      databaseSizeBytes: 995_328,
      storagePercent: 0.0185,
      rowsRead24h: 75_962,
      rowsWritten24h: 261,
      readQueries24h: 2507,
      writeQueries24h: 93,
      rowsReadPercent: 1.519,
      rowsWrittenPercent: 0.261,
      numTables: 22
    },
    workers: {
      scriptName: "riceark",
      requests24h: 200,
      errors24h: 2,
      subrequests24h: 94,
      requestPercent: 0.2,
      cpuTimeP50Ms: 4,
      cpuTimeP99Ms: 12
    },
    capacity: {
      activeUsers24h: 2,
      estimatedDauByD1Reads: 131,
      estimatedDauByD1Writes: 766,
      estimatedDauByWorkerRequests: 1000,
      bottleneck: "D1 rows read"
    }
  }
};

const health: AdminHealth = {
  generatedAt: "2026-06-10T07:34:00.000Z",
  checks: {
    api: { status: "ok" },
    d1: { status: "ok", latencyMs: 3, errorCode: null },
    kv: { status: "ok", latencyMs: 5, errorCode: null },
    lostark: {
      configured: true,
      lastSuccessAt: "2026-06-10T07:20:00.000Z",
      lastFailureAt: null,
      lastFailureCode: null,
      cacheAgeSeconds: 840,
      cacheTtlSeconds: 900
    }
  },
  deployment: {
    environment: "production",
    secrets: [
      { name: "LOSTARK_API_KEY", configured: true },
      { name: "CLOUDFLARE_API_TOKEN", configured: false },
      { name: "SESSION_SECRET", configured: true }
    ]
  },
  errors: {
    totals: { today: 7, last7d: 17, clientErrorsToday: 5, serverErrorsToday: 2 },
    byCode: [
      { code: "unauthorized", statusClass: "4xx", today: 5, last7d: 12 },
      { code: "internal_error", statusClass: "5xx", today: 2, last7d: 5 }
    ],
    byRouteGroup: [
      { routeGroup: "board", today: 7, last7d: 14, serverErrors7d: 2 },
      { routeGroup: "auth", today: 0, last7d: 3, serverErrors7d: 0 }
    ]
  }
};

function renderTab(tab: AdminTab, props?: { summary?: AdminSummary; health?: AdminHealth | null; healthError?: string | null }) {
  return renderToStaticMarkup(
    createElement(AdminDashboardContent, {
      summary: props?.summary ?? cloudflareSummary,
      health: props?.health === undefined ? health : props.health,
      healthError: props?.healthError ?? null,
      initialTab: tab
    })
  );
}

describe("AdminDashboardContent", () => {
  it("renders the tab bar and header on every tab", () => {
    const html = renderTab("overview");

    expect(html).toContain("운영 현황");
    expect(html).toContain("개요");
    expect(html).toContain("사용량·비용");
    expect(html).toContain("헬스·에러");
    expect(html).toContain("데이터");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
  });

  it("shows the status strip, core metrics and compact usage bars on the overview tab", () => {
    const html = renderTab("overview");

    expect(html).toContain("서비스 정상");
    expect(html).toContain("로아 캐시 정상");
    expect(html).toContain("한도 안정");
    expect(html).toContain("오늘 오류 7건");
    expect(html).toContain("5xx 2건");
    expect(html).toContain("핵심 지표");
    expect(html).toContain("전체 가입");
    expect(html).toContain("로그인 유지");
    expect(html).toContain("최근 24시간 체크 유저");
    expect(html).toContain("최근 24시간 체크 변경");
    expect(html).toContain("무료 한도 사용률");
    expect(html).toContain("D1 rows read");
    expect(html).toContain("1.5%");
    // 상세 표는 사용량 탭 전용이므로 개요에는 없어야 한다.
    expect(html).not.toContain("최근 24시간 사용량");
  });

  it("marks the overview status strip as degraded when health is unavailable", () => {
    const html = renderTab("overview", { health: null });

    expect(html).toContain("서비스 확인 불가");
    expect(html).toContain("오류 확인 불가");
  });

  it("shows the Cloudflare detail table and capacity on the usage tab", () => {
    const html = renderTab("usage");

    expect(html).toContain("Cloudflare 사용량");
    expect(html).toContain("최근 24시간 사용량");
    expect(html).toContain("75,962");
    expect(html).toContain("5,000,000 / day");
    expect(html).toContain("안정");
    expect(html).toContain("Workers 요청");
    expect(html).toContain("상세 지표");
    expect(html).toContain("Workers CPU (P50 / P99)");
    expect(html).toContain("12 ms");
    expect(html).toContain("예상 DAU 여유");
    expect(html).toContain("131명");
    expect(html).toContain("병목 D1 rows read");
    expect(html).toContain("무료 한도 참고");
  });

  it("shows setup guidance on the usage tab when Cloudflare metrics are not configured", () => {
    const html = renderTab("usage", { summary });

    expect(html).toContain("미설정");
    expect(html).toContain("CLOUDFLARE_API_TOKEN");
    expect(html).toContain("CLOUDFLARE_D1_DATABASE_ID");
  });

  it("shows health checks, cache status, error aggregates and secret booleans on the health tab", () => {
    const html = renderTab("health");

    expect(html).toContain("서비스 헬스");
    expect(html).toContain("D1 데이터베이스");
    expect(html).toContain("3 ms");
    expect(html).toContain("KV 캐시");
    expect(html).toContain("로스트아크 API");
    expect(html).toContain("로스트아크 캘린더 캐시");
    expect(html).toContain("14분 전 갱신");
    expect(html).toContain("에러 집계");
    expect(html).toContain("오늘 오류");
    expect(html).toContain("최근 7일 오류");
    expect(html).toContain("unauthorized");
    expect(html).toContain("internal_error");
    expect(html).toContain("오류 코드별");
    expect(html).toContain("기능 영역별");
    expect(html).toContain("배포 · 환경");
    expect(html).toContain("LOSTARK_API_KEY");
    expect(html).toContain("설정됨");
    expect(html).toContain("미설정");
  });

  it("shows a notice on the health tab when health data is unavailable", () => {
    const html = renderTab("health", { health: null, healthError: "로그인이 필요합니다." });

    expect(html).toContain("헬스 정보를 불러오지 못했습니다");
    expect(html).toContain("로그인이 필요합니다.");
  });

  it("shows user flow, check usage and data scale tables on the data tab", () => {
    const html = renderTab("data");

    expect(html).toContain("유저 흐름");
    expect(html).toContain("최근 7일 신규 가입");
    expect(html).toContain("체크 사용량");
    expect(html).toContain("1일 평균");
    expect(html).toContain("데이터 규모");
    expect(html).toContain("표 20개");
    expect(html).toContain("캐릭터 197개");
    expect(html).toContain("공유 2개");
  });

  it("never exposes provider ids, secret values or raw provider fields on any tab", () => {
    const tabs: AdminTab[] = ["overview", "usage", "health", "data"];
    for (const tab of tabs) {
      const html = renderTab(tab);
      expect(html).not.toContain("326685778656755713");
      expect(html).not.toContain("provider");
      expect(html).not.toContain("Bearer");
    }
  });
});
