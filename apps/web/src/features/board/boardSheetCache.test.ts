import { describe, expect, expectTypeOf, it } from "vitest";
import {
  buildLocalBoardPeriodFingerprint,
  composeActiveBoardView,
  evictBoardSheetLru,
  getBoardSheetCacheEntry,
  getBoardSheetCacheKey,
  isReusableBoardSheet,
  markBoardSheetCacheEntryStale,
  reconcileBoardSheetCache,
  removeBoardSheetCacheEntry,
  setBoardSheetCacheEntry,
  touchBoardSheetCacheEntry,
  type BoardSheetCacheEntry
} from "./boardSheetCache";
import type {
  BoardAxisItem,
  BoardBootstrapPayload,
  BoardCellCompletion,
  BoardCellState,
  BoardDisplaySettings,
  BoardNote,
  BoardPayload,
  BoardSheetManifestItem,
  BoardSheetPayload,
  BoardSheetPayloadItem,
  BoardTable,
  BoardVersionSummary
} from "./types";

const settings: BoardDisplaySettings = {
  show_display_name: 1,
  show_server_name: 0,
  show_class_name: 0,
  show_item_level: 1,
  show_combat_power: 0
};

function manifestItem(
  id: string,
  version = 1,
  overrides: Partial<BoardSheetManifestItem> = {}
): BoardSheetManifestItem {
  return {
    id,
    name: id,
    sort_order: 0,
    is_default: 0,
    version,
    ...overrides
  };
}

function sheetPayload(
  id: string,
  contentVersion = 1,
  overrides: Partial<BoardSheetPayload> = {}
): BoardSheetPayload {
  return {
    sheet: {
      id,
      name: id,
      sort_order: 0,
      is_default: 0,
      content_version: contentVersion
    },
    tables: [],
    notes: [],
    axisItems: [],
    cellStates: [],
    completions: [],
    periodFingerprint: "",
    ...overrides
  };
}

function entry(id: string, lastAccess: number, userId = "user-1"): [string, BoardSheetCacheEntry] {
  return [
    getBoardSheetCacheKey(userId, id),
    { payload: sheetPayload(id), lastAccess, stale: false }
  ];
}

describe("sheet-aware client contracts", () => {
  it("matches the server manifest and sheet payload shapes", () => {
    expectTypeOf<BoardSheetManifestItem>().toEqualTypeOf<{
      id: string;
      name: string;
      sort_order: number;
      is_default: number;
      version: number;
    }>();
    expectTypeOf<BoardSheetPayloadItem>().toEqualTypeOf<{
      id: string;
      name: string;
      sort_order: number;
      is_default: number;
      content_version: number;
    }>();
    expectTypeOf<BoardSheetPayload>().toEqualTypeOf<{
      sheet: BoardSheetPayloadItem;
      tables: BoardTable[];
      notes: BoardNote[];
      axisItems: BoardAxisItem[];
      cellStates: BoardCellState[];
      completions: BoardCellCompletion[];
      periodFingerprint: string;
    }>();
  });

  it("shares full manifest metadata across bootstrap and version contracts", () => {
    expectTypeOf<BoardBootstrapPayload>().toEqualTypeOf<{
      userId: string;
      settings: BoardDisplaySettings;
      manifest: { version: number; sheets: BoardSheetManifestItem[] };
      activeSheet: BoardSheetPayload;
    }>();
    expectTypeOf<BoardVersionSummary>().toEqualTypeOf<{
      manifestVersion: number;
      sheets: BoardSheetManifestItem[];
      periodFingerprint: string;
      settings?: BoardDisplaySettings | undefined;
    }>();
  });
});

