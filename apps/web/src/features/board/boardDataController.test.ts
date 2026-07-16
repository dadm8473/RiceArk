import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createBoardDataController,
  type BoardDataApi,
  type BoardDataEffect
} from "./boardDataController";
import {
  buildLocalBoardPeriodFingerprint,
  getBoardSheetCacheEntry,
  isReusableBoardSheet
} from "./boardSheetCache";
import type {
  BoardAxisItem,
  BoardBootstrapPayload,
  BoardDisplaySettings,
  BoardSheetManifestItem,
  BoardSheetPayload,
  BoardVersionSummary
} from "./types";

const defaultSettings: BoardDisplaySettings = {
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
    sort_order: Number(id.replace(/\D/g, "")) || 0,
    is_default: id === "sheet-1" ? 1 : 0,
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
      sort_order: Number(id.replace(/\D/g, "")) || 0,
      is_default: id === "sheet-1" ? 1 : 0,
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

function bootstrapPayload(
  activeSheetId = "sheet-1",
  sheets: BoardSheetManifestItem[] = [manifestItem("sheet-1")],
  overrides: Partial<BoardBootstrapPayload> = {}
): BoardBootstrapPayload {
  const active = sheets.find((sheet) => sheet.id === activeSheetId);
  return {
    userId: "user-1",
    settings: { ...defaultSettings },
    manifest: { version: 1, sheets },
    activeSheet: sheetPayload(activeSheetId, active?.version ?? 1),
    ...overrides
  };
}

function versionSummary(
  sheets: BoardSheetManifestItem[],
  overrides: Partial<BoardVersionSummary> = {}
): BoardVersionSummary {
  return {
    manifestVersion: 1,
    sheets,
    periodFingerprint: "",
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

class FakeBoardApi implements BoardDataApi {
  readonly calls: string[] = [];
  getBootstrapImpl: (sheetId?: string) => Promise<BoardBootstrapPayload> = async () =>
    bootstrapPayload();
  getSheetImpl: (sheetId: string) => Promise<BoardSheetPayload> = async (sheetId) =>
    sheetPayload(sheetId);
  getVersionsImpl: () => Promise<BoardVersionSummary> = async () =>
    versionSummary([manifestItem("sheet-1")]);

  getBootstrap(sheetId?: string): Promise<BoardBootstrapPayload> {
    this.calls.push(`bootstrap:${sheetId ?? ""}`);
    return this.getBootstrapImpl(sheetId);
  }

  getSheet(sheetId: string): Promise<BoardSheetPayload> {
    this.calls.push(`sheet:${sheetId}`);
    return this.getSheetImpl(sheetId);
  }

  getVersions(): Promise<BoardVersionSummary> {
    this.calls.push("versions");
    return this.getVersionsImpl();
  }
}

function createHarness(options: {
  activeSheetId?: string;
  manifest?: BoardSheetManifestItem[];
  maxCacheEntries?: number;
  now?: Date;
  userId?: string | null;
} = {}) {
  const api = new FakeBoardApi();
  const manifest = options.manifest ?? [manifestItem("sheet-1")];
  const activeSheetId = options.activeSheetId ?? "sheet-1";
  let now = options.now ?? new Date("2026-07-16T00:00:00.000Z");
  let clock = 0;
  api.getBootstrapImpl = async () => bootstrapPayload(activeSheetId, manifest);
  api.getSheetImpl = async (sheetId) => {
    const item = manifest.find((sheet) => sheet.id === sheetId);
    return sheetPayload(sheetId, item?.version ?? 1);
  };
  api.getVersionsImpl = async () => versionSummary(manifest);
  const controller = createBoardDataController(api, {
    maxCacheEntries: options.maxCacheEntries,
    now: () => now,
    nowMs: () => ++clock,
    userId: options.userId === undefined ? "user-1" : options.userId
  });
  return {
    api,
    controller,
    setNow(value: Date) {
      now = value;
    }
  };
}

describe("board data request budgets", () => {
  it("uses bootstrap once, loads only the first uncached visit, reuses a valid return, and polls versions only", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2")];
    const { api, controller } = createHarness({ manifest });

    await controller.bootstrap("sheet-1");
    expect(api.calls).toEqual(["bootstrap:sheet-1"]);
    expect(controller.snapshot()).toMatchObject({
      userId: "user-1",
      settings: defaultSettings,
      manifestVersion: 1,
      manifest,
      activeSheetId: "sheet-1",
      loading: false,
      error: null
    });

    await controller.selectSheet("sheet-2");
    expect(api.calls).toEqual(["bootstrap:sheet-1", "sheet:sheet-2"]);

    await controller.selectSheet("sheet-1");
    expect(api.calls).toHaveLength(2);
    expect(controller.snapshot().activeSheetId).toBe("sheet-1");

    await controller.revalidate("poll");
    expect(api.calls).toEqual(["bootstrap:sheet-1", "sheet:sheet-2", "versions"]);
  });

  it("retries a current selection once when a mutation acknowledgement overtakes its read", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2")];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    const firstRead = deferred<BoardSheetPayload>();
    let attempts = 0;
    api.getSheetImpl = async () => {
      attempts += 1;
      return attempts === 1 ? firstRead.promise : sheetPayload("sheet-2", 2);
    };

    const selecting = controller.selectSheet("sheet-2");
    controller.applyMutationVersions({ sheets: [{ id: "sheet-2", version: 2 }] });
    firstRead.resolve(sheetPayload("sheet-2", 1));
    await selecting;

    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "sheet:sheet-2",
      "sheet:sheet-2"
    ]);
    const state = controller.snapshot();
    const entry = getBoardSheetCacheEntry(state.cache, "user-1", "sheet-2");
    expect(state).toMatchObject({ activeSheetId: "sheet-2", loading: false, error: null });
    expect(entry).toMatchObject({ stale: false, payload: { sheet: { content_version: 2 } } });
    expect(
      isReusableBoardSheet(
        entry,
        state.manifest.find((sheet) => sheet.id === "sheet-2"),
        new Date("2026-07-16T00:00:00.000Z")
      )
    ).toBe(true);
  });

  it("bounds a current selection to one retry and leaves an unusable result retryable", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2")];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    const firstRead = deferred<BoardSheetPayload>();
    let attempts = 0;
    api.getSheetImpl = async () => {
      attempts += 1;
      return attempts === 1 ? firstRead.promise : sheetPayload("sheet-2", 1);
    };

    const selecting = controller.selectSheet("sheet-2");
    controller.applyMutationVersions({ sheets: [{ id: "sheet-2", version: 2 }] });
    firstRead.resolve(sheetPayload("sheet-2", 1));
    await expect(selecting).rejects.toThrow(/remained stale/);

    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "sheet:sheet-2",
      "sheet:sheet-2"
    ]);
    expect(controller.snapshot()).toMatchObject({
      activeSheetId: "sheet-2",
      loading: false,
      error: expect.stringMatching(/remained stale/)
    });
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-2")?.stale).toBe(true);

    api.getSheetImpl = async () => sheetPayload("sheet-2", 2);
    await controller.selectSheet("sheet-2");
    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "sheet:sheet-2",
      "sheet:sheet-2",
      "sheet:sheet-2"
    ]);
  });

  it("fetches exactly the active sheet after its remote content version changes", async () => {
    const manifest = [manifestItem("sheet-1")];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    api.getVersionsImpl = async () => versionSummary([manifestItem("sheet-1", 2)]);
    api.getSheetImpl = async () => sheetPayload("sheet-1", 2);

    await controller.revalidate("poll");

    expect(api.calls).toEqual(["bootstrap:sheet-1", "versions", "sheet:sheet-1"]);
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-1")).toMatchObject({
      stale: false,
      payload: { sheet: { content_version: 2 } }
    });
  });

  it("marks a changed inactive sheet stale and defers its only read until selection", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2")];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    await controller.selectSheet("sheet-2");
    await controller.selectSheet("sheet-1");
    api.getVersionsImpl = async () =>
      versionSummary([manifestItem("sheet-1"), manifestItem("sheet-2", 2)]);
    api.getSheetImpl = async (sheetId) => sheetPayload(sheetId, sheetId === "sheet-2" ? 2 : 1);

    await controller.revalidate("poll");

    expect(api.calls).toEqual(["bootstrap:sheet-1", "sheet:sheet-2", "versions"]);
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-2")?.stale).toBe(true);

    await controller.selectSheet("sheet-2");
    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "sheet:sheet-2",
      "versions",
      "sheet:sheet-2"
    ]);
  });

  it("replaces renamed, reordered, and default manifest metadata without another read", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2")];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    const remote = [
      manifestItem("sheet-2", 1, { name: "First", sort_order: 0, is_default: 1 }),
      manifestItem("sheet-1", 1, { name: "Second", sort_order: 10, is_default: 0 })
    ];
    api.getVersionsImpl = async () => versionSummary(remote, { manifestVersion: 2 });

    await controller.revalidate("broadcast");

    expect(api.calls).toEqual(["bootstrap:sheet-1", "versions"]);
    expect(controller.snapshot()).toMatchObject({ manifestVersion: 2, manifest: remote });
  });

  it("applies summary settings without bootstrapping or loading a sheet", async () => {
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");
    const settings = { ...defaultSettings, show_server_name: 1 };
    api.getVersionsImpl = async () => versionSummary([manifestItem("sheet-1")], { settings });

    await controller.revalidate("focus");

    expect(api.calls).toEqual(["bootstrap:sheet-1", "versions"]);
    expect(controller.snapshot().settings).toEqual(settings);
  });

  it("keeps exactly eight entries per user in the integrated LRU", async () => {
    const manifest = Array.from({ length: 9 }, (_, index) => manifestItem(`sheet-${index + 1}`));
    const { api, controller } = createHarness({ manifest, maxCacheEntries: 8 });
    await controller.bootstrap("sheet-1");

    for (let index = 2; index <= 9; index += 1) {
      await controller.selectSheet(`sheet-${index}`);
    }

    const state = controller.snapshot();
    expect([...state.cache.keys()].filter((key) => key.startsWith("user-1:"))).toHaveLength(8);
    expect(getBoardSheetCacheEntry(state.cache, "user-1", "sheet-1")).toBeUndefined();
    expect(getBoardSheetCacheEntry(state.cache, "user-1", "sheet-9")).toBeDefined();
    expect(api.calls).toHaveLength(9);
  });
});

