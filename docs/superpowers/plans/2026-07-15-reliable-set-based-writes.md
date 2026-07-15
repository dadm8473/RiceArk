# Reliable Set-Based Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver completion, cell-state, settings, ordering, import, and character-refresh writes with fewer RiceArk requests and bounded D1 statements while retaining the user's latest intent across ordinary navigation and transient failures.

**Architecture:** A user-scoped client queue coalesces absolute patches, sends one keepalive request at a time, and classifies retryable failures. Server array routes bind one normalized JSON payload and use guarded `json_each(?)` set operations plus the transactional version primitives from the foundation phase.

**Tech Stack:** React hooks, Fetch keepalive, Hono, Zod, Cloudflare D1 JSON functions, Lost Ark Open API, Vitest, Wrangler local D1.

**Prerequisite:** Complete `2026-07-15-performance-foundation-observability.md` first so every accepted mutation can return transactional version metadata.

---

### Task 1: Expose Retry And Keepalive Metadata In The API Client

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/src/features/board/types.ts`

- [ ] **Step 1: Write failing API-client tests**

Test that PATCH can set `keepalive`, that `Retry-After` seconds and HTTP dates are parsed, and that error bodies preserve code/message plus structured rejected keys:

```ts
await expect(apiPatch("/api/board/completions", { patches: [] }, { keepalive: true })).rejects.toMatchObject({
  status: 429,
  code: "rate_limited",
  retryAfterMs: 5_000
});
expect(fetchMock).toHaveBeenCalledWith("/api/board/completions", expect.objectContaining({ keepalive: true }));
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/web/src/api/client.test.ts`

Expected: FAIL because the third argument and retry metadata do not exist.

- [ ] **Step 3: Extend the client without changing existing callers**

Use additive options and error fields:

```ts
export interface ApiRequestOptions {
  keepalive?: boolean;
  signal?: AbortSignal;
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterMs: number | null = null,
    public readonly details: Record<string, unknown> | null = null
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function apiPatch<T>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
    keepalive: options.keepalive,
    signal: options.signal
  });
  if (!response.ok) throw await buildApiError(response, `PATCH ${path} failed`);
  return response.json() as Promise<T>;
}
```

Parse `Retry-After` once in `buildApiError`; clamp negative dates to zero and return `null` for malformed headers. Preserve every response field beside `code` and `message` in `details`, so queue adapters can validate and consume `rejectedKeys` without reparsing the response.

Add the matching browser-side version contract to `apps/web/src/features/board/types.ts` and import it into queue adapters:

```ts
export interface BoardMutationVersions {
  sheets: Array<{ id: string; version: number }>;
  manifestVersion?: number;
}
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm test apps/web/src/api/client.test.ts && pnpm --filter @riceark/web check`

```bash
git add apps/web/src/api/client.ts apps/web/src/api/client.test.ts apps/web/src/features/board/types.ts
git commit -m "Expose keepalive and retry metadata"
```

### Task 2: Build A Deterministic Reliable Patch Queue

**Files:**
- Create: `apps/web/src/features/board/reliablePatchQueue.ts`
- Create: `apps/web/src/features/board/reliablePatchQueue.test.ts`

- [ ] **Step 1: Write failing queue tests with fake timers**

Cover latest-value coalescing, one in-flight request, 800 ms debounce, 200-patch split, 24 KiB split, two simultaneous queue bodies staying below 64 KiB in aggregate, a 10-second request deadline, retry delays `1/2/5/10/30` seconds, `Retry-After`, focus/online immediate retry, permanent rejection, auth pause, and pending overlays. Use this outcome type:

```ts
type SendOutcome<K> =
  | { type: "accepted"; acknowledgedKeys: K[]; versions?: BoardMutationVersions }
  | { type: "rejected"; rejectedKeys: K[]; message: string }
  | { type: "auth"; error: ApiClientError }
  | { type: "retry"; error: unknown; retryAfterMs: number | null };
