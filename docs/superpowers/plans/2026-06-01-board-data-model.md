# Board Data Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first real board-builder storage model while keeping the existing checklist usable.

**Architecture:** Cloudflare D1 remains the durable source of truth, but the model separates semantic checklist data from presentation layout. The API should return a board-shaped payload that the React client can render and edit locally, while mutations stay small and permission-checked on the server.

**Tech Stack:** TypeScript, Hono, Zod, Cloudflare D1 migrations, Vitest, React 19.

---

## File Structure

- `apps/api/migrations/0010_board_data_model.sql`: create sheets, tables, axis items, cell state, and board completion tables.
- `apps/api/src/db/schema.test.ts`: assert the D1 schema has the new board model and uniqueness constraints.
- `packages/core/src/board.ts`: define shared board payload types and pure helpers for orientation, axis roles, and semantic cell keys.
- `packages/core/test/board.test.ts`: verify semantic cell keys and orientation helpers do not depend on visual position.
- `packages/core/src/index.ts`: export board helpers.
- `apps/api/src/db/board.ts`: create and load default sheets/tables from existing characters and tasks.
- `apps/api/src/routes/board.ts`: expose scoped board read and mutation schemas.
- `apps/api/src/routes/board.test.ts`: verify route schemas reject unsafe IDs, text, and oversized batches.
- `apps/api/src/index.ts`: mount the board routes under `/api`.
- `apps/web/src/features/dashboard/types.ts`: accept board-shaped payload alongside the legacy dashboard fields during migration.

## Task 1: Add Board Storage Schema

**Files:**
- Modify: `apps/api/src/db/schema.test.ts`
- Create: `apps/api/migrations/0010_board_data_model.sql`

- [ ] **Step 1: Write failing schema tests**

Add this test to `apps/api/src/db/schema.test.ts`:

```ts
it("defines board builder storage tables", () => {
  for (const table of [
    "sheets",
    "board_tables",
    "board_axis_items",
    "board_cell_states",
    "board_cell_completions"
  ]) {
    expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
  }

  expect(migration).toContain("UNIQUE (user_id, name)");
  expect(migration).toContain("UNIQUE (table_id, axis, sort_order)");
  expect(migration).toContain("UNIQUE (table_id, row_item_id, column_item_id)");
  expect(migration).toContain("UNIQUE (user_id, table_id, row_item_id, column_item_id, period_key)");
});
```

- [ ] **Step 2: Run schema test to verify it fails**

Run: `pnpm test apps/api/src/db/schema.test.ts`

Expected: FAIL because `0010_board_data_model.sql` does not exist yet.

- [ ] **Step 3: Add the migration**

Create `apps/api/migrations/0010_board_data_model.sql` with:

```sql
CREATE TABLE IF NOT EXISTS sheets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS board_tables (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  x INTEGER NOT NULL DEFAULT 0,
  y INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  row_role TEXT NOT NULL CHECK (row_role IN ('character', 'task', 'custom')),
  column_role TEXT NOT NULL CHECK (column_role IN ('character', 'task', 'custom')),
  task_axis TEXT NOT NULL CHECK (task_axis IN ('rows', 'columns', 'none')),
  default_row_height INTEGER NOT NULL DEFAULT 40,
  default_column_width INTEGER NOT NULL DEFAULT 132,
  default_reset_rule_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS board_axis_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES board_tables(id) ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK (axis IN ('row', 'column')),
  kind TEXT NOT NULL CHECK (kind IN ('character', 'task', 'custom')),
  label TEXT NOT NULL,
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  task_scope TEXT CHECK (task_scope IN ('character', 'roster', 'custom')),
  task_reset_type TEXT CHECK (task_reset_type IN ('daily', 'weekly', 'biweekly', 'custom', 'none')),
  task_reset_rule_json TEXT,
  task_color TEXT,
  size_px INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1,
  separator_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (table_id, axis, sort_order)
);

CREATE TABLE IF NOT EXISTS board_cell_states (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES board_tables(id) ON DELETE CASCADE,
  row_item_id TEXT NOT NULL REFERENCES board_axis_items(id) ON DELETE CASCADE,
  column_item_id TEXT NOT NULL REFERENCES board_axis_items(id) ON DELETE CASCADE,
  checkbox_visible INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (table_id, row_item_id, column_item_id)
);

CREATE TABLE IF NOT EXISTS board_cell_completions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES board_tables(id) ON DELETE CASCADE,
  row_item_id TEXT NOT NULL REFERENCES board_axis_items(id) ON DELETE CASCADE,
  column_item_id TEXT NOT NULL REFERENCES board_axis_items(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  completed INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, table_id, row_item_id, column_item_id, period_key)
);
```

- [ ] **Step 4: Run schema test to verify it passes**

