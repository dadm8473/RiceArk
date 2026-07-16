import { describe, expect, it } from "vitest";
import {
  createBoardDataController,
  type BoardDataApi,
  type BoardDataEffect
} from "./boardDataController";
import { buildLocalBoardPeriodFingerprint, getBoardSheetCacheEntry } from "./boardSheetCache";
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

  it("falls back to an uncached first sheet and loads only that fallback", async () => {
    const manifest = [manifestItem("sheet-1"), manifestItem("sheet-2", 1, { is_default: 0 })];
    const { api, controller } = createHarness({ manifest });
    await controller.bootstrap("sheet-1");
    const effects: BoardDataEffect[] = [];
    controller.subscribe((_state, effect) => {
      if (effect) effects.push(effect);
    });
    api.getVersionsImpl = async () =>
      versionSummary([manifestItem("sheet-2", 1, { is_default: 1 })], { manifestVersion: 2 });

    await controller.revalidate("poll");

    expect(api.calls).toEqual(["bootstrap:sheet-1", "versions", "sheet:sheet-2"]);
    expect(controller.snapshot().activeSheetId).toBe("sheet-2");
    expect(effects).toEqual([
      { type: "replace-url-with-sheet", replaceUrlWithSheetId: "sheet-2" }
    ]);
  });

  it("sets the active sheet to null for an empty manifest without requesting a sheet", async () => {
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
    expect(effects).toEqual([]);
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

  it("returns independently cloned snapshots and owns inbound API payloads", async () => {
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
    firstEntry.payload.tables.length = 0;
    first.cache.clear();

    const second = controller.snapshot();
    expect(second.settings?.show_display_name).toBe(1);
    expect(second.manifest[0]?.name).toBe("sheet-1");
    expect(getBoardSheetCacheEntry(second.cache, "user-1", "sheet-1")?.payload.tables).toHaveLength(1);
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
