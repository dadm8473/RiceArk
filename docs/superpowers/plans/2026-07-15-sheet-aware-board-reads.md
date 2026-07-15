# Sheet-Aware Board Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load and revalidate only the active owner sheet while keeping opened sheets instantly reusable in user-scoped memory and preserving URL back/forward behavior.

**Architecture:** A new bootstrap response contains a small manifest, the requested/default sheet payload, settings, and its initial version snapshot. A testable board controller owns an eight-entry LRU, version reconciliation, and request decisions; `useBoard` supplies browser lifecycle and leader-election wiring around that controller.

**Tech Stack:** Hono, D1, React 19, TypeScript, Vitest, Cloudflare Wrangler.

**Prerequisite:** Complete `2026-07-15-performance-foundation-observability.md` and `2026-07-15-reliable-set-based-writes.md` first.

---

### Task 1: Define Sheet-Aware Server Contracts

**Files:**
- Create: `apps/api/src/db/boardReads.ts`
- Create: `apps/api/src/db/boardReads.test.ts`
- Modify: `apps/api/src/db/board.ts`

- [ ] **Step 1: Write failing contract tests**

Test that a manifest item carries navigation metadata plus content version, a sheet payload cannot contain another sheet's table/note/axis/cell/completion, and a bootstrap includes the same version snapshot used for cache validation.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/api/src/db/boardReads.test.ts`

Expected: FAIL because `boardReads.ts` does not exist.

- [ ] **Step 3: Add exact public types**

```ts
export interface BoardSheetManifestItem {
  id: string;
  name: string;
  sort_order: number;
  is_default: number;
  version: number;
}

export interface BoardSheetManifest {
  version: number;
  sheets: BoardSheetManifestItem[];
}

export interface BoardSheetPayloadItem {
  id: string;
  name: string;
  sort_order: number;
  is_default: number;
  content_version: number;
}

export interface BoardSheetPayload {
  sheet: BoardSheetPayloadItem;
  tables: unknown[];
  notes: unknown[];
  axisItems: unknown[];
  cellStates: unknown[];
  completions: unknown[];
  periodFingerprint: string;
}

export interface BoardBootstrapPayload {
  userId: string;
  settings: unknown;
  manifest: BoardSheetManifest;
  activeSheet: BoardSheetPayload;
}

export interface BoardVersionSummary {
  manifestVersion: number;
  sheets: BoardSheetManifestItem[];
  periodFingerprint: "";
}
```

Move only new read-path code into `boardReads.ts`; keep the legacy `BoardPayload` and `loadBoard()` export in `board.ts` during compatibility rollout.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm test apps/api/src/db/boardReads.test.ts && pnpm --filter @riceark/api check`

```bash
git add apps/api/src/db/boardReads.ts apps/api/src/db/boardReads.test.ts apps/api/src/db/board.ts
git commit -m "Define sheet-aware board read contracts"
```

### Task 2: Load A Manifest And One Owned Sheet Within Query Budgets

**Files:**
- Modify: `apps/api/src/db/boardReads.ts`
- Modify: `apps/api/src/db/boardReads.test.ts`

- [ ] **Step 1: Add failing ownership, fallback, and query-budget tests**

Cover requested owned sheet, foreign/missing requested sheet fallback to default then first sorted, no sheet initialization fallback, period fingerprint, expired reserved marks, and explicit-column SQL. Count D1 statements and require at most nine read-path statements excluding session/auth for an established board, so the route stays at or below 10 including `requireUser`; require at most 30 statements for first-ever default-board initialization.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/api/src/db/boardReads.test.ts`

Expected: FAIL because only the legacy full-board loader exists.

- [ ] **Step 3: Implement the one-query manifest**

Use one CTE statement so manifest version and sheet navigation rows arrive together:

```sql
WITH manifest AS (
  SELECT COALESCE(
    (SELECT version FROM board_manifest_versions WHERE user_id = ?1),
    0
  ) AS manifest_version
)
SELECT
  manifest.manifest_version,
  sheets.id,
  sheets.name,
  sheets.sort_order,
  sheets.is_default,
  sheets.content_version AS version
FROM manifest
LEFT JOIN sheets ON sheets.user_id = ?1
ORDER BY sheets.sort_order, sheets.name
```