Run: `pnpm test apps/api/src/db/schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.test.ts apps/api/migrations/0010_board_data_model.sql
git commit -m "feat: add board data model schema"
```

## Task 2: Add Shared Board Helpers

**Files:**
- Create: `packages/core/src/board.ts`
- Create: `packages/core/test/board.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing helper tests**

Create `packages/core/test/board.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { boardCompletionKey, getBoardOrientation } from "../src/board";

describe("board helpers", () => {
  it("keys completion by semantic row and column ids", () => {
    expect(
      boardCompletionKey({
        tableId: "table-1",
        rowItemId: "row-character-a",
        columnItemId: "column-task-b",
        periodKey: "daily:2026-06-01"
      })
    ).toBe('["table-1","row-character-a","column-task-b","daily:2026-06-01"]');
  });

  it("derives table orientation from row and column roles", () => {
    expect(getBoardOrientation({ rowRole: "task", columnRole: "character" })).toBe("tasks_rows");
    expect(getBoardOrientation({ rowRole: "character", columnRole: "task" })).toBe("tasks_columns");
    expect(getBoardOrientation({ rowRole: "custom", columnRole: "custom" })).toBe("custom");
  });
});
```

- [ ] **Step 2: Run helper test to verify it fails**

Run: `pnpm test packages/core/test/board.test.ts`

Expected: FAIL because `packages/core/src/board.ts` does not exist yet.

- [ ] **Step 3: Add minimal helper implementation**

Create `packages/core/src/board.ts`:

```ts
export type BoardAxis = "row" | "column";
export type BoardAxisRole = "character" | "task" | "custom";
export type BoardTaskAxis = "rows" | "columns" | "none";
export type BoardOrientation = "tasks_rows" | "tasks_columns" | "custom";

export interface BoardCompletionIdentity {
  tableId: string;
  rowItemId: string;
  columnItemId: string;
  periodKey: string;
}

export function boardCompletionKey(identity: BoardCompletionIdentity): string {
  return JSON.stringify([identity.tableId, identity.rowItemId, identity.columnItemId, identity.periodKey]);
}

export function getBoardOrientation(input: { rowRole: BoardAxisRole; columnRole: BoardAxisRole }): BoardOrientation {
  if (input.rowRole === "task" && input.columnRole === "character") return "tasks_rows";
  if (input.rowRole === "character" && input.columnRole === "task") return "tasks_columns";
  return "custom";
}
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./board";
```

- [ ] **Step 4: Run helper test to verify it passes**

Run: `pnpm test packages/core/test/board.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/board.ts packages/core/test/board.test.ts packages/core/src/index.ts
git commit -m "feat: add board identity helpers"
```

## Task 3: Add Board Route Schemas

**Files:**
- Create: `apps/api/src/routes/board.ts`
- Create: `apps/api/src/routes/board.test.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Write failing schema tests**

Create `apps/api/src/routes/board.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { boardCompletionPatchSchema, boardAxisSizePatchSchema } from "./board";

describe("board route schemas", () => {
  it("accepts small board completion batches", () => {
    expect(
      boardCompletionPatchSchema.safeParse({
        patches: [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ]
      }).success
    ).toBe(true);
  });

  it("rejects oversized board completion batches and unsafe ids", () => {
    expect(boardCompletionPatchSchema.safeParse({ patches: new Array(201).fill({
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-06-01",
      completed: true
    }) }).success).toBe(false);

    expect(boardCompletionPatchSchema.safeParse({ patches: [{
      tableId: "table🙂",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-06-01",
      completed: true
    }] }).success).toBe(false);
  });

  it("accepts bounded pixel sizes", () => {
    expect(boardAxisSizePatchSchema.safeParse({ sizePx: 48 }).success).toBe(true);
    expect(boardAxisSizePatchSchema.safeParse({ sizePx: 0 }).success).toBe(false);
    expect(boardAxisSizePatchSchema.safeParse({ sizePx: 2000 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run route schema test to verify it fails**

Run: `pnpm test apps/api/src/routes/board.test.ts`

Expected: FAIL because `apps/api/src/routes/board.ts` does not exist yet.

- [ ] **Step 3: Add board route schemas and route shell**

Create `apps/api/src/routes/board.ts`:

```ts
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import type { Env } from "../env";
import { periodKeySchema, resourceIdSchema } from "../http/input";

export const boardCompletionPatchSchema = z.object({
  patches: z.array(z.object({
    tableId: resourceIdSchema,
    rowItemId: resourceIdSchema,
    columnItemId: resourceIdSchema,
    periodKey: periodKeySchema,
    completed: z.boolean()
  })).max(200)
});

export const boardAxisSizePatchSchema = z.object({
  sizePx: z.number().int().min(16).max(1024)
});

export const boardRoutes = new Hono<{ Bindings: Env }>();