describe("board sheet cache entries", () => {
  it("uses the exact user-scoped cache key", () => {
    expect(getBoardSheetCacheKey("user-1", "sheet-2")).toBe("user-1:sheet-2");
  });

  it("inserts and replaces a fresh entry without mutating the input map", () => {
    const originalEntry = { payload: sheetPayload("sheet-1", 1), lastAccess: 10, stale: true };
    const original = new Map([[getBoardSheetCacheKey("user-1", "sheet-1"), originalEntry]]);
    const replacement = sheetPayload("sheet-1", 2);

    const next = setBoardSheetCacheEntry(original, "user-1", replacement, 20);

    expect(next).not.toBe(original);
    expect(getBoardSheetCacheEntry(next, "user-1", "sheet-1")).toEqual({
      payload: replacement,
      lastAccess: 20,
      stale: false
    });
    expect(getBoardSheetCacheEntry(original, "user-1", "sheet-1")).toBe(originalEntry);
    expect(originalEntry).toEqual({ payload: sheetPayload("sheet-1", 1), lastAccess: 10, stale: true });
  });

  it("touches an entry immutably and leaves missing entries absent", () => {
    const originalEntry = { payload: sheetPayload("sheet-1"), lastAccess: 10, stale: false };
    const original = new Map([[getBoardSheetCacheKey("user-1", "sheet-1"), originalEntry]]);

    const touched = touchBoardSheetCacheEntry(original, "user-1", "sheet-1", 30);
    const missing = touchBoardSheetCacheEntry(original, "user-1", "missing", 30);

    expect(touched).not.toBe(original);
    expect(getBoardSheetCacheEntry(touched, "user-1", "sheet-1")).toEqual({
      payload: originalEntry.payload,
      lastAccess: 30,
      stale: false
    });
    expect(getBoardSheetCacheEntry(missing, "user-1", "missing")).toBeUndefined();
    expect(getBoardSheetCacheEntry(original, "user-1", "sheet-1")).toBe(originalEntry);
  });

  it("marks an entry stale immutably", () => {
    const originalEntry = { payload: sheetPayload("sheet-1"), lastAccess: 10, stale: false };
    const original = new Map([[getBoardSheetCacheKey("user-1", "sheet-1"), originalEntry]]);

    const next = markBoardSheetCacheEntryStale(original, "user-1", "sheet-1");

    expect(next).not.toBe(original);
    expect(getBoardSheetCacheEntry(next, "user-1", "sheet-1")).toEqual({ ...originalEntry, stale: true });
    expect(originalEntry.stale).toBe(false);
  });

  it("removes an entry immutably", () => {
    const original = new Map([entry("sheet-1", 10)]);

    const next = removeBoardSheetCacheEntry(original, "user-1", "sheet-1");

    expect(next).not.toBe(original);
    expect(getBoardSheetCacheEntry(next, "user-1", "sheet-1")).toBeUndefined();
    expect(getBoardSheetCacheEntry(original, "user-1", "sheet-1")).toBeDefined();
  });

  it("stores no pending completion or cell-state overlay fields", () => {
    const next = setBoardSheetCacheEntry(new Map(), "user-1", sheetPayload("sheet-1"), 10);
    const cached = getBoardSheetCacheEntry(next, "user-1", "sheet-1");

    expect(Object.keys(cached ?? {}).sort()).toEqual(["lastAccess", "payload", "stale"]);
    expect(cached).not.toHaveProperty("pendingCompletions");
    expect(cached).not.toHaveProperty("pendingCellStates");
  });
});

