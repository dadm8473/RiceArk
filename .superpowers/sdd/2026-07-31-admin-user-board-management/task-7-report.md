# Task 7 Report: User Board And Audit Management UI

## Status

Implemented the administrator user-board and audit management tabs, integrated them with the routed admin dashboard, verified the final source, and prepared the Task 7 commit.

## UI States

### User Board Management

- 300 ms debounced search by display name or user ID suffix.
- Initial loading, empty results, request error, retry, pagination loading, and next-page states.
- Privacy-limited user cards showing display name, provider, ID suffix, joined time, and recent activity only.
- Direct-URL selected-user loading, missing-user, error, retry, and recovery states.
- Persistent selected-user context with a clear `관리 중:` label and `다른 사용자 선택` action.
- Selected-user-only `useBoard` child; no administrator board session mounts before selection.
- Scoped `ApiClient` shared by `useBoard` and `BoardOverview`.
- Full-width editable `BoardOverview` with routed sheet selection.
- Subject-change mutation drain plus pending queue flush. Failed flushes expose retry, explicit discard, and return-to-board actions before the route can clear the subject.
- Board loading, board error/retry, and pending-write error states.

### Audit Management

- Initial loading, empty, error/retry, refresh, pagination loading, and next-page states.
- Content-free rows limited to time, administrator, target user, normalized action, and method.
- Fixed Korean labels for the four required actions; unknown actions render their normalized string once.
- Icon-only refresh control with `aria-label` and `title`.
- Long names and ID suffixes remain constrained; mobile tables scroll inside their own wrapper.

### Layout And Theme

- User-board mode removes the dashboard width cap and keeps the board full width.
- Search, selected-user context, and audit controls use unframed toolbar/context bands.
- Cards are used only for repeated user results in the new UI.
- Explicit light/dark styles cover user results, context, audit rows, and loading/empty/error states.
- Mobile user metadata and controls stack above the board.

## TDD Evidence

### RED

Initial focused run:

```text
pnpm vitest run apps/web/src/features/admin/AdminUserBoardsTab.test.ts apps/web/src/features/admin/AdminAuditTab.test.ts apps/web/src/features/admin/AdminDashboard.test.ts
Test Files: 3 failed
```

- `AdminUserBoardsTab.test.ts` and `AdminAuditTab.test.ts` failed because the modules did not exist.
- `AdminDashboard.test.ts` failed because the routed user-board and audit tabs rendered no content.
- Additional focused RED cycles covered a missing direct-URL user, duplicate unknown audit actions, pagination during refresh, and tab-specific privacy copy.

### GREEN

Final focused run:

```text
Test Files: 3 passed
Tests: 25 passed
```

## Files

Created:

- `apps/web/src/features/admin/AdminUserBoardsTab.tsx`
- `apps/web/src/features/admin/AdminUserBoardsTab.test.ts`
- `apps/web/src/features/admin/AdminAuditTab.tsx`
- `apps/web/src/features/admin/AdminAuditTab.test.ts`

Modified:

- `apps/web/src/features/admin/AdminDashboard.tsx`
- `apps/web/src/features/admin/AdminDashboard.test.ts`
- `apps/web/src/features/admin/types.ts`
- `apps/web/src/styles.css`

## Verification

Final commands on the committed source candidate:

```text
pnpm check
PASS: core, API, and web TypeScript checks

pnpm test
PASS: 69 test files, 1,222 tests

pnpm test:d1-sql
PASS: board bulk SQL verified: cells=2, completed=2, version=1

pnpm --filter @riceark/api build
PASS: Wrangler dry-run build

pnpm --filter @riceark/web build
PASS: Vite production build, 1,675 modules transformed

git diff --check
PASS
```

The full test run prints expected error logs from existing negative-path API tests; all suites exit successfully.

## Visual QA

Used the local Vite app with mocked authenticated administrator/session and API responses.

