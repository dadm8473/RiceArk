# Board Builder Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first safe board-builder foundation: user-selected default orientation, optional character display names, compact character detail display, and orientation-aware checklist rendering without mixing completion data.

**Architecture:** This phase keeps the existing `tasks` and `completions` tables as the source of truth while adding board-facing settings around them. `user_settings.checklist_orientation` controls whether the current matrix renders tasks as rows or columns, and completion identity remains `task_id + character_id + period_key`. `characters.display_name` is optional and only affects presentation.

**Tech Stack:** TypeScript, React 19, Hono, Zod, Cloudflare D1 migrations, Vitest, Vite.

---

### Task 1: Add Persistent Presentation Fields

**Files:**
- Create: `apps/api/migrations/0004_board_foundation.sql`
- Modify: `apps/api/src/db/schema.test.ts`

- [ ] **Step 1: Write the failing schema test**

Add expectations to `apps/api/src/db/schema.test.ts`:

```ts
it("stores board foundation presentation settings", () => {
  expect(migration).toContain("display_name TEXT");
  expect(migration).toContain("checklist_orientation TEXT");
});
```

- [ ] **Step 2: Run schema test to verify it fails**

Run: `pnpm test apps/api/src/db/schema.test.ts`

Expected: FAIL because the migration does not yet contain `display_name TEXT` or `checklist_orientation TEXT`.

- [ ] **Step 3: Add the migration**

Create `apps/api/migrations/0004_board_foundation.sql`:

```sql
ALTER TABLE characters ADD COLUMN display_name TEXT;

ALTER TABLE user_settings
  ADD COLUMN checklist_orientation TEXT NOT NULL DEFAULT 'tasks_rows'
  CHECK (checklist_orientation IN ('tasks_rows', 'tasks_columns'));
```

- [ ] **Step 4: Run schema test to verify it passes**

Run: `pnpm test apps/api/src/db/schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/0004_board_foundation.sql apps/api/src/db/schema.test.ts
git commit -m "feat: add board foundation settings"
```

### Task 2: Add Settings And Character Alias APIs

**Files:**
- Modify: `apps/api/src/db/settings.ts`
- Modify: `apps/api/src/routes/settings.ts`
- Modify: `apps/api/src/db/characters.ts`
- Modify: `apps/api/src/routes/characters.ts`
- Test: `apps/api/src/routes/settings.test.ts`
- Test: `apps/api/src/routes/characters.test.ts`

- [ ] **Step 1: Write failing route tests**

Add tests that verify:

```ts
expect(settingsPatchSchema.safeParse({ checklistOrientation: "tasks_rows" }).success).toBe(true);
expect(settingsPatchSchema.safeParse({ checklistOrientation: "tasks_columns" }).success).toBe(true);
expect(settingsPatchSchema.safeParse({ checklistOrientation: "wrong" }).success).toBe(false);
expect(characterDisplayNameSchema.safeParse({ displayName: "냠1" }).success).toBe(true);
expect(characterDisplayNameSchema.safeParse({ displayName: "" }).success).toBe(true);
expect(characterDisplayNameSchema.safeParse({ displayName: "123456789012345678901" }).success).toBe(false);
```

- [ ] **Step 2: Run route tests to verify they fail**

Run: `pnpm test apps/api/src/routes/settings.test.ts apps/api/src/routes/characters.test.ts`

Expected: FAIL because the exported schemas and handlers do not exist yet.

- [ ] **Step 3: Add minimal DB helpers**

Add helpers:

```ts
export type ChecklistOrientation = "tasks_rows" | "tasks_columns";

export async function updateChecklistOrientation(env: Env, userId: string, orientation: ChecklistOrientation): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, checklist_orientation, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id)
     DO UPDATE SET checklist_orientation = excluded.checklist_orientation,
                   updated_at = CURRENT_TIMESTAMP`
  )
    .bind(userId, orientation)
    .run();
}

