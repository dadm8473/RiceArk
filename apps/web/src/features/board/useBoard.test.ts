import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { ApiClientError } from "../../api/client";
import {
  BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS,
  BOARD_VERSION_IDLE_CHECK_INTERVAL_MS,
  BOARD_WRITE_INVALIDATION_COALESCE_MS,
  BOARD_RECOVERY_READ_TIMEOUT_MS,
  buildLocalBoardPeriodFingerprint,
  buildBoardVersionKey,
  canClaimBoardPollingLeadership,
  createBoardDataApi,
  createBoardReadGate,
  createBoardRecoveryReadOwner,
  createBoardSession,
  createBoardVersionTracker,
  createBoardWriteCoordinator,
  formatBoardError,
  getBoardPollingChannelName,
  getBoardPollingDelayMs,
  getBoardPollingStorageKey,
  getNextBoardPeriodBoundaryMs,
  mergeBoardVersionSummary,
  parseBoardPollingMessage,
  parseBoardPollingLeaderRecord,
  reportBoardReloadErrorIfCurrent
} from "./useBoard";
import type { BoardPollingRuntime } from "./useBoard";
import type { BoardDataApi } from "./boardDataController";
import type {
  BoardBootstrapPayload,
  BoardDisplaySettings,
  BoardPayload,
  BoardSheetManifestItem,
  BoardSheetPayload,
  BoardVersionSummary
} from "./types";

const emptyBoard: BoardPayload = {
  userId: "user-1",
  settings: {
    show_display_name: 1,
    show_server_name: 0,
    show_class_name: 0,
    show_item_level: 1,
    show_combat_power: 0
  },
  sheets: [],
  tables: [],
  notes: [],
  axisItems: [],
  cellStates: [],
  completions: []
};

const boardSettings: BoardDisplaySettings = emptyBoard.settings;

function manifestSheet(
  id: string,
  version = 1,
  options: Partial<BoardSheetManifestItem> = {}
): BoardSheetManifestItem {
  return {
    id,
    name: options.name ?? id,
    sort_order: options.sort_order ?? 0,
    is_default: options.is_default ?? 0,
    version,
    ...options
  };
}

function sheetPayload(
  id: string,
  version = 1,
  options: Partial<BoardSheetPayload> = {}
): BoardSheetPayload {
  return {
    sheet: {
      id,
      name: options.sheet?.name ?? id,
      sort_order: options.sheet?.sort_order ?? 0,
      is_default: options.sheet?.is_default ?? 0,
      content_version: version
    },
    tables: [],
    notes: [],
    axisItems: [],
    cellStates: [],
    completions: [],
    periodFingerprint: "",
    ...options
  };
}

function bootstrapPayload(
  activeSheet: BoardSheetPayload,
  sheets: BoardSheetManifestItem[],
  userId = "user-1"
): BoardBootstrapPayload {
  const activeManifest = sheets.find((sheet) => sheet.id === activeSheet.sheet.id);
  return {
    userId,
    settings: boardSettings,
    manifest: { version: Math.max(0, ...sheets.map((sheet) => sheet.version)), sheets },
    activeSheet: activeManifest
      ? {
          ...activeSheet,
          sheet: {
            id: activeManifest.id,
            name: activeManifest.name,
            sort_order: activeManifest.sort_order,
            is_default: activeManifest.is_default,
            content_version: activeManifest.version
          }
        }
      : activeSheet
  };
}

function versionSummary(
  sheets: BoardSheetManifestItem[],
  manifestVersion = Math.max(0, ...sheets.map((sheet) => sheet.version))
): BoardVersionSummary {
  return { manifestVersion, sheets, periodFingerprint: "", settings: boardSettings };
}

type FakePollingEvent = "focus" | "visibilitychange" | "activity";

function createFakeBoardPollingRuntime(options: {
  nowMs?: number;
  visible?: boolean;
  storageValues?: Map<string, string>;
} = {}) {
  let nowMs = options.nowMs ?? 0;
  let visible = options.visible ?? true;
  let nextTimerId = 0;
  const timers = new Map<number, {
    callback: () => void;
    delayMs: number;
    dueAt: number;
  }>();
  const listeners = new Map<FakePollingEvent, Set<() => void>>();
  const storageValues = options.storageValues ?? new Map<string, string>();
  const posted: unknown[] = [];
  const channelNames: string[] = [];
  let channelMessageHandler: ((message: unknown) => void) | null = null;
  let closedChannels = 0;

  const runtime: BoardPollingRuntime = {
    nowMs: () => nowMs,
    isVisible: () => visible,
    storage: {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageValues.set(key, value);
      },
      removeItem: (key: string) => {
        storageValues.delete(key);
      }
    },
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = ++nextTimerId;
      timers.set(id, { callback, delayMs, dueAt: nowMs + delayMs });
      return id;
    },
    clearTimeout: (timer: unknown) => {
      if (typeof timer === "number") timers.delete(timer);
    },
    addEventListener: (event: FakePollingEvent, callback: () => void) => {
      const callbacks = listeners.get(event) ?? new Set<() => void>();
      callbacks.add(callback);
      listeners.set(event, callbacks);
      return () => callbacks.delete(callback);
    },
    openChannel: (name: string, onMessage: (message: unknown) => void) => {
      channelNames.push(name);
      channelMessageHandler = onMessage;
      let closed = false;
      return {
        postMessage: (message: unknown) => posted.push(message),
        close: () => {
          if (closed) return;
          closed = true;
          closedChannels += 1;
          if (channelMessageHandler === onMessage) channelMessageHandler = null;
        }
      };
    }
  };

  const flushAsyncWork = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };

  return {
    runtime,
    posted,
    channelNames,
    storageValues,
    nowMs: () => nowMs,
    get closedChannels() {
      return closedChannels;
    },
    pendingDelays: () => [...timers.values()].map((timer) => timer.delayMs).sort((a, b) => a - b),
    pendingDueAt: (delayMs: number) =>
      [...timers.values()].find((timer) => timer.delayMs === delayMs)?.dueAt,
    listenerCount: () => [...listeners.values()].reduce((total, callbacks) => total + callbacks.size, 0),
    setVisible: (next: boolean) => {
      visible = next;
    },
    setNow: (next: number) => {
      nowMs = next;
    },
    emit: async (event: FakePollingEvent) => {
      for (const callback of [...(listeners.get(event) ?? [])]) callback();
      await flushAsyncWork();
    },
    receive: async (message: unknown) => {
      channelMessageHandler?.(message);
      await flushAsyncWork();
    },
    fireTimer: async (delayMs: number, preserveNow = false) => {
      const match = [...timers].find(([, timer]) => timer.delayMs === delayMs);
      if (!match) throw new Error(`No timer scheduled for ${delayMs}ms; pending: ${[...timers.values()].map((timer) => timer.delayMs).join(", ")}`);
      const [id, timer] = match;
      timers.delete(id);
      if (!preserveNow) nowMs = Math.max(nowMs, timer.dueAt);
      timer.callback();
      await flushAsyncWork();
    }
  };
}

expectTypeOf<BoardPayload["settings"]>().toEqualTypeOf<BoardDisplaySettings>();

describe("board data API", () => {
  it("uses encoded bootstrap and sheet URLs plus the v2 versions endpoint", async () => {
    const calls: string[] = [];
    const get = vi.fn(async (url: string) => {
      calls.push(url);
      return {};
    });
    const api = createBoardDataApi(get);

    await api.getBootstrap();
    await api.getBootstrap("sheet /?한글");
    await api.getSheet("sheet /?한글");
    await api.getVersions();

    expect(calls).toEqual([
      "/api/board/bootstrap",
      "/api/board/bootstrap?sheetId=sheet%20%2F%3F%ED%95%9C%EA%B8%80",
      "/api/board/sheets/sheet%20%2F%3F%ED%95%9C%EA%B8%80",
      "/api/board/versions"
    ]);
  });
});