Map the sentinel row with `id === null` to an empty `sheets` array.

- [ ] **Step 4: Implement `loadBoardSheet` with sheet-scoped predicates**

Query the selected sheet first, then tables, notes, joined axis items, and cell states concurrently. Every content query filters through the owned `sheetId`; do not rely on client ids alone. After axis rows are known, derive sorted unique current period keys and issue one completion query only when keys exist. Settings belong only to bootstrap and are loaded once by `loadBoardDisplaySettings`.

All selects list the columns currently consumed by `apps/web/src/features/board/types.ts`; no new `SELECT *` is allowed.

- [ ] **Step 5: Implement bootstrap fallback without `hasAnyBoardTable`**

```ts
export async function loadBoardBootstrap(env: Env, userId: string, requestedSheetId?: string): Promise<BoardBootstrapPayload> {
  let manifest = await loadBoardManifest(env, userId);
  if (manifest.sheets.length === 0) {
    await ensureDefaultBoard(env, userId);
    manifest = await loadBoardManifest(env, userId);
  }
  const selected = selectOwnedSheet(manifest.sheets, requestedSheetId);
  if (!selected) throw new Error("Default board initialization produced no sheet");
  const [activeSheet, settings] = await Promise.all([
    loadBoardSheet(env, userId, selected.id),
    loadBoardDisplaySettings(env, userId)
  ]);
  return { userId, settings, manifest, activeSheet };
}
```

Remove the unconditional `hasAnyBoardTable()` call from this path. The legacy loader may retain its behavior until its endpoint is retired.

- [ ] **Step 6: Collapse version summary into one statement**

Reuse the manifest CTE and map it to `{ manifestVersion, sheets, periodFingerprint: "" }`. Test one D1 statement regardless of sheet count.

- [ ] **Step 7: Run tests and commit**

Run: `pnpm test apps/api/src/db/boardReads.test.ts apps/api/src/db/board.test.ts`

```bash
git add apps/api/src/db/boardReads.ts apps/api/src/db/boardReads.test.ts apps/api/src/db/board.ts
git commit -m "Load only the active board sheet"
```

### Task 3: Expose Bootstrap And Single-Sheet Routes Compatibly

**Files:**
- Modify: `apps/api/src/routes/board.ts`
- Modify: `apps/api/src/routes/board.test.ts`
- Modify: `apps/api/src/index.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover `GET /api/board/bootstrap?sheetId=...`, `GET /api/board/sheets/:id`, invalid query/id validation, foreign sheet 404, fallback behavior, legacy `GET /api/board`, exact private headers, and no immediate version request requirement in the bootstrap body.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/api/src/routes/board.test.ts apps/api/src/index.test.ts`

Expected: FAIL with route not found.

- [ ] **Step 3: Add route schemas and handlers**

```ts
const boardBootstrapQuerySchema = z.object({
  sheetId: resourceIdSchema.optional()
}).strict();

boardRoutes.get("/board/bootstrap", zValidator("query", boardBootstrapQuerySchema), async (c) => {
  const user = await requireUser(c);
  const payload = await loadBoardBootstrap(c.env, user.id, c.req.valid("query").sheetId);
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie");
  return c.json(payload);
});
```

The sheet route uses `loadBoardSheet`; return the existing `board_sheet_not_found` 404 code when ownership fails. Add the same headers to owner board/version routes. Keep `GET /api/board` and all legacy response fields unchanged.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm test apps/api/src/routes/board.test.ts apps/api/src/index.test.ts`

```bash
git add apps/api/src/routes/board.ts apps/api/src/routes/board.test.ts apps/api/src/index.test.ts
git commit -m "Expose board bootstrap and sheet routes"
```

### Task 4: Build A Pure User-Scoped Sheet Cache

**Files:**
- Modify: `apps/web/src/features/board/types.ts`
- Create: `apps/web/src/features/board/boardSheetCache.ts`
- Create: `apps/web/src/features/board/boardSheetCache.test.ts`

- [ ] **Step 1: Write failing cache tests**

Cover version-valid reuse, period mismatch invalidation, user isolation, active-entry protection, eight-entry LRU eviction, remote inactive invalidation, deleted active fallback, and pending overlays being stored outside payload entries.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/web/src/features/board/boardSheetCache.test.ts`