describe("manifest fallback and period reconciliation", () => {
  it("falls back to a reusable cached default with one replace effect and no sheet read", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2", 1, { is_default: 0 })];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    await controller.selectSheet("sheet-2");
    await controller.selectSheet("sheet-1");
    const effects: BoardDataEffect[] = [];
    controller.subscribe((_state, effect) => {
      if (effect) effects.push(effect);
    });
    api.getVersionsImpl = async () =>
      versionSummary([manifestItem("sheet-2", 1, { is_default: 1 })], { manifestVersion: 2 });

    await controller.revalidate("poll");

    expect(api.calls).toEqual(["bootstrap:sheet-1", "sheet:sheet-2", "versions"]);
    expect(controller.snapshot().activeSheetId).toBe("sheet-2");
    expect(effects).toEqual([
      { type: "replace-url-with-sheet", replaceUrlWithSheetId: "sheet-2" }
    ]);
    expect(controller.snapshot()).not.toHaveProperty("effect");
  });

  it("falls back to the first sorted uncached sheet when no remaining sheet is default", async () => {
    const manifest = [
      manifestItem("sheet-1"),
      manifestItem("sheet-2", 1, { name: "Later", sort_order: 20, is_default: 0 }),
      manifestItem("sheet-3", 1, { name: "First", sort_order: 10, is_default: 0 })
    ];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    const effects: BoardDataEffect[] = [];
    controller.subscribe((_state, effect) => {
      if (effect) effects.push(effect);
    });
    api.getVersionsImpl = async () =>
      versionSummary(
        [
          manifestItem("sheet-2", 1, { name: "Later", sort_order: 20, is_default: 0 }),
          manifestItem("sheet-3", 1, { name: "First", sort_order: 10, is_default: 0 })
        ],
        { manifestVersion: 2 }
      );

    await controller.revalidate("poll");

    expect(api.calls).toEqual(["bootstrap:sheet-1", "versions", "sheet:sheet-3"]);
    expect(controller.snapshot().activeSheetId).toBe("sheet-3");
    expect(effects).toEqual([
      { type: "replace-url-with-sheet", replaceUrlWithSheetId: "sheet-3" }
    ]);
  });

  it("emits one null replacement for an empty manifest without replaying the effect", async () => {
    expectTypeOf<BoardDataEffect["replaceUrlWithSheetId"]>().toEqualTypeOf<string | null>();
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");
    const effects: BoardDataEffect[] = [];
    controller.subscribe((_state, effect) => {
      if (effect) effects.push(effect);
    });
    api.getVersionsImpl = async () => versionSummary([], { manifestVersion: 2 });

    await controller.revalidate("poll");

    expect(api.calls).toEqual(["bootstrap:sheet-1", "versions"]);
    expect(controller.snapshot()).toMatchObject({ activeSheetId: null, manifest: [], loading: false });
    expect(effects).toEqual([
      { type: "replace-url-with-sheet", replaceUrlWithSheetId: null }
    ]);

    const laterEffects: BoardDataEffect[] = [];
    controller.subscribe((_state, effect) => {
      if (effect) laterEffects.push(effect);
    });
    controller.applyMutationVersions({ manifestVersion: 3, sheets: [] });

    expect(api.calls).toEqual(["bootstrap:sheet-1", "versions"]);
    expect(effects).toEqual([
      { type: "replace-url-with-sheet", replaceUrlWithSheetId: null }
    ]);
    expect(laterEffects).toEqual([]);
    expect(controller.snapshot()).not.toHaveProperty("effect");
  });

  it("reloads only the active sheet after an explicit reset-period invalidation", async () => {
    const beforeReset = new Date("2026-07-15T20:59:59.999Z");
    const afterReset = new Date("2026-07-15T21:00:00.000Z");
    const dailyAxisItem = {
      id: "task-1",
      table_id: "table-1",
      axis: "row",
      kind: "task",
      label: "Daily",
      character_id: null,
      task_id: "daily-1",
      task_color: null,
      size_px: null,
      sort_order: 0,
      visible: 1,
      task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}'
    } as BoardAxisItem;
    const { api, controller, setNow } = createHarness({ now: beforeReset });
    api.getBootstrapImpl = async () =>
      bootstrapPayload("sheet-1", [manifestItem("sheet-1")], {
        activeSheet: sheetPayload("sheet-1", 1, {
          axisItems: [dailyAxisItem],
          periodFingerprint: buildLocalBoardPeriodFingerprint({ axisItems: [dailyAxisItem] }, beforeReset)
        })
      });
    api.getSheetImpl = async () =>
      sheetPayload("sheet-1", 1, {
        axisItems: [dailyAxisItem],
        periodFingerprint: buildLocalBoardPeriodFingerprint({ axisItems: [dailyAxisItem] }, afterReset)
      });
    await controller.bootstrap("sheet-1");
    setNow(afterReset);

    await controller.invalidatePeriod("sheet-1");

    expect(api.calls).toEqual(["bootstrap:sheet-1", "sheet:sheet-1"]);
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-1")?.stale).toBe(false);
  });

  it("retries an active period invalidation once when the first payload has the old fingerprint", async () => {
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");
    let attempts = 0;
    api.getSheetImpl = async () => {
      attempts += 1;
      return sheetPayload("sheet-1", 1, {
        periodFingerprint: attempts === 1 ? "old-period" : ""
      });
    };

    await controller.invalidatePeriod("sheet-1");

    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "sheet:sheet-1",
      "sheet:sheet-1"
    ]);
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-1")).toMatchObject({
      stale: false,
      payload: { periodFingerprint: "" }
    });
  });
});