- Desktop `1440x900`, light and dark: search results, selected context, board tabs/editor, and audit table remained contained with long names and IDs.
- Selected board measured `1400px` within the `1440px` viewport; the document did not overflow.
- Desktop audit table measured `1120px` client/scroll width with no page overflow.
- Mobile `390x844`, light and dark: user cards and context controls stacked; result cards had equal client/scroll widths; the document remained within the viewport.
- Mobile audit data measured `794px` inside a `366px` scroll wrapper while the document remained `390px` wide.
- Browser console inspection returned no warnings or errors.
- Request traces showed admin user/audit calls with no target header, selected-board calls with only the selected user ID, and owner-board calls with `target=none`.

Limitations:

- Live OAuth and a real authenticated administrator session were not available. Controller follow-up should repeat the desktop/mobile light/dark pass with real authentication.
- The simplified mock board had a stale reset-period fingerprint, so it exercised the selected-board error/retry state while still rendering the board editor. Controller follow-up should confirm the clean loaded-board state against real board data.

## Self-Review

- Fixed duplicate rendering of unknown audit actions found during desktop QA.
- Disabled pagination/refresh controls during competing loads.
- Updated shared admin header copy so user and audit tabs do not claim to contain aggregate metrics only.
- Removed an unrelated mobile workspace padding override.
- No unresolved code findings remain. The remaining concerns are limited to live-authenticated visual follow-up.

## Fix Round 1/5

### Resolved Findings

- Added an `App`-owned route guard for a selected administrator board. User A remains mounted while its mutation barrier drains and its pending-write queue flushes.
- Routed A-to-B, A-to-no-subject, users-tab exits, top-level view exits, and browser `popstate` through the same guard.
- Kept retry, explicit discard, and cancel behavior in the selected-user child. Navigation proceeds only after flush/retry/discard succeeds; cancel keeps the current route.
- Preserved immutable scoped clients. A route change cannot mount the replacement subject until the current subject's guard resolves.
- Stored the failed `{ cursor, append }` request independently in both user and audit pagination. Retry now requests that exact page, so later-page failures retain accumulated rows.
- Left the deferred ARIA tab-semantics finding unchanged as requested.

### RED

Command:

```text
pnpm vitest run apps/web/src/App.test.ts apps/web/src/features/admin/AdminUserBoardsTab.test.ts apps/web/src/features/admin/AdminAuditTab.test.ts apps/web/src/features/admin/AdminDashboard.test.ts
```

Output:

```text
Test Files  3 failed | 1 passed (4)
Tests       7 failed | 79 passed (86)
Exit code   1
```

The new failures covered missing A-to-B, A-to-null, users-tab, and `popstate` guards; missing exact user/audit pagination retry helpers; and missing selected-child guard registration.

### GREEN

Command:

```text
pnpm vitest run apps/web/src/App.test.ts apps/web/src/features/admin/AdminUserBoardsTab.test.ts apps/web/src/features/admin/AdminAuditTab.test.ts apps/web/src/features/admin/AdminDashboard.test.ts
```

Output:

```text
✓ apps/web/src/features/admin/AdminAuditTab.test.ts (6 tests)
✓ apps/web/src/features/admin/AdminUserBoardsTab.test.ts (9 tests)
✓ apps/web/src/features/admin/AdminDashboard.test.ts (12 tests)
✓ apps/web/src/App.test.ts (60 tests)

Test Files  4 passed (4)
Tests       87 passed (87)
Exit code   0
```

Command:

```text
pnpm check
```

Output:

```text
Scope: 3 of 4 workspace projects
packages/core check$ tsc -p tsconfig.json --noEmit
packages/core check: Done
apps/api check$ tsc -p tsconfig.json --noEmit
apps/api check: Done
apps/web check$ tsc -p tsconfig.json --noEmit
apps/web check: Done
Exit code 0
```

### Files

- `apps/web/src/App.tsx`
- `apps/web/src/App.test.ts`
- `apps/web/src/features/admin/AdminDashboard.tsx`
- `apps/web/src/features/admin/AdminUserBoardsTab.tsx`
- `apps/web/src/features/admin/AdminUserBoardsTab.test.ts`
- `apps/web/src/features/admin/AdminAuditTab.tsx`
- `apps/web/src/features/admin/AdminAuditTab.test.ts`
- `apps/web/src/features/admin/types.ts`
- `.superpowers/sdd/2026-07-31-admin-user-board-management/task-7-report.md`