```

The key race test must enqueue `completed: false` for a cell while `completed: true` is in flight, reject the first request, and assert only `false` remains for retry.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/web/src/features/board/reliablePatchQueue.test.ts`

Expected: FAIL because the queue does not exist.

- [ ] **Step 3: Implement queue contracts and byte-aware chunking**

Export these stable constants and options:

```ts
export const PATCH_QUEUE_DEBOUNCE_MS = 800;
export const PATCH_QUEUE_MAX_ITEMS = 200;
export const PATCH_QUEUE_MAX_BODY_BYTES = 24 * 1024;
export const PATCH_QUEUE_REQUEST_TIMEOUT_MS = 10_000;
export const PATCH_QUEUE_RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface ReliablePatchQueueOptions<T, K> {
  keyOf: (patch: T) => K;
  serializeBody: (patches: T[]) => string;
  send: (patches: T[]) => Promise<SendOutcome<K>>;
  onPendingChange: (patches: T[]) => void;
  onPermanentFailure: (outcome: Extract<SendOutcome<K>, { type: "rejected" }>) => void;
  onAuthPause: (error: ApiClientError) => void;
}
```

Use `TextEncoder().encode(serializedBody).byteLength` to build chunks. Preserve insertion order with `Map<K,T>`, replace queued/in-flight values by key, and remove a key only when the acknowledged value still equals the sent value. Keep one `send()` promise active at a time.

The queue is deliberately memory-only. Do not persist pending board mutations in `localStorage`, IndexedDB, KV, or D1; user changes remain visible through the in-memory overlay until acknowledged, explicitly discarded, or the authenticated identity changes.

- [ ] **Step 4: Implement retry classification**

Export and test this pure classifier:

```ts
export function classifyQueueError(error: unknown): "auth" | "retry" | "permanent" {
  if (!(error instanceof ApiClientError)) return "retry";
  if (error.status === 401 || error.status === 403) return "auth";
  if (error.status === 408 || error.status === 429 || error.status >= 500) return "retry";
  return "permanent";
}
```

Retries remain capped at 30 seconds. A successful send resets the retry index. `dispose()` clears timers but returns the pending snapshot; it does not silently discard it.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm test apps/web/src/features/board/reliablePatchQueue.test.ts && pnpm --filter @riceark/web check`

```bash
git add apps/web/src/features/board/reliablePatchQueue.ts apps/web/src/features/board/reliablePatchQueue.test.ts
git commit -m "Add reliable coalescing patch queue"
```

### Task 3: Own Completion And Cell-State Queues In `useBoard`

**Files:**
- Modify: `apps/web/src/features/board/useBoardCompletionQueue.ts`
- Create: `apps/web/src/features/board/useBoardCellStateQueue.ts`
- Create: `apps/web/src/features/board/useBoardCellStateQueue.test.ts`
- Modify: `apps/web/src/features/board/useBoard.ts`
- Modify: `apps/web/src/features/board/useBoard.test.ts`
- Modify: `apps/web/src/features/board/BoardOverview.tsx`
- Modify: `apps/web/src/features/board/BoardOverview.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/features/auth/AuthMenu.tsx`
- Modify: `apps/web/src/features/auth/AuthMenu.test.ts`

- [ ] **Step 1: Replace source-string tests with behavior tests**

Mount a small queue harness and assert:

```ts
expect(fetchMock).toHaveBeenCalledTimes(1); // ten edits inside 800 ms
expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH", keepalive: true });
expect(window.location.reload).not.toHaveBeenCalled();
```

Add cell-state tests showing ten paints coalesce by table/row/column and completion tests showing period key remains part of the key. Simulate `visibilitychange` and `pagehide` to assert immediate flush.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/web/src/features/board/useBoard.test.ts apps/web/src/features/board/useBoardCellStateQueue.test.ts apps/web/src/features/board/BoardOverview.test.ts apps/web/src/features/auth/AuthMenu.test.ts`

