# Admin User Board Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an allowlisted administrator search users, fully manage a selected user's board, and review content-free audit records of successful administrator mutations.

**Architecture:** Keep the signed-in administrator as the actor and attach an explicit target user to a scoped API client. Target-aware server routes resolve the selected user only after a fresh administrator check, then reuse the existing user-ID-based database functions. A root response middleware records successful targeted mutations without making an audit failure retry the domain mutation.

**Tech Stack:** TypeScript, Hono, Cloudflare D1/Pages Functions, React 19, Vitest, Vite, pnpm.

## Global Constraints

- The target header is exactly `X-RiceArk-Admin-Target-User`.
- Targeting is enabled only for board, character, task, and user board settings routes.
- Authentication, profile, administrator, public sharing, patch-note administration, health, usage, and public Lost Ark event routes never execute as the selected user.
- User pages contain at most 30 rows; audit pages contain at most 50 rows.
- User responses exclude email and provider-specific user IDs.
- Audit rows exclude request bodies, memo text, note content, headers, cookies, and OAuth identifiers.
- Ordinary user requests create no audit rows and perform no extra administrator authorization reads.
- No new runtime dependency is added.

---

### Task 1: Audit Storage And Data Access

**Files:**
- Create: `apps/api/migrations/0028_admin_user_board_management.sql`
- Create: `apps/api/src/admin/userBoardManagement.ts`
- Create: `apps/api/src/admin/userBoardManagement.test.ts`
- Modify: `apps/api/src/db/schema.test.ts`

**Interfaces:**
- Produces:
  - `type AdminAuditAction`
  - `recordAdminAuditLog(env, entry): Promise<void>`
  - `listAdminAuditLogs(env, cursor?): Promise<AdminAuditLogPage>`
  - `listAdminUsers(env, query): Promise<AdminUserPage>`
  - `findAdminUserSummary(env, userId): Promise<AdminUserSummary | null>`

- [ ] **Step 1: Write failing schema and data-access tests**

```ts
it("defines content-free administrator audit storage", () => {
  expect(migration).toContain("CREATE TABLE admin_audit_logs");
  expect(migration).toContain("admin_user_id TEXT NOT NULL");
  expect(migration).toContain("target_user_id TEXT NOT NULL");
  expect(migration).not.toMatch(/\b(body|payload|memo|content)\b/i);
});

it("records only actor, subject, method, action, and timestamp", async () => {
  await recordAdminAuditLog(env, {
    adminUserId: "admin-1",
    targetUserId: "user-1",
    method: "PATCH",
    action: "board.completions.update"
  });
  expect(boundValues).toEqual([
    expect.any(String),
    "admin-1",
    "user-1",
    "PATCH",
    "board.completions.update"
  ]);
});

it("limits user and audit pages at their fixed bounds", async () => {
  await listAdminUsers(env, { search: "rice", cursor: null });
  await listAdminAuditLogs(env, null);
  expect(sqlText).toContain("LIMIT 31");
  expect(sqlText).toContain("LIMIT 51");
});
```

- [ ] **Step 2: Run tests and confirm the missing migration/module failures**

Run:

```bash
pnpm vitest run apps/api/src/admin/userBoardManagement.test.ts apps/api/src/db/schema.test.ts
```

Expected: FAIL because migration `0028` and `userBoardManagement.ts` do not exist.

- [ ] **Step 3: Add the migration**

```sql
CREATE TABLE admin_audit_logs (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_admin_audit_logs_created
  ON admin_audit_logs(created_at DESC, id DESC);
CREATE INDEX idx_admin_audit_logs_target
  ON admin_audit_logs(target_user_id, created_at DESC);
CREATE INDEX idx_admin_audit_logs_admin
  ON admin_audit_logs(admin_user_id, created_at DESC);
```

- [ ] **Step 4: Implement bounded user and audit access**

Use opaque keyset cursors containing the ordered tuple rather than offsets:

```ts
export interface AdminUserSummary {
  id: string;
  displayName: string;
  provider: "discord" | "google" | string;
  createdAt: string;
  recentActivityAt: string | null;
}

export interface AdminUserPage {
  users: AdminUserSummary[];
  nextCursor: string | null;
}

export interface AdminAuditLogPage {
  logs: Array<{
    id: string;
    adminUserId: string;
    adminDisplayName: string;
    targetUserId: string;
    targetDisplayName: string;
    method: string;
    action: string;
    createdAt: string;
  }>;
  nextCursor: string | null;
}
```