export async function updateCharacterDisplayName(
  env: Env,
  userId: string,
  characterId: string,
  displayName: string | null
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE characters
     SET display_name = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL`
  )
    .bind(displayName, characterId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
```

- [ ] **Step 4: Add route schemas and handlers**

Add `PATCH /api/settings` support for `checklistOrientation`, and `PATCH /api/characters/:id/display-name` for optional display names.

- [ ] **Step 5: Run route tests**

Run: `pnpm test apps/api/src/routes/settings.test.ts apps/api/src/routes/characters.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/settings.ts apps/api/src/routes/settings.ts apps/api/src/db/characters.ts apps/api/src/routes/characters.ts apps/api/src/routes/settings.test.ts apps/api/src/routes/characters.test.ts
git commit -m "feat: add orientation and character alias APIs"
```

### Task 3: Render Orientation-Aware Matrix

**Files:**
- Modify: `apps/web/src/features/dashboard/types.ts`
- Modify: `apps/web/src/features/dashboard/ChecklistMatrix.tsx`
- Test: `apps/web/src/features/dashboard/ChecklistMatrix.test.ts`

- [ ] **Step 1: Write failing render tests**

Add tests using `renderToStaticMarkup`:

```ts
expect(renderedTasksRows.indexOf("숙제")).toBeLessThan(renderedTasksRows.indexOf("냠1"));
expect(renderedTasksColumns.indexOf("캐릭터")).toBeLessThan(renderedTasksColumns.indexOf("쿠르잔 전선"));
expect(renderedTasksColumns).toContain("title=\"루페온 / 냠수나이스1 / 소서리스 / 1,640.00 / 2,549.41\"");
```

- [ ] **Step 2: Run render tests to verify they fail**

Run: `pnpm test apps/web/src/features/dashboard/ChecklistMatrix.test.ts`

Expected: FAIL because the component does not support `tasks_columns` or `display_name`.

- [ ] **Step 3: Update dashboard types**

Add:

```ts
display_name: string | null;
checklist_orientation: "tasks_rows" | "tasks_columns";
```

- [ ] **Step 4: Implement render helpers**

Use stable keys:

```ts
const completionKey = `${task.id}:${characterId ?? "roster"}:${periodKey}`;
```

Keep that key identical in both orientations.

- [ ] **Step 5: Run render tests**

Run: `pnpm test apps/web/src/features/dashboard/ChecklistMatrix.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/dashboard/types.ts apps/web/src/features/dashboard/ChecklistMatrix.tsx apps/web/src/features/dashboard/ChecklistMatrix.test.ts
git commit -m "feat: render checklist in either orientation"
```

### Task 4: Add First-Use Orientation And Alias Controls

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/features/tools/WorkspaceActions.tsx`
- Modify: `apps/web/src/features/characters/CharacterImport.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/features/characters/CharacterImport.test.ts`
- Test: `apps/web/src/features/tools/WorkspaceActions.test.ts`

- [ ] **Step 1: Write failing UI tests**

Add expectations:

```ts
expect(html).toContain("표 방향");
expect(html).toContain("캐릭터를 열로");
expect(html).toContain("숙제를 열로");
expect(html).toContain("축약 이름");
```

- [ ] **Step 2: Run UI tests to verify they fail**

Run: `pnpm test apps/web/src/features/characters/CharacterImport.test.ts apps/web/src/features/tools/WorkspaceActions.test.ts`

Expected: FAIL because controls do not render yet.

- [ ] **Step 3: Add orientation buttons**

Render two buttons when dashboard data exists:

```tsx
<button type="button" aria-pressed={orientation === "tasks_rows"}>캐릭터를 열로</button>
<button type="button" aria-pressed={orientation === "tasks_columns"}>숙제를 열로</button>
```

Persist with:

```ts
await apiPatch("/api/settings", { checklistOrientation: next });
```

- [ ] **Step 4: Add alias controls**

In the character modal, render existing characters with optional display name inputs and save each alias with:

```ts
await apiPatch(`/api/characters/${character.id}/display-name`, { displayName });
```

- [ ] **Step 5: Run UI tests**

Run: `pnpm test apps/web/src/features/characters/CharacterImport.test.ts apps/web/src/features/tools/WorkspaceActions.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/features/tools/WorkspaceActions.tsx apps/web/src/features/characters/CharacterImport.tsx apps/web/src/styles.css apps/web/src/features/characters/CharacterImport.test.ts apps/web/src/features/tools/WorkspaceActions.test.ts
git commit -m "feat: add orientation and alias controls"
```

### Task 5: Verify And Deploy Readiness

**Files:**
- No direct file changes expected.

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 2: Run type checks**

Run: `pnpm check`

Expected: all workspace type checks pass.

- [ ] **Step 3: Build the web app**

Run: `pnpm --filter @riceark/web build`

Expected: Vite build succeeds.

- [ ] **Step 4: Start local dev server**

Run: `npm run dev -- --host 127.0.0.1`

Expected: local URL opens and shows the dashboard.

- [ ] **Step 5: Verify mobile layout**

Open the app at a mobile viewport and check:

- Top action buttons wrap without overlap.
- Orientation controls wrap without overlap.
- Matrix uses horizontal scroll.
- Character aliases show compactly.
- Character detail text is available from the compact label.

- [ ] **Step 6: Commit any verification fixes**

```bash
git add <changed-files>
git commit -m "fix: polish board foundation layout"
```