describe("board sheet reuse", () => {
  const beforeDailyReset = new Date("2026-06-05T20:59:59.999Z");
  const afterDailyReset = new Date("2026-06-05T21:00:00.000Z");
  const dailyAxisItems = [
    {
      kind: "task",
      task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}'
    }
  ] as BoardAxisItem[];

  it("reuses only a fresh version-valid entry in the current period", () => {
    const payload = sheetPayload("sheet-1", 7, {
      axisItems: dailyAxisItems,
      periodFingerprint: buildLocalBoardPeriodFingerprint({ axisItems: dailyAxisItems }, beforeDailyReset)
    });
    const cached = { payload, lastAccess: 10, stale: false };

    expect(isReusableBoardSheet(cached, manifestItem("sheet-1", 7), beforeDailyReset)).toBe(true);
    expect(isReusableBoardSheet(undefined, manifestItem("sheet-1", 7), beforeDailyReset)).toBe(false);
    expect(isReusableBoardSheet(cached, undefined, beforeDailyReset)).toBe(false);
    expect(isReusableBoardSheet(cached, manifestItem("sheet-1", 8), beforeDailyReset)).toBe(false);
  });

  it("rejects entries carrying an explicit stale flag", () => {
    const cached = { payload: sheetPayload("sheet-1", 7), lastAccess: 10, stale: true };

    expect(isReusableBoardSheet(cached, manifestItem("sheet-1", 7), beforeDailyReset)).toBe(false);
  });

  it("rejects a manifest item for a different sheet with the same version and fingerprint", () => {
    const cached = { payload: sheetPayload("sheet-a", 7), lastAccess: 10, stale: false };

    expect(isReusableBoardSheet(cached, manifestItem("sheet-b", 7), beforeDailyReset)).toBe(false);
  });

  it("rejects an otherwise valid entry after a local period boundary", () => {
    const payload = sheetPayload("sheet-1", 7, {
      axisItems: dailyAxisItems,
      periodFingerprint: buildLocalBoardPeriodFingerprint({ axisItems: dailyAxisItems }, beforeDailyReset)
    });

    expect(
      isReusableBoardSheet({ payload, lastAccess: 10, stale: false }, manifestItem("sheet-1", 7), afterDailyReset)
    ).toBe(false);
  });

  it("builds a canonical sorted fingerprint and tolerates malformed legacy rules", () => {
    const axisItems = [
      {
        kind: "task",
        task_reset_rule_json: '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}'
      },
      { kind: "task", task_reset_rule_json: "legacy:not-json" },
      {
        kind: "task",
        task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}'
      },
      {
        kind: "task",
        task_reset_rule_json: '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}'
      },
      { kind: "custom", task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}' }
    ];
    const now = new Date("2026-06-05T03:00:00.000Z");

    expect(buildLocalBoardPeriodFingerprint({ axisItems }, now)).toBe(
      "daily:2026-06-05|weekly:2026-06-03"
    );
  });
});

describe("manifest reconciliation", () => {
  it("marks changed inactive sheets stale and leaves other users untouched", () => {
    const activeEntry = entry("active", 10);
    const inactiveEntry = entry("inactive", 20);
    const otherUserEntry = entry("inactive", 30, "user-2");
    const original = new Map([activeEntry, inactiveEntry, otherUserEntry]);
    const originalInactive = inactiveEntry[1];
    const originalOtherUser = otherUserEntry[1];

    const result = reconcileBoardSheetCache(
      original,
      "user-1",
      [manifestItem("active", 1), manifestItem("inactive", 2)],
      "active"
    );

    expect(result.cache).not.toBe(original);
    expect(result.nextActiveSheetId).toBe("active");
    expect(getBoardSheetCacheEntry(result.cache, "user-1", "active")?.stale).toBe(false);
    expect(getBoardSheetCacheEntry(result.cache, "user-1", "inactive")).toEqual({
      ...originalInactive,
      stale: true
    });
    expect(getBoardSheetCacheEntry(result.cache, "user-2", "inactive")).toBe(originalOtherUser);
    expect(originalInactive.stale).toBe(false);
  });

  it("removes deleted current-user sheets without touching another user's same sheet id", () => {
    const deleted = entry("deleted", 10);
    const otherUser = entry("deleted", 20, "user-2");
    const original = new Map([deleted, otherUser]);

    const result = reconcileBoardSheetCache(original, "user-1", [], null);

    expect(getBoardSheetCacheEntry(result.cache, "user-1", "deleted")).toBeUndefined();
    expect(getBoardSheetCacheEntry(result.cache, "user-2", "deleted")).toBe(otherUser[1]);
    expect(getBoardSheetCacheEntry(original, "user-1", "deleted")).toBe(deleted[1]);
  });

  it("falls back from a deleted active sheet to the default sheet", () => {
    const result = reconcileBoardSheetCache(
      new Map(),
      "user-1",
      [
        manifestItem("first", 1, { sort_order: 0 }),
        manifestItem("default", 1, { sort_order: 100, is_default: 1 })
      ],
      "deleted"
    );

    expect(result.nextActiveSheetId).toBe("default");
  });

  it("falls back to the first canonically sorted sheet when no default exists", () => {
    const result = reconcileBoardSheetCache(
      new Map(),
      "user-1",
      [
        manifestItem("later", 1, { name: "B", sort_order: 20 }),
        manifestItem("tie-z", 1, { name: "A", sort_order: 10 }),
        manifestItem("tie-a", 1, { name: "A", sort_order: 10 })
      ],
      "deleted"
    );

    expect(result.nextActiveSheetId).toBe("tie-a");
  });

  it("falls back to null when the remote manifest is empty", () => {
    const result = reconcileBoardSheetCache(new Map(), "user-1", [], "deleted");

    expect(result.nextActiveSheetId).toBeNull();
  });
});

