import { getPeriodKey, type ResetRule } from "@riceark/core";
import type {
  BoardDisplaySettings,
  BoardPayload,
  BoardSheetManifestItem,
  BoardSheetPayload
} from "./types";

export interface BoardPeriodFingerprintSource {
  axisItems: Array<{ kind: string; task_reset_rule_json?: string | null | undefined }>;
}

export interface BoardSheetCacheEntry {
  readonly payload: BoardSheetPayload;
  readonly lastAccess: number;
  readonly stale: boolean;
}

export type BoardSheetCache = Map<string, BoardSheetCacheEntry>;

export interface BoardSheetCacheReconciliation {
  cache: BoardSheetCache;
  nextActiveSheetId: string | null;
}

export function getBoardSheetCacheKey(userId: string, sheetId: string): string {
  return `${userId}:${sheetId}`;
}

export function getBoardSheetCacheEntry(
  cache: ReadonlyMap<string, BoardSheetCacheEntry>,
  userId: string,
  sheetId: string
): BoardSheetCacheEntry | undefined {
  return cache.get(getBoardSheetCacheKey(userId, sheetId));
}

export function setBoardSheetCacheEntry(
  cache: ReadonlyMap<string, BoardSheetCacheEntry>,
  userId: string,
  payload: BoardSheetPayload,
  lastAccess: number
): BoardSheetCache {
  const next = new Map(cache);
  next.set(getBoardSheetCacheKey(userId, payload.sheet.id), { payload, lastAccess, stale: false });
  return next;
}

export function touchBoardSheetCacheEntry(
  cache: ReadonlyMap<string, BoardSheetCacheEntry>,
  userId: string,
  sheetId: string,
  lastAccess: number
): BoardSheetCache {
  const next = new Map(cache);
  const key = getBoardSheetCacheKey(userId, sheetId);
  const entry = cache.get(key);
  if (entry) next.set(key, { ...entry, lastAccess });
  return next;
}

export function markBoardSheetCacheEntryStale(
  cache: ReadonlyMap<string, BoardSheetCacheEntry>,
  userId: string,
  sheetId: string
): BoardSheetCache {
  const next = new Map(cache);
  const key = getBoardSheetCacheKey(userId, sheetId);
  const entry = cache.get(key);
  if (entry) next.set(key, { ...entry, stale: true });
  return next;
}

export function removeBoardSheetCacheEntry(
  cache: ReadonlyMap<string, BoardSheetCacheEntry>,
  userId: string,
  sheetId: string
): BoardSheetCache {
  const next = new Map(cache);
  next.delete(getBoardSheetCacheKey(userId, sheetId));
  return next;
}

export function buildLocalBoardPeriodFingerprint(
  board: BoardPeriodFingerprintSource | null | undefined,
  now = new Date()
): string {
  if (!board) return "";
  const periodKeys = new Set<string>();
  for (const item of board.axisItems) {
    if (item.kind !== "task" || !item.task_reset_rule_json) continue;
    try {
      periodKeys.add(getPeriodKey(JSON.parse(item.task_reset_rule_json) as ResetRule, now));
    } catch {
      // Invalid legacy reset rules do not invalidate otherwise usable cached data.
    }
  }
  return [...periodKeys].sort().join("|");
}

export function isReusableBoardSheet(
  entry: BoardSheetCacheEntry | undefined,
  manifestItem: BoardSheetManifestItem | undefined,
  now: Date
): boolean {
  return Boolean(
    entry &&
      manifestItem &&
      !entry.stale &&
      entry.payload.sheet.id === manifestItem.id &&
      entry.payload.sheet.content_version === manifestItem.version &&
      entry.payload.periodFingerprint === buildLocalBoardPeriodFingerprint(entry.payload, now)
  );
}

function isEntryForUser(key: string, entry: BoardSheetCacheEntry, userId: string): boolean {
  return key === getBoardSheetCacheKey(userId, entry.payload.sheet.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortManifest(manifest: BoardSheetManifestItem[]): BoardSheetManifestItem[] {
  return [...manifest].sort(
    (left, right) =>
      left.sort_order - right.sort_order || compareStrings(left.name, right.name) || compareStrings(left.id, right.id)
  );
}

export function reconcileBoardSheetCache(
  cache: ReadonlyMap<string, BoardSheetCacheEntry>,
  userId: string,
  manifest: BoardSheetManifestItem[],
  activeSheetId: string | null
): BoardSheetCacheReconciliation {
  const next = new Map(cache);
  const manifestById = new Map(manifest.map((item) => [item.id, item]));

  for (const [key, entry] of cache) {
    if (!isEntryForUser(key, entry, userId)) continue;
    const remote = manifestById.get(entry.payload.sheet.id);
    if (!remote) {
      next.delete(key);
    } else if (entry.payload.sheet.content_version !== remote.version) {
      next.set(key, { ...entry, stale: true });
    }
  }

  const sortedManifest = sortManifest(manifest);
  const nextActiveSheetId =
    (activeSheetId !== null && manifestById.has(activeSheetId) ? activeSheetId : undefined) ??
    sortedManifest.find((sheet) => sheet.is_default === 1)?.id ??
    sortedManifest[0]?.id ??
    null;

  return { cache: next, nextActiveSheetId };
}

export function evictBoardSheetLru(
  cache: ReadonlyMap<string, BoardSheetCacheEntry>,
  userId: string,
  activeSheetId: string | null,
  maxEntries = 8
): BoardSheetCache {
  const next = new Map(cache);
  const userEntries = [...cache].filter(([key, entry]) => isEntryForUser(key, entry, userId));
  const activeKey = activeSheetId === null ? null : getBoardSheetCacheKey(userId, activeSheetId);
  const protectsActive = activeKey !== null && userEntries.some(([key]) => key === activeKey);
  const requestedLimit = Number.isFinite(maxEntries) ? Math.max(0, Math.floor(maxEntries)) : 8;
  const retainedLimit = Math.max(requestedLimit, protectsActive ? 1 : 0);
  let retainedCount = userEntries.length;

  const evictionCandidates = userEntries
    .filter(([key]) => key !== activeKey)
    .sort(
      ([leftKey, leftEntry], [rightKey, rightEntry]) =>
        leftEntry.lastAccess - rightEntry.lastAccess || compareStrings(leftKey, rightKey)
    );

  for (const [key] of evictionCandidates) {
    if (retainedCount <= retainedLimit) break;
    next.delete(key);
    retainedCount -= 1;
  }

  return next;
}

export function composeActiveBoardView(
  userId: string,
  settings: BoardDisplaySettings,
  manifest: BoardSheetManifestItem[],
  payload: BoardSheetPayload
): BoardPayload {
  return {
    userId,
    settings,
    sheets: manifest,
    tables: payload.tables,
    notes: payload.notes,
    axisItems: payload.axisItems,
    cellStates: payload.cellStates,
    completions: payload.completions
  };
}