Expected: FAIL because the cache module does not exist.

- [ ] **Step 3: Add client contracts matching the server**

```ts
export interface BoardSheetManifestItem extends BoardSheet {
  version: number;
}

export interface BoardSheetPayload {
  sheet: BoardSheet & { content_version: number };
  tables: BoardTable[];
  notes: BoardNote[];
  axisItems: BoardAxisItem[];
  cellStates: BoardCellState[];
  completions: BoardCellCompletion[];
  periodFingerprint: string;
}

export interface BoardBootstrapPayload {
  userId: string;
  settings: BoardDisplaySettings;
  manifest: { version: number; sheets: BoardSheetManifestItem[] };
  activeSheet: BoardSheetPayload;
}
```

- [ ] **Step 4: Implement bounded LRU operations**

Use immutable helpers over `Map<string, BoardSheetCacheEntry>`:

```ts
export interface BoardSheetCacheEntry {
  payload: BoardSheetPayload;
  lastAccess: number;
  stale: boolean;
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
    entry.payload.sheet.content_version === manifestItem.version &&
    entry.payload.periodFingerprint === buildLocalBoardPeriodFingerprint(entry.payload, now)
  );
}
```

The cache key is `${userId}:${sheetId}`. `evictBoardSheetLru` retains the active key and keeps at most eight entries for the current user.

- [ ] **Step 5: Add the legacy view adapter**

To avoid rewriting the 5,000-line board renderer in the same commit, export a pure adapter:

```ts
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
```

- [ ] **Step 6: Run tests and commit**

Run: `pnpm test apps/web/src/features/board/boardSheetCache.test.ts && pnpm --filter @riceark/web check`

```bash
git add apps/web/src/features/board/types.ts apps/web/src/features/board/boardSheetCache.ts apps/web/src/features/board/boardSheetCache.test.ts
git commit -m "Add bounded board sheet memory cache"
```

### Task 5: Implement A Testable Board Data Controller

**Files:**
- Create: `apps/web/src/features/board/boardDataController.ts`
- Create: `apps/web/src/features/board/boardDataController.test.ts`

- [ ] **Step 1: Write failing flow-budget tests**

Inject fake `getBootstrap`, `getSheet`, and `getVersions` functions and prove:

```ts
expect(apiCalls).toEqual(["bootstrap:sheet-1"]);                    // authenticated initial load
expect(apiCalls).toEqual(["bootstrap:sheet-1", "sheet:sheet-2"]); // first visit
expect(apiCalls).toHaveLength(2);                                  // unchanged return to sheet-1
expect(apiCalls.at(-1)).toBe("versions");                           // no-change poll
```

Also cover active remote change -> one active sheet fetch, inactive remote change -> stale only, manifest rename/order/default update without a second request, active deletion fallback, reset fingerprint invalidation, and identity clearing.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/web/src/features/board/boardDataController.test.ts`

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement controller state and API boundary**

```ts
export interface BoardDataApi {
  getBootstrap: (sheetId?: string) => Promise<BoardBootstrapPayload>;
  getSheet: (sheetId: string) => Promise<BoardSheetPayload>;
  getVersions: () => Promise<BoardVersionSummary>;
}

export interface BoardDataState {
  userId: string | null;
  settings: BoardDisplaySettings | null;
  manifestVersion: number;
  manifest: BoardSheetManifestItem[];
  activeSheetId: string | null;
  cache: Map<string, BoardSheetCacheEntry>;
  loading: boolean;
  error: string | null;
}
```

Expose `bootstrap(requestedId)`, `selectSheet(id)`, `revalidate(reason)`, `applyMutationVersions(versions)`, `markSheetStale(sheetId)`, `invalidatePeriod(sheetId)`, `setUser(userId)`, `snapshot()`, and `subscribe(listener)`. Deduplicate concurrent bootstrap/sheet/version requests by key and clear each promise in `finally`.

- [ ] **Step 4: Reconcile summaries without eager inactive reads**

The controller replaces manifest metadata from the summary, marks changed inactive entries stale, and fetches only when the changed id is active. `markSheetStale` follows the same rule: a failed note mutation refreshes only its active owning sheet and leaves an inactive sheet stale until selected. The controller never prefetches unopened or inactive sheets. When the active sheet is deleted, choose default/first, remove its cache entry, and emit `{ replaceUrlWithSheetId }` to the browser adapter.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm test apps/web/src/features/board/boardDataController.test.ts`