Expected: FAIL because cell states bypass a queue and failures reload the page.

- [ ] **Step 3: Wrap the queue for both endpoints**

Both hooks call `apiPatch(..., { keepalive: true, signal: AbortSignal.timeout(PATCH_QUEUE_REQUEST_TIMEOUT_MS) })`. Completion sends `{ patches }` to `/api/board/completions`; cell state sends `{ patches }` to `/api/board/cell-states`. Their send adapters translate `ApiClientError` through `classifyQueueError` and pass accepted version metadata to `useBoard`. A deadline abort is retryable and retains the sent snapshot.

- [ ] **Step 4: Move queue lifetime to authenticated-user scope**

Change the hook input and result:

```ts
useBoard({
  enabled,
  pollingEnabled,
  userId: session.status === "authenticated" ? session.user.id : null
});

return {
  data,
  error,
  reload,
  enqueueCompletion,
  enqueueCellState,
  flushPendingWrites,
  discardPendingWrites,
  hasPendingWrites,
  pendingWriteError
};
```

Pending completion and cell-state arrays live beside the board cache, not in `BoardOverview`. When server data reloads, apply pending patches after the payload. A user id change disposes and clears the previous user's queue before constructing the next one.

- [ ] **Step 5: Remove direct cell-state writes and page reload recovery**

`BoardOverview` applies its optimistic local patch and calls the callback supplied by `useBoard`. Bulk paint passes all patches through the same callback. Delete all `window.location.reload()` calls used for completion or cell-state failure.

- [ ] **Step 6: Flush before logout and require explicit discard**

`App.handleLogout` first awaits `board.flushPendingWrites()`; the active request deadline bounds this wait to 10 seconds. On timeout or another retryable failure, leave the session active and render two commands in `AuthMenu`: retry save, or discard changes and log out. Only the explicit discard calls `board.discardPendingWrites()` before `/api/auth/logout`.

- [ ] **Step 7: Run tests and commit**

Run: `pnpm test apps/web/src/features/board/useBoard.test.ts apps/web/src/features/board/useBoardCellStateQueue.test.ts apps/web/src/features/board/BoardOverview.test.ts apps/web/src/features/auth/AuthMenu.test.ts`

```bash
git add apps/web/src/features/board/useBoardCompletionQueue.ts apps/web/src/features/board/useBoardCellStateQueue.ts apps/web/src/features/board/useBoardCellStateQueue.test.ts apps/web/src/features/board/useBoard.ts apps/web/src/features/board/useBoard.test.ts apps/web/src/features/board/BoardOverview.tsx apps/web/src/features/board/BoardOverview.test.ts apps/web/src/App.tsx apps/web/src/features/auth/AuthMenu.tsx apps/web/src/features/auth/AuthMenu.test.ts
git commit -m "Keep board writes reliable across navigation"
```

### Task 4: Convert Completion And Cell-State Batches To Guarded Set SQL

**Files:**
- Create: `apps/api/src/db/boardBulkSql.ts`
- Create: `apps/api/src/db/boardBulkSql.test.ts`
- Modify: `apps/api/src/db/board.ts`
- Modify: `apps/api/src/db/board.test.ts`
- Modify: `apps/api/src/routes/board.ts`
- Modify: `apps/api/src/routes/board.test.ts`
- Modify: `apps/api/src/http/errors.ts`

- [ ] **Step 1: Write failing SQL-shape, authorization, and budget tests**