Select the 30-user page before correlated provider/activity lookups. Derive recent activity from the newest session creation, completion update, sheet update, character update, or task update for only those page users. Return provider names but never provider IDs or email.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm vitest run apps/api/src/admin/userBoardManagement.test.ts apps/api/src/db/schema.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/0028_admin_user_board_management.sql apps/api/src/admin/userBoardManagement.ts apps/api/src/admin/userBoardManagement.test.ts apps/api/src/db/schema.test.ts
git commit -m "Add admin board management audit storage"
```

---

### Task 2: Request-Scoped Actor And Subject Resolution

**Files:**
- Create: `apps/api/src/auth/userAccess.ts`
- Create: `apps/api/src/auth/userAccess.test.ts`
- Modify: `apps/api/src/auth/user.ts`
- Modify: `apps/api/src/auth/admin.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/index.test.ts`

**Interfaces:**
- Consumes: `recordAdminAuditLog`
- Produces:
  - `ADMIN_TARGET_USER_HEADER`
  - `type UserAccess = { actor; subject; targeted }`
  - `requireUserAccess(c, { allowAdminTarget }): Promise<UserAccess>`
  - `requireSubjectUser(c, { allowAdminTarget }): Promise<AuthenticatedUser>`
  - Hono variable `adminTargetAccess`
  - `getAdminAuditAction(method, path): AdminAuditAction | null`

- [ ] **Step 1: Write authorization tests**

```ts
it("keeps actor and subject equal without a target header", async () => {
  const access = await requireUserAccess(context(), { allowAdminTarget: true });
  expect(access).toMatchObject({
    actor: { id: "admin-1" },
    subject: { id: "admin-1" },
    targeted: false
  });
});

it("resolves an existing target only for an allowlisted actor", async () => {
  const access = await requireUserAccess(
    context({ "X-RiceArk-Admin-Target-User": "user-2" }),
    { allowAdminTarget: true }
  );
  expect(access).toMatchObject({
    actor: { id: "admin-1" },
    subject: { id: "user-2" },
    targeted: true
  });
});

it("rejects targeting before disclosing whether the subject exists", async () => {
  await expect(
    requireUserAccess(nonAdminContext({ "X-RiceArk-Admin-Target-User": "missing" }), {
      allowAdminTarget: true
    })
  ).rejects.toMatchObject({ status: 403, code: "forbidden" });
});

it("rejects the target header on a route that did not opt in", async () => {
  await expect(
    requireUserAccess(context({ "X-RiceArk-Admin-Target-User": "user-2" }), {
      allowAdminTarget: false
    })
  ).rejects.toMatchObject({ status: 403, code: "admin_target_not_allowed" });
});
```

- [ ] **Step 2: Run tests and confirm missing resolver failures**

Run:

```bash
pnpm vitest run apps/api/src/auth/userAccess.test.ts apps/api/src/index.test.ts
```

Expected: FAIL because the access resolver and audit response middleware do not exist.

- [ ] **Step 3: Split session authentication from subject resolution**

Keep `requireUser(c)` as the session-only compatibility path. Add:

```ts
export const ADMIN_TARGET_USER_HEADER = "X-RiceArk-Admin-Target-User";

export async function requireUserAccess(
  c: AppContext,
  options: { allowAdminTarget: boolean }
): Promise<UserAccess>;

export async function requireSubjectUser(
  c: AppContext,
  options: { allowAdminTarget: boolean }
): Promise<AuthenticatedUser> {
  return (await requireUserAccess(c, options)).subject;
}
```

`requireAdmin` must always validate the actor returned by session-only `requireUser`, never a selected subject.

- [ ] **Step 4: Add successful-mutation audit middleware**

After `await next()`:

```ts
const access = c.get("adminTargetAccess");
const action = getAdminAuditAction(c.req.method, c.req.path);
if (access?.targeted && action && c.res.status >= 200 && c.res.status < 300) {
  try {
    await recordAdminAuditLog(c.env, {
      adminUserId: access.actor.id,
      targetUserId: access.subject.id,
      method: c.req.method,
      action
    });
  } catch (error) {
    console.error("Failed to record administrator audit log", error);
    await recordApiError(c.env, {
      status: 500,
      code: "admin_audit_write_failed",
      path: "/api/admin/audit-logs"
    }).catch(() => undefined);
  }
}
```

Map only mutating board, character, task, and settings route patterns. Return `null` for GET/HEAD/OPTIONS, auth, admin, shared, patch-note, and event routes.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm vitest run apps/api/src/auth/userAccess.test.ts apps/api/src/index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth/userAccess.ts apps/api/src/auth/userAccess.test.ts apps/api/src/auth/user.ts apps/api/src/auth/admin.ts apps/api/src/index.ts apps/api/src/env.ts apps/api/src/index.test.ts
git commit -m "Resolve admin board targets per request"
```