### Visual QA

No layout or styling was changed in this round. Authenticated visual QA was not repeated; the existing Task 7 mock-auth desktop/mobile evidence and its live-authentication limitation still apply. Controller follow-up should verify the blocked flush prompt while navigating by tab, subject route, and browser history in a real authenticated administrator session.

### Concerns And Self-Review

- Overlapping guarded exits share the selected child lifecycle and use the latest guarded destination.
- Reselecting a route that does not change the current subject does not supersede an in-flight guarded exit.
- A canceled `popstate` restores the current administrator route URL.
- Exact-page retries preserve `append: true`, so existing user cards and audit rows are merged rather than replaced.
- The deferred ARIA tab-semantics minor remains open for final review by instruction.

## Fix Round 2/5

### Resolved Regression

- Every `requestAppRoute` call now advances the route request sequence, including an unguarded request that keeps the current selected subject.
- This corrects the round 1 self-review claim that a same-subject route should not supersede an in-flight exit; browser Forward must supersede it.
- `App` tracks the guard serving the active route request. A newer unguarded route explicitly supersedes that guard before applying its route.
- A delayed stale route callback checks its request sequence and cannot mutate route state after a newer Back/Forward request.
- The selected-user guard now exposes `supersede()`. If its drain/flush is still running, user A stays write-locked until that work settles and then unlocks without navigating. If the transition is already blocked, supersession unlocks and resolves it immediately.
- A superseded transition failure is treated as an abandoned navigation rather than reopening the route-change recovery prompt.
- The pending `popstate` restoration marker is cleared when the newer unguarded Forward route takes ownership of the URL.

### RED

Exact delayed Back-to-Forward reproduction:

```text
pnpm vitest run apps/web/src/App.test.ts

Test Files  1 failed (1)
Tests       1 failed | 60 passed (61)
Exit code   1
```

Failure:

```text
App > keeps user A mounted when Forward supersedes a delayed guarded Back to user B
expected "spy" to be called once, but got 0 times
```

Combined route and selected-user unlock RED:

```text
pnpm vitest run apps/web/src/App.test.ts apps/web/src/features/admin/AdminUserBoardsTab.test.ts

Test Files  2 failed (2)
Tests       2 failed | 69 passed (71)
Exit code   1
```

Failures:

```text
App > keeps user A mounted when Forward supersedes a delayed guarded Back to user B
AdminUserBoardsTab > unlocks user A only after a superseded in-flight transition settles
```

### GREEN

Focused App/admin command:

```text
pnpm vitest run apps/web/src/App.test.ts apps/web/src/features/admin/AdminUserBoardsTab.test.ts apps/web/src/features/admin/AdminAuditTab.test.ts apps/web/src/features/admin/AdminDashboard.test.ts
```

Output:

```text
✓ apps/web/src/features/admin/AdminAuditTab.test.ts (6 tests)
✓ apps/web/src/features/admin/AdminUserBoardsTab.test.ts (10 tests)
✓ apps/web/src/features/admin/AdminDashboard.test.ts (12 tests)
✓ apps/web/src/App.test.ts (61 tests)

Test Files  4 passed (4)
Tests       89 passed (89)
Exit code   0
```

Workspace check command:

```text
pnpm check
```

Output:

```text
Scope: 3 of 4 workspace projects
packages/core check$ tsc -p tsconfig.json --noEmit
packages/core check: Done
apps/api check$ tsc -p tsconfig.json --noEmit
apps/api check: Done
apps/web check$ tsc -p tsconfig.json --noEmit
apps/web check: Done
Exit code 0
```

### Files

- `apps/web/src/App.tsx`
- `apps/web/src/App.test.ts`
- `apps/web/src/features/admin/AdminUserBoardsTab.tsx`
- `apps/web/src/features/admin/AdminUserBoardsTab.test.ts`
- `apps/web/src/features/admin/types.ts`
- `.superpowers/sdd/2026-07-31-admin-user-board-management/task-7-report.md`

