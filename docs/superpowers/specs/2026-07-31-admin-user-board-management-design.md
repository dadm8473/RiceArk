# Admin User Board Management Design

## Goal

Add an administrator-only area that can find a user, open that user's complete RiceArk board, and perform the same edits the owner can perform. Successful administrator mutations are recorded in a compact audit log without storing board content.

The first release supports one configured administrator but must keep authorization correct if more administrators are added later.

## Product Scope

The existing operations dashboard gains two tabs:

- `사용자 보드`: user search, selection, and full board management.
- `관리 기록`: paginated administrator mutation history.

The administrator can perform all owner board operations, including:

- Select, create, rename, reorder, and delete sheets.
- Create, edit, move, resize, lock, transpose, and delete tables.
- Add, edit, reorder, hide, and delete axis items.
- Change checks, checkbox settings, custom icons, and cell memos.
- Create, edit, move, resize, lock, recolor, and delete notes.
- Import, create, refresh, edit, pin, reorder, and delete characters.
- Create, edit, reorder, and delete tasks used by the board.
- Change user-owned board display settings.

Public sharing and favorite actions remain owned by their existing workflows. Authentication, profile, logout, administrator configuration, and patch-note administration are never executed as the selected user.

## User Experience

### User Search

The `사용자 보드` tab opens with a compact management toolbar rather than loading every board.

- Search matches display name and the visible suffix of a user ID.
- Results are paginated at 30 users.
- Each result shows display name, login provider, join date, recent activity date, and a shortened user ID.
- Email addresses and provider-specific account IDs are not returned or displayed.
- Recent activity is the newest available timestamp among recent session creation and user-owned board activity. The API labels unavailable activity explicitly instead of inventing a date.

No board payload is loaded until the administrator selects a user.

### Selected User State

After selection, a persistent context bar shows:

- `관리 중: {display name}`
- Short user ID and provider.
- A control to change or clear the selected user.

The user's sheet tabs and active board render beneath the context bar using the existing owner board UI. The context bar remains visually distinct in light and dark themes so that the administrator never mistakes the target board for their own board.

The selected user is kept in the administrator route state so browser back and forward restore the management context. The route contains only the internal user ID, never email or provider account IDs.

### Audit History

The `관리 기록` tab lists the newest successful administrator mutations first, 50 rows per page.

Each row contains:

- Timestamp.
- Administrator display name and ID.
- Target user display name and ID.
- HTTP method.
- Normalized action name such as `board.completions.update` or `characters.refresh`.

The log does not contain memo text, note content, character profile payloads, OAuth identifiers, cookies, request headers, or request bodies.

## Architecture

### Request-Scoped Targeting

Administrator management uses an explicit request header:

`X-RiceArk-Admin-Target-User: <user-id>`

The header is request-scoped. It never changes the login session and never creates an impersonation cookie.

For user-owned APIs, the server resolves two identities:

- `actor`: the authenticated session user.
- `subject`: the owner of the data being read or changed.

Without the header, `actor` and `subject` are the same, preserving all existing behavior. With the header, the server:

1. Authenticates the session actor.
2. Verifies the actor against the administrator allowlist.
3. Validates the target ID format.
4. Confirms that the target user exists.
5. Uses the target as the subject for the existing database operation.

A non-administrator sending the header receives `403`. A missing target receives `404`. Invalid target syntax receives `400`. These responses use `Cache-Control: private, no-store` and never reveal whether another target exists to a non-administrator.

Target resolution is enabled only for the authenticated user-owned route groups needed by the board editor:

- Board.
- Characters.
- Tasks.
- User board settings.

It is not enabled for:

- Authentication and profile routes.
- Administrator routes.
- Public shared-board routes.
- Patch-note administration.
- Health and usage endpoints.
- Public Lost Ark event data.

### Scoped Frontend API

The frontend creates an API client object bound to an optional target user ID. The target header is added by that object only.

The existing board session, write queues, board editor, character import, task form, and settings actions receive the scoped client through explicit props or options. There is no module-level mutable target and no browser cookie. Unmounting the administrator board destroys the scoped client and its pending board session.

The administrator board has its own `useBoard` instance. Owner-board polling remains disabled while the operations dashboard is active. The administrator board polls only while its management view is visible and a user is selected.

### Reusing Existing Domain Logic