---

### Task 3: Apply Targeting To Existing User-Owned Routes

**Files:**
- Modify: `apps/api/src/routes/board.ts`
- Modify: `apps/api/src/routes/characters.ts`
- Modify: `apps/api/src/routes/tasks.ts`
- Modify: `apps/api/src/routes/settings.ts`
- Modify: `apps/api/src/routes/board.test.ts`
- Modify: `apps/api/src/routes/characters.test.ts`
- Modify: `apps/api/src/routes/tasks.test.ts`
- Modify: `apps/api/src/routes/settings.test.ts`

**Interfaces:**
- Consumes: `requireSubjectUser(c, { allowAdminTarget: true })`
- Produces: Existing API responses, now keyed to the selected subject for opted-in requests.

- [ ] **Step 1: Add route-level failing tests**

For each route group, make the session resolve `admin-1`, send the target header for `user-2`, and assert database bindings use `user-2`:

```ts
const response = await app.request("/api/board/bootstrap", {
  headers: {
    cookie: "riceark_session=admin-session",
    "X-RiceArk-Admin-Target-User": "user-2"
  }
}, env);

expect(response.status).toBe(200);
expect(boardUserBindings).toContain("user-2");
expect(boardUserBindings).not.toContain("admin-1");
```

Add equivalent mutation coverage for board, character, task, and settings routes. Add explicit tests proving profile, board sharing, shared favorites, and character search rate limiting remain actor-owned or reject targeting.

- [ ] **Step 2: Run tests and verify they fail on actor-owned bindings**

Run:

```bash
pnpm vitest run apps/api/src/routes/board.test.ts apps/api/src/routes/characters.test.ts apps/api/src/routes/tasks.test.ts apps/api/src/routes/settings.test.ts
```

Expected: FAIL because routes still call session-only `requireUser`.

- [ ] **Step 3: Replace user resolution only on approved endpoints**

Use:

```ts
const user = await requireSubjectUser(c, { allowAdminTarget: true });
```

for private board CRUD and completion routes, character CRUD/import/refresh routes, task CRUD routes, and settings update routes.

Keep:

```ts
const user = await requireUser(c);
```

for character search rate limits and board share/favorite ownership. Public event endpoints require neither subject targeting nor a target-dependent query.

- [ ] **Step 4: Run target route tests**

Run:

```bash
pnpm vitest run apps/api/src/routes/board.test.ts apps/api/src/routes/characters.test.ts apps/api/src/routes/tasks.test.ts apps/api/src/routes/settings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/board.ts apps/api/src/routes/characters.ts apps/api/src/routes/tasks.ts apps/api/src/routes/settings.ts apps/api/src/routes/board.test.ts apps/api/src/routes/characters.test.ts apps/api/src/routes/tasks.test.ts apps/api/src/routes/settings.test.ts
git commit -m "Allow admins to manage targeted user data"
```

---

### Task 4: Administrator User And Audit Endpoints

**Files:**
- Modify: `apps/api/src/routes/admin.ts`
- Modify: `apps/api/src/routes/admin.test.ts`

**Interfaces:**
- Consumes: `listAdminUsers`, `findAdminUserSummary`, `listAdminAuditLogs`
- Produces:
  - `GET /api/admin/users?search=&cursor=&selectedUserId=`
  - `GET /api/admin/audit-logs?cursor=`

- [ ] **Step 1: Write failing endpoint tests**

```ts
it("returns a privacy-safe user page and direct selected summary", async () => {
  const response = await adminRequest(
    "/api/admin/users?search=rice&selectedUserId=user-2"
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  await expect(response.json()).resolves.toEqual({
    users: expect.any(Array),
    nextCursor: null,
    selectedUser: expect.objectContaining({
      id: "user-2",
      displayName: "Rice"
    })
  });
  expect(await response.clone().text()).not.toMatch(/email|providerUserId/i);
});

it("returns fifty newest content-free audit records", async () => {
  const response = await adminRequest("/api/admin/audit-logs");
  expect(response.status).toBe(200);
  expect(await response.text()).not.toMatch(/memo|body|payload|content/i);
});
```

- [ ] **Step 2: Run endpoint tests and confirm 404 failures**

