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
  cache: BoardSheetCache;
  loading: boolean;
  error: string | null;
}

export type BoardDataEffect = {
  type: "replace-url-with-sheet";
  replaceUrlWithSheetId: string;
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
        payload: cloneOwned(entry.payload),
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
  let operationGeneration = 0;
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

  const beginOperation = (changes: Partial<BoardDataState> = {}): number => {
    const operation = ++operationGeneration;
    state = { ...state, ...changes, loading: true, error: null };
    emit();
    return operation;
  };

  const finishOperation = (generation: number, operation: number, changes: Partial<BoardDataState> = {}) => {
    if (!owns(generation) || operation !== operationGeneration) return false;
    state = { ...state, ...changes, loading: false, error: null };
    emit();
    return true;
  };

  const failOperation = (
    generation: number,
    operation: number,
    error: unknown,
    fallback: string
  ) => {
    if (!owns(generation) || operation !== operationGeneration) return false;
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

    const payload = cloneOwned(incoming);
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
    if (payload.sheet.content_version < expectedVersion) {
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
      .then((payload) => {
        if (payload.sheet.id !== sheetId) {
          throw new Error(
            `Board sheet response id "${payload.sheet.id}" does not match requested sheet "${sheetId}"`
          );
        }
        return payload;
      })
      .finally(() => {
        if (sheetRequests.get(key) === request) sheetRequests.delete(key);
      });
    sheetRequests.set(key, request);
    return request;
  };

  const loadSheetForOperation = async (
    userId: string,
    sheetId: string,
    generation: number,
    operation: number
  ): Promise<void> => {
    try {
      const payload = await requestSheet(userId, sheetId);
      if (!owns(generation, userId)) return;
      const stored = storeSheetPayload(userId, sheetId, payload);
      if (operation === operationGeneration && state.activeSheetId === sheetId) {
        finishOperation(generation, operation);
      } else if (stored) {
        emit();
      }
    } catch (error) {
      if (!owns(generation, userId)) return;
      failOperation(generation, operation, error, `Unable to load board sheet "${sheetId}"`);
      throw error;
    }
  };

  const applyVersionSummary = (
    incoming: BoardVersionSummary,
    userId: string
  ): {
    activeChanged: boolean;
    effect: BoardDataEffect | undefined;
    needsActiveSheet: boolean;
  } => {
    const summary = cloneOwned(incoming);
    const priorActiveSheetId = state.activeSheetId;
    const currentById = new Map(state.manifest.map((sheet) => [sheet.id, sheet]));
    const acceptsMetadata = summary.manifestVersion >= state.manifestVersion;
    let manifest: BoardSheetManifestItem[];

    if (acceptsMetadata) {
      manifest = summary.sheets.map((sheet) => {
        const version = updateKnownSheetVersion(
          sheet.id,
          Math.max(currentById.get(sheet.id)?.version ?? 0, sheet.version)
        );
        return { ...sheet, version };
      });
    } else {
      const incomingById = new Map(summary.sheets.map((sheet) => [sheet.id, sheet]));
      manifest = state.manifest.map((sheet) => {
        const version = updateKnownSheetVersion(
          sheet.id,
          Math.max(sheet.version, incomingById.get(sheet.id)?.version ?? 0)
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
      activeWasDeleted && reconciliation.nextActiveSheetId !== null
        ? {
            type: "replace-url-with-sheet" as const,
            replaceUrlWithSheetId: reconciliation.nextActiveSheetId
          }
        : undefined;
    const activeChanged = priorActiveSheetId !== reconciliation.nextActiveSheetId;

    state = {
      ...state,
      settings: summary.settings === undefined ? state.settings : { ...summary.settings },
      manifestVersion: Math.max(state.manifestVersion, summary.manifestVersion),
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
    const operation = beginOperation();

    let request!: Promise<void>;
    request = (async () => {
      try {
        const incoming = await callApi(() => api.getBootstrap(requestedId));
        if (!owns(generation)) return;
        if (expectedUserId !== null && incoming.userId !== expectedUserId) {
          throw new Error(
            `Board bootstrap response user "${incoming.userId}" does not match authenticated user "${expectedUserId}"`
          );
        }
        if (operation !== operationGeneration) return;

        const payload = cloneOwned(incoming);
        const activeSheetId = payload.activeSheet.sheet.id;
        if (!payload.manifest.sheets.some((sheet) => sheet.id === activeSheetId)) {
          throw new Error(`Board bootstrap active sheet "${activeSheetId}" is missing from its manifest`);
        }
        knownSheetVersions = new Map(
          payload.manifest.sheets.map((sheet) => [sheet.id, sheet.version])
        );
        updateKnownSheetVersion(activeSheetId, payload.activeSheet.sheet.content_version);
        let cache = setBoardSheetCacheEntry(
          new Map(),
          payload.userId,
          payload.activeSheet,
          nowMs()
        );
        const activeManifestItem = payload.manifest.sheets.find((sheet) => sheet.id === activeSheetId);
        if (
          activeManifestItem &&
          payload.activeSheet.sheet.content_version < activeManifestItem.version
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
          manifestVersion: payload.manifest.version,
          manifest: payload.manifest.sheets,
          activeSheetId,
          cache,
          loading: false,
          error: null
        };
        emit();
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
      operationGeneration += 1;
      state = { ...state, loading: false, error: error.message };
      emit();
      return Promise.reject(error);
    }

    const entry = getBoardSheetCacheEntry(state.cache, userId, sheetId);
    if (isReusableBoardSheet(entry, manifestItem, now())) {
      operationGeneration += 1;
      state = {
        ...state,
        activeSheetId: sheetId,
        cache: evictBoardSheetLru(
          touchBoardSheetCacheEntry(state.cache, userId, sheetId, nowMs()),
          userId,
          sheetId,
          maxCacheEntries
        ),
        loading: false,
        error: null
      };
      emit();
      return Promise.resolve();
    }

    const generation = ownershipGeneration;
    const operation = beginOperation({ activeSheetId: sheetId });
    return loadSheetForOperation(userId, sheetId, generation, operation);
  };

  const revalidate = (reason: string): Promise<void> => {
    void reason;
    if (disposed || state.userId === null) return Promise.resolve();
    const userId = state.userId;
    const existing = versionRequests.get(userId);
    if (existing) return existing;
    const generation = ownershipGeneration;
    const operation = beginOperation();

    let request!: Promise<void>;
    request = (async () => {
      let summary: BoardVersionSummary;
      try {
        summary = await callApi(() => api.getVersions());
      } catch (error) {
        if (!owns(generation, userId)) return;
        failOperation(generation, operation, error, "Unable to revalidate board data");
        throw error;
      }
      if (!owns(generation, userId)) return;

      const { activeChanged, effect, needsActiveSheet } = applyVersionSummary(summary, userId);
      if (operation !== operationGeneration) {
        if (!activeChanged && !needsActiveSheet) {
          emit(effect);
          return;
        }

        const reconciliationOperation = ++operationGeneration;
        if (!needsActiveSheet || state.activeSheetId === null) {
          state = { ...state, loading: false, error: null };
          emit(effect);
          return;
        }

        const activeSheetId = state.activeSheetId;
        state = { ...state, loading: true, error: null };
        emit(effect);
        await loadSheetForOperation(
          userId,
          activeSheetId,
          generation,
          reconciliationOperation
        );
        return;
      }
      if (!needsActiveSheet || state.activeSheetId === null) {
        state = { ...state, loading: false, error: null };
        emit(effect);
        return;
      }

      const activeSheetId = state.activeSheetId;
      emit(effect);
      await loadSheetForOperation(userId, activeSheetId, generation, operation);
    })().finally(() => {
      if (versionRequests.get(userId) === request) versionRequests.delete(userId);
    });
    versionRequests.set(userId, request);
    return request;
  };

  const applyMutationVersions = (versions: BoardMutationVersions) => {
    if (disposed || state.userId === null) return;
    const userId = state.userId;
    let manifestVersion = state.manifestVersion;
    let manifest = state.manifest;
    let cache = state.cache;
    let changed = false;

    if (versions.manifestVersion !== undefined && versions.manifestVersion > manifestVersion) {
      manifestVersion = versions.manifestVersion;
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
    const operation = beginOperation({ cache });
    return loadSheetForOperation(userId, sheetId, generation, operation);
  };

  const setUser = (userId: string | null) => {
    if (disposed || state.userId === userId) return;
    ownershipGeneration += 1;
    operationGeneration += 1;
    bootstrapRequests.clear();
    sheetRequests.clear();
    versionRequests.clear();
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
      operationGeneration += 1;
      listeners.clear();
      bootstrapRequests.clear();
      sheetRequests.clear();
      versionRequests.clear();
      knownSheetVersions.clear();
    }
  };
}