Database functions already accept a `userId`; they continue to do so. Route handlers pass the resolved subject ID instead of duplicating board CRUD logic under a second administrator API tree.

The only new administrator data endpoints are:

- `GET /api/admin/users`
- `GET /api/admin/audit-logs`

Board and related mutations continue to use their existing paths with the request-scoped administrator target header.

## Data Model

Add `admin_audit_logs`:

- `id TEXT PRIMARY KEY`
- `admin_user_id TEXT NOT NULL REFERENCES users(id)`
- `target_user_id TEXT NOT NULL REFERENCES users(id)`
- `method TEXT NOT NULL`
- `action TEXT NOT NULL`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

Indexes:

- `(created_at DESC, id DESC)` for global history.
- `(target_user_id, created_at DESC)` for later target filtering.
- `(admin_user_id, created_at DESC)` for later actor filtering.

The user list query first selects one 30-user page and then derives provider and activity metadata only for those users. Existing ownership indexes are reused; any missing index justified by query plans is added in the same migration.

## Audit Semantics

An audit entry is attempted only when:

- An administrator target header was accepted.
- The method mutates state.
- The route completed with a successful status.

Reads are not logged. Failed and rejected mutations are not shown as successful changes.

Audit insertion is awaited after the mutation response is produced but does not roll back an already committed domain mutation. If audit insertion fails, the mutation response remains successful and the failure is recorded through the existing server error counter and console path. This avoids causing a client retry that might repeat a mutation.

Action names are mapped from normalized route patterns, not raw URLs, so resource IDs are not copied into the audit action field.

## Performance

- User results are limited to 30 and boards load lazily after selection.
- Audit results are limited to 50.
- User searches are debounced and require server pagination.
- No board polling runs when no target is selected or the tab is hidden.
- Selecting a different user disposes the previous board session and pending timers before loading the next one.
- Administrator writes add one small D1 audit row. Ordinary user traffic adds no audit writes.
- Administrator user-list and audit responses use `private, no-store`.

## Security And Privacy

- Server authorization is authoritative; hiding the UI is not treated as security.
- The actor is always derived from the signed session cookie.
- The subject is accepted only after a fresh administrator allowlist check.
- A selected user cannot alter authentication, administrator configuration, or another user's public sharing identity.
- Email and OAuth provider user IDs are excluded from the list response.
- Request bodies and content fields are excluded from audit logs.
- The UI prominently identifies the selected subject during every edit.

## Error Handling

- User-list failures leave the operations metrics tabs usable.
- Board-load failures keep the selected user visible and provide retry and clear-selection actions.
- Changing users waits for or explicitly discards pending administrator board writes through the existing reliable write-queue lifecycle.
- If a user is deleted between list and selection, the board request returns `404` and the UI offers to return to search.
- Authorization expiry or allowlist removal immediately disables subsequent scoped requests.

## Testing

### API

- Administrator user list is paginated, searchable, privacy-safe, and `no-store`.
- Non-administrators cannot list users or audit logs.
- A normal user-owned request still resolves the session user.
- A valid administrator target resolves the selected subject for reads and every mutation route group.
- A non-administrator target header is rejected before target existence is disclosed.
- Authentication, administrator, shared, and public routes ignore or reject target scoping as designed.
- Successful administrator mutations create content-free audit rows.
- Failed mutations and reads do not create audit rows.
- Audit insertion failure does not convert a committed mutation into a retryable response.

### Web

- The operations dashboard exposes `사용자 보드` and `관리 기록`.
- Search results render only approved identity fields.
- Selecting a user creates a scoped board client and displays the management context bar.
- Clearing or changing the user disposes the previous board session.
- Existing board editing requests receive the target header in administrator mode.
- Owner board requests never receive the target header.
- Loading, empty, error, pagination, light-theme, dark-theme, desktop, and mobile states render without overlap.

### Regression

- Existing owner board editing and reliable queues continue to pass unchanged behavior tests.
- Shared board viewing remains read-only and does not receive administrator targeting.
- All API authorization and administrator summary tests continue to pass.

## Acceptance Criteria

The feature is complete when an allowlisted administrator can search for a user, open any of that user's sheets, perform every existing owner board edit, observe the result after reload, and find a content-free record of each successful mutation in `관리 기록`. A normal user cannot select or infer another user through the same request mechanism, and ordinary user traffic incurs no new audit writes.