Run:

```bash
pnpm vitest run apps/api/src/routes/admin.test.ts
```

Expected: FAIL because both endpoints are missing.

- [ ] **Step 3: Implement validated endpoints**

Use Zod query validation:

```ts
const adminUsersQuerySchema = z.object({
  search: z.string().trim().max(80).default(""),
  cursor: z.string().max(512).optional(),
  selectedUserId: z.string().uuid().optional()
});

const adminAuditQuerySchema = z.object({
  cursor: z.string().max(512).optional()
});
```

Call `requireAdmin(c)` before parsing or querying target-specific data. Set `Cache-Control: private, no-store` and `Vary: Cookie`.

- [ ] **Step 4: Run administrator endpoint tests**

Run:

```bash
pnpm vitest run apps/api/src/routes/admin.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin.ts apps/api/src/routes/admin.test.ts
git commit -m "Expose admin users and audit history"
```

---

### Task 5: Scoped Web API And Reusable Board Dependencies

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/src/features/board/useBoard.ts`
- Modify: `apps/web/src/features/board/useBoard.test.ts`
- Modify: `apps/web/src/features/board/BoardOverview.tsx`
- Modify: `apps/web/src/features/board/BoardOverview.test.ts`
- Modify: `apps/web/src/features/characters/CharacterImport.tsx`
- Modify: `apps/web/src/features/characters/CharacterImport.test.ts`
- Modify: `apps/web/src/features/tasks/TaskForm.tsx`
- Modify: `apps/web/src/features/tasks/TaskForm.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  postNoContent(path: string): Promise<void>;
  patch<T>(path: string, body: unknown, options?: ApiRequestOptions): Promise<T>;
  delete(path: string): Promise<void>;
}

export function createApiClient(options?: {
  adminTargetUserId?: string;
}): ApiClient;

export const defaultApiClient: ApiClient;
```

- `useBoard` option `apiClient?: ApiClient`
- `BoardOverview` prop `apiClient?: ApiClient`
- `CharacterImport` and `TaskForm` prop `apiClient?: ApiClient`

- [ ] **Step 1: Write scoped-client and dependency-injection tests**

```ts
it("adds the admin target only to the scoped client", async () => {
  const scoped = createApiClient({ adminTargetUserId: "user-2" });
  await scoped.get("/api/board/bootstrap");
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/board/bootstrap",
    expect.objectContaining({
      headers: expect.objectContaining({
        "X-RiceArk-Admin-Target-User": "user-2"
      })
    })
  );

  await defaultApiClient.get("/api/board/bootstrap");
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/board/bootstrap",
    expect.not.objectContaining({
      headers: expect.objectContaining({
        "X-RiceArk-Admin-Target-User": expect.any(String)
      })
    })
  );
});
```

Add source/behavior tests showing board reads, reliable completion and cell-state queues, direct editor CRUD, character import, and task creation all use the injected client.

- [ ] **Step 2: Run tests and confirm scoped-client failures**

Run:

```bash
pnpm vitest run apps/web/src/api/client.test.ts apps/web/src/features/board/useBoard.test.ts apps/web/src/features/board/BoardOverview.test.ts apps/web/src/features/characters/CharacterImport.test.ts apps/web/src/features/tasks/TaskForm.test.ts
```

Expected: FAIL because `createApiClient` and component API props do not exist.

- [ ] **Step 3: Implement immutable API clients**

Build headers per request:

```ts
function requestHeaders(
  targetUserId: string | undefined,
  contentType: boolean
): Headers {
  const headers = new Headers();
  if (contentType) headers.set("Content-Type", "application/json");
  if (targetUserId) headers.set(ADMIN_TARGET_USER_HEADER, targetUserId);
  return headers;
}
```

Retain the existing named `apiGet`, `apiPost`, `apiPatch`, and `apiDelete` exports as delegates to `defaultApiClient` so unrelated callers do not change.

- [ ] **Step 4: Inject the client through the board stack**

`useBoard` passes `apiClient.get` into `createBoardDataApi` and `apiClient.patch` into both reliable queues. `BoardOverview` replaces direct module calls with its `apiClient` prop and passes it to `CharacterImport` and `TaskForm`. Public Lost Ark event reads use `defaultApiClient` explicitly so the target header is not sent.

- [ ] **Step 5: Run scoped web tests**

Run:

```bash
pnpm vitest run apps/web/src/api/client.test.ts apps/web/src/features/board/useBoard.test.ts apps/web/src/features/board/BoardOverview.test.ts apps/web/src/features/characters/CharacterImport.test.ts apps/web/src/features/tasks/TaskForm.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/api/client.test.ts apps/web/src/features/board/useBoard.ts apps/web/src/features/board/useBoard.test.ts apps/web/src/features/board/BoardOverview.tsx apps/web/src/features/board/BoardOverview.test.ts apps/web/src/features/characters/CharacterImport.tsx apps/web/src/features/characters/CharacterImport.test.ts apps/web/src/features/tasks/TaskForm.tsx apps/web/src/features/tasks/TaskForm.test.ts
git commit -m "Add scoped API clients for admin boards"
```

---

### Task 6: Administrator Route State

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.ts`
- Modify: `apps/web/src/features/admin/types.ts`
- Modify: `apps/web/src/features/admin/AdminDashboard.tsx`
- Modify: `apps/web/src/features/admin/AdminDashboard.test.ts`