describe("remote summary application budgets", () => {
  it("applies unchanged and inactive changes without polling or eager inactive reads", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2")];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    await controller.selectSheet("sheet-2");
    await controller.selectSheet("sheet-1");

    await controller.applyRemoteSummary(versionSummary(manifest), "broadcast");
    expect(api.calls).toEqual(["bootstrap:sheet-1", "sheet:sheet-2"]);

    await controller.applyRemoteSummary(
      versionSummary([manifestItem("sheet-1"), manifestItem("sheet-2", 2)], {
        manifestVersion: 2
      }),
      "broadcast"
    );

    expect(api.calls).toEqual(["bootstrap:sheet-1", "sheet:sheet-2"]);
    expect(controller.snapshot()).toMatchObject({ activeSheetId: "sheet-1", loading: false, error: null });
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-2")?.stale).toBe(true);
  });

  it("loads exactly one changed active sheet without polling", async () => {
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");
    api.getSheetImpl = async () => sheetPayload("sheet-1", 2);

    await controller.applyRemoteSummary(
      versionSummary([manifestItem("sheet-1", 2)], { manifestVersion: 2 }),
      "cross-tab"
    );

    expect(api.calls).toEqual(["bootstrap:sheet-1", "sheet:sheet-1"]);
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-1")).toMatchObject({
      stale: false,
      payload: { sheet: { content_version: 2 } }
    });
  });

  it("reconciles active deletion to an uncached fallback with one read and one effect", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2", 1, { is_default: 0 })];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    const effects: BoardDataEffect[] = [];
    controller.subscribe((_state, effect) => {
      if (effect) effects.push(effect);
    });
    api.getSheetImpl = async () => sheetPayload("sheet-2", 2, {
      sheet: {
        id: "sheet-2",
        name: "sheet-2",
        sort_order: 2,
        is_default: 1,
        content_version: 2
      }
    });

    await controller.applyRemoteSummary(
      versionSummary([manifestItem("sheet-2", 2, { is_default: 1 })], {
        manifestVersion: 2
      }),
      "cross-tab"
    );

    expect(api.calls).toEqual(["bootstrap:sheet-1", "sheet:sheet-2"]);
    expect(controller.snapshot()).toMatchObject({ activeSheetId: "sheet-2", loading: false, error: null });
    expect(effects).toEqual([
      { type: "replace-url-with-sheet", replaceUrlWithSheetId: "sheet-2" }
    ]);
  });

  it("rejects duplicate ids without API calls or state contamination", async () => {
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");

    await expect(
      controller.applyRemoteSummary(
        versionSummary([manifestItem("sheet-1"), manifestItem("sheet-1")]),
        "cross-tab"
      )
    ).rejects.toThrow(/duplicate sheet id.*sheet-1/i);

    expect(api.calls).toEqual(["bootstrap:sheet-1"]);
    expect(controller.snapshot()).toMatchObject({
      manifestVersion: 1,
      manifest: [{ id: "sheet-1", version: 1 }],
      loading: false,
      error: expect.stringMatching(/duplicate sheet id/i)
    });

    await controller.applyRemoteSummary(versionSummary([manifestItem("sheet-1")]), "retry");
    expect(api.calls).toEqual(["bootstrap:sheet-1"]);
    expect(controller.snapshot()).toMatchObject({ loading: false, error: null });
  });
});

