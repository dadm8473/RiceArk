import {
  evictBoardSheetLru,
  getBoardSheetCacheEntry,
  isReusableBoardSheet,
  markBoardSheetCacheEntryStale,
  reconcileBoardSheetCache,
  setBoardSheetCacheEntry,
  touchBoardSheetCacheEntry,
  type BoardSheetCache,
  type BoardSheetCacheEntry
} from "./boardSheetCache";
import type {
  BoardBootstrapPayload,
  BoardDisplaySettings,
  BoardMutationVersions,
  BoardSheetManifestItem,
  BoardSheetPayload,
  BoardVersionSummary
} from "./types";

export interface BoardDataApi {
  getBootstrap(sheetId?: string): Promise<BoardBootstrapPayload>;
  getSheet(sheetId: string): Promise<BoardSheetPayload>;
  getVersions(): Promise<BoardVersionSummary>;
}

export interface BoardDataState {
  userId: string | null;
  settings: BoardDisplaySettings | null;
  manifestVersion: number;
  manifest: BoardSheetManifestItem[];
  activeSheetId: string | null;
  /**
   * Snapshot maps and entry wrappers are caller-owned. Cached payload values are
   * controller-owned immutable snapshots and are shared by reference.
   */
  cache: BoardSheetCache;
  loading: boolean;
  error: string | null;
}

export type BoardDataEffect = {
  type: "replace-url-with-sheet";
  replaceUrlWithSheetId: string | null;
};

export type BoardDataListener = (state: BoardDataState, effect?: BoardDataEffect) => void;

export interface BoardDataControllerOptions {
  userId?: string | null | undefined;
  now?: (() => Date) | undefined;
  nowMs?: (() => number) | undefined;
  maxCacheEntries?: number | undefined;
}

export interface BoardDataController {
  bootstrap(requestedId?: string): Promise<void>;
  selectSheet(sheetId: string): Promise<void>;
  revalidate(reason: string): Promise<void>;
  applyRemoteSummary(summary: BoardVersionSummary, reason?: string): Promise<void>;
  applyMutationVersions(versions: BoardMutationVersions): void;
  markSheetStale(sheetId: string): Promise<void>;
  invalidatePeriod(sheetId: string): Promise<void>;
  setUser(userId: string | null): void;
  snapshot(): BoardDataState;
  subscribe(listener: BoardDataListener): () => void;
  dispose(): void;
}

function cloneOwned<T>(value: T): T {
  return structuredClone(value);
}

function cloneCache(cache: ReadonlyMap<string, BoardSheetCacheEntry>): BoardSheetCache {
  return new Map(
    [...cache].map(([key, entry]) => [
      key,
      {
        payload: entry.payload,
        lastAccess: entry.lastAccess,
        stale: entry.stale
      }
    ])
  );
}

function formatBoardDataError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function callApi<T>(request: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(request());
  } catch (error) {
    return Promise.reject(error);
  }
}

function validateBootstrapIdentity(payload: BoardBootstrapPayload): BoardSheetManifestItem {
  const manifestIds = new Set<string>();
  for (const sheet of payload.manifest.sheets) {
    if (manifestIds.has(sheet.id)) {
      throw new Error(`Board bootstrap manifest contains duplicate sheet id "${sheet.id}"`);
    }
    manifestIds.add(sheet.id);
  }

  const active = payload.activeSheet.sheet;
  const manifestMatches = payload.manifest.sheets.filter((sheet) => sheet.id === active.id);
  if (manifestMatches.length !== 1) {
    throw new Error(
      `Board bootstrap active sheet "${active.id}" must appear exactly once in its manifest`
    );
  }
  const manifestItem = manifestMatches[0]!;
  if (
    active.name !== manifestItem.name ||
    active.sort_order !== manifestItem.sort_order ||
    active.is_default !== manifestItem.is_default
  ) {
    throw new Error(`Board bootstrap active sheet "${active.id}" metadata does not match its manifest`);
  }
  if (active.content_version !== manifestItem.version) {
    throw new Error(`Board bootstrap active sheet "${active.id}" version does not match its manifest`);
  }
  return manifestItem;
}

