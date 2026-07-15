# Performance Foundation And Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make board cache versions transactionally trustworthy, stop known waste from anonymous and admin flows, and expose production Workers usage before payload or queue optimization begins.

**Architecture:** D1 mutation statements and their version increments run in one `DB.batch()` transaction and return their resulting versions through `RETURNING`. Admin aggregates are isolated behind authorization and cached without admin identity; the browser waits for resolved session state before owner-board or admin routing work.

**Tech Stack:** Cloudflare Pages Functions, Hono, D1 SQL, React 19, TypeScript, Vitest.

**Prerequisite:** None. Execute this foundation plan before the write, read, or public-cache phases.

---

### Task 1: Add Mutation Version Primitives

**Files:**
- Create: `apps/api/src/db/boardVersions.ts`
- Create: `apps/api/src/db/boardVersions.test.ts`
- Modify: `apps/api/src/db/board.ts`

- [ ] **Step 1: Write failing tests for returned version rows**

Add tests that capture prepared SQL and prove sheet and manifest statements use `RETURNING`, deduplicate sheet versions, and preserve an optional manifest version:

```ts
expect(sheetStatement.sql).toContain("RETURNING id, content_version AS version");
expect(manifestStatement.sql).toContain("RETURNING user_id, version");
expect(buildBoardMutationVersions([
  { id: "sheet-1", version: 4 },
  { id: "sheet-1", version: 4 },
  { id: "sheet-2", version: 8 }
], 12)).toEqual({
  sheets: [{ id: "sheet-1", version: 4 }, { id: "sheet-2", version: 8 }],
  manifestVersion: 12
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `pnpm test apps/api/src/db/boardVersions.test.ts`

Expected: FAIL because `boardVersions.ts` does not exist.

- [ ] **Step 3: Implement the shared contract and statements**

Create these exact public contracts and helpers:

```ts
import type { Env } from "../env";

export interface BoardSheetVersion {
  id: string;
  version: number;
}

export interface BoardMutationVersions {
  sheets: BoardSheetVersion[];
  manifestVersion?: number;
}

export type BoardMutationResult<T extends object = { ok: true }> = T & {
  versions: BoardMutationVersions;
};

export function bumpBoardManifestVersionStatement(env: Env, userId: string) {
  return env.DB.prepare(`
    INSERT INTO board_manifest_versions (user_id, version, updated_at)
    VALUES (?1, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE
    SET version = board_manifest_versions.version + 1,
        updated_at = CURRENT_TIMESTAMP
    RETURNING user_id, version
  `).bind(userId);
}

export function bumpBoardSheetVersionStatement(env: Env, userId: string, sheetId: string) {
  return env.DB.prepare(`
    UPDATE sheets
    SET content_version = content_version + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?1 AND id = ?2
    RETURNING id, content_version AS version
  `).bind(userId, sheetId);
}