For 200 patches, assert one JSON payload bind, fewer than 100 binds per statement, at most 20 D1 statements including auth, one version increment per sheet, and no row-by-row statement array. Test invalid axis membership, locked table, stale period, deleted target, duplicates, empty patches, and two sheets.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/api/src/db/boardBulkSql.test.ts apps/api/src/db/board.test.ts apps/api/src/routes/board.test.ts`

Expected: FAIL because current writes prepare one statement per patch.

- [ ] **Step 3: Build normalized JSON payloads**

Generate ids before serialization and use camel-free SQL field names:

```ts
const rows = mergeBoardCompletionPatches(patches).map((patch) => ({
  id: crypto.randomUUID(),
  table_id: patch.tableId,
  row_item_id: patch.rowItemId,
  column_item_id: patch.columnItemId,
  period_key: patch.periodKey,
  completed: patch.completed ? 1 : 0
}));
const payloadJson = JSON.stringify(rows);
```

Preflight loads authorized targets once and uses existing reset-rule helpers to reject the whole request before the write batch when any period is not current.

- [ ] **Step 4: Implement a globally guarded completion upsert**

Use a single JSON bind and a count guard so a write-time ownership/lock race produces zero rows, never a partial batch:

```sql
WITH input AS (
  SELECT
    json_extract(value, '$.id') AS id,
    json_extract(value, '$.table_id') AS table_id,
    json_extract(value, '$.row_item_id') AS row_item_id,
    json_extract(value, '$.column_item_id') AS column_item_id,
    json_extract(value, '$.period_key') AS period_key,
    CAST(json_extract(value, '$.completed') AS INTEGER) AS completed
  FROM json_each(?2)
), valid AS (
  SELECT input.*
  FROM input
  JOIN board_tables AS tables
    ON tables.id = input.table_id AND tables.user_id = ?1 AND tables.locked = 0
  JOIN board_axis_items AS rows
    ON rows.id = input.row_item_id AND rows.table_id = tables.id AND rows.axis = 'row' AND rows.user_id = ?1
  JOIN board_axis_items AS columns
    ON columns.id = input.column_item_id AND columns.table_id = tables.id AND columns.axis = 'column' AND columns.user_id = ?1
)
INSERT INTO board_cell_completions (
  id, user_id, table_id, row_item_id, column_item_id, period_key, completed, updated_at
)
SELECT id, ?1, table_id, row_item_id, column_item_id, period_key, completed, CURRENT_TIMESTAMP
FROM valid
WHERE (SELECT COUNT(*) FROM valid) = json_array_length(?2)
ON CONFLICT(user_id, table_id, row_item_id, column_item_id, period_key)
DO UPDATE SET completed = excluded.completed, updated_at = CURRENT_TIMESTAMP
RETURNING table_id, row_item_id, column_item_id, period_key
```

Compare every returned key with the request keys. The distinct-sheet version statement must repeat the same global ownership, lock, row-axis, and column-axis count guard against the same JSON payload; it returns no rows when a write-time race invalidates any key. Zero/missing keys return a structured `invalid_board_completion_target` response and leave persisted versions unchanged.

- [ ] **Step 5: Implement cell-state upsert/delete with one version statement**

Use one normalized payload and the same global target guard. Rows where `mark_type='default'`, `memo IS NULL`, and `mark_icon IS NULL` are deleted; all other rows are upserted. Keep `checkbox_visible=0` only for `disabled`, null both memo/icon for disabled, and keep `mark_period_key` only for reserved. Batch the two mutation statements and one distinct-sheet version statement. Each statement validates all input targets, each mutation filters only its own operation subset, the union of delete/upsert `RETURNING` keys must equal the request, and the version statement repeats the global guard so a race cannot produce a version-only update.

- [ ] **Step 6: Return structured rejected keys**

Use this error payload for permanent queue reconciliation:

```json
{
  "error": {
    "code": "invalid_board_cell_state_target",
    "message": "셀 표시 상태를 바꿀 수 없는 항목입니다.",
    "rejectedKeys": [["table-1", "row-1", "column-1"]]
  }
}
```

Extend `ApiError` with additive `ApiErrorOptions` containing optional serializable `details` and response `headers`. `jsonError` spreads detail fields next to `code` and `message` inside `error`, applies optional headers, and leaves every existing payload unchanged when options are absent. This establishes the same header path later used for upstream `Retry-After`.

- [ ] **Step 7: Run tests and commit**

Run: `pnpm test apps/api/src/db/boardBulkSql.test.ts apps/api/src/db/board.test.ts apps/api/src/routes/board.test.ts`

```bash
git add apps/api/src/db/boardBulkSql.ts apps/api/src/db/boardBulkSql.test.ts apps/api/src/db/board.ts apps/api/src/db/board.test.ts apps/api/src/routes/board.ts apps/api/src/routes/board.test.ts apps/api/src/http/errors.ts
git commit -m "Use guarded set SQL for board cell writes"
```

### Task 5: Convert Remaining Array Writes To JSON Set Operations

**Files:**
- Modify: `apps/api/src/db/board.ts`
- Modify: `apps/api/src/db/board.test.ts`
- Modify: `apps/api/src/db/characters.ts`
- Modify: `apps/api/src/db/characters.test.ts`
- Modify: `apps/api/src/db/tasks.ts`
- Modify: `apps/api/src/routes/tasks.test.ts`
- Modify: `apps/api/src/db/completions.ts`
- Modify: `apps/api/src/routes/dashboard.test.ts`

- [ ] **Step 1: Add failing 200-row budget tests**

Test axis order, character import, character order, task order, default-board axis seeding, and legacy completion synchronization at their schema maximum. Each accepted route must prepare at most 20 statements and each SQL statement must bind fewer than 100 values.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/api/src/db/board.test.ts apps/api/src/db/characters.test.ts apps/api/src/routes/tasks.test.ts apps/api/src/routes/dashboard.test.ts`