function validateVersionSummaryIdentity(summary: BoardVersionSummary): void {
  const sheetIds = new Set<string>();
  for (const sheet of summary.sheets) {
    if (sheetIds.has(sheet.id)) {
      throw new Error(`Board version summary contains duplicate sheet id "${sheet.id}"`);
    }
    sheetIds.add(sheet.id);
  }
}

type BoardDataOperationKind = "bootstrap" | "sheet" | "summary";

interface BoardDataOperation {
  readonly id: number;
  readonly kind: BoardDataOperationKind;
}

export function createBoardDataController(
  api: BoardDataApi,
  options: BoardDataControllerOptions = {}
): BoardDataController {
  const now = options.now ?? (() => new Date());
  const nowMs = options.nowMs ?? (() => Date.now());
  const maxCacheEntries = options.maxCacheEntries ?? 8;
  let state: BoardDataState = {
    userId: options.userId ?? null,
    settings: null,
    manifestVersion: 0,
    manifest: [],
    activeSheetId: null,
    cache: new Map(),
    loading: false,
    error: null
  };
  let disposed = false;
  let ownershipGeneration = 0;
  let nextOperationId = 0;
  let currentOperation: BoardDataOperation | null = null;
  let knownManifestVersion = 0;
  let knownSheetVersions = new Map<string, number>();
  const listeners = new Set<BoardDataListener>();
  const bootstrapRequests = new Map<string, Promise<void>>();
  const sheetRequests = new Map<string, Promise<BoardSheetPayload>>();
  const versionRequests = new Map<string, Promise<void>>();

  const snapshot = (): BoardDataState => ({
    userId: state.userId,
    settings: state.settings === null ? null : { ...state.settings },
    manifestVersion: state.manifestVersion,
    manifest: state.manifest.map((sheet) => ({ ...sheet })),
    activeSheetId: state.activeSheetId,
    cache: cloneCache(state.cache),
    loading: state.loading,
    error: state.error
  });

  const emit = (effect?: BoardDataEffect) => {
    if (disposed) return;
    for (const listener of [...listeners]) {
      try {
        listener(snapshot(), effect === undefined ? undefined : { ...effect });
      } catch {
        // A state observer does not own controller progress or other observers.
      }
    }
  };

  const owns = (generation: number, userId?: string) =>
    !disposed &&
    generation === ownershipGeneration &&
    (userId === undefined || state.userId === userId);

  const isCurrentOperation = (operation: BoardDataOperation): boolean =>
    currentOperation?.id === operation.id;

  const beginOperation = (
    kind: BoardDataOperationKind,
    changes: Partial<BoardDataState> = {},
    effect?: BoardDataEffect
  ): BoardDataOperation => {
    const operation = { id: ++nextOperationId, kind };
    const bootstrapOwnsState =
      kind === "summary" && currentOperation?.kind === "bootstrap" && state.loading;
    if (bootstrapOwnsState) return operation;

    currentOperation = operation;
    state = { ...state, ...changes, loading: true, error: null };
    emit(effect);
    return operation;
  };

  const replaceOperation = (
    kind: BoardDataOperationKind,
    changes: Partial<BoardDataState>,
    effect?: BoardDataEffect
  ) => {
    currentOperation = { id: ++nextOperationId, kind };
    state = { ...state, ...changes };
    emit(effect);
  };

  const finishOperation = (
    generation: number,
    operation: BoardDataOperation,
    changes: Partial<BoardDataState> = {},
    effect?: BoardDataEffect
  ) => {
    if (!owns(generation) || !isCurrentOperation(operation)) return false;
    state = { ...state, ...changes, loading: false, error: null };
    emit(effect);
    return true;
  };

  const failOperation = (
    generation: number,
    operation: BoardDataOperation,
    error: unknown,
    fallback: string
  ) => {
    if (!owns(generation) || !isCurrentOperation(operation)) return false;
    state = { ...state, loading: false, error: formatBoardDataError(error, fallback) };
    emit();
    return true;
  };

  const updateKnownSheetVersion = (sheetId: string, version: number): number => {
    const nextVersion = Math.max(knownSheetVersions.get(sheetId) ?? 0, version);
    knownSheetVersions.set(sheetId, nextVersion);
    return nextVersion;
  };

  const storeSheetPayload = (userId: string, sheetId: string, incoming: BoardSheetPayload): boolean => {
    const manifestItem = state.manifest.find((sheet) => sheet.id === sheetId);
    if (state.userId !== userId || !manifestItem) return false;

    const payload = incoming;
    const existing = getBoardSheetCacheEntry(state.cache, userId, sheetId);
    if (
      existing &&
      existing.payload.sheet.content_version > payload.sheet.content_version
    ) {
      return false;
    }

    const expectedVersion = updateKnownSheetVersion(
      sheetId,
      Math.max(manifestItem.version, payload.sheet.content_version)
    );
    const manifest = state.manifest.map((sheet) =>
      sheet.id === sheetId && sheet.version < expectedVersion
        ? { ...sheet, version: expectedVersion }
        : sheet
    );
    let cache = setBoardSheetCacheEntry(state.cache, userId, payload, nowMs());
    const nextManifestItem = manifest.find((sheet) => sheet.id === sheetId);
    if (
      !isReusableBoardSheet(
        getBoardSheetCacheEntry(cache, userId, sheetId),
        nextManifestItem,
        now()
      )
    ) {
      cache = markBoardSheetCacheEntryStale(cache, userId, sheetId);
    }
    cache = evictBoardSheetLru(cache, userId, state.activeSheetId, maxCacheEntries);
    state = { ...state, manifest, cache };
    return true;
  };

  const requestSheet = (userId: string, sheetId: string): Promise<BoardSheetPayload> => {
    const key = `${userId}:${sheetId}`;
    const existing = sheetRequests.get(key);
    if (existing) return existing;

    let request!: Promise<BoardSheetPayload>;
    request = callApi(() => api.getSheet(sheetId))
      .then((incoming) => {
        if (incoming.sheet.id !== sheetId) {
          throw new Error(
            `Board sheet response id "${incoming.sheet.id}" does not match requested sheet "${sheetId}"`
          );
        }
        return cloneOwned(incoming);
      })
      .finally(() => {
        if (sheetRequests.get(key) === request) sheetRequests.delete(key);
      });
    sheetRequests.set(key, request);
    return request;
  };

  const isStoredSheetReusable = (userId: string, sheetId: string): boolean =>
    isReusableBoardSheet(
      getBoardSheetCacheEntry(state.cache, userId, sheetId),
      state.manifest.find((sheet) => sheet.id === sheetId),
      now()
    );

  const loadSheetForOperation = async (
    userId: string,
    sheetId: string,
    generation: number,
    operation: BoardDataOperation
  ): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const payload = await requestSheet(userId, sheetId);
      if (!owns(generation, userId)) return;
      const stored = storeSheetPayload(userId, sheetId, payload);
      const ownsActiveLoad = isCurrentOperation(operation) && state.activeSheetId === sheetId;
      if (!ownsActiveLoad) {
        if (stored) emit();
        return;
      }

      if (isStoredSheetReusable(userId, sheetId)) {
        finishOperation(generation, operation);
        return;
      }

      if (attempt === 0) continue;
      state = {
        ...state,
        cache: markBoardSheetCacheEntryStale(state.cache, userId, sheetId)
      };
      throw new Error(`Board sheet "${sheetId}" remained stale after refresh`);
    }
  };

  const applySummaryVersionBounds = (
    summary: BoardVersionSummary,
    userId: string
  ): boolean => {
    knownManifestVersion = Math.max(knownManifestVersion, summary.manifestVersion);
    for (const sheet of summary.sheets) updateKnownSheetVersion(sheet.id, sheet.version);

    let changed = state.manifestVersion < knownManifestVersion;
    const manifest = state.manifest.map((sheet) => {
      const version = Math.max(sheet.version, knownSheetVersions.get(sheet.id) ?? 0);
      if (version === sheet.version) return sheet;
      changed = true;
      return { ...sheet, version };
    });
    let cache = state.cache;
    for (const sheet of manifest) {
      const entry = getBoardSheetCacheEntry(cache, userId, sheet.id);
      if (entry && entry.payload.sheet.content_version < sheet.version && !entry.stale) {
        cache = markBoardSheetCacheEntryStale(cache, userId, sheet.id);
        changed = true;
      }
    }
    if (!changed) return false;
    state = { ...state, manifestVersion: knownManifestVersion, manifest, cache };
    return true;
  };

  const applyVersionSummary = (
    summary: BoardVersionSummary,
    userId: string,
    allowSettings: boolean
  ): {
    activeChanged: boolean;
    effect: BoardDataEffect | undefined;
    needsActiveSheet: boolean;
  } => {
    const priorActiveSheetId = state.activeSheetId;
    const currentById = new Map(state.manifest.map((sheet) => [sheet.id, sheet]));
    const acceptsMetadata = summary.manifestVersion >= state.manifestVersion;
    knownManifestVersion = Math.max(knownManifestVersion, summary.manifestVersion);
    for (const sheet of summary.sheets) updateKnownSheetVersion(sheet.id, sheet.version);
    let manifest: BoardSheetManifestItem[];

    if (acceptsMetadata) {
      manifest = summary.sheets.map((sheet) => {
        const version = updateKnownSheetVersion(
          sheet.id,
          Math.max(
            currentById.get(sheet.id)?.version ?? 0,
            knownSheetVersions.get(sheet.id) ?? 0
          )
        );
        return { ...sheet, version };
      });
    } else {
      const incomingById = new Map(summary.sheets.map((sheet) => [sheet.id, sheet]));
      manifest = state.manifest.map((sheet) => {
        const version = updateKnownSheetVersion(
          sheet.id,
          Math.max(
            sheet.version,
            incomingById.get(sheet.id)?.version ?? 0,
            knownSheetVersions.get(sheet.id) ?? 0
          )
        );
        return version === sheet.version ? sheet : { ...sheet, version };
      });
    }

    const reconciliation = reconcileBoardSheetCache(
      state.cache,
      userId,
      manifest,
      priorActiveSheetId
    );
    const activeWasDeleted =
      priorActiveSheetId !== null && !manifest.some((sheet) => sheet.id === priorActiveSheetId);
    const effect =
      activeWasDeleted
        ? {
            type: "replace-url-with-sheet" as const,
            replaceUrlWithSheetId: reconciliation.nextActiveSheetId
          }
        : undefined;
    const activeChanged = priorActiveSheetId !== reconciliation.nextActiveSheetId;

    state = {
      ...state,
      settings:
        allowSettings && acceptsMetadata && summary.settings !== undefined
          ? { ...summary.settings }
          : state.settings,
      manifestVersion: Math.max(state.manifestVersion, knownManifestVersion),
      manifest,
      activeSheetId: reconciliation.nextActiveSheetId,
      cache: reconciliation.cache
    };

    if (state.activeSheetId === null) return { activeChanged, effect, needsActiveSheet: false };
    const entry = getBoardSheetCacheEntry(state.cache, userId, state.activeSheetId);
    const item = state.manifest.find((sheet) => sheet.id === state.activeSheetId);
    if (!isReusableBoardSheet(entry, item, now())) {
      return { activeChanged, effect, needsActiveSheet: true };
    }
    state = {
      ...state,
      cache: evictBoardSheetLru(
        touchBoardSheetCacheEntry(state.cache, userId, state.activeSheetId, nowMs()),
        userId,
        state.activeSheetId,
        maxCacheEntries
      )
    };
    return { activeChanged, effect, needsActiveSheet: false };
  };

  const bootstrap = (requestedId?: string): Promise<void> => {
    if (disposed) return Promise.resolve();
    const expectedUserId = state.userId;
    const generation = ownershipGeneration;
    const key = `${expectedUserId ?? ""}\u0000${requestedId ?? ""}`;
    const existing = bootstrapRequests.get(key);
    if (existing) return existing;
    const operation = beginOperation("bootstrap");

    let request!: Promise<void>;
    request = (async () => {
      try {
        const incoming = await callApi(() => api.getBootstrap(requestedId));
        if (!owns(generation) || !isCurrentOperation(operation)) return;
        const payload = cloneOwned(incoming);
        if (expectedUserId !== null && payload.userId !== expectedUserId) {
          throw new Error(
            `Board bootstrap response user "${payload.userId}" does not match authenticated user "${expectedUserId}"`
          );
        }
        validateBootstrapIdentity(payload);
        const activeSheetId = payload.activeSheet.sheet.id;
        const currentById = new Map(state.manifest.map((sheet) => [sheet.id, sheet]));
        knownManifestVersion = Math.max(
          knownManifestVersion,
          state.manifestVersion,
          payload.manifest.version
        );
        const manifest = payload.manifest.sheets.map((sheet) => ({
          ...sheet,
          version: updateKnownSheetVersion(
            sheet.id,
            Math.max(sheet.version, currentById.get(sheet.id)?.version ?? 0)
          )
        }));
        const activeManifestItem = manifest.find((sheet) => sheet.id === activeSheetId)!;
        updateKnownSheetVersion(activeSheetId, activeManifestItem.version);
        let cache = setBoardSheetCacheEntry(
          new Map(),
          payload.userId,
          payload.activeSheet,
          nowMs()
        );
        if (
          !isReusableBoardSheet(
            getBoardSheetCacheEntry(cache, payload.userId, activeSheetId),
            activeManifestItem,
            now()
          )
        ) {
          cache = markBoardSheetCacheEntryStale(cache, payload.userId, activeSheetId);
        }
        cache = evictBoardSheetLru(
          cache,
          payload.userId,
          activeSheetId,
          maxCacheEntries
        );
        state = {
          userId: payload.userId,
          settings: payload.settings,
          manifestVersion: knownManifestVersion,
          manifest,
          activeSheetId,
          cache,
          loading: true,
          error: null
        };
        if (isStoredSheetReusable(payload.userId, activeSheetId)) {
          finishOperation(generation, operation);
          return;
        }

        emit();
        await loadSheetForOperation(payload.userId, activeSheetId, generation, operation);
      } catch (error) {
        if (!owns(generation)) return;
        failOperation(generation, operation, error, "Unable to load board data");
        throw error;
      }
    })().finally(() => {
      if (bootstrapRequests.get(key) === request) bootstrapRequests.delete(key);
    });
    bootstrapRequests.set(key, request);
    return request;
  };

  const selectSheet = (sheetId: string): Promise<void> => {
    if (disposed || state.userId === null) return Promise.resolve();
    const userId = state.userId;
    const manifestItem = state.manifest.find((sheet) => sheet.id === sheetId);
    if (!manifestItem) {
      const error = new Error(`Board sheet "${sheetId}" is not present in the manifest`);
      replaceOperation("sheet", { loading: false, error: error.message });
      return Promise.reject(error);
    }

    const entry = getBoardSheetCacheEntry(state.cache, userId, sheetId);
    if (isReusableBoardSheet(entry, manifestItem, now())) {
      replaceOperation("sheet", {
        activeSheetId: sheetId,
        cache: evictBoardSheetLru(
          touchBoardSheetCacheEntry(state.cache, userId, sheetId, nowMs()),
          userId,
          sheetId,
          maxCacheEntries
        ),
        loading: false,
        error: null
      });
      return Promise.resolve();
    }

    const generation = ownershipGeneration;
    const operation = beginOperation("sheet", { activeSheetId: sheetId });
    return loadSheetForOperation(userId, sheetId, generation, operation).catch((error) => {
      if (!owns(generation, userId)) return;
      failOperation(generation, operation, error, `Unable to load board sheet "${sheetId}"`);
      throw error;
    });
  };

  const ownVersionSummary = (incoming: BoardVersionSummary): BoardVersionSummary => {
    const summary = cloneOwned(incoming);
    validateVersionSummaryIdentity(summary);
    return summary;
  };

  const applyOwnedVersionSummary = async (
    summary: BoardVersionSummary,
    userId: string,
    generation: number,
    operation: BoardDataOperation,
    failureMessage: string
  ): Promise<void> => {
    if (!owns(generation, userId)) return;
    if (currentOperation?.kind === "bootstrap" && !isCurrentOperation(operation)) {
      const bootstrapWasLoading = state.loading;
      if (applySummaryVersionBounds(summary, userId)) emit();
      if (
        bootstrapWasLoading ||
        state.error !== null ||
        state.activeSheetId === null ||
        isStoredSheetReusable(userId, state.activeSheetId)
      ) {
        return;
      }

      const activeSheetId = state.activeSheetId;
      const refreshOperation = beginOperation("summary");
      try {
        await loadSheetForOperation(userId, activeSheetId, generation, refreshOperation);
      } catch (error) {
        if (!owns(generation, userId)) return;
        failOperation(generation, refreshOperation, error, failureMessage);
        throw error;
      }
      return;
    }

    let refreshOperation = operation;
    try {
      const operationWasCurrent = isCurrentOperation(operation);
      const { effect, needsActiveSheet } = applyVersionSummary(
        summary,
        userId,
        operationWasCurrent
      );
      if (!owns(generation, userId)) return;

      if (!needsActiveSheet || state.activeSheetId === null) {
        if (isCurrentOperation(operation)) {
          finishOperation(generation, operation, {}, effect);
        } else {
          emit(effect);
        }
        return;
      }

      const activeSheetId = state.activeSheetId;
      if (!isCurrentOperation(operation)) {
        if (state.loading && currentOperation !== null) {
          refreshOperation = currentOperation;
          emit(effect);
        } else {
          refreshOperation = beginOperation("summary", {}, effect);
        }
      } else {
        emit(effect);
      }
      await loadSheetForOperation(userId, activeSheetId, generation, refreshOperation);
    } catch (error) {
      if (!owns(generation, userId)) return;
      failOperation(generation, refreshOperation, error, failureMessage);
      throw error;
    }
  };

  const revalidate = (reason: string): Promise<void> => {
    void reason;
    if (disposed || state.userId === null) return Promise.resolve();
    const userId = state.userId;
    const existing = versionRequests.get(userId);
    if (existing) return existing;
    const generation = ownershipGeneration;
    const operation = beginOperation("summary");

    let request!: Promise<void>;
    request = (async () => {
      let summary: BoardVersionSummary;
      try {
        const incoming = await callApi(() => api.getVersions());
        if (!owns(generation, userId)) return;
        summary = ownVersionSummary(incoming);
      } catch (error) {
        if (!owns(generation, userId)) return;
        failOperation(generation, operation, error, "Unable to revalidate board data");
        throw error;
      }
      await applyOwnedVersionSummary(
        summary,
        userId,
        generation,
        operation,
        "Unable to revalidate board data"
      );
    })().finally(() => {
      if (versionRequests.get(userId) === request) versionRequests.delete(userId);
    });
    versionRequests.set(userId, request);
    return request;
  };

  const applyRemoteSummary = (
    incoming: BoardVersionSummary,
    reason = "remote"
  ): Promise<void> => {
    void reason;
    if (disposed || state.userId === null) return Promise.resolve();
    const userId = state.userId;
    const generation = ownershipGeneration;
    const operation = beginOperation("summary");
    let summary: BoardVersionSummary;
    try {
      summary = ownVersionSummary(incoming);
    } catch (error) {
      failOperation(generation, operation, error, "Unable to apply remote board data");
      return Promise.reject(error);
    }
    return applyOwnedVersionSummary(
      summary,
      userId,
      generation,
      operation,
      "Unable to apply remote board data"
    );
  };

  const applyMutationVersions = (versions: BoardMutationVersions) => {
    if (disposed || state.userId === null) return;
    const userId = state.userId;
    let manifestVersion = state.manifestVersion;
    let manifest = state.manifest;
    let cache = state.cache;
    let changed = false;

    if (versions.manifestVersion !== undefined) {
      knownManifestVersion = Math.max(knownManifestVersion, versions.manifestVersion);
    }
    if (knownManifestVersion > manifestVersion) {
      manifestVersion = knownManifestVersion;
      changed = true;
    }

    for (const incoming of versions.sheets) {
      const currentManifestVersion = manifest.find((sheet) => sheet.id === incoming.id)?.version ?? 0;
      const version = updateKnownSheetVersion(
        incoming.id,
        Math.max(currentManifestVersion, incoming.version)
      );
      if (version > currentManifestVersion) {
        manifest = manifest.map((sheet) =>
          sheet.id === incoming.id ? { ...sheet, version } : sheet
        );
        if (manifest.some((sheet) => sheet.id === incoming.id)) changed = true;
      }
      const entry = getBoardSheetCacheEntry(cache, userId, incoming.id);
      if (entry && entry.payload.sheet.content_version < version && !entry.stale) {
        cache = markBoardSheetCacheEntryStale(cache, userId, incoming.id);
        changed = true;
      }
    }

    if (!changed) return;
    state = { ...state, manifestVersion, manifest, cache };
    emit();
  };

  const invalidateSheet = (sheetId: string): Promise<void> => {
    if (disposed || state.userId === null) return Promise.resolve();
    const userId = state.userId;
    const entry = getBoardSheetCacheEntry(state.cache, userId, sheetId);
    const cache = markBoardSheetCacheEntryStale(state.cache, userId, sheetId);
    if (state.activeSheetId !== sheetId) {
      if (entry && !entry.stale) {
        state = { ...state, cache };
        emit();
      }
      return Promise.resolve();
    }

    const generation = ownershipGeneration;
    const operation = beginOperation("sheet", { cache });
    return loadSheetForOperation(userId, sheetId, generation, operation).catch((error) => {
      if (!owns(generation, userId)) return;
      failOperation(generation, operation, error, `Unable to load board sheet "${sheetId}"`);
      throw error;
    });
  };

  const setUser = (userId: string | null) => {
    if (disposed || state.userId === userId) return;
    ownershipGeneration += 1;
    currentOperation = null;
    bootstrapRequests.clear();
    sheetRequests.clear();
    versionRequests.clear();
    knownManifestVersion = 0;
    knownSheetVersions.clear();
    state = {
      userId,
      settings: null,
      manifestVersion: 0,
      manifest: [],
      activeSheetId: null,
      cache: new Map(),
      loading: false,
      error: null
    };
    emit();
  };

  return {
    bootstrap,
    selectSheet,
    revalidate,
    applyRemoteSummary,
    applyMutationVersions,
    markSheetStale: invalidateSheet,
    invalidatePeriod: invalidateSheet,
    setUser,
    snapshot,
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ownershipGeneration += 1;
      currentOperation = null;
      listeners.clear();
      bootstrapRequests.clear();
      sheetRequests.clear();
      versionRequests.clear();
      knownManifestVersion = 0;
      knownSheetVersions.clear();
    }
  };
}