**Interfaces:**
- Extends `AdminTab` with `"users" | "audit"`
- Extends `AppRouteState` with:

```ts
adminTab: AdminTab | null;
adminUserId: string | null;
adminSheetId: string | null;
```

- `AdminDashboard` receives controlled route state and navigation callbacks.

- [ ] **Step 1: Write URL and dashboard tab tests**

```ts
expect(
  getAppRouteState(
    "https://riceark.pages.dev/?view=admin&adminTab=users&adminUser=user-2&adminSheet=sheet-3"
  )
).toMatchObject({
  activeView: "admin",
  adminTab: "users",
  adminUserId: "user-2",
  adminSheetId: "sheet-3"
});

expect(getAppRouteUrl(route, "https://riceark.pages.dev/")).toBe(
  "/?view=admin&adminTab=users&adminUser=user-2&adminSheet=sheet-3"
);
```

- [ ] **Step 2: Run tests and confirm route fields are missing**

Run:

```bash
pnpm vitest run apps/web/src/App.test.ts apps/web/src/features/admin/AdminDashboard.test.ts
```

Expected: FAIL because admin route state and tabs are not represented.

- [ ] **Step 3: Implement controlled administrator routing**

Parse only valid admin tab keys and non-empty internal IDs. Clear all administrator parameters when leaving the administrator view. Selecting a user pushes history; automatic active-sheet normalization replaces history; sheet tab selection pushes history. Browser `popstate` restores the administrator tab, user, and sheet.

- [ ] **Step 4: Run routing tests**

Run:

```bash
pnpm vitest run apps/web/src/App.test.ts apps/web/src/features/admin/AdminDashboard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.ts apps/web/src/features/admin/types.ts apps/web/src/features/admin/AdminDashboard.tsx apps/web/src/features/admin/AdminDashboard.test.ts
git commit -m "Route admin user board management"
```

---

### Task 7: User Board And Audit Management UI

**Files:**
- Create: `apps/web/src/features/admin/AdminUserBoardsTab.tsx`
- Create: `apps/web/src/features/admin/AdminUserBoardsTab.test.ts`
- Create: `apps/web/src/features/admin/AdminAuditTab.tsx`
- Create: `apps/web/src/features/admin/AdminAuditTab.test.ts`
- Modify: `apps/web/src/features/admin/AdminDashboard.tsx`
- Modify: `apps/web/src/features/admin/AdminDashboard.test.ts`
- Modify: `apps/web/src/features/admin/types.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `createApiClient`, `useBoard`, `BoardOverview`, route callbacks.
- Produces: Search, selection, full board editor, management context bar, and paginated audit list.

- [ ] **Step 1: Write UI behavior tests**

```ts
it("shows approved user metadata without private identifiers", () => {
  const html = renderUserResults({
    id: "12345678-1234-1234-1234-123456789012",
    displayName: "Rice",
    provider: "discord",
    createdAt: "2026-07-01T00:00:00.000Z",
    recentActivityAt: "2026-07-30T00:00:00.000Z"
  });
  expect(html).toContain("Rice");
  expect(html).toContain("Discord");
  expect(html).toContain("9012");
  expect(html).not.toContain("email");
  expect(html).not.toContain("providerUserId");
});

it("shows a persistent management context for the selected user", () => {
  const html = renderSelectedUser("Rice");
  expect(html).toContain("관리 중: Rice");
  expect(html).toContain("다른 사용자 선택");
});