Expected: FAIL on row-by-row batches and bind-heavy `IN (...)` queries.

- [ ] **Step 3: Convert ordering writes**

Serialize ids once and use the `json_each.key` as stable order:

```sql
WITH input AS (
  SELECT CAST(key AS INTEGER) AS position, value AS id
  FROM json_each(?2)
), valid AS (
  SELECT input.*
  FROM input
  JOIN characters ON characters.id = input.id
  WHERE characters.user_id = ?1 AND characters.enabled = 1 AND characters.deleted_at IS NULL
)
UPDATE characters
SET sort_order = (SELECT position * 10 FROM valid WHERE valid.id = characters.id),
    updated_at = CURRENT_TIMESTAMP
WHERE user_id = ?1
  AND id IN (SELECT id FROM valid)
  AND (SELECT COUNT(*) FROM valid) = json_array_length(?2)
RETURNING id
```

Use equivalent ownership joins for task orders and board axis orders. Compare all returned ids to the normalized list.

- [ ] **Step 4: Convert import, seed, and legacy synchronization writes**

Assign UUIDs in TypeScript, bind one JSON array, and use `INSERT ... SELECT ... ON CONFLICT DO UPDATE`. Default seeding uses one insert for all missing axis rows. Legacy completion sync uses one upsert for all mapped patches. Every route validates the whole normalized input before writing, repeats ownership/eligibility predicates in SQL, and compares the complete `RETURNING` key set. Empty arrays skip D1 entirely.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm test apps/api/src/db/board.test.ts apps/api/src/db/characters.test.ts apps/api/src/routes/tasks.test.ts apps/api/src/routes/dashboard.test.ts`

```bash
git add apps/api/src/db/board.ts apps/api/src/db/board.test.ts apps/api/src/db/characters.ts apps/api/src/db/characters.test.ts apps/api/src/db/tasks.ts apps/api/src/routes/tasks.test.ts apps/api/src/db/completions.ts apps/api/src/routes/dashboard.test.ts
git commit -m "Bound all array mutations with set SQL"
```

### Task 6: Collapse Table And Axis Settings Fan-Out

**Files:**
- Modify: `apps/api/src/routes/board.ts`
- Modify: `apps/api/src/routes/board.test.ts`
- Modify: `apps/api/src/db/board.ts`
- Modify: `apps/api/src/db/board.test.ts`
- Modify: `apps/web/src/features/board/BoardOverview.tsx`
- Modify: `apps/web/src/features/board/BoardOverview.test.ts`

- [ ] **Step 1: Write failing one-request flow tests**

For a table with 97 axis items, saving name/default sizes/apply flags/character display/separator must call one endpoint. Editing one axis item with cross-size propagation must also call one endpoint. Assert at most 10 D1 statements for either route.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/api/src/routes/board.test.ts apps/api/src/db/board.test.ts apps/web/src/features/board/BoardOverview.test.ts`