### Visual QA And Concerns

- This round changes route arbitration and pending-write lifecycle only; no layout or style code changed.
- Authenticated visual QA was not repeated. Controller follow-up should exercise rapid Back-to-Forward navigation with a real delayed board write.
- The deferred ARIA tab-semantics minor remains untouched.

## Fix Round 3/5

### Resolved Remaining Invariant

- Replaced the selected-user guard's disconnected navigation refs with a production `AdminSubjectNavigationController` that owns one pending route promise and one in-flight subject transition.
- Every guarded claimant clears the superseded marker before checking for an existing request. A third B or C route can therefore reclaim the same delayed drain after Forward temporarily supersedes it.
- Reclaimed requests receive the original pending promise and do not start another mutation drain or queue flush.
- `App` request IDs still decide which promise callback may apply route state. Earlier B callbacks stay stale; only the latest B/C callback can update the UI.
- If A remains latest, the controller resolves false and unlocks after the transition settles. If B/C becomes latest, it resolves true, stays locked through route application, and releases exactly once when the selected subject unmounts.
- Transition failures remain recoverable: an active latest route keeps the retry/discard prompt, while an abandoned route unlocks without reviving stale navigation.

### Behavioral Coverage

- `A -> B`, `-> A`, `-> B` before one delayed flush settles: final UI user is B and URL is B.
- `A -> B`, `-> A`, `-> C` before the same delayed flush settles: final UI user is C and URL is C.
- Both sequences assert one transition start, no early unlock, and no stale A/B route mutation.
- Controller coverage asserts the reclaimed request is the same promise, starts no duplicate flush, and unlocks exactly once on final release.

### RED

Command:

```text
pnpm vitest run apps/web/src/App.test.ts apps/web/src/features/admin/AdminUserBoardsTab.test.ts
```

Output:

```text
Test Files  2 failed (2)
Tests       3 failed | 71 passed (74)
Exit code   1
```

Failures:

```text
App > applies latest route user-b when it reclaims the same delayed subject flush
App > applies latest route user-c when it reclaims the same delayed subject flush
AdminUserBoardsTab > reclaims one delayed transition for the latest guarded route without another flush
```

### GREEN

Focused App/admin command:

```text
pnpm vitest run apps/web/src/App.test.ts apps/web/src/features/admin/AdminUserBoardsTab.test.ts apps/web/src/features/admin/AdminAuditTab.test.ts apps/web/src/features/admin/AdminDashboard.test.ts
```

Output:

```text
✓ apps/web/src/features/admin/AdminAuditTab.test.ts (6 tests)
✓ apps/web/src/features/admin/AdminUserBoardsTab.test.ts (11 tests)
✓ apps/web/src/features/admin/AdminDashboard.test.ts (12 tests)
✓ apps/web/src/App.test.ts (63 tests)

Test Files  4 passed (4)
Tests       92 passed (92)
Exit code   0
```

Workspace check command:

```text
pnpm check
```

Output:

```text
Scope: 3 of 4 workspace projects
packages/core check$ tsc -p tsconfig.json --noEmit
packages/core check: Done
apps/api check$ tsc -p tsconfig.json --noEmit
apps/api check: Done
apps/web check$ tsc -p tsconfig.json --noEmit
apps/web check: Done
Exit code 0
```

### Files

- `apps/web/src/App.test.ts`
- `apps/web/src/features/admin/AdminUserBoardsTab.tsx`
- `apps/web/src/features/admin/AdminUserBoardsTab.test.ts`
- `.superpowers/sdd/2026-07-31-admin-user-board-management/task-7-report.md`

### Visual QA And Concerns

- No layout, styling, or visible copy changed in round 3.
- Authenticated visual QA was not repeated. Controller follow-up should exercise B/A/B and B/A/C browser-history sequences against a genuinely delayed write.
- The deferred ARIA tab-semantics minor remains untouched.