describe("bounded user-scoped LRU eviction", () => {
  it("protects the active entry and deterministically retains eight current-user entries", () => {
    const original = new Map([
      entry("active", 0),
      entry("sheet-a", 1),
      entry("sheet-b", 1),
      entry("sheet-c", 3),
      entry("sheet-d", 4),
      entry("sheet-e", 5),
      entry("sheet-f", 6),
      entry("sheet-g", 7),
      entry("sheet-h", 8),
      entry("other", -1, "user-2")
    ]);

    const next = evictBoardSheetLru(original, "user-1", "active");
    const currentUserKeys = [...next.keys()].filter((key) => key.startsWith("user-1:"));

    expect(next).not.toBe(original);
    expect(currentUserKeys).toHaveLength(8);
    expect(getBoardSheetCacheEntry(next, "user-1", "active")).toBeDefined();
    expect(getBoardSheetCacheEntry(next, "user-1", "sheet-a")).toBeUndefined();
    expect(getBoardSheetCacheEntry(next, "user-1", "sheet-b")).toBeDefined();
    expect(getBoardSheetCacheEntry(next, "user-2", "other")).toBeDefined();
    expect(original).toHaveLength(10);
  });

  it("keeps the active entry when an edge maximum is below one", () => {
    const original = new Map([entry("active", 0), entry("inactive", 10), entry("other", 20, "user-2")]);

    const next = evictBoardSheetLru(original, "user-1", "active", 0);

    expect(getBoardSheetCacheEntry(next, "user-1", "active")).toBeDefined();
    expect(getBoardSheetCacheEntry(next, "user-1", "inactive")).toBeUndefined();
    expect(getBoardSheetCacheEntry(next, "user-2", "other")).toBeDefined();
  });
});

describe("legacy active board adapter", () => {
  it("composes the exact legacy shape from manifest navigation and active payload content", () => {
    const manifest = [manifestItem("sheet-1", 4), manifestItem("sheet-2", 8)];
    const payload = sheetPayload("sheet-1", 4);

    const view = composeActiveBoardView("user-1", settings, manifest, payload);

    expectTypeOf(view).toEqualTypeOf<BoardPayload>();
    expect(view).toEqual({
      userId: "user-1",
      settings,
      sheets: manifest,
      tables: payload.tables,
      notes: payload.notes,
      axisItems: payload.axisItems,
      cellStates: payload.cellStates,
      completions: payload.completions
    });
    expect(Object.keys(view).sort()).toEqual([
      "axisItems",
      "cellStates",
      "completions",
      "notes",
      "settings",
      "sheets",
      "tables",
      "userId"
    ]);
    expect(view).not.toHaveProperty("sheet");
    expect(view).not.toHaveProperty("periodFingerprint");
  });
});