describe("deduplication and retry", () => {
  it("deduplicates a bootstrap key and clears it after failure so the same key retries", async () => {
    const api = new FakeBoardApi();
    const first = deferred<BoardBootstrapPayload>();
    let attempts = 0;
    api.getBootstrapImpl = () => {
      attempts += 1;
      return attempts === 1 ? first.promise : Promise.resolve(bootstrapPayload());
    };
    const controller = createBoardDataController(api, { userId: "user-1" });

    const left = controller.bootstrap("sheet-1");
    const right = controller.bootstrap("sheet-1");
    expect(api.calls).toEqual(["bootstrap:sheet-1"]);
    first.reject(new Error("bootstrap unavailable"));
    await expect(left).rejects.toThrow("bootstrap unavailable");
    await expect(right).rejects.toThrow("bootstrap unavailable");

    await controller.bootstrap("sheet-1");
    expect(api.calls).toEqual(["bootstrap:sheet-1", "bootstrap:sheet-1"]);
  });

  it("deduplicates user and sheet reads and retries after a shared failure", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2")];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    const first = deferred<BoardSheetPayload>();
    let attempts = 0;
    api.getSheetImpl = (sheetId) => {
      attempts += 1;
      return attempts === 1 ? first.promise : Promise.resolve(sheetPayload(sheetId));
    };

    const left = controller.selectSheet("sheet-2");
    const right = controller.selectSheet("sheet-2");
    expect(api.calls).toEqual(["bootstrap:sheet-1", "sheet:sheet-2"]);
    first.reject(new Error("sheet unavailable"));
    await expect(left).rejects.toThrow("sheet unavailable");
    await expect(right).rejects.toThrow("sheet unavailable");

    await controller.selectSheet("sheet-2");
    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "sheet:sheet-2",
      "sheet:sheet-2"
    ]);
  });

  it("deduplicates version requests and retries a failed poll", async () => {
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");
    const first = deferred<BoardVersionSummary>();
    let attempts = 0;
    api.getVersionsImpl = () => {
      attempts += 1;
      return attempts === 1 ? first.promise : Promise.resolve(versionSummary([manifestItem("sheet-1")]));
    };

    const left = controller.revalidate("focus");
    const right = controller.revalidate("poll");
    expect(api.calls).toEqual(["bootstrap:sheet-1", "versions"]);
    first.reject(new Error("versions unavailable"));
    await expect(left).rejects.toThrow("versions unavailable");
    await expect(right).rejects.toThrow("versions unavailable");

    await controller.revalidate("retry");
    expect(api.calls).toEqual(["bootstrap:sheet-1", "versions", "versions"]);
  });
});

