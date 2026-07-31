# Task 5 Report: Scoped Web API And Reusable Board Dependencies

## Status

Complete.

Commit message: `Add scoped API clients for admin boards`

## RED Evidence

Command:

```bash
pnpm vitest run apps/web/src/api/client.test.ts apps/web/src/features/board/useBoard.test.ts apps/web/src/features/board/BoardOverview.test.ts apps/web/src/features/characters/CharacterImport.test.ts apps/web/src/features/tasks/TaskForm.test.ts
```

Observed exit code: `1`.

```text
Test Files  5 failed (5)
Tests  11 failed | 224 passed (235)
```

The expected failures covered missing `createApiClient` and scoped headers, absent `apiClient` props, missing `useBoard` read/write wiring, direct BoardOverview named API calls, child character/task mutations, and the public Lost Ark read not naming `defaultApiClient`.

## GREEN Evidence

The same focused command passed after implementation:

```text
Test Files  5 passed (5)
Tests  235 passed (235)
```

## Propagation Inventory

- `createApiClient` captures an optional administrator target by value, freezes the returned client, and constructs fresh request headers for `get`, `post`, `postNoContent`, `patch`, and `delete`.
- `defaultApiClient` is untargeted. Existing `apiGet`, `apiPost`, `apiPostNoContent`, `apiPatch`, and `apiDelete` exports delegate to it.
- `useBoard` passes `apiClient.get` to bootstrap, sheet, and version reads through `createBoardDataApi`.
- `useBoard` passes the same `apiClient.patch` to the write coordinator, which supplies both the reliable completion queue and reliable cell-state queue.
- `BoardOverview` uses its injected client for sheet CRUD; table create, update, delete, transpose, lock, and layout; note CRUD and layout; axis item create, update, size, delete, and order; and character save, refresh, and batch refresh.
- `BoardTableToolModal` forwards the client to `CharacterImport`, `TaskForm`, and completion-column creation.
- `CharacterImport` uses the injected client for character search, roster import, and manual creation.
- `TaskForm` uses the injected client for task creation.
- Public Lost Ark event schedule reads explicitly use `defaultApiClient`, so administrator targeting is never sent to that endpoint.

## Files Changed

- `apps/web/src/api/client.ts`
- `apps/web/src/api/client.test.ts`
- `apps/web/src/features/board/useBoard.ts`
- `apps/web/src/features/board/useBoard.test.ts`
- `apps/web/src/features/board/BoardOverview.tsx`
- `apps/web/src/features/board/BoardOverview.test.ts`
- `apps/web/src/features/characters/CharacterImport.tsx`
- `apps/web/src/features/characters/CharacterImport.test.ts`
- `apps/web/src/features/tasks/TaskForm.tsx`
- `apps/web/src/features/tasks/TaskForm.test.ts`
- `.superpowers/sdd/2026-07-31-admin-user-board-management/task-5-report.md`

## Verification

Web TypeScript check:

```bash
pnpm --filter @riceark/web check
```

Observed exit code: `0`.

Full suite, run once:

```bash
pnpm test
```

Observed exit code: `0`.

```text
Test Files  67 passed (67)
Tests  1202 passed (1202)
```

The suite emitted expected stderr from existing failure-path tests.

## Self-Review

- Confirmed no module-level mutable target state, cookie-based target storage, or mutable client target setter exists.
- Confirmed every request creates a new `Headers` instance and only scoped clients add `X-RiceArk-Admin-Target-User`.
- Confirmed the target is copied from the options object and the returned API client is frozen.
- Confirmed named API export compatibility and optional-prop defaults preserve all existing callers.
- Confirmed no `apiGet`, `apiPost`, `apiPatch`, or `apiDelete` call remains in the listed board and form components.
- Confirmed public Lost Ark event reads cannot inherit the injected targeted client.
- Confirmed `git diff --check` reports no whitespace errors.

## Concerns

Root `pnpm check` exits `2` before reaching the web package because the existing `apps/api/src/routes/admin.test.ts:172` passes `statements: string[] | undefined` to an exact optional `statements?: string[]` property. The same line is present unchanged in `HEAD` (`dba8594`), so it was not modified in Task 5. The scoped web check passes.
