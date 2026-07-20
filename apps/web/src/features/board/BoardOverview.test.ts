import { readFileSync } from "node:fs";
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as BoardOverviewModule from "./BoardOverview";
import {
  applyBoardTableSettingsToAxisItems,
  applyBoardAxisItemSaveToAxisItems,
  applyBoardCharacterSaveToAxisItems,
  BoardAxisItemEditModal,
  BoardCellMarkToolbar,
  BoardDisplayOptions,
  BoardOverview,
  BoardScheduleAdventureRow,
  BoardTableToolModal,
  BoardTableSettingsModal,
  BoardTableCreateModal,
  BoardTableGrid,
  BoardSheetSettingsModal,
  buildBoardNoteSavePatch,
  bringBoardTableToFront,
  getStoredBoardZoom,
  getBoardScheduleRowAvailable,
  getCharacterRefreshCooldownState,
  getBoardEventRewardFilterSummary,
  getMixedBoardDisplaySettingKeys,
  getEventRemainingMinutes,
  getLostArkAdventureRuleLabel,
  getLostArkScheduleCountdownLabel,
  getBoardEventNotificationDueItems,
  getBoardEventNotificationCurrentLabel,
  getBoardEventNotificationSettingsForMinuteSelection,
  getStoredBoardEventNotificationSettings,
  getRefreshableBoardCharacterIds,
  getBoardCellMarkTooltipContent,
  getBoardWriteLockRollback,
  isBoardInteractionLocked,
  normalizeBoardEventNotificationMinutes,
  parseBoardEventOptions,
  normalizeBoardZoom,
  runBoardAxisItemOperation,
  runBoardAxisItemSaveOperation,
  runOptimisticBoardWrite,
  shouldSaveBoardCharacterDetails
} from "./BoardOverview";
import { getBoardCellPeriodKey } from "./completions";
import { BoardMutationBarrierLockedError, createBoardMutationBarrier, type BoardMutationRunner } from "./mutationBarrier";
import type { BoardAxisItem, BoardPayload } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type BoardTableSettingsRequestInput = {
  name: string;
  defaultRowHeight: number;
  defaultColumnWidth: number;
  displaySettings: BoardPayload["settings"] | null;
  eventOptions?: { rewardFilters: Array<"gold" | "card" | "coin" | "silver" | "cardXp"> } | null | undefined;
  applyRowSize: boolean;
  applyColumnSize: boolean;
  locked: 0 | 1;
  characterSeparator?: { widthPx: number; style: "solid" | "dashed" | "dotted"; color: string } | null | undefined;
  characterDisplaySettings?: BoardPayload["settings"] | null | undefined;
};

type BoardAxisItemRequestInput = {
  label: string;
  taskColor?: string | null | undefined;
  taskResetType?: "daily" | "weekly" | "biweekly" | "none" | undefined;
  taskResetRuleJson?: string | undefined;
  separator?: { widthPx: number; style: "solid" | "dashed" | "dotted"; color: string } | null | undefined;
  sizePx?: number | null | undefined;
  crossSizePx?: number | null | undefined;
  displaySettings?: BoardPayload["settings"] | null | undefined;
  shouldUpdateDetails: boolean;
};

type SaveBoardTableSettingsRequest = (
  tableId: string,
  input: BoardTableSettingsRequestInput,
  applyLocal: () => void
) => Promise<void>;

type SaveBoardAxisItemRequest = (
  axisItemId: string,
  input: BoardAxisItemRequestInput,
  applyLocal: () => void
) => Promise<void>;

type BoardCharacterRefreshUpdatedResult = {
  id: string;
  status: "updated";
  character: {
    id?: string;
    name: string;
    serverName: string;
    className: string;
    itemLevel: string;
    combatPower: string | null;
  };
};

type BoardCharacterRefreshBatchResult =
  | BoardCharacterRefreshUpdatedResult
  | { id: string; status: "manual" | "not_found" | "not_available" }
  | { id: string; status: "rate_limited"; retryAfterSeconds: number }
  | { id: string; status: "failed"; code: string };

type ApplyBoardCharacterRefreshResults = (
  items: BoardAxisItem[],
  results: BoardCharacterRefreshUpdatedResult[]
) => BoardAxisItem[];

type RefreshBoardTableCharactersRequest = (
  characterIds: string[],
  applyUpdated: (results: BoardCharacterRefreshUpdatedResult[]) => void,
  postRequest?: (
    path: string,
    body: unknown
  ) => Promise<{
    results: BoardCharacterRefreshBatchResult[];
    versions: { sheets: Array<{ id: string; version: number }> };
  }>
) => Promise<{
  failedCount: number;
  failures?: Array<{
    code?: string;
    id: string;
    name?: string;
    reason: string;
    retryAfterSeconds?: number;
    status?: "manual" | "not_found" | "not_available" | "rate_limited" | "failed";
  }>;
  refreshedCount: number;
  totalCount: number;
}>;

function getSaveBoardTableSettingsRequest(): SaveBoardTableSettingsRequest {
  const candidate = (BoardOverviewModule as unknown as {
    saveBoardTableSettingsRequest?: SaveBoardTableSettingsRequest;
  }).saveBoardTableSettingsRequest;
  expect(candidate).toBeTypeOf("function");
  if (!candidate) throw new Error("saveBoardTableSettingsRequest is unavailable");
  return candidate;
}

function getSaveBoardAxisItemRequest(): SaveBoardAxisItemRequest {
  const candidate = (BoardOverviewModule as unknown as {
    saveBoardAxisItemRequest?: SaveBoardAxisItemRequest;
  }).saveBoardAxisItemRequest;
  expect(candidate).toBeTypeOf("function");
  if (!candidate) throw new Error("saveBoardAxisItemRequest is unavailable");
  return candidate;
}

function getApplyBoardCharacterRefreshResults(): ApplyBoardCharacterRefreshResults {
  const candidate = (BoardOverviewModule as unknown as {
    applyBoardCharacterRefreshResultsToAxisItems?: ApplyBoardCharacterRefreshResults;
  }).applyBoardCharacterRefreshResultsToAxisItems;
  expect(candidate).toBeTypeOf("function");
  if (!candidate) throw new Error("applyBoardCharacterRefreshResultsToAxisItems is unavailable");
  return candidate;
}

function getRefreshBoardTableCharactersRequest(): RefreshBoardTableCharactersRequest {
  const candidate = (BoardOverviewModule as unknown as {
    refreshBoardTableCharactersRequest?: RefreshBoardTableCharactersRequest;
  }).refreshBoardTableCharactersRequest;
  expect(candidate).toBeTypeOf("function");
  if (!candidate) throw new Error("refreshBoardTableCharactersRequest is unavailable");
  return candidate;
}

function getBoardCharacterNamesById(): (tableId: string, items: BoardAxisItem[]) => Map<string, string> {
  const candidate = (BoardOverviewModule as unknown as {
    getBoardCharacterNamesById?: (tableId: string, items: BoardAxisItem[]) => Map<string, string>;
  }).getBoardCharacterNamesById;
  expect(candidate).toBeTypeOf("function");
  if (!candidate) throw new Error("getBoardCharacterNamesById is unavailable");
  return candidate;
}

function getAddBoardCharacterRefreshFailureNames(): (
  summary: Awaited<ReturnType<RefreshBoardTableCharactersRequest>>,
  names: ReadonlyMap<string, string>
) => Awaited<ReturnType<RefreshBoardTableCharactersRequest>> {
  const candidate = (BoardOverviewModule as unknown as {
    addBoardCharacterRefreshFailureNames?: (
      summary: Awaited<ReturnType<RefreshBoardTableCharactersRequest>>,
      names: ReadonlyMap<string, string>
    ) => Awaited<ReturnType<RefreshBoardTableCharactersRequest>>;
  }).addBoardCharacterRefreshFailureNames;
  expect(candidate).toBeTypeOf("function");
  if (!candidate) throw new Error("addBoardCharacterRefreshFailureNames is unavailable");
  return candidate;
}

function getBoardCharacterRefreshFailureList(): (props: {
  failures: Array<{ id: string; name?: string; reason: string }>;
}) => ReactElement | null {
  const candidate = (BoardOverviewModule as unknown as {
    BoardCharacterRefreshFailureList?: (props: {
      failures: Array<{ id: string; name?: string; reason: string }>;
    }) => ReactElement | null;
  }).BoardCharacterRefreshFailureList;
  expect(candidate).toBeTypeOf("function");
  if (!candidate) throw new Error("BoardCharacterRefreshFailureList is unavailable");
  return candidate;
}

type BoardSheetTabsComponent = (props: {
  activeSheetId: string | null;
  onSheetSelected: (sheetId: string) => void;
  sheets: BoardPayload["sheets"];
}) => ReactElement;

function getBoardSheetTabs(): BoardSheetTabsComponent {
  const candidate = (BoardOverviewModule as unknown as {
    BoardSheetTabs?: BoardSheetTabsComponent;
  }).BoardSheetTabs;
  expect(candidate).toBeTypeOf("function");
  if (!candidate) throw new Error("BoardSheetTabs is unavailable");
  return candidate;
}

const board: BoardPayload = {
  userId: "user-1",
  settings: {
    show_display_name: 1,
    show_server_name: 0,
    show_class_name: 0,
    show_item_level: 1,
    show_combat_power: 0
  },
  sheets: [
    {
      id: "sheet-1",
      name: "기본",
      sort_order: 0,
      is_default: 1
    }
  ],
  tables: [
    {
      id: "table-1",
      sheet_id: "sheet-1",
      name: "숙제",
      sort_order: 0,
      x: 0,
      y: 0,
      width: null,
      height: null,
      row_role: "task",
      column_role: "character",
      task_axis: "rows",
      default_row_height: 40,
      default_column_width: 132,
      locked: 0
    }
  ],
  notes: [],
  axisItems: [
    {
      id: "row-task-1",
      table_id: "table-1",
      axis: "row",
      kind: "task",
      label: "쿠르잔 전선",
      character_id: null,
      task_id: "task-1",
      task_color: "#2563eb",
      task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
      size_px: null,
      sort_order: 0,
      visible: 1
    },
    {
      id: "column-character-1",
      table_id: "table-1",
      axis: "column",
      kind: "character",
      label: "냠수나이스1",
      character_id: "character-1",
      task_id: null,
      task_color: null,
      size_px: null,
      sort_order: 0,
      visible: 1
    }
  ],
  cellStates: [],
  completions: []
};