export function buildBoardMutationVersions(
  sheets: BoardSheetVersion[],
  manifestVersion?: number
): BoardMutationVersions {
  const deduped = new Map(sheets.map((sheet) => [sheet.id, sheet]));
  return {
    sheets: [...deduped.values()].sort((left, right) => left.id.localeCompare(right.id)),
    ...(manifestVersion === undefined ? {} : { manifestVersion })
  };
}
```

Also add `bumpBoardSheetVersionsForTablesStatement`, `bumpBoardSheetVersionForNoteStatement`, and `bumpBoardSheetVersionsForCharacterStatement`. Each must repeat `user_id` ownership in its subquery and end in the same `RETURNING id, content_version AS version` projection.

- [ ] **Step 4: Run tests and type checking**

Run: `pnpm test apps/api/src/db/boardVersions.test.ts apps/api/src/db/board.test.ts && pnpm --filter @riceark/api check`

Expected: PASS.

- [ ] **Step 5: Commit the primitives**

```bash
git add apps/api/src/db/boardVersions.ts apps/api/src/db/boardVersions.test.ts apps/api/src/db/board.ts
git commit -m "Add transactional board version primitives"
```

### Task 2: Version Sheet And Note Mutations Atomically

**Files:**
- Modify: `apps/api/src/db/board.ts`
- Modify: `apps/api/src/db/board.test.ts`
- Modify: `apps/api/src/routes/board.ts`
- Modify: `apps/api/src/routes/board.test.ts`

- [ ] **Step 1: Write failing version-delta tests**

Cover these exact invariants:

```ts
const expectations = {
  createSheet: { manifest: 1, sheets: 0 },
  renameSheet: { manifest: 1, sheets: 1 },
  deleteSheet: { manifest: 1, sheets: 0 },
  createTable: { manifest: 0, sheets: 1 },
  createNote: { manifest: 0, sheets: 1 },
  updateNote: { manifest: 0, sheets: 1 },
  moveNote: { manifest: 0, sheets: 1 },
  deleteNote: { manifest: 0, sheets: 1 }
};
```

For a not-found, locked, duplicate-name, or rejected operation, assert that no version row is returned and the persisted version is unchanged. Route tests must assert that legacy fields remain top-level:

```ts
expect(await created.json()).toEqual({
  id: expect.any(String),
  versions: { sheets: [], manifestVersion: 4 }
});
expect(await renamed.json()).toEqual({
  ok: true,
  versions: { sheets: [{ id: "sheet-1", version: 7 }], manifestVersion: 5 }
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `pnpm test apps/api/src/db/board.test.ts apps/api/src/routes/board.test.ts`

Expected: FAIL because mutation responses do not contain `versions` and several mutations do not bump versions.

- [ ] **Step 3: Convert sheet mutations to transactional batches**

Use an insert with `RETURNING id` plus the manifest statement for creation. Rename must batch the guarded update, sheet bump, and a manifest bump that repeats the same target and name-availability predicate. Delete must conditionally bump the manifest while the owned sheet still exists, then delete it in the same batch. Because application code cannot branch between statements inside `DB.batch()`, no version statement may rely only on the result of a previous statement. Extract rows from the returned `D1Result.results` rather than issuing another query.

The create return shape must be:

```ts
return {
  id,
  versions: buildBoardMutationVersions([], returnedManifest?.version ?? 0)
};
```

The rename return shape must be a discriminated result so the route cannot lose metadata:

```ts
export type UpdateBoardSheetResult =
  | { type: "updated"; result: BoardMutationResult }
  | { type: "name_conflict" }
  | { type: "not_found" };
```

- [ ] **Step 4: Convert table and note mutations**

For create/update/layout/delete operations, place the domain statement and version statement in one batch. Each version statement repeats the domain operation's ownership, existence, and lock predicate so a rejected write returns no version row. For note deletion, bump the owning sheet before deleting the note so the subquery can still resolve it:

```ts
const [versionResult, deleteResult] = await env.DB.batch([
  bumpBoardSheetVersionForNoteStatement(env, userId, noteId),
  env.DB.prepare("DELETE FROM board_notes WHERE id = ?1 AND user_id = ?2 RETURNING id")
    .bind(noteId, userId)
]);
```

Compare the domain and version `RETURNING` rows before constructing success. Return `BoardMutationResult<{ id: string }>` for creates and `BoardMutationResult` for update/delete operations. Keep the existing `id` and `ok` fields exactly where legacy clients expect them.

- [ ] **Step 5: Update route serialization**

Delete endpoints that now have metadata return `200` JSON instead of `204`:

```ts
return c.json({ ok: true, versions: result.versions });
```

Keep status `201` for create endpoints. Preserve all existing error codes and statuses.

- [ ] **Step 6: Run focused tests**

Run: `pnpm test apps/api/src/db/board.test.ts apps/api/src/routes/board.test.ts`

Expected: PASS with exact one-step version deltas.

- [ ] **Step 7: Commit sheet and note versioning**

```bash
git add apps/api/src/db/board.ts apps/api/src/db/board.test.ts apps/api/src/routes/board.ts apps/api/src/routes/board.test.ts
git commit -m "Return atomic board mutation versions"
```

### Task 3: Version Table, Axis, Completion, Cell-State, And Character Projections

**Files:**
- Modify: `apps/api/src/db/board.ts`
- Modify: `apps/api/src/db/board.test.ts`
- Modify: `apps/api/src/db/characters.ts`
- Modify: `apps/api/src/db/characters.test.ts`
- Modify: `apps/api/src/routes/board.ts`
- Modify: `apps/api/src/routes/characters.ts`
- Modify: `apps/api/src/routes/board.test.ts`
- Modify: `apps/api/src/routes/characters.test.ts`

- [ ] **Step 1: Write failing coverage for every remaining board-content mutation**

Use a parameterized route test over table settings/delete/layout/transpose, character import/manual creation, task creation, axis create/update/order/size/hide, completion batch, and cell-state batch. Assert exactly one returned increment per distinct affected sheet, even when a batch contains many cells or tables.

Add character tests proving that display-name/details/delete/refresh bump every distinct sheet whose visible axis item references that character, while a character not present on a board returns an empty `sheets` array.

Replace the existing share start/stop assertions: sharing metadata is loaded by the sharing overview and does not change sheet navigation or rendered sheet content. Starting or stopping a share must execute only the guarded share mutation and must not increment `board_manifest_versions` or `sheets.content_version`.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `pnpm test apps/api/src/db/board.test.ts apps/api/src/db/characters.test.ts apps/api/src/routes/board.test.ts apps/api/src/routes/characters.test.ts`

Expected: FAIL on missing version rows.

- [ ] **Step 3: Batch each domain write with the correct version statement**

Use these mappings without substituting a follow-up read:

| Mutation family | Version statement |
| --- | --- |
| table id known | `bumpBoardSheetVersionsForTablesStatement(..., [tableId])` |
| axis id known | sheet selected through `board_axis_items -> board_tables` |
| completion/cell batch | distinct sheets selected from normalized table ids |
| character id known | `bumpBoardSheetVersionsForCharacterStatement` |
| transpose | one owning-sheet increment for the whole transaction |

For a multi-table completion request, the SQL must update each distinct sheet once:

```sql
UPDATE sheets
SET content_version = content_version + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE user_id = ?1
  AND id IN (
    SELECT DISTINCT sheet_id
    FROM board_tables
    WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))
  )
RETURNING id, content_version AS version
```

- [ ] **Step 4: Return additive metadata from all routes**

Every accepted board-content route returns either `{ ok: true, versions }` or its existing domain object spread with `{ versions }`. Character refresh keeps profile fields top-level:

```ts
return c.json({ ...updated.character, versions: updated.versions });
```

For local character cooldown `429`, set `Retry-After` before throwing:

```ts
c.header("Retry-After", String(updated.retryAfterSeconds));
throw new ApiError(429, "character_refresh_rate_limited", message);
```

Share start/stop responses remain on their existing compatibility contract and do not include board version metadata because those mutations no longer change either version domain.

- [ ] **Step 5: Run focused tests**

Run: `pnpm test apps/api/src/db/board.test.ts apps/api/src/db/characters.test.ts apps/api/src/routes/board.test.ts apps/api/src/routes/characters.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit complete version coverage**

```bash
git add apps/api/src/db/board.ts apps/api/src/db/board.test.ts apps/api/src/db/characters.ts apps/api/src/db/characters.test.ts apps/api/src/routes/board.ts apps/api/src/routes/characters.ts apps/api/src/routes/board.test.ts apps/api/src/routes/characters.test.ts
git commit -m "Cover all board content version mutations"
```

### Task 4: Gate Owner Reads And Admin Routing On Resolved Sessions

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.ts`
- Modify: `apps/api/src/admin/errorCounters.ts`
- Modify: `apps/api/src/admin/errorCounters.test.ts`

- [ ] **Step 1: Write failing session and accounting tests**

Add an App test that renders checking, anonymous, authenticated, and direct-admin states and inspects the `useBoard` arguments. Required behavior:

```ts
expect(hooks.useBoard).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false })); // checking
expect(hooks.useBoard).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false })); // anonymous
expect(hooks.useBoard).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));  // authenticated board
```

Add an error-counter test asserting `/api/session` + `401` + `unauthorized` creates zero D1 statements, while a board `401`, another session `4xx`, and all `5xx` still record.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/web/src/App.test.ts apps/api/src/admin/errorCounters.test.ts`

Expected: FAIL because anonymous board requests are enabled, direct admin redirects while checking, and expected session 401s are stored.

- [ ] **Step 3: Add resolved-session guards**

Use these conditions in `App.tsx`:

```ts
const isAuthenticated = session.status === "authenticated";
const isBoardEnabled = isAuthenticated && (activeView === "board" || activeView === "shared");
const isBoardPollingEnabled = isAuthenticated && activeView === "board";

useEffect(() => {
  if (activeView !== "admin" || session.status === "checking") return;
  if (!isAdmin) applyAppRoute({ activeView: "board", shareId: null, sheetId: null }, "replace");
}, [activeView, isAdmin, session.status]);
```

The shared-view owner read remains temporarily enabled for legacy sharing UI and is removed by the shared-overview plan.

- [ ] **Step 4: Exclude only the expected anonymous session error**

Add a pure predicate and call it before D1 preparation:

```ts
export function shouldRecordApiError(input: { status: number; code: string; path: string }): boolean {
  return input.status >= 400 && !(input.status === 401 && input.code === "unauthorized" && input.path === "/api/session");
}
```

- [ ] **Step 5: Run tests and commit**

Run: `pnpm test apps/web/src/App.test.ts apps/api/src/admin/errorCounters.test.ts`

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.ts apps/api/src/admin/errorCounters.ts apps/api/src/admin/errorCounters.test.ts
git commit -m "Avoid anonymous board and premature admin work"
```

### Task 5: Collapse And Cache Admin Aggregates

**Files:**
- Create: `apps/api/src/admin/summary.ts`
- Create: `apps/api/src/admin/summary.test.ts`
- Modify: `apps/api/src/routes/admin.ts`
- Modify: `apps/api/src/routes/admin.test.ts`

- [ ] **Step 1: Write failing SQL and identity-isolation tests**

Assert that the completion table occurs once in the user metrics SQL and that two admins inside five minutes receive the same cached metrics but their own identity:

```ts
expect(userMetricsSql.match(/FROM board_cell_completions/g)).toHaveLength(1);
expect(first.admin.id).toBe("admin-a");
expect(second.admin.id).toBe("admin-b");
expect(metricsDbReads).toBe(1);
```

Also assert `Cache-Control: private, no-store` and `Vary: Cookie` on both admin routes.

Add capacity-output assertions that label the estimate as sample-limited and expose fixed admin-query cost separately from per-active-user cost whenever both values are available. Missing Cloudflare data must produce an explicit warning instead of a confident multiplier.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/api/src/admin/summary.test.ts apps/api/src/routes/admin.test.ts`

Expected: FAIL because the helper and aggregate cache do not exist.

- [ ] **Step 3: Implement one completion scan**

Export the SQL constant for direct testing:

```sql
WITH completion_activity AS (
  SELECT
    COUNT(DISTINCT CASE WHEN datetime(updated_at) >= datetime('now','-1 day') THEN user_id END) AS completion_users_24h,
    COUNT(DISTINCT CASE WHEN datetime(updated_at) >= datetime('now','-7 days') THEN user_id END) AS completion_users_7d,
    SUM(CASE WHEN datetime(updated_at) >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS completion_updates_24h,
    SUM(CASE WHEN datetime(updated_at) >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS completion_updates_7d
  FROM board_cell_completions
)
SELECT
  (SELECT COUNT(*) FROM users) AS total_users,
  (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE datetime(expires_at) > CURRENT_TIMESTAMP) AS active_logged_in_users,
  (SELECT COUNT(*) FROM sessions WHERE datetime(expires_at) > CURRENT_TIMESTAMP) AS active_sessions,
  (SELECT COUNT(*) FROM users WHERE datetime(created_at) >= datetime('now','-1 day')) AS users_created_24h,
  (SELECT COUNT(*) FROM users WHERE datetime(created_at) >= datetime('now','-7 days')) AS users_created_7d,
  completion_activity.*
FROM completion_activity
```

- [ ] **Step 4: Cache only user-independent metrics**

Use a module cache keyed by account/database/script configuration with a five-minute expiry and an in-flight promise. The cached value contains users, activity, data, free-plan reference, and Cloudflare usage; it never contains `admin`.

Build capacity output from named components: `fixedAdminReads`, observed end-user reads/writes, active-user sample size, and `uncertaintyReasons`. Do not subtract an estimate when the source counter is unavailable, and do not emit a guaranteed capacity multiplier from a sample-limited window.

The route flow must remain:

```ts
const admin = await requireAdmin(c);
const metrics = await getAdminSummaryMetrics(c.env);
c.header("Cache-Control", "private, no-store");
c.header("Vary", "Cookie");
return c.json({ generatedAt: new Date().toISOString(), admin: { id: admin.id, displayName: admin.displayName }, ...metrics });
```

- [ ] **Step 5: Run tests and commit**

Run: `pnpm test apps/api/src/admin/summary.test.ts apps/api/src/routes/admin.test.ts`

```bash
git add apps/api/src/admin/summary.ts apps/api/src/admin/summary.test.ts apps/api/src/routes/admin.ts apps/api/src/routes/admin.test.ts
git commit -m "Cache admin metrics and collapse completion scans"
```

### Task 6: Resolve Pages Script Metrics And Bound Cloudflare Fetches

**Files:**
- Create: `apps/api/src/http/externalFetch.ts`
- Create: `apps/api/src/http/externalFetch.test.ts`
- Modify: `apps/api/src/admin/cloudflareUsage.ts`
- Create: `apps/api/src/admin/cloudflareUsage.test.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/web/wrangler.jsonc`

- [ ] **Step 1: Write failing fetch and metric-resolution tests**

Cover an eight-second signal, one attempt on timeout, timeout-to-partial-admin-warning behavior, Pages `production_script_name` precedence, configured fallback, and the warning when D1 has traffic but Workers resolves to zero:

```ts
expect(fetchMock).toHaveBeenCalledTimes(1);
expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
expect(summary.workers?.scriptName).toBe("pages-worker-production");
expect(summary.warnings).toContain("Workers 요청 수가 0이지만 D1 사용량이 있습니다. Pages production script 이름을 확인해주세요.");
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/api/src/http/externalFetch.test.ts apps/api/src/admin/cloudflareUsage.test.ts`

Expected: FAIL because the deadline helper and Pages project lookup do not exist.

- [ ] **Step 3: Implement the external fetch deadline**

```ts
export const EXTERNAL_FETCH_TIMEOUT_MS = 8_000;

export function fetchExternal(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetch(input, { ...init, signal });
}
```

Do not add an internal retry.

- [ ] **Step 4: Resolve the Pages production script name**

Add optional `CLOUDFLARE_PAGES_PROJECT_NAME` to `Env`, set it to `riceark` in `apps/web/wrangler.jsonc`, and query:

```text
GET /client/v4/accounts/{accountId}/pages/projects/{projectName}
```

Use `result.production_script_name` when present, then `CLOUDFLARE_WORKER_SCRIPT_NAME`, then return `null`. Route every Cloudflare REST and GraphQL call through `fetchExternal`. Catch each analytics source independently so a timeout or upstream failure appends a warning and preserves the rest of the admin summary; never retry the same external call inside one request.

- [ ] **Step 5: Run tests and full API checks**

Run: `pnpm test apps/api/src/http/externalFetch.test.ts apps/api/src/admin/cloudflareUsage.test.ts apps/api/src/routes/admin.test.ts && pnpm --filter @riceark/api check`

Expected: PASS.

- [ ] **Step 6: Commit metric repair**

```bash
git add apps/api/src/http/externalFetch.ts apps/api/src/http/externalFetch.test.ts apps/api/src/admin/cloudflareUsage.ts apps/api/src/admin/cloudflareUsage.test.ts apps/api/src/env.ts apps/web/wrangler.jsonc
git commit -m "Resolve Pages metrics and bound external fetches"
```

### Task 7: Verify The Foundation Phase

**Files:**
- Modify only if a verification failure exposes a defect in the files above.

- [ ] **Step 1: Run formatting and diff checks**

Run: `git diff --check`

Expected: no output.

- [ ] **Step 2: Run all quality gates**

Run: `pnpm check && pnpm test && pnpm build`

Expected: all workspace type checks pass, all tests pass, and both API dry-run and web production builds complete.

- [ ] **Step 3: Inspect the phase diff and query contracts**

Run:

```bash
git diff --stat main...HEAD
rg -n "RETURNING id, content_version AS version|RETURNING user_id, version" apps/api/src/db
rg -n "window.location.reload|/api/board" apps/web/src/App.tsx apps/web/src/features/board
```

Expected: every board version helper uses `RETURNING`; remaining reloads are catalogued for the write-delivery phase; anonymous board enabling is absent from `App.tsx`.

- [ ] **Step 4: Commit only verification fixes**

If Step 2 required code corrections, stage exactly those files and commit them as `Fix performance foundation verification defects`. If no correction was required, create no empty commit.