```bash
git add apps/web/src/features/board/boardDataController.ts apps/web/src/features/board/boardDataController.test.ts
git commit -m "Add sheet-aware board data controller"
```

### Task 6: Rewire `useBoard` To Bootstrap, Cache, And V2 Polling

**Files:**
- Modify: `apps/web/src/features/board/useBoard.ts`
- Modify: `apps/web/src/features/board/useBoard.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.ts`

- [ ] **Step 1: Add failing browser-adapter tests**

Test v2 storage/channel names, user/protocol filtering, focus/visibility revalidation, hidden-tab no-fetch, leader-only polling, board-view return immediate check, note-save failure invalidating only its owning sheet, URL replacement on deletion, and state clearing on logout/account change. Retain active 120-second and idle 300-second cadence.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/web/src/features/board/useBoard.test.ts apps/web/src/App.test.ts`

Expected: FAIL because `useBoard` still loads the legacy full board and immediately requests versions.

- [ ] **Step 3: Wrap the controller in React state**

Create one controller per authenticated `userId`. Subscribe in an effect and expose a composed `BoardPayload` for the active cached sheet. Initial fetch is exactly:

```ts
apiGet<BoardBootstrapPayload>(
  `/api/board/bootstrap${requestedSheetId ? `?sheetId=${encodeURIComponent(requestedSheetId)}` : ""}`
);
```

Do not call `/api/board/versions` immediately after bootstrap.

- [ ] **Step 4: Separate view enablement from cache lifetime**

When `enabled` becomes false for another app view, stop polling but retain controller/cache for the same authenticated user. When returning to board, render a reusable entry immediately and call `revalidate("view-return")`. When `userId` becomes null or changes, clear all state and pending write overlays.

Route a failed note create/update/delete through `markSheetStale(note.sheet_id)`. If that sheet is active, reload only that sheet; if inactive, preserve the current view and defer its reload until selection. Pending completion and cell-state overlays remain outside fetched payloads and are reapplied after any note-triggered reload.

- [ ] **Step 5: Version the cross-tab protocol**

Use:

```ts
const protocolVersion = 2;
const leaderKey = `riceark-board-polling:v2:${userId}`;
const channelName = `riceark-board-polling:v2:${userId}`;
```

Every message includes `{ protocolVersion: 2, userId, sourceId, summary }`. Ignore a mismatched protocol or user. A follower applies summary metadata and asks its controller to fetch only if its visible active sheet changed.

- [ ] **Step 6: Move sheet route state into `App`**

Track `routeSheetId` alongside active view/share id. `popstate` supplies it to `useBoard`; selecting a sheet uses `applyAppRoute(..., "push")`; deleted-sheet fallback uses `replace`. Pass authenticated user id to `useBoard`.

- [ ] **Step 7: Run tests and commit**

Run: `pnpm test apps/web/src/features/board/useBoard.test.ts apps/web/src/App.test.ts`

```bash
git add apps/web/src/features/board/useBoard.ts apps/web/src/features/board/useBoard.test.ts apps/web/src/App.tsx apps/web/src/App.test.ts
git commit -m "Use active-sheet bootstrap and v2 revalidation"
```

### Task 7: Make `BoardOverview` A Controlled Active-Sheet Renderer

**Files:**
- Modify: `apps/web/src/features/board/BoardOverview.tsx`
- Modify: `apps/web/src/features/board/BoardOverview.test.ts`
- Create: `apps/web/src/features/board/boardIndexes.ts`
- Create: `apps/web/src/features/board/boardIndexes.test.ts`

- [ ] **Step 1: Write failing controlled-navigation and indexing tests**

Assert tab clicks call `onSheetSelected(id)` without writing history inside `BoardOverview`, back/forward state comes from props, and table-local indexes contain only the selected sheet payload. Test stable grouping for tables, notes, axis items, cell states, and completions.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/web/src/features/board/BoardOverview.test.ts apps/web/src/features/board/boardIndexes.test.ts`