boardRoutes.get("/board", async (c) => {
  const user = await requireUser(c);
  return c.json({ userId: user.id, sheets: [], tables: [], axisItems: [], cellStates: [], completions: [] });
});

boardRoutes.patch("/board/completions", zValidator("json", boardCompletionPatchSchema), async (c) => {
  await requireUser(c);
  return c.json({ ok: true });
});
```

Mount in `apps/api/src/index.ts`:

```ts
import { boardRoutes } from "./routes/board";

app.route("/api", boardRoutes);
```

- [ ] **Step 4: Run route schema test to verify it passes**

Run: `pnpm test apps/api/src/routes/board.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/board.ts apps/api/src/routes/board.test.ts apps/api/src/index.ts
git commit -m "feat: add board route contracts"
```

## Task 4: Load Or Create Default Board From Existing Checklist

**Files:**
- Create: `apps/api/src/db/board.ts`
- Test: `apps/api/src/db/board.test.ts`
- Modify: `apps/api/src/routes/board.ts`

- [ ] **Step 1: Write default board unit tests around SQL intent**

Create `apps/api/src/db/board.test.ts` with tests that assert the exported constants and defaults:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_SHEET_NAME, DEFAULT_TABLE_NAME, defaultBoardRolesForOrientation } from "./board";

describe("board db defaults", () => {
  it("uses Korean-facing default names", () => {
    expect(DEFAULT_SHEET_NAME).toBe("기본");
    expect(DEFAULT_TABLE_NAME).toBe("숙제");
  });

  it("maps existing orientation to board roles", () => {
    expect(defaultBoardRolesForOrientation("tasks_rows")).toMatchObject({
      rowRole: "task",
      columnRole: "character",
      taskAxis: "rows"
    });
    expect(defaultBoardRolesForOrientation("tasks_columns")).toMatchObject({
      rowRole: "character",
      columnRole: "task",
      taskAxis: "columns"
    });
  });
});
```

- [ ] **Step 2: Run DB test to verify it fails**

Run: `pnpm test apps/api/src/db/board.test.ts`

Expected: FAIL because `apps/api/src/db/board.ts` does not exist yet.

- [ ] **Step 3: Add the board DB module skeleton**

Create `apps/api/src/db/board.ts` with default constants, orientation mapping, and a `loadBoard` function that returns existing rows. Keep mutating bootstrap logic in a separate function so it can be tested and called intentionally.

- [ ] **Step 4: Run DB test to verify it passes**

Run: `pnpm test apps/api/src/db/board.test.ts`

Expected: PASS.

- [ ] **Step 5: Wire `/api/board` to `loadBoard`**

Modify `apps/api/src/routes/board.ts` so `GET /board` returns `await loadBoard(c.env, user.id)`.

- [ ] **Step 6: Run board route tests and DB tests**

Run: `pnpm test apps/api/src/routes/board.test.ts apps/api/src/db/board.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/board.ts apps/api/src/db/board.test.ts apps/api/src/routes/board.ts
git commit -m "feat: load board payload shell"
```

## Task 5: Save Board Completion Batches

**Files:**
- Modify: `apps/api/src/db/board.ts`
- Modify: `apps/api/src/routes/board.ts`
- Test: `apps/api/src/routes/board.test.ts`

- [ ] **Step 1: Add tests for completion mutation schema**

Extend `apps/api/src/routes/board.test.ts` to assert the schema rejects missing period keys, unsafe IDs, and batches over 200 items.

- [ ] **Step 2: Implement `saveBoardCompletionPatches`**

In `apps/api/src/db/board.ts`, insert into `board_cell_completions` with:

```sql
INSERT INTO board_cell_completions
  (id, user_id, table_id, row_item_id, column_item_id, period_key, completed, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
ON CONFLICT(user_id, table_id, row_item_id, column_item_id, period_key)
DO UPDATE SET completed = excluded.completed, updated_at = CURRENT_TIMESTAMP
```

- [ ] **Step 3: Wire route to DB helper**

Modify `PATCH /board/completions` so it calls `saveBoardCompletionPatches(c.env, user.id, patches)`.

- [ ] **Step 4: Run board route tests**

Run: `pnpm test apps/api/src/routes/board.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/board.ts apps/api/src/routes/board.ts apps/api/src/routes/board.test.ts
git commit -m "feat: save board completion batches"
```

## Self-Review

- Spec coverage: this plan covers the first storage/API phase: board tables, semantic completion identity, route validation, and the initial board payload shell. It intentionally does not yet implement full sheet/table UI, axis editing, resizing, or guarded transpose; those remain later phases from the spec rollout.
- Placeholder scan: no unresolved placeholder markers or undefined follow-up placeholders remain in the planned steps.
- Type consistency: `tableId`, `rowItemId`, `columnItemId`, `periodKey`, `rowRole`, `columnRole`, and `taskAxis` are used consistently across tasks.
