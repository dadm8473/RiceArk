# Drag Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag to reorder characters and tasks without changing completion identity.

**Architecture:** Characters update `characters.sort_order`. Tasks use a new per-user `task_orders` table so shared template task order is never mutated. The frontend keeps local item order during pointer drag and saves ids to the reorder endpoints on pointer up.

**Tech Stack:** TypeScript, React 19, Hono, Zod, Cloudflare D1, Vitest, Vite.

---

### Task 1: Persistence And API

**Files:**
- Create: `apps/api/migrations/0005_task_orders.sql`
- Modify: `apps/api/src/db/schema.test.ts`
- Modify: `apps/api/src/db/characters.ts`
- Modify: `apps/api/src/routes/characters.ts`
- Modify: `apps/api/src/db/tasks.ts`
- Modify: `apps/api/src/routes/tasks.ts`
- Modify: `apps/api/src/db/dashboard.ts`
- Test: `apps/api/src/routes/characters.test.ts`
- Test: `apps/api/src/routes/tasks.test.ts`

- [ ] Add schema tests for `task_orders`.
- [ ] Add route schema tests for duplicate and valid reorder payloads.
- [ ] Add migration.
- [ ] Implement `reorderCharacters`.
- [ ] Implement `reorderTasks`.
- [ ] Add `PATCH /api/characters/order`.
- [ ] Add `PATCH /api/tasks/order`.
- [ ] Update dashboard task query to use `task_orders`.
- [ ] Run `pnpm test apps/api/src/db/schema.test.ts apps/api/src/routes/characters.test.ts apps/api/src/routes/tasks.test.ts`.
- [ ] Commit with `feat: add reorder APIs`.

### Task 2: Reorder Helpers

**Files:**
- Create: `apps/web/src/features/dashboard/reorder.ts`
- Test: `apps/web/src/features/dashboard/reorder.test.ts`

- [ ] Add tests for moving ids from one index to another.
- [ ] Add tests for no-op moves.
- [ ] Implement `moveItem`.
- [ ] Run `pnpm test apps/web/src/features/dashboard/reorder.test.ts`.
- [ ] Commit with `feat: add dashboard reorder helper`.

### Task 3: Pointer Drag Matrix UI

**Files:**
- Modify: `apps/web/src/features/dashboard/ChecklistMatrix.tsx`
- Modify: `apps/web/src/features/dashboard/ChecklistMatrix.test.ts`
- Modify: `apps/web/src/styles.css`

- [ ] Add render tests that task and character handles appear.
- [ ] Add render test that roster has no handle.
- [ ] Implement local task and character order state.
- [ ] Add pointer drag handlers on reorder handles.
- [ ] Save `taskIds` to `/api/tasks/order`.
- [ ] Save `characterIds` to `/api/characters/order`.
- [ ] Add handle styling and dragging visual state.
- [ ] Run `pnpm test apps/web/src/features/dashboard/ChecklistMatrix.test.ts`.
- [ ] Commit with `feat: add matrix drag reorder`.

### Task 4: Verification And Deployment

**Files:**
- No direct file changes expected.

- [ ] Run `pnpm test`.
- [ ] Run `pnpm check`.
- [ ] Run `pnpm --filter @riceark/web build`.
- [ ] Run `pnpm --filter @riceark/api build`.
- [ ] Run `pnpm --filter @riceark/web build:functions`.
- [ ] Apply remote D1 migrations with `pnpm wrangler d1 migrations apply riceark --remote`.
- [ ] Push `main`.
- [ ] Confirm Cloudflare Pages active deployment source is the new commit.