Expected: FAIL because the component owns URL parsing/history.

- [ ] **Step 3: Add controlled props**

```ts
interface Props {
  board: BoardPayload;
  activeSheetId: string;
  onSheetSelected: (sheetId: string) => void;
  onBoardChanged?: () => Promise<BoardPayload | null> | void;
  readOnly?: boolean;
}
```

Delete `getBoardSheetIdFromUrl`, the local `activeSheetId` state, and the component `popstate` listener. Tab buttons call the prop. Sheet creation calls `onSheetSelected(created.id)` before reloading manifest/sheet state.

- [ ] **Step 4: Build table-local indexes once**

Export `indexBoardPayloadByTable(payload)` returning maps for axis items, cell states, and completions plus sheet notes/tables. Create it with one `useMemo([tables, notes, axisItems, cellStates, completions])` and pass table-local arrays to `BoardTableGrid` instead of filtering whole arrays repeatedly.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm test apps/web/src/features/board/BoardOverview.test.ts apps/web/src/features/board/boardIndexes.test.ts apps/web/src/App.test.ts`

```bash
git add apps/web/src/features/board/BoardOverview.tsx apps/web/src/features/board/BoardOverview.test.ts apps/web/src/features/board/boardIndexes.ts apps/web/src/features/board/boardIndexes.test.ts apps/web/src/App.tsx apps/web/src/App.test.ts
git commit -m "Control active sheet rendering and indexing"
```

### Task 8: Measure Query And Payload Reduction

**Files:**
- Create: `apps/api/scripts/measure-board-read-path.mjs`
- Modify: `apps/api/package.json`
- Modify: root `package.json`

- [ ] **Step 1: Create a reproducible three-sheet fixture**

The script creates local D1 data with three sheets, their current production-like table/axis/cell/completion distribution, runs legacy full-board SQL and one active-sheet path through `wrangler d1 execute --local --json`, and sums each result's `meta.rows_read` and serialized JSON bytes.

- [ ] **Step 2: Add the command**

Add `"measure:board-reads": "node scripts/measure-board-read-path.mjs"` to the API package and forward it from the root package.

- [ ] **Step 3: Run and assert the budget**

Run: `pnpm measure:board-reads`

Expected: output reports established bootstrap at no more than 10 D1 queries including auth-equivalent overhead, no-change version check at one version SQL statement, and active-sheet rows at least 40% below legacy full-board rows for the three-sheet fixture. Exit nonzero when a budget fails.

- [ ] **Step 4: Run all quality gates**

Run: `git diff --check && pnpm check && pnpm test && pnpm test:d1-sql && pnpm measure:board-reads && pnpm build`

Expected: every command passes.

- [ ] **Step 5: Commit measurement tooling**

```bash
git add apps/api/scripts/measure-board-read-path.mjs apps/api/package.json package.json
git commit -m "Measure active-sheet board read savings"
```

### Task 9: Preserve Legacy Endpoint Compatibility

**Files:**
- Modify: `apps/api/src/routes/board.test.ts`
- Modify: `docs/superpowers/specs/2026-07-15-performance-caching-optimization-design.md` only when recording an observed rollout date.

- [ ] **Step 1: Add compatibility assertions**

Test that `GET /api/board` still returns `userId/settings/sheets/tables/notes/axisItems/cellStates/completions`, single-character refresh still exists, and old mutation top-level fields remain present beside `versions`.

- [ ] **Step 2: Run compatibility and full tests**

Run: `pnpm test apps/api/src/routes/board.test.ts apps/api/src/routes/characters.refresh.test.ts && pnpm test`

Expected: PASS.

- [ ] **Step 3: Inspect production-removal guard**

Do not delete `GET /api/board` in this plan. Its removal requires a later deployment after at least 30 days and negligible legacy traffic from Cloudflare request analytics.

- [ ] **Step 4: Commit the compatibility guard**

```bash
git add apps/api/src/routes/board.test.ts
git commit -m "Preserve legacy board compatibility"
```