it("renders content-free audit rows", () => {
  const html = renderAuditRow({
    action: "board.completions.update",
    method: "PATCH"
  });
  expect(html).toContain("체크 상태 변경");
  expect(html).not.toMatch(/memo|payload|body/i);
});
```

- [ ] **Step 2: Run UI tests and verify missing-component failures**

Run:

```bash
pnpm vitest run apps/web/src/features/admin/AdminUserBoardsTab.test.ts apps/web/src/features/admin/AdminAuditTab.test.ts apps/web/src/features/admin/AdminDashboard.test.ts
```

Expected: FAIL because the new tabs do not exist.

- [ ] **Step 3: Implement the user management tab**

Use a 300 ms debounced search. Do not instantiate `useBoard` until a selected user exists. Bind the client with:

```ts
const apiClient = useMemo(
  () => createApiClient({ adminTargetUserId: selectedUser.id }),
  [selectedUser.id]
);
```

Show loading, empty, error, retry, next-page, and direct-URL selected-user states. Before switching or clearing a user, call the existing board write flush/discard flow so pending writes cannot cross subjects.

- [ ] **Step 4: Implement the audit tab**

Render action labels through a fixed map:

```ts
const ACTION_LABELS: Record<string, string> = {
  "board.completions.update": "체크 상태 변경",
  "board.cell_states.update": "체크칸 설정 변경",
  "characters.refresh": "캐릭터 정보 갱신",
  "settings.update": "보드 표시 설정 변경"
};
```

Unknown future actions display their normalized action string. Add cursor pagination and a refresh icon button with a tooltip.

- [ ] **Step 5: Add responsive and dark-theme styles**

Use an unframed toolbar and full-width board area. Keep cards only for repeated user results. Constrain buttons and IDs so long names cannot overlap. On mobile, stack user metadata and controls above the board. Add dark-theme colors for the management context, user results, audit table, loading, empty, and error states.

- [ ] **Step 6: Run UI and full tests**

Run:

```bash
pnpm vitest run apps/web/src/features/admin/AdminUserBoardsTab.test.ts apps/web/src/features/admin/AdminAuditTab.test.ts apps/web/src/features/admin/AdminDashboard.test.ts
pnpm check
pnpm test
pnpm test:d1-sql
```

Expected: all commands exit 0.

- [ ] **Step 7: Run production builds and visual QA**

Run:

```bash
pnpm --filter @riceark/api build
pnpm --filter @riceark/web build
pnpm --filter @riceark/web dev --host 127.0.0.1
```

Verify with Playwright at desktop `1440x900` and mobile `390x844`:

- User search, selected context, board tabs, board editor, and audit table have no overlap.
- Long display names and IDs wrap or truncate inside their containers.
- Light and dark themes remain legible.
- No board request is made before user selection.
- Owner board requests do not carry the administrator target header.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/admin/AdminUserBoardsTab.tsx apps/web/src/features/admin/AdminUserBoardsTab.test.ts apps/web/src/features/admin/AdminAuditTab.tsx apps/web/src/features/admin/AdminAuditTab.test.ts apps/web/src/features/admin/AdminDashboard.tsx apps/web/src/features/admin/AdminDashboard.test.ts apps/web/src/features/admin/types.ts apps/web/src/styles.css
git commit -m "Add admin user board management UI"
```

---

### Task 8: Final Security And Regression Verification

**Files:**
- Modify only files required by failures discovered in this task.

**Interfaces:**
- Consumes all prior tasks.
- Produces a verified implementation ready for review and deployment.

- [ ] **Step 1: Verify the migration against local D1**

Run:

```bash
pnpm --filter @riceark/api db:migrate:local
pnpm test:d1-sql
```

Expected: migration `0028` applies and the board SQL verifier passes.

- [ ] **Step 2: Run the complete verification suite**

Run:

```bash
pnpm check
pnpm test
pnpm --filter @riceark/api build
pnpm --filter @riceark/web build
git diff --check
```

Expected: all commands exit 0 with no failed tests.

- [ ] **Step 3: Inspect the final security boundaries**

Run:

```bash
rg -n "X-RiceArk-Admin-Target-User|allowAdminTarget|adminTargetUserId" apps/api/src apps/web/src
rg -n "email|provider_user_id|request_body|payload|memo|content" apps/api/src/admin/userBoardManagement.ts apps/web/src/features/admin
```

Confirm target propagation appears only in approved route groups and privacy-sensitive fields do not appear in API response or audit UI types.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git status --short
git diff --stat
git diff -- apps/api apps/web docs/superpowers
```

Confirm unrelated `image/` and `outputs/` files are neither modified nor staged.
