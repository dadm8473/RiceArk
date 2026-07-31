export type AdminSummary = {
  generatedAt: string;
  admin: {
    id: string;
    displayName: string;
  };
  users: {
    total: number;
    activeLoggedIn: number;
    activeSessions: number;
    created24h: number;
    created7d: number;
  };
  activity: {
    completionUsers24h: number;
    completionUsers7d: number;
    completionUpdates24h: number;
    completionUpdates7d: number;
  };
  data: {
    sheets: number;
    tables: number;
    axisItems: number;
    cellStates: number;
    boardCompletions: number;
    notes: number;
    shares: number;
    shareFavorites: number;
    characters: number;
    tasks: number;
  };
  freePlanReference: {
    d1RowsReadDaily: number;
    d1RowsWrittenDaily: number;
    workersRequestsDaily: number;
  };
  cloudflare: {
    status: "ok" | "partial" | "unconfigured" | "error";
    configured: boolean;
    checkedAt: string | null;
    cacheTtlSeconds: number;
    requiredSecrets: string[];
    warnings: string[];
    d1: {
      databaseName: string | null;
      databaseSizeBytes: number | null;
      storagePercent: number | null;
      rowsRead24h: number | null;
      rowsWritten24h: number | null;
      readQueries24h: number | null;
      writeQueries24h: number | null;
      rowsReadPercent: number | null;
      rowsWrittenPercent: number | null;
      numTables: number | null;
    } | null;
    workers: {
      scriptName: string;
      requests24h: number;
      errors24h: number;
      subrequests24h: number;
      requestPercent: number;
      cpuTimeP50Ms: number | null;
      cpuTimeP99Ms: number | null;
    } | null;
    capacity: {
      activeUsers24h: number;
      estimatedDauByD1Reads: number | null;
      estimatedDauByD1Writes: number | null;
      estimatedDauByWorkerRequests: number | null;
      bottleneck: string | null;
    };
  };
};

export type AdminHealthCheck = {
  status: "ok" | "error";
  latencyMs: number | null;
  errorCode: string | null;
};

export type AdminHealth = {
  generatedAt: string;
  checks: {
    api: { status: "ok" };
    d1: AdminHealthCheck;
    kv: AdminHealthCheck;
    lostark: {
      configured: boolean;
      lastSuccessAt: string | null;
      lastFailureAt: string | null;
      lastFailureCode: string | null;
      cacheAgeSeconds: number | null;
      cacheTtlSeconds: number;
    };
  };
  deployment: {
    environment: string;
    secrets: Array<{ name: string; configured: boolean }>;
  };
  errors: {
    totals: {
      today: number;
      last7d: number;
      clientErrorsToday: number;
      serverErrorsToday: number;
    };
    byCode: Array<{ code: string; statusClass: "4xx" | "5xx"; today: number; last7d: number }>;
    byRouteGroup: Array<{ routeGroup: string; today: number; last7d: number; serverErrors7d: number }>;
  };
};

export type AdminTab = "overview" | "usage" | "health" | "data" | "users" | "audit";