describe("race and identity protection", () => {
  it("lets a slow prior selection populate cache without replacing the newer active state", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2"), manifestItem("sheet-3")];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    const second = deferred<BoardSheetPayload>();
    const third = deferred<BoardSheetPayload>();
    api.getSheetImpl = (sheetId) => (sheetId === "sheet-2" ? second.promise : third.promise);

    const selectSecond = controller.selectSheet("sheet-2");
    const selectThird = controller.selectSheet("sheet-3");
    second.resolve(sheetPayload("sheet-2"));
    await selectSecond;

    expect(controller.snapshot()).toMatchObject({
      activeSheetId: "sheet-3",
      loading: true,
      error: null
    });
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-2")).toBeDefined();

    third.resolve(sheetPayload("sheet-3"));
    await selectThird;

    const state = controller.snapshot();
    expect(state).toMatchObject({ activeSheetId: "sheet-3", loading: false, error: null });
    expect(getBoardSheetCacheEntry(state.cache, "user-1", "sheet-2")).toBeDefined();
    expect(getBoardSheetCacheEntry(state.cache, "user-1", "sheet-3")).toBeDefined();
  });

  it("does not retry an unusable selection after it is superseded and becomes inactive", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2"), manifestItem("sheet-3")];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    const second = deferred<BoardSheetPayload>();
    api.getSheetImpl = async (sheetId) =>
      sheetId === "sheet-2" ? second.promise : sheetPayload("sheet-3");

    const selectSecond = controller.selectSheet("sheet-2");
    controller.applyMutationVersions({ sheets: [{ id: "sheet-2", version: 2 }] });
    await controller.selectSheet("sheet-3");
    second.resolve(sheetPayload("sheet-2", 1));
    await selectSecond;

    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "sheet:sheet-2",
      "sheet:sheet-3"
    ]);
    expect(controller.snapshot()).toMatchObject({ activeSheetId: "sheet-3", loading: false, error: null });
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-2")?.stale).toBe(true);
  });

  it("refreshes a cached selection invalidated by a slower version response", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2")];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    await controller.selectSheet("sheet-2");
    await controller.selectSheet("sheet-1");
    const remote = deferred<BoardVersionSummary>();
    api.getVersionsImpl = () => remote.promise;
    api.getSheetImpl = async (sheetId) => sheetPayload(sheetId, sheetId === "sheet-2" ? 2 : 1);

    const polling = controller.revalidate("poll");
    await controller.selectSheet("sheet-2");
    remote.resolve(
      versionSummary([manifestItem("sheet-1"), manifestItem("sheet-2", 2)])
    );
    await polling;

    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "sheet:sheet-2",
      "versions",
      "sheet:sheet-2"
    ]);
    expect(controller.snapshot()).toMatchObject({
      activeSheetId: "sheet-2",
      loading: false,
      error: null
    });
    expect(
      getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-2")?.payload.sheet
        .content_version
    ).toBe(2);
  });

  it("retries once after a newer version summary joins an older active sheet request", async () => {
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");
    const olderSheet = deferred<BoardSheetPayload>();
    let sheetAttempt = 0;
    api.getSheetImpl = async () => {
      sheetAttempt += 1;
      return sheetAttempt === 1 ? olderSheet.promise : sheetPayload("sheet-1", 2);
    };
    api.getVersionsImpl = async () => versionSummary([manifestItem("sheet-1", 2)]);

    const olderRefresh = controller.markSheetStale("sheet-1");
    const polling = controller.revalidate("poll");
    expect(api.calls).toEqual(["bootstrap:sheet-1", "sheet:sheet-1", "versions"]);
    olderSheet.resolve(sheetPayload("sheet-1", 1));
    await olderRefresh;
    await polling;

    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "sheet:sheet-1",
      "versions",
      "sheet:sheet-1"
    ]);
    const state = controller.snapshot();
    const entry = getBoardSheetCacheEntry(state.cache, "user-1", "sheet-1");
    expect(entry).toMatchObject({ stale: false, payload: { sheet: { content_version: 2 } } });
    expect(
      isReusableBoardSheet(
        entry,
        state.manifest.find((sheet) => sheet.id === "sheet-1"),
        new Date("2026-07-16T00:00:00.000Z")
      )
    ).toBe(true);
  });

  it("fails after one fresh retry remains behind and leaves the active entry retryable", async () => {
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");
    const olderSheet = deferred<BoardSheetPayload>();
    let sheetAttempt = 0;
    api.getSheetImpl = async () => {
      sheetAttempt += 1;
      return sheetAttempt === 1 ? olderSheet.promise : sheetPayload("sheet-1", 1);
    };
    api.getVersionsImpl = async () => versionSummary([manifestItem("sheet-1", 2)]);

    const olderRefresh = controller.markSheetStale("sheet-1");
    const polling = controller.revalidate("poll");
    const pollingResult = polling.then(
      () => null,
      (error: unknown) => error
    );
    olderSheet.resolve(sheetPayload("sheet-1", 1));
    await olderRefresh;
    expect(await pollingResult).toEqual(expect.objectContaining({ message: expect.stringMatching(/remained stale/) }));

    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "sheet:sheet-1",
      "versions",
      "sheet:sheet-1"
    ]);
    expect(controller.snapshot()).toMatchObject({ loading: false, error: expect.stringMatching(/remained stale/) });
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-1")?.stale).toBe(true);

    api.getSheetImpl = async () => sheetPayload("sheet-1", 2);
    await controller.revalidate("retry");

    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "sheet:sheet-1",
      "versions",
      "sheet:sheet-1",
      "versions",
      "sheet:sheet-1"
    ]);
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-1")).toMatchObject({
      stale: false,
      payload: { sheet: { content_version: 2 } }
    });
  });

  it("keeps newer bootstrap settings when an older version response resolves later", async () => {
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");
    const olderVersions = deferred<BoardVersionSummary>();
    api.getVersionsImpl = () => olderVersions.promise;
    const polling = controller.revalidate("poll");
    const newerSettings = { ...defaultSettings, show_server_name: 1 };
    const newerManifest = [manifestItem("sheet-1", 2)];
    api.getBootstrapImpl = async () =>
      bootstrapPayload("sheet-1", newerManifest, {
        settings: newerSettings,
        manifest: { version: 2, sheets: newerManifest },
        activeSheet: sheetPayload("sheet-1", 2)
      });

    await controller.bootstrap("sheet-1");
    olderVersions.resolve(
      versionSummary([manifestItem("sheet-1")], {
        manifestVersion: 1,
        settings: { ...defaultSettings }
      })
    );
    await polling;

    expect(api.calls).toEqual(["bootstrap:sheet-1", "versions", "bootstrap:sheet-1"]);
    expect(controller.snapshot()).toMatchObject({
      settings: newerSettings,
      manifestVersion: 2,
      manifest: [{ id: "sheet-1", version: 2 }]
    });
  });

  it("does not let an older poll cancel or reconcile over a newer in-flight bootstrap", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2", 1, { is_default: 0 })];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    const olderVersions = deferred<BoardVersionSummary>();
    const newerBootstrap = deferred<BoardBootstrapPayload>();
    const effects: BoardDataEffect[] = [];
    controller.subscribe((_state, effect) => {
      if (effect) effects.push(effect);
    });
    api.getVersionsImpl = () => olderVersions.promise;
    const polling = controller.revalidate("poll");
    api.getBootstrapImpl = () => newerBootstrap.promise;
    const bootstrapping = controller.bootstrap("sheet-2");
    const newerSettings = { ...defaultSettings, show_server_name: 1 };
    const newerManifest = [manifestItem("sheet-2", 3, { is_default: 1 })];

    olderVersions.resolve(
      versionSummary([manifestItem("sheet-2", 2, { is_default: 1 })], { manifestVersion: 2 })
    );
    await polling;

    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "versions",
      "bootstrap:sheet-2"
    ]);
    expect(controller.snapshot()).toMatchObject({
      activeSheetId: "sheet-1",
      loading: true,
      error: null
    });
    expect(effects).toEqual([]);

    newerBootstrap.resolve(
      bootstrapPayload("sheet-2", newerManifest, {
        settings: newerSettings,
        manifest: { version: 3, sheets: newerManifest },
        activeSheet: sheetPayload("sheet-2", 3, {
          sheet: {
            id: "sheet-2",
            name: "sheet-2",
            sort_order: 2,
            is_default: 1,
            content_version: 3
          }
        })
      })
    );
    await bootstrapping;

    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "versions",
      "bootstrap:sheet-2"
    ]);
    expect(controller.snapshot()).toMatchObject({
      settings: newerSettings,
      manifestVersion: 3,
      manifest: newerManifest,
      activeSheetId: "sheet-2",
      loading: false,
      error: null
    });
    expect(effects).toEqual([]);
  });

  it("keeps mutation lower bounds through bootstrap and refreshes its behind active payload", async () => {
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");
    const pendingBootstrap = deferred<BoardBootstrapPayload>();
    api.getBootstrapImpl = () => pendingBootstrap.promise;
    api.getSheetImpl = async () => sheetPayload("sheet-1", 3);

    const bootstrapping = controller.bootstrap("sheet-1");
    controller.applyMutationVersions({
      manifestVersion: 3,
      sheets: [{ id: "sheet-1", version: 3 }]
    });
    const olderManifest = [manifestItem("sheet-1", 2)];
    pendingBootstrap.resolve(
      bootstrapPayload("sheet-1", olderManifest, {
        manifest: { version: 2, sheets: olderManifest },
        activeSheet: sheetPayload("sheet-1", 2)
      })
    );
    await bootstrapping;

    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "bootstrap:sheet-1",
      "sheet:sheet-1"
    ]);
    const state = controller.snapshot();
    const entry = getBoardSheetCacheEntry(state.cache, "user-1", "sheet-1");
    expect(state).toMatchObject({
      manifestVersion: 3,
      manifest: [{ id: "sheet-1", version: 3 }],
      activeSheetId: "sheet-1",
      loading: false,
      error: null
    });
    expect(entry).toMatchObject({ stale: false, payload: { sheet: { content_version: 3 } } });
    expect(
      isReusableBoardSheet(entry, state.manifest[0], new Date("2026-07-16T00:00:00.000Z"))
    ).toBe(true);
  });

  it("fails a behind bootstrap after one refresh retry and leaves the same key retryable", async () => {
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");
    const pendingBootstrap = deferred<BoardBootstrapPayload>();
    api.getBootstrapImpl = () => pendingBootstrap.promise;
    api.getSheetImpl = async () => sheetPayload("sheet-1", 2);

    const bootstrapping = controller.bootstrap("sheet-1");
    controller.applyMutationVersions({
      manifestVersion: 3,
      sheets: [{ id: "sheet-1", version: 3 }]
    });
    const olderManifest = [manifestItem("sheet-1", 2)];
    pendingBootstrap.resolve(
      bootstrapPayload("sheet-1", olderManifest, {
        manifest: { version: 2, sheets: olderManifest },
        activeSheet: sheetPayload("sheet-1", 2)
      })
    );

    await expect(bootstrapping).rejects.toThrow(/remained stale/);
    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "bootstrap:sheet-1",
      "sheet:sheet-1",
      "sheet:sheet-1"
    ]);
    expect(controller.snapshot()).toMatchObject({
      manifestVersion: 3,
      manifest: [{ id: "sheet-1", version: 3 }],
      loading: false,
      error: expect.stringMatching(/remained stale/)
    });
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-1")?.stale).toBe(true);

    const currentManifest = [manifestItem("sheet-1", 3)];
    api.getBootstrapImpl = async () =>
      bootstrapPayload("sheet-1", currentManifest, {
        manifest: { version: 3, sheets: currentManifest },
        activeSheet: sheetPayload("sheet-1", 3)
      });
    await controller.bootstrap("sheet-1");

    expect(api.calls).toEqual([
      "bootstrap:sheet-1",
      "bootstrap:sheet-1",
      "sheet:sheet-1",
      "sheet:sheet-1",
      "bootstrap:sheet-1"
    ]);
    expect(controller.snapshot()).toMatchObject({ loading: false, error: null });
  });

  it("rejects duplicate summary ids before contamination and clears the poll for retry", async () => {
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");
    let attempts = 0;
    api.getVersionsImpl = async () => {
      attempts += 1;
      return attempts === 1
        ? versionSummary([manifestItem("sheet-1", 2), manifestItem("sheet-1", 3)], {
            manifestVersion: 2
          })
        : versionSummary([manifestItem("sheet-1")]);
    };

    await expect(controller.revalidate("duplicate")).rejects.toThrow(/duplicate sheet id.*sheet-1/i);

    expect(api.calls).toEqual(["bootstrap:sheet-1", "versions"]);
    expect(controller.snapshot()).toMatchObject({
      manifestVersion: 1,
      manifest: [{ id: "sheet-1", version: 1 }],
      loading: false,
      error: expect.stringMatching(/duplicate sheet id/i)
    });
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-1")).toMatchObject({
      stale: false,
      payload: { sheet: { content_version: 1 } }
    });

    await controller.revalidate("retry");
    expect(api.calls).toEqual(["bootstrap:sheet-1", "versions", "versions"]);
    expect(controller.snapshot()).toMatchObject({ loading: false, error: null });
  });

  it("does not let a slow version summary regress mutation-acknowledged manifest or sheet versions", async () => {
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");
    const remote = deferred<BoardVersionSummary>();
    api.getVersionsImpl = () => remote.promise;
    api.getSheetImpl = async () => sheetPayload("sheet-1", 3);

    const polling = controller.revalidate("poll");
    controller.applyMutationVersions({ manifestVersion: 3, sheets: [{ id: "sheet-1", version: 3 }] });
    expect(api.calls).toEqual(["bootstrap:sheet-1", "versions"]);
    remote.resolve(
      versionSummary([manifestItem("sheet-1", 2, { name: "stale rename" })], { manifestVersion: 2 })
    );
    await polling;

    expect(api.calls).toEqual(["bootstrap:sheet-1", "versions", "sheet:sheet-1"]);
    expect(controller.snapshot()).toMatchObject({
      manifestVersion: 3,
      manifest: [{ id: "sheet-1", name: "sheet-1", version: 3 }]
    });
  });

  it("isolates a late sheet response after logout and account change", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2")];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    const pending = deferred<BoardSheetPayload>();
    api.getSheetImpl = () => pending.promise;

    const selecting = controller.selectSheet("sheet-2");
    controller.setUser(null);
    controller.setUser("user-2");
    pending.resolve(sheetPayload("sheet-2"));
    await selecting;

    expect(controller.snapshot()).toMatchObject({
      userId: "user-2",
      settings: null,
      manifestVersion: 0,
      manifest: [],
      activeSheetId: null,
      loading: false,
      error: null
    });
    expect(controller.snapshot().cache.size).toBe(0);
  });

  it("isolates a late bootstrap response from a replacement account", async () => {
    const api = new FakeBoardApi();
    const pending = deferred<BoardBootstrapPayload>();
    api.getBootstrapImpl = () => pending.promise;
    const controller = createBoardDataController(api, { userId: "user-1" });

    const bootstrapping = controller.bootstrap("sheet-1");
    controller.setUser("user-2");
    pending.resolve(bootstrapPayload());
    await bootstrapping;

    expect(controller.snapshot()).toMatchObject({ userId: "user-2", manifest: [], activeSheetId: null });
    expect(controller.snapshot().cache.size).toBe(0);
  });

  it("rejects a bootstrap for a different authenticated user without caching it", async () => {
    const api = new FakeBoardApi();
    api.getBootstrapImpl = async () => bootstrapPayload("sheet-1", [manifestItem("sheet-1")], { userId: "user-2" });
    const controller = createBoardDataController(api, { userId: "user-1" });

    await expect(controller.bootstrap("sheet-1")).rejects.toThrow(/user-2.*user-1/);

    expect(controller.snapshot()).toMatchObject({ userId: "user-1", manifest: [], loading: false });
    expect(controller.snapshot().cache.size).toBe(0);
  });

  const invalidBootstrapCases: Array<{
    label: string;
    mutate: (payload: BoardBootstrapPayload) => void;
  }> = [
    {
      label: "manifest ids are duplicated",
      mutate: (payload) => {
        payload.manifest.sheets.push({ ...payload.manifest.sheets[0]! });
      }
    },
    {
      label: "the active item is missing",
      mutate: (payload) => {
        payload.manifest.sheets = [];
      }
    },
    {
      label: "the active name differs",
      mutate: (payload) => {
        payload.activeSheet.sheet.name = "different";
      }
    },
    {
      label: "the active sort order differs",
      mutate: (payload) => {
        payload.activeSheet.sheet.sort_order += 1;
      }
    },
    {
      label: "the active default flag differs",
      mutate: (payload) => {
        payload.activeSheet.sheet.is_default = 0;
      }
    },
    {
      label: "the active content version differs",
      mutate: (payload) => {
        payload.activeSheet.sheet.content_version += 1;
      }
    }
  ];

  for (const invalidCase of invalidBootstrapCases) {
    it(`rejects an internally inconsistent bootstrap when ${invalidCase.label}`, async () => {
      const api = new FakeBoardApi();
      const payload = bootstrapPayload();
      invalidCase.mutate(payload);
      api.getBootstrapImpl = async () => payload;
      const controller = createBoardDataController(api, { userId: "user-1" });

      await expect(controller.bootstrap("sheet-1")).rejects.toThrow();

      expect(api.calls).toEqual(["bootstrap:sheet-1"]);
      expect(controller.snapshot()).toMatchObject({
        userId: "user-1",
        settings: null,
        manifestVersion: 0,
        manifest: [],
        activeSheetId: null,
        loading: false,
        error: expect.any(String)
      });
      expect(controller.snapshot().cache.size).toBe(0);
    });
  }

  it("rejects a sheet response with the wrong id without contaminating either cache key", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2"), manifestItem("sheet-3")];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    api.getSheetImpl = async () => sheetPayload("sheet-3");

    await expect(controller.selectSheet("sheet-2")).rejects.toThrow(/sheet-3.*sheet-2/);

    const state = controller.snapshot();
    expect(getBoardSheetCacheEntry(state.cache, "user-1", "sheet-2")).toBeUndefined();
    expect(getBoardSheetCacheEntry(state.cache, "user-1", "sheet-3")).toBeUndefined();
    expect(state).toMatchObject({ activeSheetId: "sheet-2", loading: false });
  });
});