Expected: FAIL because the browser sends one request per item.

- [ ] **Step 3: Extend table settings input**

Add these fields to `updateBoardTableSettingsSchema` and `UpdateBoardTableSettingsInput`:

```ts
applyRowSize: z.boolean().default(false),
applyColumnSize: z.boolean().default(false),
characterSeparator: boardAxisSeparatorSchema.nullable().optional(),
characterDisplaySettings: boardDisplaySettingsSchema.nullable().optional()
```

The DB helper validates table ownership/lock once, updates the table, updates all visible row/column sizes with at most two set statements, updates visible character-axis display/separator fields with one statement, then bumps the sheet once.

- [ ] **Step 4: Merge axis detail, own size, and cross-size propagation**

Extend `updateBoardAxisItemSchema` with optional `sizePx` and `crossSizePx`. One DB transaction updates the target item's details/primary size and, when `crossSizePx` is supplied, applies it to all visible items on that table axis. Remove the separate `/size` request from `handleAxisItemSave`; retain the route during the legacy-client window.

- [ ] **Step 5: Replace client fan-out with one call**

`handleTableSettingsSave` sends exactly the modal input to `/api/board/tables/:id`. `handleAxisItemSave` sends details and sizes together to `/api/board/axis-items/:id`. Apply the existing pure local reducers only after success.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm test apps/api/src/routes/board.test.ts apps/api/src/db/board.test.ts apps/web/src/features/board/BoardOverview.test.ts`

```bash
git add apps/api/src/routes/board.ts apps/api/src/routes/board.test.ts apps/api/src/db/board.ts apps/api/src/db/board.test.ts apps/web/src/features/board/BoardOverview.tsx apps/web/src/features/board/BoardOverview.test.ts
git commit -m "Collapse board settings request fan-out"
```

### Task 7: Replace Roster-Wide Refresh With Direct Profile Batches

**Files:**
- Modify: `apps/api/src/lostark/client.ts`
- Modify: `apps/api/src/lostark/client.test.ts`
- Modify: `apps/api/src/db/characters.ts`
- Modify: `apps/api/src/db/characters.test.ts`
- Modify: `apps/api/src/routes/characters.ts`
- Modify: `apps/api/src/routes/characters.refresh.test.ts`
- Modify: `apps/web/src/features/board/BoardOverview.tsx`
- Modify: `apps/web/src/features/board/BoardOverview.test.ts`

- [ ] **Step 1: Write failing request-count and partial-result tests**

For 20 saved characters, assert one RiceArk request, no siblings calls, at most 20 Lost Ark profile calls, maximum four unresolved profile calls at once, zero KV puts, and one result per requested id. Include updated, manual, not-found, cooldown, upstream-not-found, upstream-error, and upstream `429` results with preserved `Retry-After` metadata.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/api/src/lostark/client.test.ts apps/api/src/db/characters.test.ts apps/api/src/routes/characters.refresh.test.ts apps/web/src/features/board/BoardOverview.test.ts`

Expected: FAIL because refresh calls roster search once per character.

- [ ] **Step 3: Add direct profile normalization**

Export a fresh-only helper that uses `fetchExternal` and never reads/writes KV:

```ts
export async function fetchLostArkCharacterProfile(
  env: Env,
  characterName: string
): Promise<ImportedCharacterCandidate | null> {
  const response = await fetchExternal(`${BASE_URL}/armories/characters/${encodeURIComponent(characterName)}/profiles`, {
    headers: lostArkHeaders(env)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw lostArkApiError(response);
  return normalizeLostArkProfile(await readJsonOrNull(response));
}
```

The normalized profile includes name, server, class, item level, and combat power.

- [ ] **Step 4: Add bounded concurrency and batch DB update**

Create a `mapWithConcurrency(items, 4, worker)` helper with an order-preserving result array. `refreshCharactersFromLostArk` loads at most 40 owned rows through one JSON-id query, applies cooldown decisions, fetches eligible profiles, and performs one JSON-backed character update plus one distinct-sheet version update.

- [ ] **Step 5: Add the batch route**

Use this schema and response family:

```ts
const characterRefreshBatchSchema = z.object({
  characterIds: z.array(resourceIdSchema).min(1).max(40)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate character ids are not allowed")
}).strict();

type CharacterRefreshBatchItem =
  | { id: string; status: "updated"; character: CharacterSnapshot }
  | { id: string; status: "manual" | "not_found" | "not_available" }
  | { id: string; status: "rate_limited"; retryAfterSeconds: number }
  | { id: string; status: "failed"; code: string };
```

Return `{ results, versions }`. Keep the existing single-character route and implement it through the same service.

- [ ] **Step 6: Replace the client refresh loop**

`handleRefreshTableCharacters` sends one POST to `/api/characters/refresh-batch`, applies all `updated` profiles to local axis items, and derives the same Korean success/failure counts from result statuses.

- [ ] **Step 7: Run tests and commit**

Run: `pnpm test apps/api/src/lostark/client.test.ts apps/api/src/db/characters.test.ts apps/api/src/routes/characters.refresh.test.ts apps/web/src/features/board/BoardOverview.test.ts`

```bash
git add apps/api/src/lostark/client.ts apps/api/src/lostark/client.test.ts apps/api/src/db/characters.ts apps/api/src/db/characters.test.ts apps/api/src/routes/characters.ts apps/api/src/routes/characters.refresh.test.ts apps/web/src/features/board/BoardOverview.tsx apps/web/src/features/board/BoardOverview.test.ts
git commit -m "Batch direct Lost Ark character refreshes"
```

### Task 8: Verify SQL Against Wrangler D1 And Run Full Gates

**Files:**
- Create: `apps/api/scripts/verify-board-bulk-sql.mjs`
- Modify: `apps/api/package.json`
- Modify: root `package.json`

- [ ] **Step 1: Add a local-D1 verification script**

The script creates a temporary Wrangler state directory, applies the production migrations, seeds one user/sheet/table/row/column, executes representative completion upsert, cell-state delete/upsert, ordering, and `UPDATE ... RETURNING`, then fails unless it reads two accepted cells and the expected version. Always remove the temporary directory in `finally`.

- [ ] **Step 2: Expose exact package commands**

Add:

```json
{
  "scripts": {
    "test:d1-sql": "node scripts/verify-board-bulk-sql.mjs"
  }
}
```

to `apps/api/package.json`, and `"test:d1-sql": "pnpm --filter @riceark/api test:d1-sql"` to the root.

- [ ] **Step 3: Run SQL verification**

Run: `pnpm test:d1-sql`

Expected: output ends with `board bulk SQL verified: cells=2, completed=2, version=1` and exit code 0.

- [ ] **Step 4: Run all quality gates**

Run: `git diff --check && pnpm check && pnpm test && pnpm build`

Expected: all checks pass.

- [ ] **Step 5: Commit verification tooling**

```bash
git add apps/api/scripts/verify-board-bulk-sql.mjs apps/api/package.json package.json
git commit -m "Verify bulk SQL with local D1"
```