describe("sheet-aware board session", () => {
  it("bootstraps the requested sheet once without an immediate versions request", async () => {
    const requestedId = "sheet /?한글";
    const active = sheetPayload(requestedId, 3, {
      sheet: {
        id: requestedId,
        name: "요청 시트",
        sort_order: 2,
        is_default: 0,
        content_version: 3
      },
      notes: [{
        id: "note-1",
        sheet_id: requestedId,
        title: "memo",
        body: "body",
        color: "yellow",
        sort_order: 0,
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        locked: 0
      }]
    });
    const manifest = [
      manifestSheet("sheet-1", 1, { is_default: 1 }),
      manifestSheet(requestedId, 3, { name: "요청 시트", sort_order: 2 })
    ];
    const calls: string[] = [];
    const api = createBoardDataApi(async (url) => {
      calls.push(url);
      if (url.startsWith("/api/board/bootstrap")) return bootstrapPayload(active, manifest);
      throw new Error(`Unexpected GET ${url}`);
    });
    const session = createBoardSession({ userId: "user-1", api, runtime: null });

    await session.configure({ enabled: true, pollingEnabled: true, requestedSheetId: requestedId });

    expect(calls).toEqual([
      "/api/board/bootstrap?sheetId=sheet%20%2F%3F%ED%95%9C%EA%B8%80"
    ]);
    expect(session.snapshot()).toMatchObject({
      activeSheetId: requestedId,
      loading: false,
      error: null,
      data: {
        userId: "user-1",
        settings: boardSettings,
        sheets: manifest,
        notes: [expect.objectContaining({ id: "note-1" })]
      }
    });
    session.dispose();
  });

  it("uses one GET for an uncached sheet, zero for cached return, and one versions GET for no-change reload", async () => {
    const sheet1 = manifestSheet("sheet-1", 1, { is_default: 1 });
    const sheet2 = manifestSheet("sheet-2", 1, { sort_order: 1 });
    const calls: string[] = [];
    const api: BoardDataApi = {
      getBootstrap: async (requestedId) => {
        calls.push(`bootstrap:${requestedId ?? ""}`);
        return bootstrapPayload(sheetPayload("sheet-1", 1, { sheet: { ...sheet1, content_version: 1 } }), [sheet1, sheet2]);
      },
      getSheet: async (sheetId) => {
        calls.push(`sheet:${sheetId}`);
        const item = sheetId === "sheet-1" ? sheet1 : sheet2;
        return sheetPayload(sheetId, item.version, { sheet: { ...item, content_version: item.version } });
      },
      getVersions: async () => {
        calls.push("versions");
        return versionSummary([sheet1, sheet2]);
      }
    };
    const session = createBoardSession({ userId: "user-1", api, runtime: null });

    await session.configure({ enabled: true, pollingEnabled: false, requestedSheetId: null });
    await session.selectSheet("sheet-2");
    await session.selectSheet("sheet-1");
    await session.reload();

    expect(calls).toEqual(["bootstrap:", "sheet:sheet-2", "versions"]);
    expect(session.snapshot().activeSheetId).toBe("sheet-1");
    session.dispose();
  });

  it("reconciles requested, null-history, and invalid routes without replaying replacement effects", async () => {
    const sheet1 = manifestSheet("sheet-1", 1, { is_default: 1 });
    const sheet2 = manifestSheet("sheet-2", 1, { sort_order: 1 });
    let remoteManifest = [sheet1, sheet2];
    const replacements: Array<string | null> = [];
    const calls: string[] = [];
    const api: BoardDataApi = {
      getBootstrap: async (requestedId) => {
        calls.push(`bootstrap:${requestedId ?? ""}`);
        const selected = remoteManifest.find((sheet) => sheet.id === requestedId) ?? sheet1;
        return bootstrapPayload(
          sheetPayload(selected.id, selected.version, {
            sheet: { ...selected, content_version: selected.version }
          }),
          remoteManifest
        );
      },
      getSheet: async (sheetId) => {
        calls.push(`sheet:${sheetId}`);
        const item = remoteManifest.find((sheet) => sheet.id === sheetId)!;
        return sheetPayload(sheetId, item.version, { sheet: { ...item, content_version: item.version } });
      },
      getVersions: async () => {
        calls.push("versions");
        return versionSummary(remoteManifest, 2);
      }
    };
    const session = createBoardSession({ userId: "user-1", api, runtime: null });

    await session.configure({
      enabled: true,
      pollingEnabled: false,
      requestedSheetId: "missing",
      onReplaceSheetId: (sheetId) => replacements.push(sheetId)
    });
    await session.configure({
      enabled: true,
      pollingEnabled: false,
      requestedSheetId: "missing",
      onReplaceSheetId: (sheetId) => replacements.push(sheetId)
    });
    await session.configure({
      enabled: true,
      pollingEnabled: false,
      requestedSheetId: "sheet-2",
      onReplaceSheetId: (sheetId) => replacements.push(sheetId)
    });
    expect(session.snapshot().activeSheetId).toBe("sheet-2");

    await session.configure({
      enabled: true,
      pollingEnabled: false,
      requestedSheetId: null,
      onReplaceSheetId: (sheetId) => replacements.push(sheetId)
    });
    expect(session.snapshot().activeSheetId).toBe("sheet-1");

    await session.configure({
      enabled: true,
      pollingEnabled: false,
      requestedSheetId: "sheet-2",
      onReplaceSheetId: (sheetId) => replacements.push(sheetId)
    });
    remoteManifest = [sheet1];
    await session.reload();
    await session.reload();

    expect(replacements).toEqual(["sheet-1", "sheet-1"]);
    expect(session.snapshot().activeSheetId).toBe("sheet-1");
    expect(calls).toEqual([
      "bootstrap:missing",
      "sheet:sheet-2",
      "versions",
      "versions"
    ]);
    session.dispose();
  });

  it("reloads a stale active note owner only and defers an inactive owner until selection", async () => {
    const sheet1 = manifestSheet("sheet-1", 1, { is_default: 1 });
    const sheet2 = manifestSheet("sheet-2", 1, { sort_order: 1 });
    const calls: string[] = [];
    const api: BoardDataApi = {
      getBootstrap: async () => bootstrapPayload(sheetPayload("sheet-1"), [sheet1, sheet2]),
      getSheet: async (sheetId) => {
        calls.push(`sheet:${sheetId}`);
        const item = sheetId === "sheet-1" ? sheet1 : sheet2;
        return sheetPayload(sheetId, item.version, { sheet: { ...item, content_version: item.version } });
      },
      getVersions: async () => versionSummary([sheet1, sheet2])
    };
    const session = createBoardSession({ userId: "user-1", api, runtime: null });
    await session.configure({ enabled: true, pollingEnabled: false, requestedSheetId: null });

    await session.markSheetStale("sheet-1");
    await session.selectSheet("sheet-2");
    await session.selectSheet("sheet-1");
    calls.length = 0;
    await session.markSheetStale("sheet-2");

    expect(calls).toEqual([]);
    expect(session.snapshot().activeSheetId).toBe("sheet-1");
    await session.selectSheet("sheet-2");
    expect(calls).toEqual(["sheet:sheet-2"]);
    session.dispose();
  });

  it("preserves accepted and pending write overlays across same-payload version emissions and fresh sheets", async () => {
    const sheet1v1 = manifestSheet("sheet-1", 1, { is_default: 1 });
    const sheet1v2 = manifestSheet("sheet-1", 2, { is_default: 1 });
    const acceptedCompletion = {
      table_id: "table-1",
      row_item_id: "accepted-row",
      column_item_id: "column-1",
      period_key: "daily:2026-07-16",
      completed: 1
    };
    const calls: string[] = [];
    const api: BoardDataApi = {
      getBootstrap: async () => bootstrapPayload(sheetPayload("sheet-1", 1), [sheet1v1]),
      getSheet: async (sheetId) => {
        calls.push(`sheet:${sheetId}`);
        return sheetPayload("sheet-1", 2, { completions: [acceptedCompletion] });
      },
      getVersions: async () => versionSummary([sheet1v2], 2)
    };
    const patch = vi.fn(async () => ({
      ok: true as const,
      versions: { manifestVersion: 2, sheets: [{ id: "sheet-1", version: 2 }] }
    }));
    const session = createBoardSession({
      userId: "user-1",
      api,
      runtime: null,
      writeCoordinatorOptions: { attachLifecycle: false, patch }
    });
    await session.configure({ enabled: true, pollingEnabled: false, requestedSheetId: null });
    session.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "accepted-row",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-16",
      completed: true
    });

    await session.flushPendingWrites();

    expect(session.snapshot().data?.completions).toEqual([acceptedCompletion]);
    expect(session.snapshot().data?.sheets[0]).toMatchObject({ id: "sheet-1", version: 2 });
    expect(calls).toEqual([]);

    session.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "pending-row",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-16",
      completed: true
    });
    await session.markSheetStale("sheet-1");

    expect(calls).toEqual(["sheet:sheet-1"]);
    expect(session.snapshot().data?.completions).toEqual([
      acceptedCompletion,
      expect.objectContaining({ row_item_id: "pending-row", completed: 1 })
    ]);
    session.dispose();
  });

  it("does not bootstrap while initially disabled, retains same-user cache, and clears on disposal", async () => {
    const sheet1 = manifestSheet("sheet-1", 1, { is_default: 1 });
    const getBootstrap = vi.fn(async () => bootstrapPayload(sheetPayload("sheet-1"), [sheet1]));
    const getVersions = vi.fn(async () => versionSummary([sheet1]));
    const session = createBoardSession({
      userId: "user-1",
      api: {
        getBootstrap,
        getSheet: async () => sheetPayload("sheet-1"),
        getVersions
      },
      runtime: null
    });
    await session.configure({ enabled: false, pollingEnabled: false, requestedSheetId: null });
    expect(getBootstrap).not.toHaveBeenCalled();
    expect(session.snapshot().data).toBeNull();

    await session.configure({ enabled: true, pollingEnabled: false, requestedSheetId: null });
    session.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-16",
      completed: true
    });

    await session.configure({ enabled: false, pollingEnabled: false, requestedSheetId: null });
    expect(session.snapshot()).toMatchObject({ data: null, hasPendingWrites: true });
    await session.configure({ enabled: true, pollingEnabled: false, requestedSheetId: null });
    expect(getBootstrap).toHaveBeenCalledTimes(1);
    expect(getVersions).toHaveBeenCalledTimes(1);
    expect(session.snapshot().data?.completions).toHaveLength(1);

    session.dispose();
    expect(session.snapshot()).toMatchObject({
      userId: null,
      data: null,
      activeSheetId: null,
      hasPendingWrites: false,
      pendingWriteError: null
    });
  });

  it("does not restart polling when an older bootstrap finishes after the session is disabled", async () => {
    const sheet1 = manifestSheet("sheet-1", 1, { is_default: 1 });
    let resolveBootstrap!: (payload: BoardBootstrapPayload) => void;
    const bootstrap = new Promise<BoardBootstrapPayload>((resolve) => {
      resolveBootstrap = resolve;
    });
    const runtime = createFakeBoardPollingRuntime();
    const api: BoardDataApi = {
      getBootstrap: () => bootstrap,
      getSheet: async () => sheetPayload("sheet-1"),
      getVersions: vi.fn(async () => versionSummary([sheet1]))
    };
    const session = createBoardSession({
      userId: "user-1",
      api,
      runtime: runtime.runtime,
      sourceId: "source-1"
    });

    const enabling = session.configure({
      enabled: true,
      pollingEnabled: true,
      requestedSheetId: null
    });
    await Promise.resolve();
    await session.configure({
      enabled: false,
      pollingEnabled: false,
      requestedSheetId: null
    });
    resolveBootstrap(bootstrapPayload(sheetPayload("sheet-1"), [sheet1]));
    await enabling;

    expect(runtime.channelNames).toEqual([]);
    expect(runtime.listenerCount()).toBe(0);
    expect(api.getVersions).not.toHaveBeenCalled();
    session.dispose();
  });

  it("forces active-sheet logout recovery after versions while preserving pending overlays", async () => {
    const sheet1 = manifestSheet("sheet-1", 1, { is_default: 1 });
    const calls: string[] = [];
    const session = createBoardSession({
      userId: "user-1",
      api: {
        getBootstrap: async () => bootstrapPayload(sheetPayload("sheet-1"), [sheet1]),
        getSheet: async () => {
          calls.push("sheet:sheet-1");
          return sheetPayload("sheet-1");
        },
        getVersions: async () => {
          calls.push("versions");
          return versionSummary([sheet1]);
        }
      },
      runtime: null
    });
    await session.configure({ enabled: true, pollingEnabled: false, requestedSheetId: null });
    session.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "pending-row",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-16",
      completed: true
    });

    await session.reconcileAfterLogoutFailure();

    expect(calls).toEqual(["versions", "sheet:sheet-1"]);
    expect(session.snapshot().data?.completions).toEqual([
      expect.objectContaining({ row_item_id: "pending-row", completed: 1 })
    ]);
    session.dispose();
  });

  it("forces a cached fallback sheet refresh when logout recovery deletes the prior active sheet", async () => {
    const sheet1 = manifestSheet("sheet-1", 1, { is_default: 1 });
    const sheet2 = manifestSheet("sheet-2", 1, { sort_order: 1 });
    const calls: string[] = [];
    const session = createBoardSession({
      userId: "user-1",
      api: {
        getBootstrap: async () =>
          bootstrapPayload(sheetPayload("sheet-1"), [sheet1, sheet2]),
        getSheet: async (sheetId) => {
          calls.push(`sheet:${sheetId}`);
          return sheetPayload(sheetId);
        },
        getVersions: async () => {
          calls.push("versions");
          return versionSummary([sheet2], 2);
        }
      },
      runtime: null
    });
    await session.configure({ enabled: true, pollingEnabled: false, requestedSheetId: null });
    await session.selectSheet("sheet-2");
    await session.selectSheet("sheet-1");

    await session.reconcileAfterLogoutFailure();

    expect(session.snapshot().activeSheetId).toBe("sheet-2");
    expect(calls).toEqual(["sheet:sheet-2", "versions", "sheet:sheet-2"]);
    session.dispose();
  });
});