describe("explicit invalidation and state ownership", () => {
  it("marks an active entry stale, exposes a scoped failure, and retries the active sheet", async () => {
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");
    let attempts = 0;
    api.getSheetImpl = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("active refresh failed");
      return sheetPayload("sheet-1");
    };

    await expect(controller.markSheetStale("sheet-1")).rejects.toThrow("active refresh failed");
    expect(controller.snapshot()).toMatchObject({ loading: false, error: "active refresh failed" });
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-1")?.stale).toBe(true);

    await controller.markSheetStale("sheet-1");
    expect(api.calls).toEqual(["bootstrap:sheet-1", "sheet:sheet-1", "sheet:sheet-1"]);
    expect(controller.snapshot()).toMatchObject({ loading: false, error: null });
  });

  it("marks only an inactive entry stale and defers refresh without disturbing active errors", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2")];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    await controller.selectSheet("sheet-2");
    await controller.selectSheet("sheet-1");
    const callCount = api.calls.length;

    await controller.markSheetStale("sheet-2");

    expect(api.calls).toHaveLength(callCount);
    expect(controller.snapshot()).toMatchObject({ activeSheetId: "sheet-1", loading: false, error: null });
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-2")?.stale).toBe(true);
  });

  it("applies mutation versions synchronously and monotonically without eager reads", async () => {
    const { api, controller } = createHarness();
    await controller.bootstrap("sheet-1");

    controller.applyMutationVersions({ manifestVersion: 0, sheets: [{ id: "sheet-1", version: 0 }] });
    expect(controller.snapshot().manifest[0]?.version).toBe(1);
    controller.applyMutationVersions({ manifestVersion: 4, sheets: [{ id: "sheet-1", version: 4 }] });

    expect(api.calls).toEqual(["bootstrap:sheet-1"]);
    expect(controller.snapshot()).toMatchObject({ manifestVersion: 4, manifest: [{ version: 4 }] });
    expect(getBoardSheetCacheEntry(controller.snapshot().cache, "user-1", "sheet-1")?.stale).toBe(true);
  });

  it("clones snapshot containers while reusing the controller-owned immutable payload", async () => {
    const api = new FakeBoardApi();
    const payload = bootstrapPayload();
    payload.activeSheet.tables.push({ id: "table-1" } as BoardSheetPayload["tables"][number]);
    api.getBootstrapImpl = async () => payload;
    const controller = createBoardDataController(api, { userId: "user-1" });
    await controller.bootstrap("sheet-1");
    payload.settings.show_display_name = 0;
    payload.manifest.sheets[0]!.name = "mutated outside";
    payload.activeSheet.tables.length = 0;

    const first = controller.snapshot();
    first.settings!.show_display_name = 0;
    first.manifest[0]!.name = "mutated snapshot";
    const firstEntry = getBoardSheetCacheEntry(first.cache, "user-1", "sheet-1")!;
    first.cache.clear();

    const second = controller.snapshot();
    const secondEntry = getBoardSheetCacheEntry(second.cache, "user-1", "sheet-1")!;
    expect(second.settings?.show_display_name).toBe(1);
    expect(second.manifest[0]?.name).toBe("sheet-1");
    expect(secondEntry.payload.tables).toHaveLength(1);
    expect(firstEntry).not.toBe(secondEntry);
    expect(firstEntry.payload).toBe(secondEntry.payload);
    expect(firstEntry.payload).not.toBe(payload.activeSheet);
  });

  it("unsubscribes cleanly and dispose makes pending completions silent no-ops", async () => {
    const api = new FakeBoardApi();
    const pending = deferred<BoardBootstrapPayload>();
    api.getBootstrapImpl = () => pending.promise;
    const controller = createBoardDataController(api, { userId: "user-1" });
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications += 1;
    });
    const bootstrapping = controller.bootstrap("sheet-1");
    expect(notifications).toBe(1);
    unsubscribe();
    controller.setUser("user-1");
    expect(notifications).toBe(1);
    const secondUnsubscribe = controller.subscribe(() => {
      notifications += 1;
    });
    controller.dispose();
    pending.resolve(bootstrapPayload());
    await bootstrapping;
    secondUnsubscribe();

    expect(notifications).toBe(1);
    expect(controller.snapshot().manifest).toEqual([]);
  });
});
