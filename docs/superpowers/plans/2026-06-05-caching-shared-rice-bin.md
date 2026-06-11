# Caching And Shared Rice Bin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add low-cost board synchronization and a read-only live "공유 쌀통" feature without allowing stale shared access, accidental edits, or user-visible sync regressions.

**Architecture:** Owner boards remain authoritative in D1 and are guarded by existing authenticated mutation routes. Shared rice bins use separate GET-only public routes backed by active `shareId` lookup in D1, while owner-side sync uses manifest/sheet versions and reset-period fingerprints to avoid full-board polling. Shared views use only memory/ETag style caching, never IndexedDB persistence.

**Tech Stack:** Cloudflare Workers, Hono, D1 SQL migrations, React, TypeScript, Vitest.

---

### Task 1: Server Schema And Contracts

**Files:**
- Create: `apps/api/migrations/0022_board_sharing_and_versions.sql`
- Modify: `apps/api/src/db/schema.test.ts`
- Modify: `apps/api/src/routes/board.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add assertions that migrations define `content_version`, `board_manifest_versions`, `board_shares`, and `board_share_favorites`, with indexes for `share_id`, owner sheet sharing, and favorites.

- [ ] **Step 2: Run schema tests**

Run: `pnpm test apps/api/src/db/schema.test.ts`

- [ ] **Step 3: Add migration**

Add `sheets.content_version`, manifest version table, share table, favorite table, and indexes. Use hard-delete friendly share rows so re-sharing creates a fresh `share_id`.

- [ ] **Step 4: Run schema tests again**

Run: `pnpm test apps/api/src/db/schema.test.ts`

### Task 2: Board Version And Share DB Helpers

**Files:**
- Modify: `apps/api/src/db/board.ts`
- Modify: `apps/api/src/db/board.test.ts`

- [ ] **Step 1: Write failing DB tests**

Cover starting share, stopping share, re-sharing with a new id, favorite add/remove/list, owner share listing, and loading an active shared sheet payload.

- [ ] **Step 2: Run DB tests**

Run: `pnpm test apps/api/src/db/board.test.ts`

- [ ] **Step 3: Implement helpers**

Implement atomic version bump helpers, active share creation/deletion, favorite helpers, owner share list helpers, and a pure-read shared sheet loader that never calls default board seeding.

- [ ] **Step 4: Run DB tests again**

Run: `pnpm test apps/api/src/db/board.test.ts`

### Task 3: Shared Rice Bin API

**Files:**
- Modify: `apps/api/src/routes/board.ts`
- Modify: `apps/api/src/routes/board.test.ts`
- Modify: `apps/api/src/index.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover `POST /api/board/sheets/:id/share`, `DELETE /api/board/sheets/:id/share`, `GET /api/shared-rice-bins/:shareId`, `GET /api/shared-rice-bins/:shareId/version`, `GET/POST/DELETE /api/board/share-favorites`, and method rejection for public mutation attempts.

- [ ] **Step 2: Run route tests**

Run: `pnpm test apps/api/src/routes/board.test.ts apps/api/src/index.test.ts`

- [ ] **Step 3: Implement routes**

Use `requireUser` only for owner/favorite routes. Public shared routes must be GET-only and return `Cache-Control` headers that do not allow stale access beyond the short shared cache window.

- [ ] **Step 4: Run route tests again**

Run: `pnpm test apps/api/src/routes/board.test.ts apps/api/src/index.test.ts`

### Task 4: Frontend Shared Rice Bin UI

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/features/board/BoardOverview.tsx`
- Modify: `apps/web/src/features/board/types.ts`
- Create: `apps/web/src/features/shared-rice-bin/*`
- Modify: related web tests.

- [ ] **Step 1: Write failing UI tests**

Cover the top "공유 쌀통" entry, owner share management, copyable link/id, public lookup by id/link, favorites, and read-only shared board rendering with no mutation calls.

- [ ] **Step 2: Run web tests**

Run: `pnpm test apps/web/src/App.test.ts apps/web/src/features/board/BoardOverview.test.ts`

- [ ] **Step 3: Implement UI**

Add a shared rice bin panel/page. Owner tab share start/stop lives in the shared panel. Shared lookup renders through a read-only board view where checkboxes, dragging, menus, and add/edit/delete controls cannot call mutation APIs.

- [ ] **Step 4: Run web tests again**

Run: `pnpm test apps/web/src/App.test.ts apps/web/src/features/board/BoardOverview.test.ts`

### Task 5: Safe Sync And Caching

**Files:**
- Modify: `apps/api/src/routes/board.ts`
- Modify: `apps/api/src/db/board.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/features/board/useBoard.ts`
- Modify: `apps/web/src/features/board/useBoardCompletionQueue.ts`

- [ ] **Step 1: Write failing sync tests**

Cover owner version endpoint, 304 handling, period fingerprint changes, completion queue failure handling, and logout/user mismatch cache invalidation.

- [ ] **Step 2: Run sync tests**

Run: `pnpm test apps/api/src/routes/board.test.ts apps/web/src/api/client.test.ts apps/web/src/features/board/useBoard.test.ts`

- [ ] **Step 3: Implement minimal safe sync**

Start with memory cache and focus/visibility version checks. Do not add IndexedDB until the owner-only behavior is stable. Shared rice bins remain non-persistent.

- [ ] **Step 4: Run sync tests again**

Run: `pnpm test apps/api/src/routes/board.test.ts apps/web/src/api/client.test.ts apps/web/src/features/board/useBoard.test.ts`

### Task 6: Full Verification And Deploy

**Files:**
- All touched files.

- [ ] **Step 1: Run full checks**

Run: `pnpm check`, `pnpm test`, and `pnpm build`.

- [ ] **Step 2: Deploy**

Deploy API and Pages after checks pass.

- [ ] **Step 3: Smoke test production**

Verify health, owner login board load, shared lookup, share stop old link failure, and favorite behavior.