describe("v2 board polling runtime", () => {
  it("uses exact user-scoped names and rejects malformed, wrong-user, and same-source messages", () => {
    const sheet = manifestSheet("sheet-1", 1, { is_default: 1 });
    const valid = {
      protocolVersion: 2 as const,
      userId: "user-1",
      sourceId: "tab-b",
      summary: versionSummary([sheet])
    };

    expect(getBoardPollingStorageKey("user /한글")).toBe("riceark-board-polling:v2:user /한글");
    expect(getBoardPollingChannelName("user /한글")).toBe("riceark-board-polling:v2:user /한글");
    expect(parseBoardPollingMessage(valid, "user-1", "tab-a")).toEqual(valid);
    expect(parseBoardPollingMessage({ ...valid, protocolVersion: 1 }, "user-1", "tab-a")).toBeNull();
    expect(parseBoardPollingMessage({ ...valid, userId: "user-2" }, "user-1", "tab-a")).toBeNull();
    expect(parseBoardPollingMessage({ ...valid, sourceId: "tab-a" }, "user-1", "tab-a")).toBeNull();
    expect(parseBoardPollingMessage({ ...valid, summary: { ...valid.summary, sheets: [{ id: "sheet-1", version: 1 }] } }, "user-1", "tab-a")).toBeNull();
    expect(parseBoardPollingMessage(null, "user-1", "tab-a")).toBeNull();
  });

  it("starts after the active interval, backs off when idle, and lets only the leader fetch versions", async () => {
    const sheet = manifestSheet("sheet-1", 1, { is_default: 1 });
    const leaderRuntime = createFakeBoardPollingRuntime();
    const leaderCalls: string[] = [];
    const leader = createBoardSession({
      userId: "user-1",
      sourceId: "tab-a",
      runtime: leaderRuntime.runtime,
      api: {
        getBootstrap: async () => {
          leaderCalls.push("bootstrap");
          return bootstrapPayload(sheetPayload("sheet-1"), [sheet]);
        },
        getSheet: async () => sheetPayload("sheet-1"),
        getVersions: async () => {
          leaderCalls.push("versions");
          return versionSummary([sheet]);
        }
      }
    });

    await leader.configure({ enabled: true, pollingEnabled: true, requestedSheetId: null });
    expect(leaderCalls).toEqual(["bootstrap"]);
    expect(leaderRuntime.pendingDelays()).toContain(BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS);
    expect(leaderRuntime.pendingDueAt(BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS)).toBe(
      BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS
    );
    leaderRuntime.setNow(BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS / 2);
    await leaderRuntime.emit("activity");
    expect(leaderRuntime.pendingDueAt(BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS)).toBe(
      BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS
    );

    await leaderRuntime.fireTimer(BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS);
    expect(leaderCalls).toEqual(["bootstrap", "versions"]);
    leaderRuntime.setNow(6 * 60_000);
    await leaderRuntime.fireTimer(BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS, true);
    expect(leaderCalls).toEqual(["bootstrap", "versions", "versions"]);
    expect(leaderRuntime.pendingDelays()).toContain(BOARD_VERSION_IDLE_CHECK_INTERVAL_MS);
    await leaderRuntime.emit("activity");
    expect(leaderRuntime.pendingDelays()).toContain(BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS);

    const followerStorage = new Map<string, string>([[
      getBoardPollingStorageKey("user-1"),
      JSON.stringify({ id: "tab-a", expiresAt: 1_000_000 })
    ]]);
    const followerRuntime = createFakeBoardPollingRuntime({ storageValues: followerStorage });
    const followerVersions = vi.fn(async () => versionSummary([sheet]));
    const follower = createBoardSession({
      userId: "user-1",
      sourceId: "tab-b",
      runtime: followerRuntime.runtime,
      api: {
        getBootstrap: async () => bootstrapPayload(sheetPayload("sheet-1"), [sheet]),
        getSheet: async () => sheetPayload("sheet-1"),
        getVersions: followerVersions
      }
    });
    await follower.configure({ enabled: true, pollingEnabled: true, requestedSheetId: null });
    await followerRuntime.fireTimer(BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS);
    expect(followerVersions).not.toHaveBeenCalled();

    leader.dispose();
    follower.dispose();
  });

  it("does no hidden fetch, checks immediately on focus/visible/view return, and cleans up", async () => {
    const sheet = manifestSheet("sheet-1", 1, { is_default: 1 });
    const fake = createFakeBoardPollingRuntime({ visible: false });
    const calls: string[] = [];
    const session = createBoardSession({
      userId: "user-1",
      sourceId: "tab-a",
      runtime: fake.runtime,
      api: {
        getBootstrap: async () => {
          calls.push("bootstrap");
          return bootstrapPayload(sheetPayload("sheet-1"), [sheet]);
        },
        getSheet: async () => sheetPayload("sheet-1"),
        getVersions: async () => {
          calls.push("versions");
          return versionSummary([sheet]);
        }
      }
    });

    await session.configure({ enabled: true, pollingEnabled: true, requestedSheetId: null });
    expect(calls).toEqual(["bootstrap"]);
    expect(fake.pendingDelays()).not.toContain(BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS);
    await fake.emit("focus");
    expect(calls).toEqual(["bootstrap"]);

    fake.setVisible(true);
    await fake.emit("visibilitychange");
    await vi.waitFor(() => expect(calls).toEqual(["bootstrap", "versions"]));
    expect(fake.channelNames).toEqual([getBoardPollingChannelName("user-1")]);
    await fake.emit("focus");
    await vi.waitFor(() => expect(calls).toEqual(["bootstrap", "versions", "versions"]));

    fake.setVisible(false);
    await fake.emit("visibilitychange");
    expect(fake.storageValues.has(getBoardPollingStorageKey("user-1"))).toBe(false);
    expect(fake.pendingDelays()).not.toContain(BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS);

    await session.configure({ enabled: true, pollingEnabled: false, requestedSheetId: null });
    expect(fake.listenerCount()).toBe(0);
    expect(fake.pendingDelays()).toEqual([]);
    const returning = session.configure({ enabled: true, pollingEnabled: true, requestedSheetId: null });
    expect(session.snapshot().data).not.toBeNull();
    fake.setVisible(true);
    await returning;
    await vi.waitFor(() => expect(calls).toEqual(["bootstrap", "versions", "versions", "versions"]));

    session.dispose();
    expect(fake.listenerCount()).toBe(0);
    expect(fake.pendingDelays()).toEqual([]);
    expect(fake.closedChannels).toBe(2);
  });

  it("applies follower summaries without versions GETs and fetches only a changed active sheet", async () => {
    const sheet1v1 = manifestSheet("sheet-1", 1, { is_default: 1 });
    const sheet1v2 = manifestSheet("sheet-1", 2, { is_default: 1 });
    const sheet2v1 = manifestSheet("sheet-2", 1, { sort_order: 1 });
    const sheet2v2 = manifestSheet("sheet-2", 2, { sort_order: 1 });
    const fake = createFakeBoardPollingRuntime();
    const calls: string[] = [];
    const session = createBoardSession({
      userId: "user-1",
      sourceId: "tab-a",
      runtime: fake.runtime,
      api: {
        getBootstrap: async () => bootstrapPayload(sheetPayload("sheet-1"), [sheet1v1, sheet2v1]),
        getSheet: async (sheetId) => {
          calls.push(`sheet:${sheetId}`);
          return sheetPayload("sheet-1", 2, {
            sheet: { ...sheet1v2, content_version: 2 }
          });
        },
        getVersions: async () => {
          calls.push("versions");
          return versionSummary([sheet1v2, sheet2v2], 2);
        }
      }
    });
    await session.configure({ enabled: true, pollingEnabled: true, requestedSheetId: null });
    const message = (summary: BoardVersionSummary, overrides: Record<string, unknown> = {}) => ({
      protocolVersion: 2,
      userId: "user-1",
      sourceId: "tab-b",
      summary,
      ...overrides
    });

    await fake.receive(message(versionSummary([sheet1v1, sheet2v2], 2)));
    expect(calls).toEqual([]);
    expect(session.snapshot().data?.sheets.find((sheet) => sheet.id === "sheet-2")).toMatchObject({ version: 2 });

    await fake.receive(message(versionSummary([sheet1v2, sheet2v2], 2)));
    await vi.waitFor(() => expect(calls).toEqual(["sheet:sheet-1"]));
    expect(session.snapshot().data?.sheets.find((sheet) => sheet.id === "sheet-1")).toMatchObject({ version: 2 });

    await fake.receive(message(versionSummary([sheet1v2, sheet2v2], 2), { protocolVersion: 1 }));
    await fake.receive(message(versionSummary([sheet1v2, sheet2v2], 2), { userId: "user-2" }));
    await fake.receive(message(versionSummary([sheet1v2, sheet2v2], 2), { sourceId: "tab-a" }));
    expect(calls).toEqual(["sheet:sheet-1"]);
    session.dispose();
  });

  it("ignores broadcasts off the owner view and performs one leader revalidation on return", async () => {
    const sheet1v1 = manifestSheet("sheet-1", 1, { is_default: 1 });
    const sheet1v2 = manifestSheet("sheet-1", 2, { is_default: 1 });
    const fake = createFakeBoardPollingRuntime();
    const calls: string[] = [];
    const session = createBoardSession({
      userId: "user-1",
      sourceId: "tab-a",
      runtime: fake.runtime,
      api: {
        getBootstrap: async () => bootstrapPayload(sheetPayload("sheet-1"), [sheet1v1]),
        getSheet: async () => {
          calls.push("sheet");
          return sheetPayload("sheet-1", 2, { sheet: { ...sheet1v2, content_version: 2 } });
        },
        getVersions: async () => {
          calls.push("versions");
          return versionSummary([sheet1v1]);
        }
      }
    });
    await session.configure({ enabled: true, pollingEnabled: true, requestedSheetId: null });
    await session.configure({ enabled: true, pollingEnabled: false, requestedSheetId: null });

    await fake.receive({
      protocolVersion: 2,
      userId: "user-1",
      sourceId: "tab-b",
      summary: versionSummary([sheet1v2], 2)
    });
    expect(calls).toEqual([]);

    await session.configure({ enabled: true, pollingEnabled: true, requestedSheetId: null });
    await vi.waitFor(() => expect(calls).toEqual(["versions"]));
    session.dispose();
  });

  it("coalesces mutation invalidations into one full canonical v2 summary", async () => {
    const sheet = manifestSheet("sheet-1", 1, { name: "Main", is_default: 1 });
    const fake = createFakeBoardPollingRuntime();
    const patch = vi.fn(async () => ({
      ok: true as const,
      versions: { manifestVersion: 2, sheets: [{ id: "sheet-1", version: 2 }] }
    }));
    const session = createBoardSession({
      userId: "user-1",
      sourceId: "tab-a",
      runtime: fake.runtime,
      api: {
        getBootstrap: async () => bootstrapPayload(sheetPayload("sheet-1"), [sheet]),
        getSheet: async () => sheetPayload("sheet-1", 2),
        getVersions: async () => versionSummary([{ ...sheet, version: 2 }], 2)
      },
      writeCoordinatorOptions: { attachLifecycle: false, patch }
    });
    await session.configure({ enabled: true, pollingEnabled: true, requestedSheetId: null });
    session.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-16",
      completed: true
    });
    session.enqueueCellState({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      markType: "fixed",
      markIcon: "pin",
      memo: "memo"
    });
    await session.flushPendingWrites();

    expect(fake.pendingDelays().filter((delay) => delay === BOARD_WRITE_INVALIDATION_COALESCE_MS)).toHaveLength(1);
    await fake.fireTimer(BOARD_WRITE_INVALIDATION_COALESCE_MS);
    expect(fake.posted).toEqual([{
      protocolVersion: 2,
      userId: "user-1",
      sourceId: "tab-a",
      summary: {
        manifestVersion: 2,
        sheets: [{ ...sheet, version: 2 }],
        periodFingerprint: "",
        settings: boardSettings
      }
    }]);
    session.dispose();
  });

  it("refetches only the active sheet at a visible local period boundary", async () => {
    const start = Date.parse("2026-07-15T20:59:00.000Z");
    const fake = createFakeBoardPollingRuntime({ nowMs: start });
    const sheet = manifestSheet("sheet-1", 1, { is_default: 1 });
    const axisItem = {
      id: "task-1",
      table_id: "table-1",
      axis: "row" as const,
      kind: "task" as const,
      label: "Daily",
      character_id: null,
      task_id: "daily-task",
      task_color: null,
      size_px: null,
      sort_order: 0,
      visible: 1,
      task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}'
    };
    const makePayload = () => {
      const payload = sheetPayload("sheet-1", 1, { axisItems: [axisItem] });
      return {
        ...payload,
        periodFingerprint: buildLocalBoardPeriodFingerprint(payload, new Date(fake.nowMs()))
      };
    };
    const calls: string[] = [];
    const session = createBoardSession({
      userId: "user-1",
      sourceId: "tab-a",
      runtime: fake.runtime,
      api: {
        getBootstrap: async () => bootstrapPayload(makePayload(), [sheet]),
        getSheet: async () => {
          calls.push("sheet");
          return makePayload();
        },
        getVersions: async () => {
          calls.push("versions");
          return versionSummary([sheet]);
        }
      }
    });
    await session.configure({ enabled: true, pollingEnabled: true, requestedSheetId: null });
    const boundaryDelay = fake.pendingDelays().find(
      (delay) => delay !== 15_000 && delay !== BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS
    );
    expect(boundaryDelay).toBeDefined();

    await fake.fireTimer(boundaryDelay!);
    await vi.waitFor(() => expect(calls).toEqual(["sheet"]));
    session.dispose();
  });

  it("defers a hidden period boundary until visible without a broad read", async () => {
    const start = Date.parse("2026-07-15T20:59:00.000Z");
    const storageValues = new Map<string, string>([[
      getBoardPollingStorageKey("user-1"),
      JSON.stringify({ id: "other-tab", expiresAt: start + 10 * 60_000 })
    ]]);
    const fake = createFakeBoardPollingRuntime({ nowMs: start, visible: false, storageValues });
    const sheet = manifestSheet("sheet-1", 1, { is_default: 1 });
    const axisItem = {
      id: "task-1",
      table_id: "table-1",
      axis: "row" as const,
      kind: "task" as const,
      label: "Daily",
      character_id: null,
      task_id: "daily-task",
      task_color: null,
      size_px: null,
      sort_order: 0,
      visible: 1,
      task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}'
    };
    const makePayload = () => {
      const payload = sheetPayload("sheet-1", 1, { axisItems: [axisItem] });
      return {
        ...payload,
        periodFingerprint: buildLocalBoardPeriodFingerprint(payload, new Date(fake.nowMs()))
      };
    };
    const calls: string[] = [];
    const session = createBoardSession({
      userId: "user-1",
      sourceId: "tab-a",
      runtime: fake.runtime,
      api: {
        getBootstrap: async () => bootstrapPayload(makePayload(), [sheet]),
        getSheet: async () => {
          calls.push("sheet");
          return makePayload();
        },
        getVersions: async () => {
          calls.push("versions");
          return versionSummary([sheet]);
        }
      }
    });
    await session.configure({ enabled: true, pollingEnabled: true, requestedSheetId: null });
    fake.setNow(start + 2 * 60_000);
    expect(calls).toEqual([]);

    fake.setVisible(true);
    await fake.emit("visibilitychange");
    await vi.waitFor(() => expect(calls).toEqual(["sheet"]));
    session.dispose();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("formatBoardError", () => {
  it("uses a Korean login prompt for unauthorized API errors", () => {
    const error = new ApiClientError(401, "unauthorized", "Login required");

    expect(formatBoardError(error)).toBe("로그인이 필요합니다. Discord 또는 Google로 로그인해주세요.");
  });

  it("uses a board-specific fallback for unknown errors", () => {
    expect(formatBoardError("bad")).toBe("보드 데이터를 불러오지 못했습니다.");
  });

  it("does not publish a stale coordinator reload failure into a new account", () => {
    const oldCoordinator = {};
    const currentCoordinator = {};
    const report = vi.fn();

    expect(reportBoardReloadErrorIfCurrent(currentCoordinator, oldCoordinator, new Error("old failure"), report))
      .toBe(false);
    expect(report).not.toHaveBeenCalled();
    expect(reportBoardReloadErrorIfCurrent(currentCoordinator, currentCoordinator, new Error("current failure"), report))
      .toBe(true);
    expect(report).toHaveBeenCalledWith("current failure");
  });

  it("builds reset period fingerprints locally from the loaded board payload", () => {
    const board = {
      axisItems: [
        { kind: "character", task_reset_rule_json: null },
        { kind: "task", task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}' },
        { kind: "task", task_reset_rule_json: '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}' },
        { kind: "task", task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}' }
      ]
    };
    const summary = { manifestVersion: 3, sheets: [{ id: "sheet-1", version: 5 }], periodFingerprint: "" };

    expect(buildLocalBoardPeriodFingerprint(board, new Date("2026-06-05T03:00:00.000Z"))).toBe(
      "daily:2026-06-05|weekly:2026-06-03"
    );
    expect(buildBoardVersionKey(summary, board, new Date("2026-06-05T03:00:00.000Z"))).toContain(
      "daily:2026-06-05|weekly:2026-06-03"
    );
  });

  it("sorts unique reset period keys independently of task input order", () => {
    const board = {
      axisItems: [
        { kind: "task", task_reset_rule_json: '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}' },
        { kind: "task", task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}' },
        { kind: "custom", task_reset_rule_json: null },
        { kind: "task", task_reset_rule_json: '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}' }
      ]
    };

    expect(buildLocalBoardPeriodFingerprint(board, new Date("2026-06-05T03:00:00.000Z"))).toBe(
      "daily:2026-06-05|weekly:2026-06-03"
    );
  });

  it("backs off board version polling after the user is idle", () => {
    const nowMs = Date.parse("2026-06-05T03:00:00.000Z");

    expect(getBoardPollingDelayMs(nowMs - 60_000, nowMs)).toBe(BOARD_VERSION_ACTIVE_CHECK_INTERVAL_MS);
    expect(getBoardPollingDelayMs(nowMs - 6 * 60_000, nowMs)).toBe(BOARD_VERSION_IDLE_CHECK_INTERVAL_MS);
  });

  it("calculates the next local reset boundary without asking the server", () => {
    const board = {
      axisItems: [
        { kind: "task", task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}' },
        { kind: "task", task_reset_rule_json: '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}' }
      ]
    };

    expect(getNextBoardPeriodBoundaryMs(board, new Date("2026-06-05T20:50:00.000Z"))).toBe(
      Date.parse("2026-06-05T21:00:00.000Z")
    );
    expect(getNextBoardPeriodBoundaryMs(board, new Date("2026-06-03T21:00:01.000Z"))).toBe(
      Date.parse("2026-06-04T21:00:00.000Z")
    );
  });

  it("lets only the current or expired board polling leader claim polling work", () => {
    expect(parseBoardPollingLeaderRecord('{"id":"tab-a","expiresAt":1000}')).toEqual({ id: "tab-a", expiresAt: 1000 });
    expect(parseBoardPollingLeaderRecord("bad")).toBeNull();
    expect(canClaimBoardPollingLeadership(null, "tab-a", 100)).toBe(true);
    expect(canClaimBoardPollingLeadership({ id: "tab-a", expiresAt: 1000 }, "tab-a", 200)).toBe(true);
    expect(canClaimBoardPollingLeadership({ id: "tab-a", expiresAt: 1000 }, "tab-b", 200)).toBe(false);
    expect(canClaimBoardPollingLeadership({ id: "tab-a", expiresAt: 1000 }, "tab-b", 1001)).toBe(true);
  });

  it("merges mutation and summary versions monotonically across the initial-summary race", () => {
    const acknowledged = mergeBoardVersionSummary(null, {
      manifestVersion: 8,
      sheets: [{ id: "sheet-1", version: 7 }]
    });
    const initialSummary = mergeBoardVersionSummary(acknowledged, {
      manifestVersion: 6,
      sheets: [
        { id: "sheet-1", version: 5 },
        { id: "sheet-2", version: 3 }
      ],
      periodFingerprint: "server-period"
    });

    expect(initialSummary).toEqual({
      manifestVersion: 8,
      sheets: [
        { id: "sheet-1", version: 7 },
        { id: "sheet-2", version: 3 }
      ],
      periodFingerprint: "server-period"
    });
    expect(mergeBoardVersionSummary(initialSummary, { sheets: [{ id: "sheet-1", version: 4 }] })).toEqual(
      initialSummary
    );
  });

  it("keeps the writing tab on its acknowledged version when a stale poll arrives", () => {
    const board = { axisItems: [] };
    const initial = mergeBoardVersionSummary(null, {
      manifestVersion: 2,
      sheets: [{ id: "sheet-1", version: 5 }],
      periodFingerprint: ""
    });
    const acknowledged = mergeBoardVersionSummary(initial, {
      sheets: [{ id: "sheet-1", version: 6 }]
    });
    const acknowledgedKey = buildBoardVersionKey(acknowledged, board);
    const afterStalePoll = mergeBoardVersionSummary(acknowledged, {
      manifestVersion: 2,
      sheets: [{ id: "sheet-1", version: 5 }],
      periodFingerprint: ""
    });

    expect(buildBoardVersionKey(afterStalePoll, board)).toBe(acknowledgedKey);
  });

  it("replaces provided display settings and preserves them when later updates omit settings", () => {
    const initialSettings: BoardDisplaySettings = {
      show_display_name: 1,
      show_server_name: 0,
      show_class_name: 0,
      show_item_level: 1,
      show_combat_power: 0
    };
    const incomingSettings: BoardDisplaySettings = {
      show_display_name: 0,
      show_server_name: 1,
      show_class_name: 1,
      show_item_level: 0,
      show_combat_power: 1
    };
    const initial = mergeBoardVersionSummary(null, {
      manifestVersion: 8,
      sheets: [{ id: "sheet-1", version: 7 }],
      periodFingerprint: "current-period",
      settings: initialSettings
    });
    const afterSettingsSummary = mergeBoardVersionSummary(initial, {
      manifestVersion: 6,
      sheets: [{ id: "sheet-1", version: 5 }],
      periodFingerprint: "stale-period",
      settings: incomingSettings
    });

    expect(afterSettingsSummary).toEqual({
      manifestVersion: 8,
      sheets: [{ id: "sheet-1", version: 7 }],
      periodFingerprint: "stale-period",
      settings: incomingSettings
    });

    const afterMutation = mergeBoardVersionSummary(afterSettingsSummary, {
      manifestVersion: 9,
      sheets: [{ id: "sheet-1", version: 8 }]
    });
    expect(afterMutation.settings).toEqual(incomingSettings);

    const afterStaleSummaryWithoutSettings = mergeBoardVersionSummary(afterMutation, {
      manifestVersion: 7,
      sheets: [{ id: "sheet-1", version: 6 }],
      periodFingerprint: "older-period"
    });
    expect(afterStaleSummaryWithoutSettings.settings).toEqual(incomingSettings);
    expect(afterStaleSummaryWithoutSettings.manifestVersion).toBe(9);
    expect(afterStaleSummaryWithoutSettings.sheets).toEqual([{ id: "sheet-1", version: 8 }]);
  });
});

describe("board read generation isolation", () => {
  it("ignores an older success after a newer same-user load applies", async () => {
    const first = deferred<BoardPayload>();
    const second = deferred<BoardPayload>();
    const applied: BoardPayload[] = [];
    const failures: unknown[] = [];
    const read = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const gate = createBoardReadGate({
      read,
      onApplied: (payload) => applied.push(payload),
      onFailure: (error) => failures.push(error)
    });
    const older = gate.load(undefined);
    const newer = gate.load(undefined);
    const newerBoard = { ...emptyBoard, userId: "user-1-new" };

    second.resolve(newerBoard);
    await expect(newer).resolves.toMatchObject({ type: "applied", payload: newerBoard });
    first.resolve(emptyBoard);
    await expect(older).resolves.toEqual({ type: "stale" });

    expect(applied).toEqual([newerBoard]);
    expect(failures).toEqual([]);
    gate.dispose();
  });

  it("ignores an older failure after a newer same-user load applies", async () => {
    const first = deferred<BoardPayload>();
    const second = deferred<BoardPayload>();
    const applied = vi.fn();
    const onFailure = vi.fn();
    const gate = createBoardReadGate({
      read: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
      onApplied: applied,
      onFailure
    });
    const older = gate.load(undefined);
    const newer = gate.load(undefined);

    second.resolve(emptyBoard);
    await newer;
    first.reject(new Error("stale failure"));
    await expect(older).resolves.toEqual({ type: "stale" });

    expect(applied).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
    gate.dispose();
  });

  it("prefetches a version lower bound before the board GET", async () => {
    type VersionContext = {
      summary: null | { manifestVersion: number; sheets: Array<{ id: string; version: number }>; periodFingerprint: string };
    };
    const versionSummary = deferred<NonNullable<VersionContext["summary"]>>();
    const boardRead = deferred<BoardPayload>();
    const calls: string[] = [];
    const gate = createBoardReadGate<VersionContext>({
      prepare: async () => {
        calls.push("versions");
        return { summary: await versionSummary.promise };
      },
      read: async () => {
        calls.push("board");
        return boardRead.promise;
      },
      onApplied: vi.fn(),
      onFailure: vi.fn()
    });

    const loading = gate.load({ summary: null });
    expect(calls).toEqual(["versions"]);
    versionSummary.resolve({ manifestVersion: 1, sheets: [], periodFingerprint: "" });
    await vi.waitFor(() => expect(calls).toEqual(["versions", "board"]));
    boardRead.resolve(emptyBoard);
    await expect(loading).resolves.toMatchObject({ type: "applied" });
    gate.dispose();
  });

  it("invalidates a pre-acknowledgment GET before overlay removal and preserves the local mutation version", async () => {
    const oldBoardRead = deferred<BoardPayload>();
    const tracker = createBoardVersionTracker();
    tracker.apply({ manifestVersion: 1, sheets: [{ id: "sheet-1", version: 1 }], periodFingerprint: "" });
    let gate!: ReturnType<typeof createBoardReadGate<{ summary: { manifestVersion: number; sheets: Array<{ id: string; version: number }>; periodFingerprint: string } }>>;
    const coordinator = createBoardWriteCoordinator("user-1", {
      attachLifecycle: false,
      onBeforeAccepted: () => gate.invalidate(),
      onVersions: (versions) => tracker.apply(versions),
      patch: vi.fn(async () => ({
        ok: true as const,
        versions: { manifestVersion: 2, sheets: [{ id: "sheet-1", version: 5 }] }
      }))
    });
    coordinator.setAuthoritativeBase(emptyBoard);
    gate = createBoardReadGate({
      prepare: async (context) => {
        tracker.observe(context.summary);
        return context;
      },
      read: () => oldBoardRead.promise,
      onApplied: (payload, context) => {
        coordinator.setAuthoritativeBase(payload);
        tracker.apply(context.summary);
      },
      onFailure: vi.fn()
    });
    const oldLoad = gate.load({
      summary: { manifestVersion: 1, sheets: [{ id: "sheet-1", version: 2 }], periodFingerprint: "" }
    });
    const localPatch = {
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    };
    coordinator.enqueueCompletion(localPatch);

    await coordinator.flushPendingWrites();
    oldBoardRead.resolve(emptyBoard);
    await expect(oldLoad).resolves.toEqual({ type: "stale" });

    expect(coordinator.getAuthoritativeBase()?.completions).toEqual([
      expect.objectContaining({ row_item_id: "row-1", completed: 1 })
    ]);
    expect(tracker.getState()).toEqual({
      observed: { manifestVersion: 2, sheets: [{ id: "sheet-1", version: 5 }], periodFingerprint: "" },
      applied: { manifestVersion: 2, sheets: [{ id: "sheet-1", version: 5 }], periodFingerprint: "" }
    });
    gate.dispose();
    coordinator.discardAndDispose();
  });
});

describe("exclusive board recovery reads", () => {
  it("invalidates an older normal read and exclusively applies the recovery read", async () => {
    const olderRead = deferred<BoardPayload>();
    const recoveryRead = deferred<BoardPayload>();
    const recoveredBoard = { ...emptyBoard, userId: "recovered-user" };
    const applied: BoardPayload[] = [];
    const read = vi.fn()
      .mockImplementationOnce(() => olderRead.promise)
      .mockImplementationOnce(() => recoveryRead.promise);
    const gate = createBoardReadGate({
      read,
      onApplied: (payload) => applied.push(payload),
      onFailure: vi.fn()
    });
    const owner = createBoardRecoveryReadOwner({ gate });

    const older = owner.load(undefined);
    const recovery = owner.reconcile(undefined);
    recoveryRead.resolve(recoveredBoard);

    await expect(recovery).resolves.toBe(recoveredBoard);
    olderRead.resolve(emptyBoard);
    await expect(older).resolves.toEqual({ type: "stale" });
    expect(applied).toEqual([recoveredBoard]);
    expect(read).toHaveBeenCalledTimes(2);
    owner.dispose();
  });

  it("refuses normal and invalidation reads until recovery settles without superseding it", async () => {
    const recoveryRead = deferred<BoardPayload>();
    const laterRead = deferred<BoardPayload>();
    const read = vi.fn()
      .mockImplementationOnce(() => recoveryRead.promise)
      .mockImplementationOnce(() => laterRead.promise);
    const gate = createBoardReadGate({ read, onApplied: vi.fn(), onFailure: vi.fn() });
    const owner = createBoardRecoveryReadOwner({ gate });

    const recovery = owner.reconcile(undefined);
    await expect(owner.load(undefined)).resolves.toEqual({ type: "blocked" });
    owner.invalidate();
    await expect(owner.load(undefined)).resolves.toEqual({ type: "blocked" });
    expect(read).toHaveBeenCalledTimes(1);

    recoveryRead.resolve(emptyBoard);
    await expect(recovery).resolves.toBe(emptyBoard);

    const retryableInvalidation = owner.load(undefined);
    expect(read).toHaveBeenCalledTimes(2);
    laterRead.resolve(emptyBoard);
    await expect(retryableInvalidation).resolves.toMatchObject({ type: "applied" });
    owner.dispose();
  });

  it("retries a stale recovery generation within the same deadline", async () => {
    const staleRead = deferred<BoardPayload>();
    const retryRead = deferred<BoardPayload>();
    const recoveredBoard = { ...emptyBoard, userId: "retried-recovery" };
    const read = vi.fn()
      .mockImplementationOnce(() => staleRead.promise)
      .mockImplementationOnce(() => retryRead.promise);
    const gate = createBoardReadGate({ read, onApplied: vi.fn(), onFailure: vi.fn() });
    const owner = createBoardRecoveryReadOwner({ gate });

    const recovery = owner.reconcile(undefined);
    gate.invalidate();
    staleRead.resolve(emptyBoard);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    retryRead.resolve(recoveredBoard);

    await expect(recovery).resolves.toBe(recoveredBoard);
    owner.dispose();
  });

  it("times out a hung recovery, invalidates its late response, and restores normal reads", async () => {
    vi.useFakeTimers();
    try {
      const lateRecoveryRead = deferred<BoardPayload>();
      const normalRead = deferred<BoardPayload>();
      const currentBoard = { ...emptyBoard, userId: "current-after-timeout" };
      const applied: BoardPayload[] = [];
      const onTimeout = vi.fn();
      const read = vi.fn()
        .mockImplementationOnce(() => lateRecoveryRead.promise)
        .mockImplementationOnce(() => normalRead.promise);
      const gate = createBoardReadGate({
        read,
        onApplied: (payload) => applied.push(payload),
        onFailure: vi.fn()
      });
      const owner = createBoardRecoveryReadOwner({ gate, onTimeout });

      const recovery = owner.reconcile(undefined);
      const recoveryFailure = expect(recovery).rejects.toThrow(/10초/);
      await vi.advanceTimersByTimeAsync(BOARD_RECOVERY_READ_TIMEOUT_MS);
      await recoveryFailure;
      expect(onTimeout).toHaveBeenCalledTimes(1);

      const afterTimeout = owner.load(undefined);
      normalRead.resolve(currentBoard);
      await expect(afterTimeout).resolves.toMatchObject({ type: "applied", payload: currentBoard });

      lateRecoveryRead.resolve({ ...emptyBoard, userId: "late-recovery" });
      await vi.runAllTimersAsync();
      expect(applied).toEqual([currentBoard]);
      owner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("board observed and applied versions", () => {
  it("does not apply failed observations and never regresses a newer local mutation", () => {
    const tracker = createBoardVersionTracker();
    tracker.apply({ manifestVersion: 1, sheets: [{ id: "sheet-1", version: 1 }], periodFingerprint: "" });
    tracker.observe({ manifestVersion: 2, sheets: [{ id: "sheet-1", version: 2 }], periodFingerprint: "remote" });

    expect(tracker.getState().applied?.sheets).toEqual([{ id: "sheet-1", version: 1 }]);

    tracker.apply({ manifestVersion: 3, sheets: [{ id: "sheet-1", version: 5 }] });
    tracker.apply({ manifestVersion: 2, sheets: [{ id: "sheet-1", version: 2 }], periodFingerprint: "remote" });

    expect(tracker.getState()).toEqual({
      observed: { manifestVersion: 3, sheets: [{ id: "sheet-1", version: 5 }], periodFingerprint: "remote" },
      applied: { manifestVersion: 3, sheets: [{ id: "sheet-1", version: 5 }], periodFingerprint: "remote" }
    });
  });
});

describe("BoardWriteCoordinator", () => {
  it("reapplies pending completion and cell-state intent over a reloaded authoritative board", () => {
    const coordinator = createBoardWriteCoordinator("user-1", { attachLifecycle: false });
    coordinator.setAuthoritativeBase(emptyBoard);
    coordinator.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    });
    coordinator.enqueueCellState({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      markType: "fixed",
      markIcon: "pin",
      memo: "21:00"
    });

    coordinator.setAuthoritativeBase({ ...emptyBoard, completions: [], cellStates: [] });

    expect(coordinator.getVisibleData()?.completions).toHaveLength(1);
    expect(coordinator.getVisibleData()?.cellStates).toHaveLength(1);
    coordinator.discardAndDispose();
  });

  it("commits an accepted chunk to base while a newer same-key generation remains visible", async () => {
    const first = deferred<{ ok: true; versions: { sheets: [] } }>();
    const second = deferred<{ ok: true; versions: { sheets: [] } }>();
    const patch = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const coordinator = createBoardWriteCoordinator("user-1", { attachLifecycle: false, patch });
    coordinator.setAuthoritativeBase(emptyBoard);
    const oldPatch = {
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    };
    coordinator.enqueueCompletion(oldPatch);
    const flushing = coordinator.flushPendingWrites();
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    coordinator.enqueueCompletion({ ...oldPatch, completed: false });

    first.resolve({ ok: true, versions: { sheets: [] } });
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(2));

    expect(coordinator.getAuthoritativeBase()?.completions[0]?.completed).toBe(1);
    expect(coordinator.getVisibleData()?.completions[0]?.completed).toBe(0);
    coordinator.discardAndDispose();
    second.resolve({ ok: true, versions: { sheets: [] } });
    await flushing.catch(() => undefined);
  });

  it("reverts a permanently rejected current generation to authoritative base without reload", async () => {
    const patch = vi.fn(async () => {
      throw new ApiClientError(422, "invalid_patch", "Locked cell");
    });
    const coordinator = createBoardWriteCoordinator("user-1", { attachLifecycle: false, patch });
    coordinator.setAuthoritativeBase(emptyBoard);
    coordinator.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    });

    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });

    expect(coordinator.getVisibleData()?.completions).toEqual([]);
    expect(coordinator.getAuthoritativeBase()?.completions).toEqual([]);
    expect(coordinator.getSnapshot()).toMatchObject({ hasPendingWrites: true, pendingWriteError: "Locked cell" });
    coordinator.discardAndDispose();
  });

  it("preserves a completion error when the cell-state queue succeeds", async () => {
    const patch = vi.fn(async (path: string) => {
      if (path === "/api/board/completions") {
        throw new ApiClientError(422, "invalid_patch", "Completion locked");
      }
      return { ok: true as const, versions: { sheets: [] } };
    });
    const coordinator = createBoardWriteCoordinator("user-1", { attachLifecycle: false, patch });
    coordinator.setAuthoritativeBase(emptyBoard);
    coordinator.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    });
    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });
    coordinator.enqueueCellState({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      markType: "fixed",
      markIcon: "pin",
      memo: "saved"
    });

    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });

    expect(coordinator.getSnapshot().pendingWriteError).toBe("Completion locked");
    coordinator.discardAndDispose();
  });

  it("keeps both permanent queue errors until their retained intents are acknowledged", async () => {
    let completionFails = true;
    const patch = vi.fn(async (path: string) => {
      if (path === "/api/board/completions" && completionFails) {
        throw new ApiClientError(422, "invalid_completion", "Completion failed");
      }
      if (path === "/api/board/cell-states") {
        throw new ApiClientError(422, "invalid_cell_state", "Cell state failed");
      }
      return { ok: true as const, versions: { sheets: [] } };
    });
    const coordinator = createBoardWriteCoordinator("user-1", { attachLifecycle: false, patch });
    coordinator.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    });
    coordinator.enqueueCellState({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      markType: "fixed",
      markIcon: "pin",
      memo: "failed"
    });
    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });

    expect(coordinator.getSnapshot().pendingWriteError).toContain("Completion failed");
    expect(coordinator.getSnapshot().pendingWriteError).toContain("Cell state failed");

    completionFails = false;
    coordinator.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "row-2",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    });
    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });

    expect(coordinator.getSnapshot().pendingWriteError).toContain("Completion failed");
    expect(coordinator.getSnapshot().pendingWriteError).toContain("Cell state failed");
    coordinator.retryPendingWrites();
    expect(coordinator.getSnapshot().pendingWriteError).toContain("Completion failed");
    expect(coordinator.getSnapshot().pendingWriteError).toContain("Cell state failed");
    coordinator.discardAndDispose();
  });

  it("keeps a partial permanent rejection visible after the same queue accepts its remainder", async () => {
    const rejectedPatch = {
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    };
    const acceptedPatch = { ...rejectedPatch, rowItemId: "row-2" };
    const patch = vi.fn()
      .mockRejectedValueOnce(new ApiClientError(422, "invalid_completion", "Locked row", null, {
        rejectedKeys: [{
          tableId: rejectedPatch.tableId,
          rowItemId: rejectedPatch.rowItemId,
          columnItemId: rejectedPatch.columnItemId,
          periodKey: rejectedPatch.periodKey
        }]
      }))
      .mockResolvedValueOnce({ ok: true as const, versions: { sheets: [] } })
      .mockResolvedValueOnce({ ok: true as const, versions: { sheets: [] } });
    const coordinator = createBoardWriteCoordinator("user-1", { attachLifecycle: false, patch });
    coordinator.setAuthoritativeBase(emptyBoard);
    coordinator.enqueueCompletion(rejectedPatch);
    coordinator.enqueueCompletion(acceptedPatch);

    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });

    expect(patch).toHaveBeenCalledTimes(2);
    expect(coordinator.getSnapshot()).toMatchObject({
      hasPendingWrites: true,
      pendingWriteError: "Locked row"
    });
    expect(coordinator.getAuthoritativeBase()?.completions).toEqual([
      expect.objectContaining({ row_item_id: "row-2", completed: 1 })
    ]);

    coordinator.retryPendingWrites();
    expect(coordinator.getSnapshot()).toMatchObject({
      hasPendingWrites: true,
      pendingWriteError: "Locked row"
    });
    await expect(coordinator.flushPendingWrites()).resolves.toBeUndefined();
    expect(patch).toHaveBeenCalledTimes(3);
    expect(patch.mock.calls[2]?.[1]).toEqual({ patches: [rejectedPatch] });
    expect(coordinator.getSnapshot().pendingWriteError).toBeNull();
    coordinator.discardAndDispose();
  });

  it("keeps a permanently rejected retry blocked after making another network request", async () => {
    const rejectedPatch = {
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    };
    const patch = vi.fn(async (_path: string, _body: { patches: unknown[] }) => {
      throw new ApiClientError(422, "invalid_completion", "Still locked");
    });
    const coordinator = createBoardWriteCoordinator("user-1", { attachLifecycle: false, patch });
    coordinator.setAuthoritativeBase(emptyBoard);
    coordinator.enqueueCompletion(rejectedPatch);
    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });

    coordinator.retryPendingWrites();
    await expect(coordinator.flushPendingWrites()).rejects.toMatchObject({ reason: "rejected" });

    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1]?.[1]).toEqual({ patches: [rejectedPatch] });
    expect(coordinator.getSnapshot()).toMatchObject({
      hasPendingWrites: true,
      pendingWriteError: "Still locked"
    });
    coordinator.discardAndDispose();
  });

  it("clears the prior account overlay and queues before another account is constructed", () => {
    const first = createBoardWriteCoordinator("user-1", { attachLifecycle: false });
    first.setAuthoritativeBase(emptyBoard);
    first.enqueueCompletion({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15",
      completed: true
    });

    first.discardAndDispose();
    const second = createBoardWriteCoordinator("user-2", { attachLifecycle: false });

    expect(first.getSnapshot()).toEqual({ data: null, hasPendingWrites: false, pendingWriteError: null });
    expect(second.getSnapshot()).toEqual({ data: null, hasPendingWrites: false, pendingWriteError: null });
    second.discardAndDispose();
  });

  it("waits for both queues to settle before rejecting a failed flush", async () => {
    const completion = deferred<void>();
    const cellState = deferred<void>();
    const coordinator = createBoardWriteCoordinator("user-1", {
      attachLifecycle: false,
      queueOverrides: {
        completion: { flush: () => completion.promise },
        cellState: { flush: () => cellState.promise }
      }
    });
    let settled = false;
    const flushing = coordinator.flushPendingWrites().finally(() => {
      settled = true;
    });

    completion.reject(new Error("offline"));
    await Promise.resolve();
    expect(settled).toBe(false);
    cellState.resolve();

    await expect(flushing).rejects.toThrow("offline");
    coordinator.discardAndDispose();
  });
});