describe("BoardOverview", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("admits character metadata and axis detail save as one operation", async () => {
    const metadataRequest = deferred<void>();
    const events: string[] = [];
    const barrier = createBoardMutationBarrier();
    const save = runBoardAxisItemSaveOperation(
      barrier.run,
      async () => {
        events.push("metadata:start");
        await metadataRequest.promise;
        events.push("metadata:end");
      },
      async () => {
        events.push("axis:save");
      }
    );

    const drain = barrier.lockAndDrain();
    expect(events).toEqual(["metadata:start"]);
    metadataRequest.resolve();

    await save;
    await drain;
    expect(events).toEqual(["metadata:start", "metadata:end", "axis:save"]);
  });

  it("reports a failed axis follow-up through the admitted operation drain", async () => {
    const failure = new Error("axis size failed");
    const barrier = createBoardMutationBarrier();
    const save = runBoardAxisItemSaveOperation(
      barrier.run,
      async () => undefined,
      async () => {
        throw failure;
      }
    );
    const drain = barrier.lockAndDrain();

    await expect(save).rejects.toBe(failure);
    await expect(drain).rejects.toMatchObject({ errors: [failure] });
  });

  it.each(["refresh", "delete"])("admits axis item %s exactly once", async () => {
    const operation = vi.fn(async () => "done");
    const admission = vi.fn();
    const runMutation: BoardMutationRunner = async (admitted) => {
      admission();
      return admitted();
    };

    await expect(runBoardAxisItemOperation(runMutation, operation)).resolves.toBe("done");

    expect(admission).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("saves 97-item table settings with one HTTP request and applies local state after success", async () => {
    const saveBoardTableSettingsRequest = getSaveBoardTableSettingsRequest();
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const axisItems: BoardAxisItem[] = Array.from({ length: 97 }, (_, index) => {
      const row = index % 2 === 0;
      return {
        ...(row ? board.axisItems[0]! : board.axisItems[1]!),
        id: `table-axis-${index}`,
        axis: row ? "row" : "column",
        kind: row ? "task" : "character",
        sort_order: index * 10,
        size_px: null,
        separator_json: null,
        display_options_json: null,
        visible: 1
      };
    });
    const displaySettings: BoardPayload["settings"] = {
      show_display_name: 1,
      show_server_name: 1,
      show_class_name: 1,
      show_item_level: 1,
      show_combat_power: 1
    };
    const input: BoardTableSettingsRequestInput = {
      name: "Weekly",
      defaultRowHeight: 52,
      defaultColumnWidth: 148,
      displaySettings,
      eventOptions: { rewardFilters: ["gold", "card"] },
      applyRowSize: true,
      applyColumnSize: true,
      locked: 0,
      characterSeparator: { widthPx: 4, style: "dashed", color: "#334455" },
      characterDisplaySettings: displaySettings
    };
    let localAxisItems = axisItems;

    const pending = saveBoardTableSettingsRequest("table-1", input, () => {
      localAxisItems = applyBoardTableSettingsToAxisItems(localAxisItems, "table-1", {
        defaultRowHeight: input.defaultRowHeight,
        defaultColumnWidth: input.defaultColumnWidth,
        displaySettings: input.characterDisplaySettings,
        applyRowSize: input.applyRowSize,
        applyColumnSize: input.applyColumnSize,
        characterSeparator: input.characterSeparator
      });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localAxisItems).toBe(axisItems);
    const [path, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/board/tables/table-1");
    expect(request.method).toBe("PATCH");
    expect(JSON.parse(String(request.body))).toEqual(input);

    response.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    await pending;

    expect(localAxisItems).not.toBe(axisItems);
    expect(localAxisItems).toHaveLength(97);
    expect(localAxisItems.filter((item) => item.axis === "row").every((item) => item.size_px === 52)).toBe(true);
    expect(localAxisItems.filter((item) => item.axis === "column").every((item) => item.size_px === 148)).toBe(true);
    expect(localAxisItems.filter((item) => item.kind === "character").every((item) =>
      item.separator_json === JSON.stringify(input.characterSeparator) &&
      item.display_options_json === JSON.stringify(displaySettings)
    )).toBe(true);
  });

  it("keeps table settings local state unchanged when the single request fails", async () => {
    const saveBoardTableSettingsRequest = getSaveBoardTableSettingsRequest();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "request_failed", message: "failed" }
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const applyLocal = vi.fn();

    await expect(saveBoardTableSettingsRequest("table-1", {
      name: "Weekly",
      defaultRowHeight: 52,
      defaultColumnWidth: 148,
      displaySettings: null,
      applyRowSize: true,
      applyColumnSize: true,
      locked: 0,
      characterSeparator: null,
      characterDisplaySettings: null
    }, applyLocal)).rejects.toThrow("failed");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(applyLocal).not.toHaveBeenCalled();
  });

  it("saves axis details and 97-item cross sizing with one HTTP request", async () => {
    const saveBoardAxisItemRequest = getSaveBoardAxisItemRequest();
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const axisItems: BoardAxisItem[] = Array.from({ length: 97 }, (_, index) => ({
      ...board.axisItems[0]!,
      id: `row-peer-${index}`,
      table_id: "table-1",
      axis: "row",
      kind: "task",
      label: `Peer ${index}`,
      sort_order: index * 10,
      size_px: null,
      cross_size_px: null,
      visible: 1
    }));
    const input: BoardAxisItemRequestInput = {
      label: "Updated",
      taskColor: "#334455",
      taskResetType: "weekly",
      taskResetRuleJson: '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}',
      separator: { widthPx: 3, style: "solid", color: "#112233" },
      sizePx: 44,
      crossSizePx: 96,
      displaySettings: board.settings,
      shouldUpdateDetails: true
    };
    let localAxisItems = axisItems;

    const pending = saveBoardAxisItemRequest("row-peer-0", input, () => {
      localAxisItems = applyBoardAxisItemSaveToAxisItems(localAxisItems, {
        axisItemId: "row-peer-0",
        ...input
      });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localAxisItems).toBe(axisItems);
    const [path, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/board/axis-items/row-peer-0");
    expect(JSON.parse(String(request.body))).toEqual({
      label: "Updated",
      taskColor: "#334455",
      taskResetType: "weekly",
      separator: { widthPx: 3, style: "solid", color: "#112233" },
      sizePx: 44,
      crossSizePx: 96,
      displaySettings: board.settings
    });

    response.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    await pending;

    expect(localAxisItems).toHaveLength(97);
    expect(localAxisItems.every((item) => item.cross_size_px === 96)).toBe(true);
    expect(localAxisItems[0]).toMatchObject({ label: "Updated", size_px: 44, task_color: "#334455" });
    expect(localAxisItems[1]?.size_px).toBeNull();
  });

  it("sends only sizes when axis details should not be updated", async () => {
    const saveBoardAxisItemRequest = getSaveBoardAxisItemRequest();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const axisItems: BoardAxisItem[] = [
      { ...board.axisItems[0]!, id: "row-1", label: "Original", task_color: "#112233", size_px: 40, cross_size_px: 80 },
      { ...board.axisItems[0]!, id: "row-2", label: "Peer", size_px: 40, cross_size_px: 80, sort_order: 10 }
    ];
    const input: BoardAxisItemRequestInput = {
      label: "Must not be sent",
      taskColor: "#abcdef",
      taskResetType: "weekly",
      separator: null,
      sizePx: 48,
      crossSizePx: 120,
      displaySettings: board.settings,
      shouldUpdateDetails: false
    };
    let localAxisItems = axisItems;

    await saveBoardAxisItemRequest("row-1", input, () => {
      localAxisItems = applyBoardAxisItemSaveToAxisItems(localAxisItems, {
        axisItemId: "row-1",
        ...input
      });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({ sizePx: 48, crossSizePx: 120 });
    expect(localAxisItems[0]).toMatchObject({
      label: "Original",
      task_color: "#112233",
      size_px: 48,
      cross_size_px: 120
    });
    expect(localAxisItems[1]).toMatchObject({ label: "Peer", size_px: 40, cross_size_px: 120 });
  });

  it("caches note input values before updating note state", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(source).not.toMatch(/setNotes\(\(current\) => current\.map\([\s\S]{0,240}event\.currentTarget\.value/);
  });

  it("does not render a shared rice bin read-only tab label", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("공유 쌀통 읽기 전용");
    expect(source).not.toContain("shared-readonly-badge");
  });

  it("delegates completion and cell-state persistence to owner-scoped enqueue callbacks", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(source).toContain("enqueueCompletion");
    expect(source).toContain("enqueueCellState");
    expect(source).not.toContain("useBoardCompletionQueue");
    expect(source).not.toContain('apiPatch("/api/board/cell-states"');
    expect(source).not.toContain("pendingCompletionPatchesRef");
    expect(source).not.toMatch(/handleCellMarkPaint[\s\S]{0,2200}refreshBoard\(\)/);
  });

  it("builds note save requests from only the fields the user changed", () => {
    const note = {
      id: "note-1",
      sheet_id: "sheet-1",
      title: "레이드 메모",
      body: "20분 전 본문",
      color: "#fef3c7",
      sort_order: 0,
      x: 0,
      y: 0,
      width: 220,
      height: 160,
      locked: 0
    };

    expect(buildBoardNoteSavePatch(note, { body: "새 본문" })).toEqual({ body: "새 본문" });
    expect(buildBoardNoteSavePatch(note, { color: "#fee2e2" })).toEqual({ color: "#fee2e2" });
    expect(buildBoardNoteSavePatch(note, { title: "  " })).toEqual({ title: "메모" });
  });

  it("normalizes board zoom to safe 5 percent increments from local storage", () => {
    expect(normalizeBoardZoom(100)).toBe(100);
    expect(normalizeBoardZoom(137)).toBe(135);
    expect(normalizeBoardZoom(138)).toBe(140);
    expect(normalizeBoardZoom(10)).toBe(50);
    expect(normalizeBoardZoom(300)).toBe(150);
    expect(normalizeBoardZoom("abc")).toBe(100);
    expect(getStoredBoardZoom({ getItem: () => "125" })).toBe(125);
  });

  it("calculates event countdown from the current KST clock instead of freezing server minutes", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(getEventRemainingMinutes("20:00", new Date("2026-06-04T19:17:00+09:00"))).toBe(43);
    expect(getEventRemainingMinutes("20:00", new Date("2026-06-04T19:59:00+09:00"))).toBe(1);
    expect(getEventRemainingMinutes("20:00", new Date("2026-06-04T20:00:00+09:00"))).toBe(0);
    expect(getEventRemainingMinutes("00:00", new Date("2026-06-04T23:30:00+09:00"))).toBe(30);
    expect(getEventRemainingMinutes("01:03", new Date("2026-06-05T00:30:00+09:00"))).toBe(33);
    expect(getEventRemainingMinutes(null, new Date("2026-06-04T19:17:00+09:00"))).toBeNull();
    expect(source).toContain("BOARD_EVENT_COUNTDOWN_REFRESH_MS");
    expect(source).toContain("window.setInterval");
    expect(source).toContain('window.addEventListener("focus", updateEventNow);');
    expect(source).toContain('document.addEventListener("visibilitychange", handleVisibilityChange);');
    expect(source).toContain("getEventRemainingMinutes(summary.nextTime, now)");
    expect(source).not.toContain("formatEventRemaining(summary.remainingMinutes)");
  });

  it("formats Lost Ark schedule information like the schedule mockup", () => {
    expect(getLostArkScheduleCountdownLabel("카게", "20:00", new Date("2026-06-04T19:17:00+09:00"))).toBe("카게 20:00 · 43분 남음");
    expect(getLostArkScheduleCountdownLabel("필보", null, new Date("2026-06-04T19:17:00+09:00"))).toBe("필보 오늘 남은 시간 없음");
    expect(getLostArkAdventureRuleLabel("11/13/19/21/23 전체에서 하루 1회 획득 가능")).toBe("일일 1회");
    expect(getLostArkAdventureRuleLabel("9/11/13 중 1회, 19/21/23 중 1회 획득 가능")).toBe("일일 2회");
    expect(parseBoardEventOptions(null).rewardFilters).toEqual(["gold", "card", "coin", "silver", "cardXp"]);
    expect(parseBoardEventOptions(JSON.stringify({ rewardFilters: [] })).rewardFilters).toEqual([]);
    expect(getBoardEventRewardFilterSummary(["gold", "card", "coin", "silver", "cardXp"])).toBe("전부");
    expect(getBoardEventRewardFilterSummary(["gold", "card"])).toBe("쌀(골드) / 카드 팩");
  });

  it("normalizes schedule notification settings from local storage", () => {
    expect(normalizeBoardEventNotificationMinutes([10, 5, 10, 0, 181, "12", "abc", 3.6])).toEqual([12]);
    expect(normalizeBoardEventNotificationMinutes([])).toEqual([5]);
    expect(getBoardEventNotificationCurrentLabel({ enabled: false, leadMinutes: [12] })).toBe("현재 설정: 12분 전");
    expect(getBoardEventNotificationSettingsForMinuteSelection({ enabled: false, leadMinutes: [5] }, 10, "granted")).toEqual({
      enabled: true,
      leadMinutes: [10]
    });
    expect(getBoardEventNotificationSettingsForMinuteSelection({ enabled: true, leadMinutes: [5] }, 10, "denied")).toEqual({
      enabled: false,
      leadMinutes: [10]
    });
    expect(getStoredBoardEventNotificationSettings({ getItem: () => null }, "table-1")).toEqual({
      enabled: false,
      leadMinutes: [5]
    });
    expect(
      getStoredBoardEventNotificationSettings(
        {
          getItem: () => JSON.stringify({ enabled: true, leadMinutes: [10, "7", 999] })
        },
        "table-1"
      )
    ).toEqual({
      enabled: true,
      leadMinutes: [10]
    });
  });

  it("detects due schedule notifications for the selected lead minute", () => {
    const summary = {
      adventureIsland: {
        entries: [
          {
            claimLabel: "일일 1회",
            continent: "베른 남부",
            futureTimes: ["20:05"],
            islandName: "블루홀 섬",
            rewards: ["카드 팩"],
            slotLabel: "일일 보상"
          }
        ],
        endedRewardLabels: [],
        nextTime: "20:00",
        remainingMinutes: 10,
        rewardLabels: ["카드 팩"],
        rule: "11/13/19/21/23 전체에서 하루 1회 획득 가능"
      },
      chaosGate: {
        available: true,
        detail: null,
        futureTimes: ["20:00"],
        nextTime: "20:00",
        remainingMinutes: 10
      },
      fieldBoss: {
        available: false,
        detail: null,
        futureTimes: [],
        nextTime: null,
        remainingMinutes: null
      },
      today: "2026-06-04"
    };

    const dueItems = getBoardEventNotificationDueItems({
      now: new Date("2026-06-04T19:50:00+09:00"),
      sentKeys: new Set(),
      settings: { enabled: true, leadMinutes: [10] },
      summary,
      tableId: "table-1"
    });

    expect(dueItems.map((item) => item.label)).toEqual(["카게", "모험섬"]);
    expect(dueItems[0]?.title).toBe("카게 10분 전");
    expect(dueItems[1]?.body).toContain("블루홀 섬 · 카드 팩");
    expect(
      getBoardEventNotificationDueItems({
        now: new Date("2026-06-04T19:51:00+09:00"),
        sentKeys: new Set(),
        settings: { enabled: true, leadMinutes: [10] },
        summary,
        tableId: "table-1"
      }).map((item) => item.label)
    ).toContain("카게");
    expect(
      getBoardEventNotificationDueItems({
        now: new Date("2026-06-04T19:50:00+09:00"),
        sentKeys: new Set(dueItems.map((item) => item.sentKey)),
        settings: { enabled: true, leadMinutes: [10] },
        summary,
        tableId: "table-1"
      })
    ).toEqual([]);
    const followUpDueItems = getBoardEventNotificationDueItems({
      now: new Date("2026-06-04T19:55:00+09:00"),
      sentKeys: new Set([dueItems[0]!.sentKey]),
      settings: { enabled: true, leadMinutes: [5] },
      summary,
      tableId: "table-1"
    });
    expect(followUpDueItems.map((item) => item.label)).not.toContain("카게");
  });

  it("renders adventure island details on separate lines without duplicate daily claim text", () => {
    const html = renderToStaticMarkup(
      createElement(BoardScheduleAdventureRow, {
        color: "#7c3aed",
        now: new Date("2026-06-05T18:30:00+09:00"),
        rewardFilters: ["gold", "card", "coin", "silver", "cardXp"],
        summary: {
          entries: [
            {
              claimLabel: "일일 1회",
              continent: "베른 남부",
              futureTimes: ["19:00", "21:00", "23:00"],
              islandName: "블루홀 섬",
              rewards: ["카드 팩"],
              slotLabel: "일일 보상"
            }
          ],
          endedRewardLabels: [],
          nextTime: "19:00",
          remainingMinutes: 30,
          rewardLabels: ["카드 팩"],
          rule: "11/13/19/21/23 전체에서 하루 1회 획득 가능"
        }
      })
    );

    expect(html.match(/일일 1회/g)).toHaveLength(1);
    expect(html).toContain("블루홀 섬 · 카드 팩");
    expect(html).toContain("가까운 대륙: 베른 남부");
    expect(html).toContain("19:00, 21:00, 23:00");
    expect(html).not.toContain("19:00, 21:00, 23:00 · 가까운 대륙");
    expect(html).toContain("board-schedule-island-continent");
    expect(html).toContain("board-schedule-island-times");
  });

  it("marks unavailable schedule rows so their checkboxes can be disabled", () => {
    const summary = {
      adventureIsland: {
        entries: [],
        endedRewardLabels: [],
        nextTime: null,
        remainingMinutes: null,
        rewardLabels: [],
        rule: "11/13/19/21/23 전체에서 하루 1회 획득 가능"
      },
      chaosGate: {
        available: false,
        detail: null,
        futureTimes: [],
        nextTime: null,
        remainingMinutes: null
      },
      fieldBoss: {
        available: true,
        detail: null,
        futureTimes: ["19:00"],
        nextTime: "19:00",
        remainingMinutes: 30
      },
      today: "2026-06-05"
    };

    expect(getBoardScheduleRowAvailable("카게", summary)).toBe(false);
    expect(getBoardScheduleRowAvailable("필보", summary)).toBe(true);
    expect(getBoardScheduleRowAvailable("모험섬", summary)).toBe(false);
    expect(getBoardScheduleRowAvailable("기타", summary)).toBe(true);
    expect(getBoardScheduleRowAvailable("카게", null)).toBe(true);

    expect(
      getBoardScheduleRowAvailable("모험섬", {
        ...summary,
        adventureIsland: {
          entries: [],
          endedRewardLabels: ["일일 1회 카드 팩"],
          nextTime: null,
          remainingMinutes: null,
          rewardLabels: [],
          rule: "11/13/19/21/23 전체에서 하루 1회 획득 가능"
        }
      })
    ).toBe(true);
  });

  it("brings newly created tables and notes to the front as soon as they are created", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(source).toMatch(/const table = await apiPost<\{ id: string \}>\("\/api\/board\/tables"[\s\S]{0,500}bringCreatedBoardItemToFront\(table\.id\)/);
    expect(source).toMatch(/const note = await apiPost<\{ id: string \}>\("\/api\/board\/notes"[\s\S]{0,500}bringCreatedBoardItemToFront\(note\.id\)/);
  });

  it("renders shared boards as read-only without editing controls", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board: { ...board, readOnly: true } }));

    expect(html).not.toContain("공유 쌀통 읽기 전용");
    expect(html).not.toContain("표 추가");
    expect(html).not.toContain("메모 추가");
    expect(html).not.toContain("탭 설정");
    expect(html).not.toContain("캐릭터 추가");
    expect(html).not.toContain("숙제 추가");
  });

  it("visibly locks owner board editing while logout is pending", () => {
    expect(isBoardInteractionLocked({ readOnly: false, boardReadOnly: false, writeLocked: true })).toBe(true);

    const html = renderToStaticMarkup(createElement(BoardOverview, { board, writeLocked: true }));

    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("로그아웃 중에는 보드를 편집할 수 없습니다.");
    expect(html).not.toContain("표 추가");
    expect(html).not.toContain("메모 추가");
    expect(html).not.toContain("탭 설정");
    expect(html).toMatch(/aria-label="쿠르잔 전선 \/ 냠수나이스1" class="board-check" disabled=""/);
  });

  it("restores authoritative layout and note drafts when the write lock activates", () => {
    const authoritative = {
      ...board,
      notes: [{
        id: "note-1",
        sheet_id: "sheet-1",
        title: "Saved title",
        body: "Saved body",
        color: "#ffffff",
        sort_order: 0,
        x: 20,
        y: 30,
        width: 240,
        height: 160,
        locked: 0
      }]
    };
    const localDraft = {
      axisItems: [],
      tables: authoritative.tables.map((table) => ({ ...table, x: 500, y: 600 })),
      notes: authoritative.notes.map((note) => ({
        ...note,
        title: "Unsaved title",
        body: "Unsaved body",
        x: 700,
        width: 900
      }))
    };

    expect(getBoardWriteLockRollback(authoritative, localDraft)).toEqual({
      axisItems: authoritative.axisItems,
      tables: authoritative.tables,
      notes: authoritative.notes
    });
  });

  it("suppresses optimistic queued edits after the logout barrier locks", async () => {
    const barrier = createBoardMutationBarrier();
    const apply = vi.fn();
    const enqueue = vi.fn();
    await barrier.lockAndDrain();

    await expect(
      runOptimisticBoardWrite(barrier.run, { completed: true }, apply, enqueue)
    ).rejects.toBeInstanceOf(BoardMutationBarrierLockedError);

    expect(apply).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("disables grid checkboxes in read-only board grids", () => {
    const html = renderToStaticMarkup(
      createElement(BoardTableGrid, {
        axisItems: board.axisItems,
        cellStates: board.cellStates,
        completions: board.completions,
        readOnly: true,
        table: board.tables[0]!,
        onToggle: vi.fn(),
        settings: board.settings
      })
    );

    expect(html).toContain('class="board-check"');
    expect(html).toContain("disabled");
  });

  it("keeps table-level character refresh inside the character tool modal instead of the table menu", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");
    const modalHtml = renderToStaticMarkup(
      createElement(BoardTableToolModal, {
        isRefreshingCharacters: false,
        onClose: vi.fn(),
        onRefreshCharacters: async () => ({ failedCount: 0, refreshedCount: 1, totalCount: 1 }),
        onSaved: vi.fn(),
        refreshableCharacterCount: 1,
        table: board.tables[0]!,
        tool: "characters"
      })
    );

    expect(html).not.toContain("캐릭터 정보 일괄 업데이트");
    expect(modalHtml).toContain("캐릭터 정보 일괄 업데이트");
    expect(modalHtml).toContain("가져온 캐릭터 1명");
    expect(source).toContain("onRefreshCharacters={() => handleRefreshTableCharacters(activeTableTool.table)}");
  });

  it("renders batch refresh failure names and reasons as a semantic list", () => {
    const FailureList = getBoardCharacterRefreshFailureList();
    const html = renderToStaticMarkup(createElement(FailureList, {
      failures: [
        { id: "character-1", name: "냠수나이스1", reason: "17초 뒤 다시 시도해주세요." },
        { id: "character-2", name: "펄쩍수빈", reason: "일시적인 API 오류입니다." }
      ]
    }));

    expect(html).toContain('class="board-character-refresh-failures"');
    expect(html).toContain('aria-label="업데이트 실패 캐릭터"');
    expect(html).toContain("냠수나이스1");
    expect(html).toContain("17초 뒤 다시 시도해주세요.");
    expect(html).toContain("펄쩍수빈");
    expect(html).toContain("일시적인 API 오류입니다.");
    expect(html.match(/<li/g)).toHaveLength(2);
  });

  it("wires the latest batch failures into the character update panel", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(source).toContain("const [refreshFailures, setRefreshFailures]");
    expect(source).toContain("setRefreshFailures(result.failures ?? [])");
    expect(source).toContain("<BoardCharacterRefreshFailureList failures={refreshFailures} />");
    expect(source.match(/setRefreshFailures\(\[\]\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("collects only refreshable imported characters from the selected table", () => {
    expect(
      getRefreshableBoardCharacterIds("table-1", [
        {
          ...board.axisItems[1]!,
          character_id: "character-1",
          character_source: "lostark"
        },
        {
          ...board.axisItems[1]!,
          id: "column-character-duplicate",
          character_id: "character-1",
          character_source: "lostark",
          sort_order: 10
        },
        {
          ...board.axisItems[1]!,
          id: "manual-character",
          character_id: "character-manual",
          character_source: "manual",
          sort_order: 20
        },
        {
          ...board.axisItems[1]!,
          id: "other-table-character",
          table_id: "table-2",
          character_id: "character-2",
          character_source: "lostark",
          sort_order: 30
        }
      ])
    ).toEqual(["character-1"]);
  });

  it("maps each current-table character id to one visible name", () => {
    const items: BoardAxisItem[] = [
      {
        ...board.axisItems[1]!,
        character_id: "character-1",
        character_name: "냠냠수빈"
      },
      {
        ...board.axisItems[1]!,
        id: "character-1-reference",
        character_id: "character-1",
        character_name: "다른표시",
        sort_order: 10
      },
      {
        ...board.axisItems[1]!,
        id: "character-2",
        character_id: "character-2",
        character_name: "펄쩍수빈",
        sort_order: 20
      },
      {
        ...board.axisItems[1]!,
        id: "other-table-character",
        table_id: "table-2",
        character_id: "character-3",
        character_name: "다른표캐릭터"
      }
    ];

    expect(getBoardCharacterNamesById()("table-1", items)).toEqual(new Map([
      ["character-1", "냠냠수빈"],
      ["character-2", "펄쩍수빈"]
    ]));
  });

  it("adds visible names to batch refresh failures and falls back to the id", () => {
    expect(getAddBoardCharacterRefreshFailureNames()({
      failedCount: 2,
      failures: [
        { id: "character-1", reason: "17초 뒤 다시 시도해주세요.", retryAfterSeconds: 17, status: "rate_limited" },
        { id: "missing-character", reason: "저장된 캐릭터를 찾을 수 없습니다.", status: "not_found" }
      ],
      refreshedCount: 1,
      totalCount: 3
    }, new Map([["character-1", "냠냠수빈"]]))).toEqual({
      failedCount: 2,
      failures: [
        { id: "character-1", name: "냠냠수빈", reason: "17초 뒤 다시 시도해주세요.", retryAfterSeconds: 17, status: "rate_limited" },
        { id: "missing-character", name: "missing-character", reason: "저장된 캐릭터를 찾을 수 없습니다.", status: "not_found" }
      ],
      refreshedCount: 1,
      totalCount: 3
    });
  });

  it("refreshes 20 table characters with one batch request and applies every reference only after success", async () => {
    const refreshBoardTableCharactersRequest = getRefreshBoardTableCharactersRequest();
    const applyBoardCharacterRefreshResults = getApplyBoardCharacterRefreshResults();
    const characterIds = Array.from({ length: 20 }, (_, index) => `character-${index}`);
    const originalItems: BoardAxisItem[] = [
      ...characterIds.map((characterId, index) => ({
        ...board.axisItems[1]!,
        id: `axis-${index}`,
        character_id: characterId,
        character_name: `old-${index}`,
        character_class_name: "브레이커",
        character_item_level: "1,640.00",
        character_combat_power: "2,500.00",
        character_source: "lostark" as const,
        sort_order: index * 10
      })),
      {
        ...board.axisItems[1]!,
        id: "axis-character-0-reference",
        table_id: "table-2",
        character_id: "character-0",
        character_name: "old-reference",
        character_source: "lostark",
        sort_order: 0
      }
    ];
    const results: BoardCharacterRefreshUpdatedResult[] = characterIds.map((id, index) => ({
      id,
      status: "updated",
      character: {
        id,
        name: `updated-${index}`,
        serverName: index % 2 === 0 ? "아만" : "카단",
        className: "환수사",
        itemLevel: "1,700.00",
        combatPower: "3,000.00",
        itemLevelPinned: index % 2 === 0,
        combatPowerPinned: index % 2 !== 0
      }
    }));
    const response = deferred<{
      results: BoardCharacterRefreshBatchResult[];
      versions: { sheets: Array<{ id: string; version: number }> };
    }>();
    const postRequest = vi.fn((_path: string, _body: unknown) => response.promise);
    let localItems = originalItems;

    const refresh = refreshBoardTableCharactersRequest(
      characterIds,
      (updated) => {
        localItems = applyBoardCharacterRefreshResults(localItems, updated);
      },
      postRequest
    );

    expect(postRequest).toHaveBeenCalledTimes(1);
    expect(postRequest).toHaveBeenCalledWith("/api/characters/refresh-batch", { characterIds });
    expect(postRequest.mock.calls[0]?.[0]).not.toContain("/siblings");
    expect(postRequest.mock.calls[0]?.[0]).not.toMatch(/\/characters\/[^/]+\/refresh$/);
    expect(localItems).toBe(originalItems);

    response.resolve({ results, versions: { sheets: [{ id: "sheet-1", version: 8 }] } });
    await expect(refresh).resolves.toEqual({ failedCount: 0, refreshedCount: 20, totalCount: 20 });
    expect(localItems).not.toBe(originalItems);
    expect(localItems.filter((item) => item.character_id === "character-0")).toEqual([
      expect.objectContaining({
        id: "axis-0",
        label: "updated-0",
        character_name: "updated-0",
        character_class_name: "환수사",
        character_item_level: "1,700.00",
        character_combat_power: "3,000.00",
        character_item_level_pinned: 1,
        character_combat_power_pinned: 0
      }),
      expect.objectContaining({
        id: "axis-character-0-reference",
        label: "updated-0",
        character_name: "updated-0"
      })
    ]);
  });

  it("applies saved stat pins to every axis reference for the character", () => {
    const references = [
      { ...board.axisItems[1]!, character_id: "character-1" },
      {
        ...board.axisItems[1]!,
        id: "character-reference",
        table_id: "table-2",
        character_id: "character-1"
      }
    ];

    expect(applyBoardCharacterSaveToAxisItems(
      references,
      "character-1",
      {
        displayName: "서폿",
        itemLevel: "1,700.00",
        combatPower: "3,000.00",
        itemLevelPinned: true,
        combatPowerPinned: false
      },
      { itemLevelPinned: true, combatPowerPinned: false }
    )).toEqual(references.map((item) => expect.objectContaining({
      id: item.id,
      character_display_name: "서폿",
      character_item_level: "1,700.00",
      character_combat_power: "3,000.00",
      character_item_level_pinned: 1,
      character_combat_power_pinned: 0
    })));
  });

  it("keeps local character state untouched when the batch request fails", async () => {
    const applyLocal = vi.fn();
    const failure = new Error("batch unavailable");

    await expect(
      getRefreshBoardTableCharactersRequest()(
        ["character-1"],
        applyLocal,
        vi.fn(async () => {
          throw failure;
        })
      )
    ).rejects.toBe(failure);
    expect(applyLocal).not.toHaveBeenCalled();
  });

  it("derives refreshed and failed counts from mixed batch statuses", async () => {
    const results: BoardCharacterRefreshBatchResult[] = [
      {
        id: "updated",
        status: "updated",
        character: {
          id: "updated",
          name: "업데이트",
          serverName: "아만",
          className: "환수사",
          itemLevel: "1,700.00",
          combatPower: "3,000.00"
        }
      },
      { id: "manual", status: "manual" },
      { id: "missing", status: "not_found" },
      { id: "unavailable", status: "not_available" },
      { id: "rate", status: "rate_limited", retryAfterSeconds: 17 },
      { id: "failed", status: "failed", code: "lostark_api_error" }
    ];
    const applyLocal = vi.fn();

    await expect(
      getRefreshBoardTableCharactersRequest()(
        results.map((result) => result.id),
        applyLocal,
        vi.fn(async () => ({ results, versions: { sheets: [] } }))
      )
    ).resolves.toEqual({
      failedCount: 5,
      failures: [
        { id: "manual", reason: "수동 캐릭터는 자동 갱신할 수 없습니다.", status: "manual" },
        { id: "missing", reason: "저장된 캐릭터를 찾을 수 없습니다.", status: "not_found" },
        { id: "unavailable", reason: "로스트아크에서 캐릭터 정보를 찾지 못했습니다.", status: "not_available" },
        { id: "rate", reason: "17초 뒤 다시 시도해주세요.", retryAfterSeconds: 17, status: "rate_limited" },
        { code: "lostark_api_error", id: "failed", reason: "일시적인 API 오류입니다.", status: "failed" }
      ],
      refreshedCount: 1,
      totalCount: 6
    });
    expect(applyLocal).toHaveBeenCalledWith([results[0]]);
  });

  it("handles the 40-character API limit without sending a partial table refresh", async () => {
    const postRequest = vi.fn();
    const applyLocal = vi.fn();
    const characterIds = Array.from({ length: 41 }, (_, index) => `character-${index}`);

    await expect(
      getRefreshBoardTableCharactersRequest()(characterIds, applyLocal, postRequest)
    ).resolves.toEqual({
      failedCount: 41,
      refreshedCount: 0,
      totalCount: 41,
      message: "캐릭터 정보는 한 번에 최대 40명까지 갱신할 수 있습니다."
    });
    expect(postRequest).not.toHaveBeenCalled();
    expect(applyLocal).not.toHaveBeenCalled();
  });

  it("surfaces the 40-character refresh limit directly in the character tool modal", () => {
    const html = renderToStaticMarkup(
      createElement(BoardTableToolModal, {
        isRefreshingCharacters: false,
        onClose: vi.fn(),
        onRefreshCharacters: async () => ({ failedCount: 41, refreshedCount: 0, totalCount: 41 }),
        onSaved: vi.fn(),
        refreshableCharacterCount: 41,
        table: board.tables[0]!,
        tool: "characters"
      })
    );

    expect(html).toContain("캐릭터 정보는 한 번에 최대 40명까지 갱신할 수 있습니다.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*업데이트[\s\S]*<\/button>/);
  });

  it("catches modal refresh failures while the table owner clears its pending state", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(source).toMatch(
      /async function refreshCharacters\(\)[\s\S]{0,700}try \{[\s\S]{0,300}await onRefreshCharacters\(\)[\s\S]{0,700}catch \{[\s\S]{0,300}캐릭터 정보를 업데이트하지 못했습니다/
    );
    expect(source).toMatch(
      /async function handleRefreshTableCharacters[\s\S]{0,1800}finally \{[\s\S]{0,120}setRefreshingCharacterTableId\(null\)/
    );
  });

  it("offers a Lost Ark event table template from the table creation flow", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(source).toContain("카게/필보/모험섬 표");
    expect(source).toContain('templateType: "lostark_event"');
    expect(source).toContain("LOST_ARK_EVENT_TABLE_ROWS");
    expect(source).toContain("스케줄");
    expect(source).toContain("완료");
    expect(source).not.toContain('setTableName("이벤트")');
    expect(source).not.toContain('LOST_ARK_EVENT_TABLE_DEFAULT_COMPLETION_COLUMN = "본계정"');
    expect(source).toContain("쌀(골드)");
    expect(source).toContain("쌀섬만 보기");
    expect(source).toContain("완료 열 추가");
    expect(source).toContain("board-schedule-row-label");
    expect(source).toContain("board-schedule-island-list");
    expect(source).toContain("board-schedule-interest");
    expect(source).toContain('row.label === "모험섬" && eventOptions.rewardFilters.length === 0');
    expect(source).toContain("eventOptions.rewardFilters");
    expect(source).toContain("rewardFilters={rewardFilters}");
    expect(source).toContain('className="board-table-menu-wrap"');
    expect(source).toContain('className="board-table-lock-button"');
    expect(source).not.toContain("{summary.detail ? <small>{summary.detail}</small> : null}");
    expect(source).not.toContain("{locked ? \"해제\" : \"잠금\"}");
    expect(source).not.toContain("{entry.claimLabel} · {entry.slotLabel} · {entry.islandName} · {entry.rewards.join(\", \")}");
    expect(source).toContain("{entry.islandName} · {entry.rewards.join(\", \")}");
  });

  it("closes open board menus from outside clicks and Escape while keeping menu clicks inside", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(source).toContain('document.addEventListener("pointerdown", handleBoardMenuDocumentPointerDown);');
    expect(source).toContain('document.addEventListener("keydown", handleBoardMenuDocumentKeyDown);');
    expect(source).toContain('.closest(".board-note-menu-wrap")');
    expect(source).toContain('.closest(".board-table-menu-wrap")');
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("setOpenTableMenuId(null);");
    expect(source).toMatch(/setOpenNoteMenuId\(null\);[\s\S]{0,180}handleNoteSave\(note\.id, \{ locked/);
  });

  it("keeps open note menus visible and front-most even on tiny memo cards", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(source).toContain('openNoteMenuId === note.id ? " menu-open" : ""');
    expect(source).toMatch(/className="board-note-menu-button"[\s\S]{0,360}bringNoteToFront\(note\.id\)/);
  });

  it("renders sheet tabs and content-sized table summaries from board payload", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain("기본");
    expect(html).toContain("숙제");
    expect(html).toContain("탭 설정");
    expect(html).not.toContain("분류");
    expect(html).not.toContain("시트");
    expect(html).not.toContain("숙제 행 / 캐릭터 열");
    expect(html).not.toContain("행 1");
    expect(html).not.toContain("열 1");
    expect(html).not.toContain("행 높이 40px");
    expect(html).not.toContain("열 너비 132px");
  });

  it("delegates tab clicks without owning browser history", () => {
    const pushState = vi.fn();
    const replaceState = vi.fn();
    const onSheetSelected = vi.fn();
    vi.stubGlobal("window", { history: { pushState, replaceState } });
    const tabs = getBoardSheetTabs()({
      activeSheetId: "sheet-1",
      onSheetSelected,
      sheets: [
        ...board.sheets,
        { id: "sheet-2", name: "부캐", sort_order: 10, is_default: 0 }
      ]
    });
    const buttons = Children.toArray((tabs.props as { children?: ReactNode }).children)
      .filter((child): child is ReactElement => isValidElement(child));
    const secondTab = buttons[1] as ReactElement<{ onClick: () => void }>;

    secondTab.props.onClick();

    expect(onSheetSelected).toHaveBeenCalledTimes(1);
    expect(onSheetSelected).toHaveBeenCalledWith("sheet-2");
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("renders only the payload selected by the controlled active sheet prop", () => {
    const secondSheet = { id: "sheet-2", name: "부캐", sort_order: 10, is_default: 0 };
    const secondTable = {
      ...board.tables[0]!,
      id: "table-2",
      sheet_id: secondSheet.id,
      name: "두 번째 표"
    };
    const controlledBoard: BoardPayload = {
      ...board,
      sheets: [...board.sheets, secondSheet],
      tables: [{ ...board.tables[0]!, name: "첫 번째 표" }, secondTable],
      axisItems: [
        ...board.axisItems,
        ...board.axisItems.map((item) => ({
          ...item,
          id: `${item.id}-2`,
          table_id: secondTable.id,
          character_id: item.character_id ? `${item.character_id}-2` : null,
          task_id: item.task_id ? `${item.task_id}-2` : null
        }))
      ]
    };

    const firstHtml = renderToStaticMarkup(createElement(BoardOverview, {
      activeSheetId: "sheet-1",
      board: controlledBoard,
      onSheetSelected: () => undefined
    }));
    const secondHtml = renderToStaticMarkup(createElement(BoardOverview, {
      activeSheetId: "sheet-2",
      board: controlledBoard,
      onSheetSelected: () => undefined
    }));
    const backHtml = renderToStaticMarkup(createElement(BoardOverview, {
      activeSheetId: "sheet-1",
      board: controlledBoard,
      onSheetSelected: () => undefined
    }));

    expect(firstHtml).toContain("첫 번째 표");
    expect(firstHtml).not.toContain("두 번째 표");
    expect(secondHtml).toContain("두 번째 표");
    expect(secondHtml).not.toContain("첫 번째 표");
    expect(backHtml).toContain("첫 번째 표");
    expect(backHtml).not.toContain("두 번째 표");
  });

  it("contains no URL parsing or history ownership and refreshes before selecting a created sheet", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");
    const createSheetBlock = source.slice(
      source.indexOf("async function handleCreateSheet"),
      source.indexOf("async function handleUpdateSheet")
    );

    expect(source).not.toContain("getBoardSheetIdFromUrl");
    expect(source).not.toContain("getBoardSheetRouteUrl");
    expect(source).not.toContain("getBoardHistoryState");
    expect(source).not.toContain('addEventListener("popstate"');
    expect(source).not.toContain("window.history.pushState");
    expect(createSheetBlock).not.toContain("setActiveSheetId");
    expect(createSheetBlock).toMatch(/const sheet = await apiPost[\s\S]*await refreshBoard\(\{ refreshVersion: true \}\);[\s\S]*onSheetSelected\(sheet\.id\)/);
  });

  it("uses table-local axis buckets for canvas sizing", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");
    const estimatedSizeBlock = source.slice(
      source.indexOf("function getEstimatedBoardTableSize"),
      source.indexOf("export function applyBoardTableSettingsToAxisItems")
    );

    expect(estimatedSizeBlock).not.toMatch(/axisItems\.filter\(\(item\) => item\.table_id === table\.id/);
    expect(estimatedSizeBlock).toContain("axisItemsByTable.get(table.id)");
  });

  it("renders board zoom controls at the far right of the tab bar without server persistence", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(html).toContain('class="board-zoom-controls"');
    expect(html).toContain('aria-label="보드 축소"');
    expect(html).toContain('aria-label="현재 보드 확대 비율"');
    expect(html).toContain("100%");
    expect(html).toContain('aria-label="보드 확대"');
    expect(html).toContain("--board-zoom:1");
    expect(html.indexOf('aria-label="탭 설정"')).toBeLessThan(html.indexOf('class="board-zoom-controls"'));
    expect(source).toContain("window.localStorage.setItem(BOARD_ZOOM_STORAGE_KEY");
    expect(source).not.toContain("apiPatch(\"/api/board/zoom\"");
  });

  it("renders sheet controls and opens table creation from a single button", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain('aria-label="탭 설정"');
    expect(html).toContain("표 추가");
    expect(html).toContain("메모 추가");
    expect(html).toContain('class="floating-table-add-button"');
    expect(html).toMatch(/class="floating-board-actions"[\s\S]+메모 추가[\s\S]+표 추가/);
    expect(html).toContain('class="floating-board-actions"');
    expect(html).not.toContain('class="board-toolbar"');
    expect(html).not.toContain('aria-label="새 탭 이름"');
    expect(html).not.toContain('aria-label="새 표 이름"');
    expect(html).not.toContain('aria-label="새 표 구조"');
    expect(html).not.toContain("분류");
    expect(html).not.toContain("시트");
  });

  it("describes table creation orientation from the task axis point of view", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");
    const html = renderToStaticMarkup(
      createElement(BoardTableCreateModal, {
        defaultColumnWidth: "132",
        defaultRowHeight: "40",
        displaySettings: board.settings,
        eventCompletionColumnName: "완료",
        eventRewardFilters: ["gold", "card", "coin", "silver", "cardXp"],
        isPending: false,
        name: "새 표",
        orientation: "tasks_columns",
        template: "custom",
        onClose: () => undefined,
        onDefaultColumnWidthChange: () => undefined,
        onDefaultRowHeightChange: () => undefined,
        onDisplaySettingsChange: () => undefined,
        onEventCompletionColumnNameChange: () => undefined,
        onEventRewardFiltersChange: () => undefined,
        onNameChange: () => undefined,
        onOrientationChange: () => undefined,
        onSubmit: () => undefined,
        onTemplateChange: () => undefined
      })
    );

    expect(html).toContain("숙제 열 / 캐릭터 행");
    expect(html).toContain("숙제 행 / 캐릭터 열");
    expect(html).toContain("숙제가 가로");
    expect(html).toContain("숙제가 세로");
    expect(html).not.toContain("예: 쿠르잔 전선 x 냠수나이스1");
    expect(html).not.toContain("예: 냠수나이스1 x 쿠르잔 전선");
    expect(html).not.toContain("캐릭터 행 / 숙제 열");
    expect(source).toMatch(/checked=\{orientation === "tasks_columns"\}[\s\S]{0,260}<Columns3/);
    expect(source).toMatch(/checked=\{orientation === "tasks_rows"\}[\s\S]{0,260}<Rows3/);
  });

  it("renders positioned notes for the active board tab", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          notes: [
            {
              id: "note-1",
              sheet_id: "sheet-1",
              title: "레이드 메모 📝",
              body: "이번 주 상아탑 먼저",
              color: "#fef3c7",
              x: 32,
              y: 48,
              width: 220,
              height: 160,
              sort_order: 0,
              locked: 0
            },
            {
              id: "note-2",
              sheet_id: "sheet-hidden",
              title: "숨겨진 메모",
              body: "다른 탭",
              color: "#e0f2fe",
              x: 0,
              y: 0,
              width: 220,
              height: 160,
              sort_order: 10,
              locked: 0
            }
          ]
        } as BoardPayload
      })
    );

    expect(html).toContain('class="board-note-card"');
    expect(html).toContain('style="left:32px;top:48px;width:220px;height:160px');
    expect(html).toContain('class="board-note-title-view"');
    expect(html).toContain('title="레이드 메모 📝"');
    expect(html).toContain("board-note-markdown");
    expect(html).not.toContain("board-note-body-input");
    expect(html).not.toContain('aria-label="레이드 메모 📝 메모 제목"');
    expect(html).toContain("이번 주 상아탑 먼저");
    expect(html).toContain('class="board-note-menu-button"');
    expect(html).toContain('class="board-note-menu-dots"');
    expect(html).toContain("제목 변경");
    expect(html).toContain("내용 편집");
    expect(html).toContain("잠금");
    expect(html).toContain("색 변경");
    expect(html).toContain("메모 삭제");
    expect(html).toContain('class="board-note-resize-handle"');
    expect(html).not.toContain("숨겨진 메모");
    expect(source).toMatch(/className="board-note-title-input"[\s\S]{0,160}spellCheck=\{false\}/);
    expect(source).toMatch(/className="board-note-body board-note-body-input"[\s\S]{0,200}spellCheck=\{false\}/);
    expect(source).toMatch(/aria-label="메모 제목"[\s\S]{0,240}spellCheck=\{false\}/);
    expect(source).toMatch(/aria-label="메모 내용"[\s\S]{0,240}spellCheck=\{false\}/);
  });

  it("renders note bodies as safe markdown with table support", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          notes: [
            {
              id: "note-markdown",
              sheet_id: "sheet-1",
              title: "분배 메모",
              body: [
                "| 캐릭터 | 숙제 |",
                "| --- | --- |",
                "| 냠1 | 4막 |",
                "",
                "<script>alert(1)</script>"
              ].join("\n"),
              color: "#fef3c7",
              x: 0,
              y: 0,
              width: 260,
              height: 180,
              sort_order: 0,
              locked: 0
            }
          ]
        }
      })
    );

    expect(html).toContain("board-note-markdown");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>캐릭터</th>");
    expect(html).toContain("<td>냠1</td>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("내용 편집");
  });

  it("lets memo body clicks enter markdown edit mode", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(source).toMatch(/className="board-note-body board-note-markdown"[\s\S]{0,240}onClick=\{\(event\) => \{/);
    expect(source).toContain('target.closest("a")');
    expect(source).not.toMatch(/className="board-note-body board-note-markdown"[\s\S]{0,240}onDoubleClick/);
  });

  it("renders locked notes as protected while keeping the more menu available", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          notes: [
            {
              id: "note-locked",
              sheet_id: "sheet-1",
              title: "잠긴 메모",
              body: "수정 방지",
              color: "#fef3c7",
              x: 0,
              y: 0,
              width: 220,
              height: 160,
              sort_order: 0,
              locked: 1
            }
          ]
        }
      })
    );

    expect(html).toContain('class="board-note-card locked"');
    expect(html).toContain('aria-label="잠긴 메모 메모 메뉴"');
    expect(html).toContain("잠금 해제");
    expect(html).toContain('class="board-note-title-view"');
    expect(html).not.toContain('aria-label="잠긴 메모 메모 제목"');
    expect(html).toContain("board-note-markdown");
    expect(html).not.toContain("board-note-body-input");
    expect(html).toMatch(/<button disabled="" type="button">[\s\S]*내용 편집/);
    expect(html).toMatch(/disabled=""[^>]+aria-label="잠긴 메모 메모 크기 조절"|aria-label="잠긴 메모 메모 크기 조절"[^>]+disabled=""/);
    expect(html).toMatch(/class="[^"]*\bboard-note-resize-lock-icon\b[^"]*"/);
  });

  it("renders sheet creation and deletion inside sheet settings", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");
    const html = renderToStaticMarkup(
      createElement(BoardSheetSettingsModal, {
        activeSheetId: "sheet-1",
        isPending: false,
        sheets: [
          ...board.sheets,
          { id: "sheet-2", name: "부캐", sort_order: 10, is_default: 0 }
        ],
        onClose: () => undefined,
        onCreate: async () => undefined,
        onDelete: async () => undefined,
        onUpdate: async () => undefined
      })
    );

    expect(html).toContain("탭 설정");
    expect(html).toContain('aria-label="새 탭 이름"');
    expect(html).toContain("탭 추가");
    expect(html).toContain('aria-label="편집할 탭"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("선택한 탭");
    expect(html).toContain("탭 수정");
    expect(html).toContain('aria-label="선택한 탭 이름"');
    expect(html).toContain("부캐");
    expect(html).toContain("탭 저장");
    expect(html).toContain("탭 삭제");
    expect(html).toContain("sheet-settings-detail-actions");
    expect(html).toContain("danger-button");
    expect(html).not.toContain("위험 구역");
    expect(html).not.toContain("sheet-settings-danger-zone");
    expect(html).not.toContain("삭제할 탭");
    expect(html).not.toContain("분류");
    expect(html).not.toContain("시트");
    expect(source).toMatch(/await onCreate\(name\);[\s\S]{0,120}setNewSheetName\(""\);[\s\S]{0,120}onClose\(\);/);
  });

  it("renders table-scoped character and task action buttons beside the table title", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain('aria-label="숙제 캐릭터 추가 또는 가져오기"');
    expect(html).toContain('aria-label="숙제 숙제 추가"');
    expect(html).toContain('aria-label="숙제 표 잠금"');
    expect(html).toContain('aria-label="숙제 순서 변경 모드 켜기"');
    expect(html).toContain('aria-label="숙제 표 설정"');
    expect(html.indexOf('aria-label="숙제 캐릭터 추가 또는 가져오기"')).toBeLessThan(html.indexOf('aria-label="숙제 숙제 추가"'));
    expect(html.indexOf('aria-label="숙제 숙제 추가"')).toBeLessThan(html.indexOf('aria-label="숙제 표 설정"'));
    expect(html).not.toContain('aria-label="숙제 행 이름"');
    expect(html).not.toContain('aria-label="숙제 열 이름"');
    expect(html).not.toContain("표시 편집");
    expect(html).not.toContain("표시 옵션");
  });

  it("renders editable axis labels outside reorder mode", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain('aria-label="쿠르잔 전선 편집"');
    expect(html).toContain('aria-label="냠수나이스1 편집"');
  });

  it("renders compact checkbox cells from board axis and completion state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));

    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          completions: [
            {
              table_id: "table-1",
              row_item_id: "row-task-1",
              column_item_id: "column-character-1",
              period_key: "daily:2026-06-01",
              completed: 1
            }
          ]
        }
      })
    );

    expect(html).toContain('class="board-check-grid"');
    expect(html).toContain("쿠르잔 전선");
    expect(html).toContain("냠수나이스1");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain("--task-color:#2563eb");
  });

  it("marks only the final board row so the default bottom line can be removed", () => {
    const secondRow: BoardAxisItem = {
      ...board.axisItems[0]!,
      id: "row-task-2",
      label: "가디언 토벌",
      sort_order: 20
    };
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: [board.axisItems[0]!, secondRow, board.axisItems[1]!]
        }
      })
    );

    expect(html.match(/board-grid-last-row/g) ?? []).toHaveLength(2);
    expect(html).toContain('class="board-axis-label board-row-label board-grid-last-row board-axis-edit-button"');
    expect(html).toContain('class="board-check-cell board-grid-last-row"');
  });

  it("does not carry previous reset period completions into the current board checkbox state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T00:00:00.000Z"));

    const html = renderToStaticMarkup(
      createElement(BoardTableGrid, {
        axisItems: board.axisItems,
        cellStates: [],
        completions: [
          {
            table_id: "table-1",
            row_item_id: "row-task-1",
            column_item_id: "column-character-1",
            period_key: "daily:2026-06-03",
            completed: 1
          }
        ],
        onToggle: () => undefined,
        settings: board.settings,
        table: board.tables[0]!
      })
    );

    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked=""');
  });

  it("renders task color swatches on task axis labels", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain('aria-label="쿠르잔 전선 색상 #2563eb"');
    expect(html).toContain("background:#2563eb");
  });

  it("renders character axis labels from board display settings", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          settings: {
            show_display_name: 1,
            show_server_name: 1,
            show_class_name: 1,
            show_item_level: 1,
            show_combat_power: 1
          },
          axisItems: board.axisItems.map((item) =>
            item.kind === "character"
              ? {
                  ...item,
                  character_display_name: "냠1",
                  character_server_name: "아만",
                  character_class_name: "브레이커",
                  character_item_level: "1,780.00",
                  character_combat_power: "2,500"
                }
              : item
          )
        }
      })
    );

    expect(html).toContain("냠1");
    expect(html).toContain("아만 · 브레이커");
    expect(html).toContain("Lv.1,780.00");
    expect(html).toContain("⚔️2,500");
    expect(html).not.toContain("Lv. 1,780.00");
    expect(html).not.toContain("⚔️ 2,500");
    expect(html).not.toContain("Lv. 1,780.00 · ⚔️ 2,500");
    expect(html.indexOf("아만 · 브레이커")).toBeLessThan(html.indexOf("Lv.1,780.00"));
    expect(html.indexOf("Lv.1,780.00")).toBeLessThan(html.indexOf("⚔️2,500"));
    expect(html).toContain("아만 / 냠수나이스1 / 브레이커 / 1,780.00 / 2,500");
  });

  it("renders custom row and column separators from axis settings", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: board.axisItems.map((item) =>
            item.axis === "row"
              ? { ...item, separator_json: '{"widthPx":3,"style":"dashed","color":"#334455"}' }
              : { ...item, separator_json: '{"widthPx":2,"style":"dotted","color":"#be123c"}' }
          )
        }
      })
    );

    expect(html).toContain("border-bottom:3px dashed #334455");
    expect(html).toContain("border-right:2px dotted #be123c");
  });

  it("keeps row and column size controls out of the table surface", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: board.axisItems.map((item) =>
            item.axis === "row" ? { ...item, size_px: 44 } : { ...item, size_px: 150 }
          )
        }
      })
    );

    expect(html).not.toContain('aria-label="쿠르잔 전선 행 높이"');
    expect(html).not.toContain('aria-label="냠수나이스1 열 너비"');
  });

  it("does not render direct table layout controls", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          tables: board.tables.map((table) => ({ ...table, x: 18, y: 24, width: 420, height: 260 }))
        }
      })
    );

    expect(html).not.toContain('aria-label="숙제 X 위치"');
    expect(html).not.toContain('aria-label="숙제 Y 위치"');
    expect(html).not.toContain('aria-label="숙제 너비"');
    expect(html).not.toContain('aria-label="숙제 높이"');
  });

  it("renders table movement without direct resize handles", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain('aria-label="숙제 표 이동"');
    expect(html).not.toContain('aria-label="숙제 표 크기 조절"');
  });

  it("moves table actions into a compact table menu", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(html).toContain('class="board-table-menu-wrap"');
    expect(html).toContain('class="board-table-menu-dots"');
    expect(html).toContain('aria-label="숙제 표 메뉴"');
    expect(html).toContain(">잠금</button>");
    expect(source).toContain('setOpenTableMenuId((current) => (current === table.id ? null : table.id))');
    expect(source).toContain('.closest(".board-table-menu-wrap")');
  });

  it("renders a schedule notification bell next to the schedule table menu", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          tables: [
            {
              ...board.tables[0]!,
              name: "스케줄",
              template_type: "lostark_event"
            }
          ]
        }
      })
    );

    expect(html).toContain('aria-label="스케줄 알림 설정"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('class="board-event-notification-switch');
    expect(html).toContain("다음 스케줄 1회 알림");
    expect(html).toContain("알림 시간");
    expect(html).toContain("현재 설정: 5분 전");
    expect(html).toContain(">적용</button>");
    expect(html).toContain("알림 테스트");
    expect(html).not.toContain(">테스트</button>");
    expect(html).not.toContain("알림 후보 시간");
    expect(html).not.toContain("선택된 알림 후보 시간");
    expect(html).not.toContain('title="5분 전 알림 제거"');
    expect(html).not.toContain("페이지가 열려 있으면 시스템 알림으로 알려드립니다.");
    expect(html).not.toContain("페이지가 열려 있으면 웹페이지 밖의 시스템 알림으로 알려드립니다.");
    expect(html.indexOf('aria-label="스케줄 알림 설정"')).toBeLessThan(html.indexOf('aria-label="스케줄 표 메뉴"'));
  });

  it("tracks the last touched table as the front-most table", () => {
    let depths = bringBoardTableToFront({}, "table-a");
    expect(depths).toEqual({ "table-a": 1 });

    depths = bringBoardTableToFront(depths, "table-b");
    expect(depths).toEqual({ "table-a": 1, "table-b": 2 });

    depths = bringBoardTableToFront(depths, "table-a");
    expect(depths).toEqual({ "table-a": 3, "table-b": 2 });
  });

  it("keeps only checkbox toggles interactive on locked tables", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          tables: board.tables.map((table) => ({ ...table, locked: 1 }))
        }
      })
    );

    expect(html).not.toContain("잠김");
    expect(html).toContain('aria-label="숙제 표 잠금 해제"');
    expect(html).toContain(">잠금 해제</button>");
    expect(html).not.toContain(">해제</button>");
    expect(html).not.toContain(">잠금</button>");
    expect(html).toContain('class="board-table-title board-table-static-title"');
    expect(html).toMatch(/disabled=""[^>]+aria-label="숙제 순서 변경 모드 켜기"|aria-label="숙제 순서 변경 모드 켜기"[^>]+disabled=""/);
    expect(html).not.toContain('aria-label="숙제 표 이동"');
    expect(html).toMatch(/disabled=""[^>]+aria-label="숙제 캐릭터 추가 또는 가져오기"|aria-label="숙제 캐릭터 추가 또는 가져오기"[^>]+disabled=""/);
    expect(html).toMatch(/disabled=""[^>]+aria-label="숙제 숙제 추가"|aria-label="숙제 숙제 추가"[^>]+disabled=""/);
    expect(html).toMatch(/disabled=""[^>]+aria-label="숙제 표 설정"|aria-label="숙제 표 설정"[^>]+disabled=""/);
    expect(html).not.toContain('aria-label="냠수나이스1 편집"');
    expect(html).not.toContain('aria-label="쿠르잔 전선 편집"');
    expect(html).toContain('aria-label="쿠르잔 전선 / 냠수나이스1"');
    expect(html).not.toContain('aria-label="쿠르잔 전선 / 냠수나이스1" class="board-check" disabled');
  });

  it("renders board axis labels as sortable targets in reorder mode", () => {
    const html = renderToStaticMarkup(
      createElement(BoardTableGrid, {
        axisItems: board.axisItems,
        cellStates: board.cellStates,
        completions: board.completions,
        isReorderMode: true,
        table: board.tables[0]!,
        onToggle: () => undefined,
        settings: board.settings
      })
    );

    expect(html).toContain('aria-label="쿠르잔 전선 순서 이동"');
    expect(html).toContain('aria-label="냠수나이스1 순서 이동"');
    expect(html).toContain('data-reorder-target="true"');
    expect(html).not.toContain('aria-label="쿠르잔 전선 편집"');
    expect(html).not.toContain('title="냠수나이스1"');
    expect(html).toContain('aria-label="쿠르잔 전선 / 냠수나이스1" class="board-check" disabled');
  });

  it("portals the reorder drag overlay to the document body so the scaled canvas cannot offset it", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(source).toContain('import { createPortal } from "react-dom"');
    expect(source).toMatch(/createPortal\(\s*<DragOverlay>/);
    expect(source).toContain("document.body");
  });

  it("shows a reorder done button left of the table menu while reorder mode is active", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(source).toContain('className="board-table-reorder-done-button"');
    expect(source).toContain('aria-label={`${table.name} 순서 변경 완료`}');
    expect(source.indexOf('className="board-table-reorder-done-button"')).toBeLessThan(
      source.indexOf('className="board-table-menu-button"')
    );
  });

  it("keeps transpose inside table settings instead of the table header", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain('aria-label="숙제 표 설정"');
    expect(html).not.toContain('aria-label="숙제 행/열 전환 미리보기"');
    expect(html).not.toContain("행/열 전환");
  });

  it("renders table transpose in settings without an internal lock toggle", () => {
    const html = renderToStaticMarkup(
      createElement(BoardTableSettingsModal, {
        axisItems: board.axisItems,
        settings: board.settings,
        table: board.tables[0]!,
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onTranspose: async () => undefined
      })
    );

    expect(html).toContain("표 구조");
    expect(html).toContain("행/열 뒤바꾸기");
    expect(html).toContain('aria-label="숙제 행/열 뒤바꾸기"');
    expect(html.indexOf("표시 옵션")).toBeLessThan(html.indexOf("행/열 뒤바꾸기"));
    expect(html).not.toContain("현재 값:");
    expect(html).not.toContain("table-lock-toggle");
    expect(html).not.toContain(">표 잠금<");
  });

  it("renders editable Lost Ark event reward filters in table settings", () => {
    const html = renderToStaticMarkup(
      createElement(BoardTableSettingsModal, {
        axisItems: board.axisItems,
        settings: board.settings,
        table: {
          ...board.tables[0]!,
          template_type: "lostark_event",
          event_options_json: JSON.stringify({ rewardFilters: ["gold"] })
        },
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onTranspose: async () => undefined
      })
    );

    expect(html).toContain("모험섬 관심 보상");
    expect(html).toContain("쌀(골드)");
    expect(html).toContain("카드 팩");
    expect(html).toContain('aria-label="쌀(골드) 관심 보상"');
  });

  it("keeps disabled cells present for layout without rendering a checkbox", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          cellStates: [
            {
              table_id: "table-1",
              row_item_id: "row-task-1",
              column_item_id: "column-character-1",
              checkbox_visible: 0,
              mark_type: "disabled",
              memo: null,
              mark_period_key: null
            }
          ]
        }
      })
    );

    expect(html).toContain('class="board-check-placeholder"');
    expect(html).not.toContain('aria-label="쿠르잔 전선 / 냠수나이스1" class="board-check"');
  });

  it("renders legacy fixed and reserved marks as icons inside board check cells", () => {
    const secondCharacter: BoardAxisItem = {
      ...board.axisItems[1]!,
      id: "column-character-2",
      label: "냠수나이스2",
      character_id: "character-2",
      sort_order: 1
    };
    const currentPeriodKey = getBoardCellPeriodKey(board.axisItems[0]!, secondCharacter);
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: [...board.axisItems, secondCharacter],
          cellStates: [
            {
              table_id: "table-1",
              row_item_id: "row-task-1",
              column_item_id: "column-character-1",
              checkbox_visible: 1,
              mark_type: "fixed",
              memo: "고정파티 21시",
              mark_period_key: null
            },
            {
              table_id: "table-1",
              row_item_id: "row-task-1",
              column_item_id: "column-character-2",
              checkbox_visible: 1,
              mark_type: "reserved",
              memo: null,
              mark_period_key: currentPeriodKey ?? ""
            }
          ]
        }
      })
    );

    expect(html).not.toContain('class="board-check-mark fixed"');
    expect(html).not.toContain('class="board-check-mark reserved"');
    expect(html).toContain('class="board-check-badge pin"');
    expect(html).toContain('class="board-check-badge clock"');
    expect(html).toContain('width="12" height="12"');
    expect(html).not.toContain('title="핀"');
    expect(html).not.toContain('title="시계"');
    expect(html).not.toContain('class="board-check-icon-overlay');
    expect(html).not.toContain("board-check-memo-dot");
  });

  it("shows board cell hover tooltip content only when a memo exists and labels it as memo", () => {
    expect(getBoardCellMarkTooltipContent({ type: "fixed", icon: "pin", retention: "permanent", memo: null })).toBeNull();
    expect(getBoardCellMarkTooltipContent({ type: "reserved", icon: "clock", retention: "period", memo: "" })).toBeNull();
    expect(getBoardCellMarkTooltipContent({ type: "default", icon: "memo", retention: "permanent", memo: "   " })).toBeNull();
    expect(getBoardCellMarkTooltipContent({ type: "default", icon: null, retention: "permanent", memo: null })).toBeNull();

    expect(getBoardCellMarkTooltipContent({ type: "fixed", icon: "pin", retention: "permanent", memo: "고정파티 21시" })).toEqual({
      title: "메모",
      memo: "고정파티 21시"
    });
    expect(getBoardCellMarkTooltipContent({ type: "reserved", icon: "flag", retention: "period", memo: "이번주만 진행" })).toEqual({
      title: "메모",
      memo: "이번주만 진행"
    });
  });

  it("renders a memo indicator on default board check cells with persistent memos", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          cellStates: [
            {
              table_id: "table-1",
              row_item_id: "row-task-1",
              column_item_id: "column-character-1",
              checkbox_visible: 1,
              mark_type: "default",
              memo: "상시 메모",
              mark_period_key: null
            }
          ]
        }
      })
    );

    expect(html).toContain('class="board-check-badge memo"');
    expect(html).toContain('aria-label="쿠르잔 전선 / 냠수나이스1 메모"');
    expect(html).not.toContain('class="board-check-icon-overlay');
    expect(html).not.toContain('class="board-check-memo-dot"');
    expect(html).not.toContain('class="board-check-mark fixed"');
    expect(html).not.toContain('class="board-check-mark reserved"');
  });

  it("treats reserved marks from a past period as plain cells", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          cellStates: [
            {
              table_id: "table-1",
              row_item_id: "row-task-1",
              column_item_id: "column-character-1",
              checkbox_visible: 1,
              mark_type: "reserved",
              memo: "지난주 약속",
              mark_period_key: "weekly:2000-01-05"
            }
          ]
        }
      })
    );

    expect(html).not.toContain("board-check-mark reserved");
    expect(html).not.toContain("board-check-memo-dot");
  });

  it("offers the cell mark edit mode from the table menu", () => {
    const html = renderToStaticMarkup(createElement(BoardOverview, { board }));

    expect(html).toContain('aria-label="숙제 체크칸 설정 모드 켜기"');
    expect(html).toContain("체크칸 설정");
  });

  it("does not render an empty board as a stretching spreadsheet", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          sheets: [],
          tables: [],
          axisItems: []
        }
      })
    );

    expect(html).toContain("보드 데이터를 준비하는 중입니다.");
    expect(html).not.toContain("width:100%");
  });

  it("keeps imported character columns visible before task rows exist", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: [board.axisItems[1]!]
        }
      })
    );

    expect(html).toContain("냠수나이스1");
    expect(html).toContain("숙제를 추가해주세요");
    expect(html).not.toContain("이 표에는 아직 행 또는 열이 없습니다.");
  });

  it("keeps task rows visible before character columns exist", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: [board.axisItems[0]!]
        }
      })
    );

    expect(html).toContain("쿠르잔 전선");
    expect(html).toContain("캐릭터를 추가해주세요");
    expect(html).not.toContain("이 표에는 아직 행 또는 열이 없습니다.");
  });

  it("sizes the board canvas to include all visible rows", () => {
    const manyRows: BoardAxisItem[] = Array.from({ length: 8 }, (_, index) => ({
      ...board.axisItems[0]!,
      id: `row-task-${index + 1}`,
      label: `숙제 ${index + 1}`,
      sort_order: index * 10,
      size_px: 40
    }));
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: [...manyRows, board.axisItems[1]!]
        }
      })
    );

    expect(html).toContain("--board-canvas-height:456px");
  });

  it("adds canvas slack for table borders, separators, and lower workspace padding", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: board.axisItems.map((item) =>
            item.axis === "row"
              ? { ...item, size_px: 40, separator_json: '{"widthPx":4,"style":"solid","color":"#334455"}' }
              : item
          )
        }
      })
    );

    expect(html).toContain("--board-canvas-width:520px");
    expect(html).toContain("--board-canvas-height:300px");
  });

  it("renders imported character identity as read-only while editing mutable details", () => {
    const characterItem = {
      ...board.axisItems[1]!,
      character_source: "lostark",
      character_display_name: "냠1",
      character_server_name: "아만",
      character_class_name: "브레이커",
      character_item_level: "1,778.33",
      character_combat_power: "2,549.41"
    };
    const html = renderToStaticMarkup(
      createElement(BoardAxisItemEditModal, {
        item: characterItem,
        settings: board.settings,
        table: board.tables[0]!,
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onCharacterSave: async () => undefined
      })
    );

    expect(html).not.toContain("캐릭터 정보");
    expect(html).toContain('class="character-summary-card"');
    expect(html).toContain('class="character-summary-title"');
    expect(html).toContain('class="character-summary-chip"');
    expect(html).toContain("냠수나이스1");
    expect(html).toContain("아만");
    expect(html).toContain("브레이커");
    expect(html).not.toContain("서버 아만");
    expect(html).not.toContain("닉네임 냠수나이스1");
    expect(html).not.toContain("직업 브레이커");
    expect(html).toContain("최신 정보 갱신");
    expect(html).toContain("축약 이름");
    expect(html).toContain('value="냠1"');
    expect(html).toContain('value="1,778.33"');
    expect(html).toContain('value="2,549.41"');
    expect(html).not.toContain('value="아만"');
    expect(html).not.toContain('value="브레이커"');
  });

  it("renders independent accessible stat pin toggles in the character edit modal", () => {
    const characterItem = {
      ...board.axisItems[1]!,
      character_source: "lostark",
      character_item_level_pinned: 1 as const,
      character_combat_power_pinned: 0 as const
    };
    const html = renderToStaticMarkup(
      createElement(BoardAxisItemEditModal, {
        item: characterItem,
        settings: board.settings,
        table: board.tables[0]!,
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onCharacterSave: async () => undefined
      })
    );

    expect(html).toContain('aria-label="레벨 자동 갱신 잠금"');
    expect(html).toContain('title="레벨 자동 갱신 잠금"');
    expect(html).toContain('aria-label="전투력 자동 갱신 잠금"');
    expect(html).toContain('title="전투력 자동 갱신 잠금"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html.match(/class="character-stat-pin-button/g)).toHaveLength(2);
  });

  it("keeps character axis sizing and display options in one layout row", () => {
    const characterItem = {
      ...board.axisItems[1]!,
      character_source: "lostark",
      character_server_name: "아만",
      character_class_name: "브레이커",
      size_px: 148,
      cross_size_px: 42
    };
    const html = renderToStaticMarkup(
      createElement(BoardAxisItemEditModal, {
        item: characterItem,
        settings: board.settings,
        table: board.tables[0]!,
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onCharacterSave: async () => undefined
      })
    );

    expect(html).toContain('class="tool-modal edit-modal character-axis-edit-modal"');
    expect(html).toContain('class="character-axis-layout-grid"');
    expect(html.indexOf("열 너비")).toBeLessThan(html.indexOf("열 높이"));
    expect(html.indexOf("열 높이")).toBeLessThan(html.indexOf("표시 옵션"));
    expect(html).toContain('value="148"');
    expect(html).toContain('value="42"');
  });

  it("prompts for the missing task or character side when only one axis exists", () => {
    const taskOnlyHtml = renderToStaticMarkup(
      createElement(BoardTableGrid, {
        axisItems: [board.axisItems[0]!],
        cellStates: [],
        completions: [],
        table: board.tables[0]!,
        onToggle: () => undefined,
        settings: board.settings
      })
    );
    const characterOnlyHtml = renderToStaticMarkup(
      createElement(BoardTableGrid, {
        axisItems: [board.axisItems[1]!],
        cellStates: [],
        completions: [],
        table: board.tables[0]!,
        onToggle: () => undefined,
        settings: board.settings
      })
    );

    expect(taskOnlyHtml).toContain("캐릭터를 추가해주세요");
    expect(characterOnlyHtml).toContain("숙제를 추가해주세요");
    expect(taskOnlyHtml).not.toContain("열이 없습니다.");
    expect(characterOnlyHtml).not.toContain("행이 없습니다.");
  });

  it("describes character refresh cooldown state for imported character edits", () => {
    expect(getCharacterRefreshCooldownState(0, 1_000)).toEqual({
      isBlocked: false,
      label: "최신 정보 갱신",
      remainingMs: 0,
      title: "로스트아크 API에서 최신 정보 갱신"
    });
    expect(getCharacterRefreshCooldownState(61_000, 1_000)).toEqual({
      isBlocked: true,
      label: "1분 후 갱신 가능",
      remainingMs: 60_000,
      title: "캐릭터 갱신은 1분에 한 번만 시도할 수 있습니다. 60초 후 다시 시도해주세요."
    });
  });

  it("lets manual character identity and optional details be edited", () => {
    const characterItem = {
      ...board.axisItems[1]!,
      character_source: "manual",
      character_name: "임의캐릭터",
      character_server_name: "",
      character_class_name: "",
      character_item_level: "",
      character_combat_power: null
    };
    const html = renderToStaticMarkup(
      createElement(BoardAxisItemEditModal, {
        item: characterItem,
        settings: board.settings,
        table: board.tables[0]!,
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onCharacterSave: async () => undefined,
        onCharacterRefresh: async () => ({
          name: "임의캐릭터",
          serverName: "",
          className: "",
          itemLevel: "",
          combatPower: null,
          itemLevelPinned: false,
          combatPowerPinned: false
        })
      })
    );

    expect(html).toContain("닉네임");
    expect(html).toContain('value="임의캐릭터"');
    expect(html).toContain("서버");
    expect(html).toContain("직업");
    expect(html).toContain("레벨");
    expect(html).toContain("전투력");
    expect(html).not.toContain("최신 정보 갱신");
  });

  it("lets task columns edit their column width from item settings", () => {
    const taskColumn = {
      ...board.axisItems[0]!,
      axis: "column" as const,
      size_px: 96
    };
    const html = renderToStaticMarkup(
      createElement(BoardAxisItemEditModal, {
        item: taskColumn,
        settings: board.settings,
        table: { ...board.tables[0]!, row_role: "character", column_role: "task", task_axis: "columns" },
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onCharacterSave: async () => undefined
      })
    );

    expect(html).toContain("열 너비");
    expect(html).toContain('value="96"');
  });

  it("lets task axis items edit their reset cycle from item settings", () => {
    const html = renderToStaticMarkup(
      createElement(BoardAxisItemEditModal, {
        item: { ...board.axisItems[0]!, task_reset_type: "weekly" },
        settings: board.settings,
        table: board.tables[0]!,
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onCharacterSave: async () => undefined
      })
    );

    expect(html).toContain("초기화 주기");
    expect(html).toContain('<option value="daily">일간</option>');
    expect(html).toContain('<option value="weekly" selected="">주간</option>');
    expect(html).toContain('<option value="biweekly">격주</option>');
    expect(html).toContain('<option value="none">초기화 안함</option>');
  });

  it("groups task edit basics and sizing controls into compact rows", () => {
    const html = renderToStaticMarkup(
      createElement(BoardAxisItemEditModal, {
        item: { ...board.axisItems[0]!, task_reset_type: "weekly", size_px: 44, cross_size_px: 180 },
        settings: board.settings,
        table: board.tables[0]!,
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onCharacterSave: async () => undefined
      })
    );

    expect(html).toContain('class="task-edit-basic-grid"');
    expect(html).toContain('class="compact-edit-grid task-axis-style-grid"');
    expect(html.indexOf("이름")).toBeLessThan(html.indexOf("초기화 주기"));
    expect(html.indexOf("행 높이")).toBeLessThan(html.indexOf("행 너비"));
    expect(html.indexOf("행 너비")).toBeLessThan(html.indexOf("체크 색상"));
  });

  it("moves checkbox visibility out of the axis item modal into the cell mark editor", () => {
    const html = renderToStaticMarkup(
      createElement(BoardAxisItemEditModal, {
        item: board.axisItems[0]!,
        settings: board.settings,
        table: board.tables[0]!,
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onCharacterSave: async () => undefined
      })
    );

    expect(html).not.toContain("체크박스 표시 대상");
  });

  it("renders the cell mark brush toolbar with direct icon, retention, disabled, and memo controls", () => {
    const html = renderToStaticMarkup(
      createElement(BoardCellMarkToolbar, {
        brush: { disabled: false, icon: "pin", retention: "permanent", memo: "고정파티 21시\n2줄 메모" },
        notice: null,
        onBrushChange: () => undefined
      })
    );

    expect(html).toContain('aria-label="체크칸 모드"');
    expect(html).toContain(">기본</button>");
    expect(html).toContain(">커스텀</button>");
    expect(html).toContain(">비활성화</button>");
    expect(html).not.toContain(">없음</button>");
    expect(html).toContain('aria-label="커스텀 아이콘"');
    expect(html).not.toContain('aria-label="아이콘: 메모"');
    expect(html).toContain('aria-label="아이콘: 핀"');
    expect(html).toContain('aria-label="아이콘: 시계"');
    expect(html).toContain('aria-label="아이콘: 별"');
    expect(html).toContain('aria-label="아이콘: 주의"');
    expect(html).toContain('aria-label="아이콘: 깃발"');
    expect(html).toContain('aria-label="아이콘: 태그"');
    expect(html).not.toContain('class="board-cell-mark-option icon-only memo"');
    expect(html).toContain('class="board-cell-mark-option icon-only pin active"');
    expect(html).toContain('class="board-cell-mark-selected-indicator"');
    expect(html).toContain('class="board-cell-mark-option icon-only clock"');
    expect(html).not.toContain(">체크</button>");
    expect(html).toContain('stroke-width="3"');
    expect(html).toContain('aria-label="체크칸 기간 옵션"');
    expect(html).toContain('aria-label="이번주만"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("꺼짐");
    expect(html).not.toContain("계속 유지");
    expect(html).not.toContain("이번 주기만");
    expect(html).toContain('aria-label="체크칸 비활성화"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("<textarea");
    expect(html).not.toContain("<input");
    expect(html).toContain("고정파티 21시\n2줄 메모");
    expect(html).not.toContain("셀을 클릭하면 바로 적용되고");
    expect(html).not.toContain("일반 체크박스로 사용");
  });

  it("shows the brush memo input for default marks and hides it for disabled brushes", () => {
    const defaultHtml = renderToStaticMarkup(
      createElement(BoardCellMarkToolbar, {
        brush: { disabled: false, icon: null, retention: "permanent", memo: "" },
        notice: null,
        onBrushChange: () => undefined
      })
    );
    const noticeHtml = renderToStaticMarkup(
      createElement(BoardCellMarkToolbar, {
        brush: { disabled: false, icon: "clock", retention: "period", memo: "" },
        notice: "초기화되지 않는 숙제에는 이번주만 옵션을 사용할 수 없습니다.",
        onBrushChange: () => undefined
      })
    );
    const disabledHtml = renderToStaticMarkup(
      createElement(BoardCellMarkToolbar, {
        brush: { disabled: true, icon: null, retention: "permanent", memo: "" },
        notice: null,
        onBrushChange: () => undefined
      })
    );

    expect(defaultHtml).toContain('aria-label="브러시 메모"');
    expect(defaultHtml).toContain("<textarea");
    expect(defaultHtml).not.toContain('aria-label="커스텀 아이콘"');
    expect(defaultHtml).toContain("꺼짐");
    expect(defaultHtml).not.toContain('class="cell-mark-description"');
    expect(defaultHtml).not.toContain("셀을 클릭하면 바로 적용되고");
    expect(defaultHtml).not.toContain("일반 체크박스로 사용");
    expect(defaultHtml).not.toContain('title=""');
    expect(disabledHtml).not.toContain('aria-label="브러시 메모"');
    expect(disabledHtml).not.toContain('aria-label="커스텀 아이콘"');
    expect(disabledHtml).toContain("비활성화된 체크칸은 체크박스를 숨깁니다.");
    expect(disabledHtml).not.toContain("셀을 클릭하면 바로 적용되고");
    expect(noticeHtml).toContain('aria-label="브러시 메모"');
    expect(noticeHtml).toContain('aria-label="커스텀 아이콘"');
    expect(noticeHtml).toContain('aria-label="이번주만"');
    expect(noticeHtml).toContain('aria-pressed="true"');
    expect(noticeHtml).toContain("켜짐");
    expect(noticeHtml).toContain("초기화되지 않는 숙제에는 이번주만 옵션을 사용할 수 없습니다.");
    expect(noticeHtml).not.toContain("셀을 클릭하면 바로 적용되고");
  });

  it("paints cells directly with the brush instead of opening a modal", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(source).toContain("function handleCellMarkPaint(");
    expect(source).toContain("onCellMarkPaint(row, column, mark, periodKey)");
    expect(source).not.toContain("BoardCellMarkEditModal");
    // 같은 브러시로 칠한 셀을 다시 클릭하면 해제
    expect(source).toContain("const memoEnabled = !markBrush.disabled;");
    expect(source).toContain('const markType: BoardCellMarkType = markBrush.disabled ? "disabled" : markBrush.retention === "period" ? "reserved" : "default";');
  });

  it("lets row and column items edit both height and width from item settings", () => {
    const rowHtml = renderToStaticMarkup(
      createElement(BoardAxisItemEditModal, {
        item: { ...board.axisItems[0]!, size_px: 44, cross_size_px: 180 },
        settings: board.settings,
        table: board.tables[0]!,
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onCharacterSave: async () => undefined
      })
    );
    const columnHtml = renderToStaticMarkup(
      createElement(BoardAxisItemEditModal, {
        item: { ...board.axisItems[1]!, size_px: 150, cross_size_px: 48 },
        settings: board.settings,
        table: board.tables[0]!,
        onClose: () => undefined,
        onDelete: async () => undefined,
        onSave: async () => undefined,
        onCharacterSave: async () => undefined
      })
    );

    expect(rowHtml).toContain("행 높이");
    expect(rowHtml).toContain("행 너비");
    expect(rowHtml).toContain('value="44"');
    expect(rowHtml).toContain('value="180"');
    expect(rowHtml).toContain('min="1" type="number" value="180"');
    expect(columnHtml).toContain("열 높이");
    expect(columnHtml).toContain("열 너비");
    expect(columnHtml).toContain('value="48"');
    expect(columnHtml).toContain('value="150"');
    expect(columnHtml).toContain('min="1" type="number" value="48"');
  });

  it("applies row widths and column heights from axis item settings", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: board.axisItems.map((item) =>
            item.axis === "row" ? { ...item, cross_size_px: 220 } : { ...item, cross_size_px: 48 }
          )
        }
      })
    );

    expect(html).toContain("grid-template-columns:220px 132px");
    expect(html).toContain("min-height:48px");
  });

  it("honors row label widths and column header heights below their defaults", () => {
    const html = renderToStaticMarkup(
      createElement(BoardOverview, {
        board: {
          ...board,
          axisItems: board.axisItems.map((item) =>
            item.axis === "row" ? { ...item, cross_size_px: 96 } : { ...item, cross_size_px: 18 }
          )
        }
      })
    );

    expect(html).toContain("grid-template-columns:96px 132px");
    expect(html).toContain("min-height:18px");
    expect(html).toContain('class="board-check-cell board-grid-last-row" style="min-height:40px');
  });

  it("applies cross-axis label sizing to every visible item on the same axis", () => {
    const axisItems: BoardAxisItem[] = [
      { ...board.axisItems[0]!, id: "row-task-1", table_id: "table-1", axis: "row", cross_size_px: null },
      { ...board.axisItems[0]!, id: "row-task-2", table_id: "table-1", axis: "row", cross_size_px: null, sort_order: 10 },
      { ...board.axisItems[1]!, id: "column-character-1", table_id: "table-1", axis: "column", cross_size_px: null }
    ];

    const next = applyBoardAxisItemSaveToAxisItems(axisItems, {
      axisItemId: "row-task-1",
      label: "쿠르잔 전선",
      sizePx: 44,
      crossSizePx: 96,
      shouldUpdateDetails: true
    });

    expect(next.filter((item) => item.axis === "row").map((item) => item.cross_size_px)).toEqual([96, 96]);
    expect(next.find((item) => item.id === "row-task-1")?.size_px).toBe(44);
    expect(next.find((item) => item.id === "row-task-2")?.size_px).toBeNull();
    expect(next.find((item) => item.axis === "column")?.cross_size_px).toBeNull();
  });

  it("applies task reset type changes to saved board task axis items", () => {
    const next = applyBoardAxisItemSaveToAxisItems(board.axisItems, {
      axisItemId: "row-task-1",
      label: "쿠르잔 전선",
      taskResetType: "weekly",
      taskResetRuleJson: '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}',
      shouldUpdateDetails: true
    });
    const taskItem = next.find((item) => item.id === "row-task-1");

    expect(taskItem?.task_reset_type).toBe("weekly");
    expect(taskItem?.task_reset_rule_json).toBe('{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}');
  });

  it("does not save character details when only display options change", () => {
    const characterItem = {
      ...board.axisItems[1]!,
      character_display_name: "냠1",
      character_item_level: "1,778.33",
      character_combat_power: "2,549.41"
    };

    expect(shouldSaveBoardCharacterDetails(characterItem, "냠1", "1,778.33", "2,549.41")).toBe(false);
    expect(shouldSaveBoardCharacterDetails(characterItem, "냠2", "1,778.33", "2,549.41")).toBe(true);
    expect(shouldSaveBoardCharacterDetails(characterItem, "냠1", "1,779.00", "2,549.41")).toBe(true);
    expect(
      shouldSaveBoardCharacterDetails(
        characterItem,
        "냠1",
        "1,778.33",
        "2,549.41",
        undefined,
        undefined,
        undefined,
        true,
        false
      )
    ).toBe(true);
  });

  it("applies bulk table settings to character items even when size settings also apply", () => {
    const displaySettings: BoardPayload["settings"] = {
      show_display_name: 1,
      show_server_name: 1,
      show_class_name: 1,
      show_item_level: 1,
      show_combat_power: 1
    };
    const next = applyBoardTableSettingsToAxisItems(board.axisItems, "table-1", {
      defaultRowHeight: 52,
      defaultColumnWidth: 148,
      displaySettings,
      applyRowSize: true,
      applyColumnSize: true,
      characterSeparator: { widthPx: 4, style: "dashed", color: "#334455" }
    });

    const row = next.find((item) => item.id === "row-task-1");
    const character = next.find((item) => item.id === "column-character-1");

    expect(row?.size_px).toBe(52);
    expect(row?.separator_json).toBeUndefined();
    expect(character?.size_px).toBe(148);
    expect(JSON.parse(character?.separator_json ?? "{}")).toEqual({ widthPx: 4, style: "dashed", color: "#334455" });
    expect(JSON.parse(character?.display_options_json ?? "{}")).toEqual(displaySettings);
  });

  it("detects mixed display option values from character-specific overrides", () => {
    const table = {
      ...board.tables[0]!,
      display_options_json: JSON.stringify({
        show_display_name: 1,
        show_server_name: 0,
        show_class_name: 0,
        show_item_level: 1,
        show_combat_power: 0
      })
    };
    const mixedKeys = getMixedBoardDisplaySettingKeys(
      [
        board.axisItems[0]!,
        {
          ...board.axisItems[1]!,
          display_options_json: JSON.stringify({
            show_display_name: 1,
            show_server_name: 1,
            show_class_name: 0,
            show_item_level: 1,
            show_combat_power: 0
          })
        },
        {
          ...board.axisItems[1]!,
          id: "column-character-2",
          label: "냠수나이스2",
          display_options_json: null
        }
      ],
      table,
      board.settings
    );

    expect(mixedKeys.has("show_server_name")).toBe(true);
    expect(mixedKeys.has("show_item_level")).toBe(false);
  });

  it("renders mixed display options as indeterminate checkboxes", () => {
    const html = renderToStaticMarkup(
      createElement(BoardDisplayOptions, {
        settings: board.settings,
        mixedKeys: new Set<keyof BoardPayload["settings"]>(["show_server_name"]),
        onChange: () => undefined
      })
    );

    expect(html).toContain('aria-checked="mixed"');
  });

  it("routes failed note mutations to the owning sheet before falling back to a broad reload", async () => {
    const recover = (BoardOverviewModule as unknown as {
      recoverFailedBoardNoteMutation?: (
        sheetId: string,
        onBoardSheetStale?: (sheetId: string) => Promise<void> | void,
        onBoardChanged?: () => Promise<BoardPayload | null> | void
      ) => Promise<void>;
    }).recoverFailedBoardNoteMutation;
    expect(recover).toBeTypeOf("function");
    if (!recover) return;
    const markSheetStale = vi.fn(async () => undefined);
    const reload = vi.fn(async () => board);

    await recover("sheet-2", markSheetStale, reload);

    expect(markSheetStale).toHaveBeenCalledWith("sheet-2");
    expect(reload).not.toHaveBeenCalled();

    await recover("sheet-3", undefined, reload);
    expect(reload).toHaveBeenCalledTimes(1);

    const failingRecovery = vi.fn(async () => {
      throw new Error("recovery failed");
    });
    await expect(recover("sheet-4", failingRecovery, reload)).resolves.toBeUndefined();
  });

  it("uses sheet-scoped recovery in every failed note mutation path", () => {
    const source = readFileSync(new URL("./BoardOverview.tsx", import.meta.url), "utf8");

    expect(source).toMatch(/handleCreateNote[\s\S]*?catch \(err\)[\s\S]*?recoverFailedBoardNoteMutation\(activeSheet\.id/);
    expect(source).toMatch(/handleNoteSave[\s\S]*?catch \(err\)[\s\S]*?recoverFailedBoardNoteMutation\(currentNote\.sheet_id/);
    expect(source).toMatch(/handleNoteDelete[\s\S]*?catch \(err\)[\s\S]*?recoverFailedBoardNoteMutation\(currentNote\.sheet_id/);
    expect(source).toMatch(/persistNoteLayout[\s\S]*?catch \(err\)[\s\S]*?recoverFailedBoardNoteMutation\(currentNote\.sheet_id/);
  });
});
