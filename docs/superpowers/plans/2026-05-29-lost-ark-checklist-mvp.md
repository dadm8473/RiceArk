# Lost Ark Checklist MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first deployable Cloudflare MVP for a Lost Ark daily/weekly/custom checklist service with login, character import, reset-aware checklist state, and a dense matrix UI.

**Architecture:** Use a TypeScript monorepo with a Cloudflare Worker API, Cloudflare Pages frontend, D1 database, and shared domain package. Reset and checklist logic live in shared pure functions with unit tests; Worker routes compose those functions with D1 persistence; the React frontend renders the matrix and batches checklist updates.

**Tech Stack:** TypeScript, pnpm workspaces, Vite, React, Hono, Cloudflare Workers, Cloudflare D1, Cloudflare KV/Cache API, Vitest, Playwright, Wrangler.

---

## Scope

This plan implements the MVP described in `docs/superpowers/specs/2026-05-29-lost-ark-checklist-design.md`.

The first implementation uses a small custom OAuth layer instead of an auth SaaS. This keeps the service within the $0-$5/month target and avoids provider lock-in. The OAuth layer supports Google and Discord with server-side secrets, HttpOnly session cookies, and D1-backed sessions.

## File Structure

- `package.json`: workspace scripts and root dev dependencies.
- `pnpm-workspace.yaml`: workspace package list.
- `tsconfig.base.json`: shared TypeScript compiler options.
- `vitest.config.ts`: unit test configuration for shared packages.
- `apps/api/wrangler.jsonc`: Cloudflare Worker, D1, KV, and Pages-compatible config.
- `apps/api/src/index.ts`: Hono app entrypoint.
- `apps/api/src/env.ts`: Worker bindings and secret type definitions.
- `apps/api/src/http/errors.ts`: typed API errors and JSON response helpers.
- `apps/api/src/auth/*`: OAuth providers, cookies, sessions, and auth routes.
- `apps/api/src/db/*`: D1 query helpers.
- `apps/api/src/routes/*`: API routes for health, session, dashboard, characters, tasks, and completions.
- `apps/api/migrations/*.sql`: D1 schema migrations.
- `apps/web/*`: Vite React frontend.
- `apps/web/src/api/client.ts`: browser API client.
- `apps/web/src/features/*`: feature-focused React modules.
- `packages/core/src/*`: shared reset, task, checklist, and API contract logic.
- `packages/core/test/*`: pure unit tests for reset and checklist behavior.
- `docs/deployment/cloudflare.md`: deployment and secret setup instructions.

## Task 1: Workspace Scaffold

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `apps/api/package.json`
- Create: `apps/web/package.json`
- Create: `packages/core/package.json`

- [ ] **Step 1: Create root workspace files**

Create `package.json`:

```json
{
  "name": "riceark",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.4",
  "scripts": {
    "build": "pnpm -r build",
    "check": "pnpm -r check",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev:api": "pnpm --filter @riceark/api dev",
    "dev:web": "pnpm --filter @riceark/web dev",
    "db:migrate:local": "pnpm --filter @riceark/api db:migrate:local",
    "deploy:api": "pnpm --filter @riceark/api deploy",
    "deploy:web": "pnpm --filter @riceark/web deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260529.0",
    "@types/node": "^22.15.0",
    "typescript": "^5.8.0",
    "vitest": "^3.1.0"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/workers-types"]
  }
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    globals: true
  }
});
```

- [ ] **Step 2: Create package manifests**

Create `packages/core/package.json`:

```json
{
  "name": "@riceark/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "tsc -p tsconfig.json --noEmit"
  }
}
```

Create `apps/api/package.json`:

```json
{
  "name": "@riceark/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "wrangler deploy --dry-run --outdir dist",
    "check": "tsc -p tsconfig.json --noEmit",
    "dev": "wrangler dev --local",
    "deploy": "wrangler deploy",
    "db:migrate:local": "wrangler d1 migrations apply riceark-local --local"
  },
  "dependencies": {
    "@hono/zod-validator": "^0.5.0",
    "@riceark/core": "workspace:*",
    "hono": "^4.8.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "wrangler": "^4.18.0"
  }
}
```

Create `apps/web/package.json`:

```json
{
  "name": "@riceark/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "check": "tsc -p tsconfig.json --noEmit",
    "dev": "vite --host 127.0.0.1",
    "deploy": "wrangler pages deploy dist --project-name riceark"
  },
  "dependencies": {
    "@riceark/core": "workspace:*",
    "@vitejs/plugin-react": "^4.5.0",
    "lucide-react": "^0.511.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "vite": "^6.3.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0"
  }
}
```

- [ ] **Step 3: Install dependencies**

Run:

```bash
pnpm install
```

Expected: lockfile is created and packages install without peer dependency errors.

- [ ] **Step 4: Verify scaffold**

Run:

```bash
pnpm check
```

Expected: TypeScript reports missing `tsconfig.json` files until Task 2 creates them.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts apps/api/package.json apps/web/package.json packages/core/package.json pnpm-lock.yaml
git commit -m "chore: scaffold TypeScript workspace"
```

## Task 2: Shared Reset And Period Engine

**Files:**
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/reset.ts`
- Create: `packages/core/src/types.ts`
- Create: `packages/core/test/reset.test.ts`

- [ ] **Step 1: Create failing reset tests**

Create `packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/core/test/reset.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getPeriodKey } from "../src/reset";
import type { ResetRule } from "../src/types";

describe("getPeriodKey", () => {
  it("keeps daily checks in the previous KST day before 06:00", () => {
    const rule: ResetRule = { type: "daily", hour: 6, timezone: "Asia/Seoul" };
    expect(getPeriodKey(rule, new Date("2026-05-28T20:59:00.000Z"))).toBe("daily:2026-05-28");
    expect(getPeriodKey(rule, new Date("2026-05-28T21:00:00.000Z"))).toBe("daily:2026-05-29");
  });

  it("resets weekly checks on Wednesday 06:00 KST", () => {
    const rule: ResetRule = { type: "weekly", weekday: 3, hour: 6, timezone: "Asia/Seoul" };
    expect(getPeriodKey(rule, new Date("2026-05-26T20:59:00.000Z"))).toBe("weekly:2026-05-20");
    expect(getPeriodKey(rule, new Date("2026-05-26T21:00:00.000Z"))).toBe("weekly:2026-05-27");
  });

  it("uses an anchor Wednesday for biweekly checks", () => {
    const rule: ResetRule = {
      type: "biweekly",
      weekday: 3,
      hour: 6,
      timezone: "Asia/Seoul",
      anchorDate: "2026-05-27"
    };
    expect(getPeriodKey(rule, new Date("2026-06-03T12:00:00.000Z"))).toBe("biweekly:2026-05-27");
    expect(getPeriodKey(rule, new Date("2026-06-10T00:00:00.000Z"))).toBe("biweekly:2026-06-10");
  });

  it("supports custom day intervals from an anchor date", () => {
    const rule: ResetRule = {
      type: "custom",
      intervalDays: 10,
      hour: 6,
      timezone: "Asia/Seoul",
      anchorDate: "2026-05-01"
    };
    expect(getPeriodKey(rule, new Date("2026-05-20T12:00:00.000Z"))).toBe("custom:2026-05-11");
    expect(getPeriodKey(rule, new Date("2026-05-21T00:00:00.000Z"))).toBe("custom:2026-05-21");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test packages/core/test/reset.test.ts
```

Expected: FAIL because `../src/reset` and `../src/types` do not exist.

- [ ] **Step 3: Implement reset types and period key calculation**

Create `packages/core/src/types.ts`:

```ts
export type ResetType = "daily" | "weekly" | "biweekly" | "custom";

export type ResetRule =
  | { type: "daily"; hour: number; timezone: "Asia/Seoul" }
  | { type: "weekly"; weekday: number; hour: number; timezone: "Asia/Seoul" }
  | { type: "biweekly"; weekday: number; hour: number; timezone: "Asia/Seoul"; anchorDate: string }
  | { type: "custom"; intervalDays: number; hour: number; timezone: "Asia/Seoul"; anchorDate: string };

export type TaskScope = "character" | "roster";

export interface TaskDefinition {
  id: string;
  name: string;
  scope: TaskScope;
  resetRule: ResetRule;
  sortOrder: number;
  enabled: boolean;
}

export interface CharacterSummary {
  id: string;
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  sortOrder: number;
  enabled: boolean;
}

export interface CompletionPatch {
  taskId: string;
  characterId: string | null;
  periodKey: string;
  completed: boolean;
}
```

Create `packages/core/src/reset.ts`:

```ts
import type { ResetRule } from "./types";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function toKstShiftedDate(date: Date, resetHour: number): Date {
  return new Date(date.getTime() + KST_OFFSET_MS - resetHour * 60 * 60 * 1000);
}

function dateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function startOfWeek(shiftedKst: Date, weekday: number): Date {
  const date = new Date(Date.UTC(shiftedKst.getUTCFullYear(), shiftedKst.getUTCMonth(), shiftedKst.getUTCDate()));
  const currentWeekday = date.getUTCDay();
  const diff = (currentWeekday - weekday + 7) % 7;
  return new Date(date.getTime() - diff * DAY_MS);
}

export function getPeriodKey(rule: ResetRule, now: Date = new Date()): string {
  const shifted = toKstShiftedDate(now, rule.hour);

  if (rule.type === "daily") {
    return `daily:${dateKey(shifted)}`;
  }

  if (rule.type === "weekly") {
    return `weekly:${dateKey(startOfWeek(shifted, rule.weekday))}`;
  }

  if (rule.type === "biweekly") {
    const weeklyStart = startOfWeek(shifted, rule.weekday);
    const anchor = parseDateKey(rule.anchorDate);
    const weeksSinceAnchor = Math.floor((weeklyStart.getTime() - anchor.getTime()) / (7 * DAY_MS));
    const evenWeekOffset = Math.floor(weeksSinceAnchor / 2) * 14 * DAY_MS;
    return `biweekly:${dateKey(new Date(anchor.getTime() + evenWeekOffset))}`;
  }

  const anchor = parseDateKey(rule.anchorDate);
  const daysSinceAnchor = Math.floor((shifted.getTime() - anchor.getTime()) / DAY_MS);
  const intervalStart = Math.floor(daysSinceAnchor / rule.intervalDays) * rule.intervalDays;
  return `custom:${dateKey(new Date(anchor.getTime() + intervalStart * DAY_MS))}`;
}
```

Create `packages/core/src/index.ts`:

```ts
export * from "./reset";
export * from "./types";
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
pnpm test packages/core/test/reset.test.ts
```

Expected: PASS, 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat: add reset period engine"
```

## Task 3: D1 Schema And Seed Templates

**Files:**
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/wrangler.jsonc`
- Create: `apps/api/migrations/0001_initial.sql`
- Create: `apps/api/migrations/0002_seed_default_tasks.sql`
- Create: `apps/api/src/db/schema.test.ts`

- [ ] **Step 1: Add Worker config and failing schema test**

Create `apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `apps/api/wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "riceark-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-29",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "riceark-local",
      "database_id": "local-development-placeholder"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "CACHE",
      "id": "local-development-placeholder"
    }
  ],
  "vars": {
    "APP_ORIGIN": "http://127.0.0.1:5173",
    "COOKIE_DOMAIN": "127.0.0.1",
    "ENVIRONMENT": "local"
  }
}
```

Create `apps/api/src/db/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const migration = readFileSync("apps/api/migrations/0001_initial.sql", "utf8");

describe("D1 schema", () => {
  it("defines required application tables", () => {
    for (const table of [
      "users",
      "oauth_accounts",
      "sessions",
      "characters",
      "tasks",
      "completions",
      "user_settings",
      "rate_limit_events"
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("defines completion uniqueness by user task character and period", () => {
    expect(migration).toContain("UNIQUE (user_id, task_id, character_id, period_key)");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm test apps/api/src/db/schema.test.ts
```

Expected: FAIL because `apps/api/migrations/0001_initial.sql` does not exist.

- [ ] **Step 3: Create D1 migrations**

Create `apps/api/migrations/0001_initial.sql`:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  server_name TEXT NOT NULL,
  class_name TEXT NOT NULL,
  item_level TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, name, server_name)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('character', 'roster')),
  reset_type TEXT NOT NULL CHECK (reset_type IN ('daily', 'weekly', 'biweekly', 'custom')),
  reset_rule_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_template INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS completions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  completed INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, task_id, character_id, period_key)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  density TEXT NOT NULL DEFAULT 'default' CHECK (density IN ('comfortable', 'default', 'compact')),
  row_height INTEGER NOT NULL DEFAULT 40,
  column_width INTEGER NOT NULL DEFAULT 132,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  key TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL,
  reset_at TEXT NOT NULL,
  PRIMARY KEY (key, bucket)
);

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user ON oauth_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_expires ON sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_characters_user_sort ON characters(user_id, enabled, sort_order);
CREATE INDEX IF NOT EXISTS idx_tasks_user_sort ON tasks(user_id, enabled, sort_order);
CREATE INDEX IF NOT EXISTS idx_tasks_templates ON tasks(is_template, enabled, sort_order);
CREATE INDEX IF NOT EXISTS idx_completions_dashboard ON completions(user_id, period_key);
CREATE INDEX IF NOT EXISTS idx_rate_limit_reset ON rate_limit_events(reset_at);
```

Create `apps/api/migrations/0002_seed_default_tasks.sql`:

```sql
INSERT OR IGNORE INTO tasks (
  id,
  user_id,
  name,
  scope,
  reset_type,
  reset_rule_json,
  sort_order,
  enabled,
  is_template
) VALUES
  ('template-kurzan-front', NULL, '쿠르잔 전선', 'character', 'daily', '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}', 10, 1, 1),
  ('template-guardian-raid', NULL, '가디언 토벌', 'character', 'daily', '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}', 20, 1, 1),
  ('template-act4-armoche', NULL, '4막: 아르모체', 'character', 'weekly', '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}', 30, 1, 1),
  ('template-kazeros-epilogue', NULL, '종막: 카제로스', 'character', 'weekly', '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}', 40, 1, 1),
  ('template-serca', NULL, '세르카', 'roster', 'custom', '{"type":"custom","intervalDays":1,"hour":6,"timezone":"Asia/Seoul","anchorDate":"2026-05-29"}', 50, 1, 1);
```

- [ ] **Step 4: Run schema test**

Run:

```bash
pnpm test apps/api/src/db/schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Apply local migration**

Run:

```bash
pnpm db:migrate:local
```

Expected: Wrangler applies both migrations to the local D1 database.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat: add D1 schema"
```

## Task 4: Worker API Shell

**Files:**
- Create: `apps/api/src/env.ts`
- Create: `apps/api/src/http/errors.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/index.ts`
- Create: `apps/api/src/index.test.ts`

- [ ] **Step 1: Create failing API tests**

Create `apps/api/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import app from "./index";

const env = {
  APP_ORIGIN: "http://127.0.0.1:5173",
  COOKIE_DOMAIN: "127.0.0.1",
  ENVIRONMENT: "test"
};

describe("api shell", () => {
  it("responds to health checks", async () => {
    const res = await app.request("/api/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "riceark-api" });
  });

  it("returns structured errors for missing routes", async () => {
    const res = await app.request("/api/missing", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "Route not found" }
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm test apps/api/src/index.test.ts
```

Expected: FAIL because API files do not exist.

- [ ] **Step 3: Implement Worker app shell**

Create `apps/api/src/env.ts`:

```ts
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  APP_ORIGIN: string;
  COOKIE_DOMAIN: string;
  ENVIRONMENT: "local" | "test" | "production";
  LOSTARK_API_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
}
```

Create `apps/api/src/http/errors.ts`:

```ts
import type { Context } from "hono";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function jsonError(c: Context, error: ApiError): Response {
  return c.json({ error: { code: error.code, message: error.message } }, error.status);
}

export function notFound(): ApiError {
  return new ApiError(404, "not_found", "Route not found");
}
```

Create `apps/api/src/routes/health.ts`:

```ts
import { Hono } from "hono";
import type { Env } from "../env";

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get("/health", (c) => c.json({ ok: true, service: "riceark-api" }));
```

Create `apps/api/src/index.ts`:

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { ApiError, jsonError, notFound } from "./http/errors";
import { healthRoutes } from "./routes/health";

const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.use("*", async (c, next) => {
  const origin = c.env.APP_ORIGIN;
  return cors({
    origin,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true
  })(c, next);
});

app.route("/", healthRoutes);

app.notFound((c) => jsonError(c, notFound()));

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return jsonError(c, error);
  }

  console.error(error);
  return jsonError(c, new ApiError(500, "internal_error", "Internal server error"));
});

export default app;
```

- [ ] **Step 4: Run test to verify pass**

Run:

```bash
pnpm test apps/api/src/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat: add worker api shell"
```

## Task 5: Session Cookies And D1 Auth Helpers

**Files:**
- Create: `apps/api/src/auth/cookies.ts`
- Create: `apps/api/src/auth/sessions.ts`
- Create: `apps/api/src/auth/sessions.test.ts`

- [ ] **Step 1: Create failing session tests**

Create `apps/api/src/auth/sessions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSessionCookie, clearSessionCookie } from "./cookies";
import { hashSessionToken } from "./sessions";

describe("session helpers", () => {
  it("builds secure HttpOnly cookies", () => {
    const cookie = buildSessionCookie("abc", "riceark.example", 3600);
    expect(cookie).toContain("riceark_session=abc");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=3600");
  });

  it("clears session cookies", () => {
    expect(clearSessionCookie("riceark.example")).toContain("Max-Age=0");
  });

  it("hashes session tokens deterministically", async () => {
    await expect(hashSessionToken("token", "secret")).resolves.toBe(
      await hashSessionToken("token", "secret")
    );
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm test apps/api/src/auth/sessions.test.ts
```

Expected: FAIL because auth helper files do not exist.

- [ ] **Step 3: Implement cookie and session helpers**

Create `apps/api/src/auth/cookies.ts`:

```ts
const SESSION_COOKIE = "riceark_session";

export function buildSessionCookie(token: string, domain: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Domain=${domain}`,
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

export function clearSessionCookie(domain: string): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    `Domain=${domain}`,
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((part) => part.trim());
  const match = cookies.find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : null;
}
```

Create `apps/api/src/auth/sessions.ts`:

```ts
import type { Env } from "../env";

const encoder = new TextEncoder();

export async function hashSessionToken(token: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(token));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function createSession(env: Env, userId: string, token: string, now = new Date()): Promise<void> {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");
  const tokenHash = await hashSessionToken(token, env.SESSION_SECRET);
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), userId, tokenHash, expires)
    .run();
}
```

- [ ] **Step 4: Run test to verify pass**

Run:

```bash
pnpm test apps/api/src/auth/sessions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth
git commit -m "feat: add session helpers"
```

## Task 6: OAuth Login Routes

**Files:**
- Create: `apps/api/src/auth/providers.ts`
- Create: `apps/api/src/auth/oauth.ts`
- Create: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/routes/auth.test.ts`

- [ ] **Step 1: Create failing OAuth route tests**

Create `apps/api/src/routes/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import app from "../index";

const env = {
  APP_ORIGIN: "http://127.0.0.1:5173",
  COOKIE_DOMAIN: "127.0.0.1",
  ENVIRONMENT: "test",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  DISCORD_CLIENT_ID: "discord-client",
  DISCORD_CLIENT_SECRET: "discord-secret",
  SESSION_SECRET: "test-secret"
};

describe("auth routes", () => {
  it("redirects to Google OAuth", async () => {
    const res = await app.request("/api/auth/google/start", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("accounts.google.com");
  });

  it("rejects unknown providers", async () => {
    const res = await app.request("/api/auth/unknown/start", {}, env);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm test apps/api/src/routes/auth.test.ts
```

Expected: FAIL because auth routes are not registered.

- [ ] **Step 3: Implement OAuth provider config**

Create `apps/api/src/auth/providers.ts`:

```ts
import type { Env } from "../env";

export type OAuthProvider = "google" | "discord";

export interface OAuthProviderConfig {
  id: OAuthProvider;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
}

export function getOAuthProvider(env: Env, provider: string): OAuthProviderConfig | null {
  if (provider === "google" && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return {
      id: "google",
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scope: "openid email profile"
    };
  }

  if (provider === "discord" && env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    return {
      id: "discord",
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      authorizationUrl: "https://discord.com/oauth2/authorize",
      tokenUrl: "https://discord.com/api/oauth2/token",
      userInfoUrl: "https://discord.com/api/users/@me",
      scope: "identify email"
    };
  }

  return null;
}
```

- [ ] **Step 4: Implement OAuth routes**

Create `apps/api/src/auth/oauth.ts`:

```ts
import type { OAuthProviderConfig } from "./providers";

export function buildRedirectUri(origin: string, provider: string): string {
  return `${origin}/api/auth/${provider}/callback`;
}

export function buildAuthorizationUrl(config: OAuthProviderConfig, redirectUri: string, state: string): string {
  const url = new URL(config.authorizationUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  return url.toString();
}
```

Create `apps/api/src/routes/auth.ts`:

```ts
import { Hono } from "hono";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { buildAuthorizationUrl, buildRedirectUri } from "../auth/oauth";
import { getOAuthProvider } from "../auth/providers";

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.get("/auth/:provider/start", (c) => {
  const providerName = c.req.param("provider");
  const provider = getOAuthProvider(c.env, providerName);
  if (!provider) throw new ApiError(404, "unknown_provider", "Unknown OAuth provider");

  const state = crypto.randomUUID();
  const redirectUri = buildRedirectUri(c.env.APP_ORIGIN, provider.id);
  const location = buildAuthorizationUrl(provider, redirectUri, state);
  const stateCookie = [
    `riceark_oauth_state=${state}`,
    "Path=/",
    "Max-Age=600",
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");

  return new Response(null, {
    status: 302,
    headers: {
      location,
      "set-cookie": stateCookie
    }
  });
});
```

Modify `apps/api/src/index.ts` to register auth routes:

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { ApiError, jsonError, notFound } from "./http/errors";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";

const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.use("*", async (c, next) => {
  const origin = c.env.APP_ORIGIN;
  return cors({
    origin,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true
  })(c, next);
});

app.route("/", authRoutes);
app.route("/", healthRoutes);

app.notFound((c) => jsonError(c, notFound()));

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return jsonError(c, error);
  }

  console.error(error);
  return jsonError(c, new ApiError(500, "internal_error", "Internal server error"));
});

export default app;
```

- [ ] **Step 5: Run test to verify pass**

Run:

```bash
pnpm test apps/api/src/routes/auth.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "feat: add oauth start routes"
```

## Task 7: OAuth Callback, Current User, And Logout

**Files:**
- Modify: `apps/api/src/auth/oauth.ts`
- Modify: `apps/api/src/auth/sessions.ts`
- Create: `apps/api/src/auth/requireUser.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Test: `apps/api/src/auth/oauth.test.ts`

- [ ] **Step 1: Create failing OAuth exchange tests**

Create `apps/api/src/auth/oauth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractOAuthState, normalizeProviderProfile } from "./oauth";

describe("oauth helpers", () => {
  it("extracts the stored oauth state cookie", () => {
    expect(extractOAuthState("other=1; riceark_oauth_state=abc; next=2")).toBe("abc");
  });

  it("normalizes Google profile fields", () => {
    expect(
      normalizeProviderProfile("google", {
        sub: "google-1",
        name: "쌀먹",
        email: "user@example.com",
        picture: "https://example.com/avatar.png"
      })
    ).toEqual({
      provider: "google",
      providerUserId: "google-1",
      displayName: "쌀먹",
      email: "user@example.com",
      avatarUrl: "https://example.com/avatar.png"
    });
  });

  it("normalizes Discord profile fields", () => {
    expect(
      normalizeProviderProfile("discord", {
        id: "discord-1",
        username: "rice",
        global_name: "쌀먹",
        email: "user@example.com",
        avatar: null
      })
    ).toEqual({
      provider: "discord",
      providerUserId: "discord-1",
      displayName: "쌀먹",
      email: "user@example.com",
      avatarUrl: null
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm test apps/api/src/auth/oauth.test.ts
```

Expected: FAIL because `extractOAuthState` and `normalizeProviderProfile` are not implemented.

- [ ] **Step 3: Add OAuth callback helpers**

Modify `apps/api/src/auth/oauth.ts`:

```ts
import type { OAuthProvider, OAuthProviderConfig } from "./providers";

export interface ProviderProfile {
  provider: OAuthProvider;
  providerUserId: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export function buildRedirectUri(origin: string, provider: string): string {
  return `${origin}/api/auth/${provider}/callback`;
}

export function buildAuthorizationUrl(config: OAuthProviderConfig, redirectUri: string, state: string): string {
  const url = new URL(config.authorizationUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  return url.toString();
}

export function extractOAuthState(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((part) => part.trim());
  const match = cookies.find((part) => part.startsWith("riceark_oauth_state="));
  return match ? decodeURIComponent(match.slice("riceark_oauth_state=".length)) : null;
}

export function clearOAuthStateCookie(): string {
  return "riceark_oauth_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
}

export function normalizeProviderProfile(provider: OAuthProvider, raw: Record<string, unknown>): ProviderProfile {
  if (provider === "google") {
    return {
      provider,
      providerUserId: String(raw.sub),
      displayName: String(raw.name ?? raw.email ?? "Google User"),
      email: raw.email ? String(raw.email) : null,
      avatarUrl: raw.picture ? String(raw.picture) : null
    };
  }

  const avatarHash = raw.avatar ? String(raw.avatar) : null;
  const providerUserId = String(raw.id);
  return {
    provider,
    providerUserId,
    displayName: String(raw.global_name ?? raw.username ?? "Discord User"),
    email: raw.email ? String(raw.email) : null,
    avatarUrl: avatarHash ? `https://cdn.discordapp.com/avatars/${providerUserId}/${avatarHash}.png` : null
  };
}
```

- [ ] **Step 4: Add session lookup and authenticated user helper**

Modify `apps/api/src/auth/sessions.ts`:

```ts
import type { Env } from "../env";

const encoder = new TextEncoder();

export interface AuthenticatedUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export async function hashSessionToken(token: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(token));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function createSession(env: Env, userId: string, token: string, now = new Date()): Promise<void> {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");
  const tokenHash = await hashSessionToken(token, env.SESSION_SECRET);
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), userId, tokenHash, expires)
    .run();
}

export async function findUserBySessionToken(env: Env, token: string): Promise<AuthenticatedUser | null> {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");
  const tokenHash = await hashSessionToken(token, env.SESSION_SECRET);
  const row = await env.DB.prepare(
    `SELECT users.id, users.display_name, users.avatar_url
     FROM sessions
     INNER JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > CURRENT_TIMESTAMP
     LIMIT 1`
  )
    .bind(tokenHash)
    .first<{ id: string; display_name: string; avatar_url: string | null }>();

  return row ? { id: row.id, displayName: row.display_name, avatarUrl: row.avatar_url } : null;
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");
  const tokenHash = await hashSessionToken(token, env.SESSION_SECRET);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}
```

Create `apps/api/src/auth/requireUser.ts`:

```ts
import type { Context } from "hono";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { readSessionCookie } from "./cookies";
import { findUserBySessionToken, type AuthenticatedUser } from "./sessions";

export async function requireUser(c: Context<{ Bindings: Env }>): Promise<AuthenticatedUser> {
  const token = readSessionCookie(c.req.header("cookie") ?? null);
  if (!token) throw new ApiError(401, "unauthorized", "Login required");
  const user = await findUserBySessionToken(c.env, token);
  if (!user) throw new ApiError(401, "unauthorized", "Login required");
  return user;
}
```

- [ ] **Step 5: Implement OAuth callback, current user, and logout routes**

Modify `apps/api/src/routes/auth.ts`:

```ts
import { Hono } from "hono";
import type { Env } from "../env";
import { buildSessionCookie, clearSessionCookie, readSessionCookie } from "../auth/cookies";
import {
  buildAuthorizationUrl,
  buildRedirectUri,
  clearOAuthStateCookie,
  extractOAuthState,
  normalizeProviderProfile
} from "../auth/oauth";
import { getOAuthProvider } from "../auth/providers";
import { createSession, createSessionToken, deleteSession } from "../auth/sessions";
import { requireUser } from "../auth/requireUser";
import { ApiError } from "../http/errors";

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.get("/auth/:provider/start", (c) => {
  const providerName = c.req.param("provider");
  const provider = getOAuthProvider(c.env, providerName);
  if (!provider) throw new ApiError(404, "unknown_provider", "Unknown OAuth provider");

  const state = crypto.randomUUID();
  const redirectUri = buildRedirectUri(c.env.APP_ORIGIN, provider.id);
  const location = buildAuthorizationUrl(provider, redirectUri, state);
  const stateCookie = [
    `riceark_oauth_state=${state}`,
    "Path=/",
    "Max-Age=600",
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");

  return new Response(null, { status: 302, headers: { location, "set-cookie": stateCookie } });
});

authRoutes.get("/auth/:provider/callback", async (c) => {
  const providerName = c.req.param("provider");
  const provider = getOAuthProvider(c.env, providerName);
  if (!provider) throw new ApiError(404, "unknown_provider", "Unknown OAuth provider");

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state || extractOAuthState(c.req.header("cookie") ?? null) !== state) {
    throw new ApiError(400, "invalid_oauth_state", "Invalid OAuth state");
  }

  const redirectUri = buildRedirectUri(c.env.APP_ORIGIN, provider.id);
  const tokenResponse = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri
    })
  });
  if (!tokenResponse.ok) throw new ApiError(502, "oauth_token_failed", "OAuth token exchange failed");

  const tokenJson = (await tokenResponse.json()) as { access_token: string };
  const profileResponse = await fetch(provider.userInfoUrl, {
    headers: { authorization: `Bearer ${tokenJson.access_token}`, accept: "application/json" }
  });
  if (!profileResponse.ok) throw new ApiError(502, "oauth_profile_failed", "OAuth profile request failed");

  const profile = normalizeProviderProfile(provider.id, (await profileResponse.json()) as Record<string, unknown>);
  const existing = await c.env.DB.prepare(
    "SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?"
  )
    .bind(profile.provider, profile.providerUserId)
    .first<{ user_id: string }>();

  const userId = existing?.user_id ?? crypto.randomUUID();
  if (!existing) {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users (id, display_name, avatar_url) VALUES (?, ?, ?)")
        .bind(userId, profile.displayName, profile.avatarUrl),
      c.env.DB.prepare(
        "INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, email) VALUES (?, ?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), userId, profile.provider, profile.providerUserId, profile.email),
      c.env.DB.prepare("INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)").bind(userId)
    ]);
  }

  const sessionToken = createSessionToken();
  await createSession(c.env, userId, sessionToken);

  return new Response(null, {
    status: 302,
    headers: [
      ["location", c.env.APP_ORIGIN],
      ["set-cookie", clearOAuthStateCookie()],
      ["set-cookie", buildSessionCookie(sessionToken, c.env.COOKIE_DOMAIN, 30 * 24 * 60 * 60)]
    ]
  });
});

authRoutes.get("/session", async (c) => {
  const user = await requireUser(c);
  return c.json({ user });
});

authRoutes.post("/auth/logout", async (c) => {
  const token = readSessionCookie(c.req.header("cookie") ?? null);
  if (token) await deleteSession(c.env, token);
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": clearSessionCookie(c.env.COOKIE_DOMAIN) }
  });
});
```

- [ ] **Step 6: Run OAuth tests and API checks**

Run:

```bash
pnpm test apps/api/src/auth/oauth.test.ts && pnpm --filter @riceark/api check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth apps/api/src/routes/auth.ts
git commit -m "feat: complete oauth session flow"
```

## Task 8: Lost Ark API Proxy And Cache

**Files:**
- Create: `apps/api/src/lostark/client.ts`
- Create: `apps/api/src/lostark/normalize.ts`
- Create: `apps/api/src/routes/characters.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/lostark/normalize.test.ts`

- [ ] **Step 1: Create failing normalization tests**

Create `apps/api/src/lostark/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeLostArkCharacter } from "./normalize";

describe("normalizeLostArkCharacter", () => {
  it("normalizes API fields used by the import UI", () => {
    expect(
      normalizeLostArkCharacter({
        CharacterName: "바드쌀",
        ServerName: "루페온",
        CharacterClassName: "바드",
        ItemAvgLevel: "1,640.00"
      })
    ).toEqual({
      name: "바드쌀",
      serverName: "루페온",
      className: "바드",
      itemLevel: "1,640.00"
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm test apps/api/src/lostark/normalize.test.ts
```

Expected: FAIL because normalize module does not exist.

- [ ] **Step 3: Implement Lost Ark normalization and client**

Create `apps/api/src/lostark/normalize.ts`:

```ts
export interface LostArkArmoryCharacter {
  CharacterName: string;
  ServerName: string;
  CharacterClassName: string;
  ItemAvgLevel: string;
}

export interface ImportedCharacterCandidate {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
}

export function normalizeLostArkCharacter(character: LostArkArmoryCharacter): ImportedCharacterCandidate {
  return {
    name: character.CharacterName,
    serverName: character.ServerName,
    className: character.CharacterClassName,
    itemLevel: character.ItemAvgLevel
  };
}
```

Create `apps/api/src/lostark/client.ts`:

```ts
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { normalizeLostArkCharacter, type ImportedCharacterCandidate, type LostArkArmoryCharacter } from "./normalize";

const BASE_URL = "https://developer-lostark.game.onstove.com";

export async function searchRosterCharacters(env: Env, characterName: string): Promise<ImportedCharacterCandidate[]> {
  if (!env.LOSTARK_API_KEY) {
    throw new ApiError(500, "lostark_key_missing", "Lost Ark API key is not configured");
  }

  const cacheKey = `lostark:roster:${characterName.toLowerCase()}`;
  const cached = await env.CACHE.get(cacheKey, "json");
  if (Array.isArray(cached)) {
    return cached as ImportedCharacterCandidate[];
  }

  const response = await fetch(`${BASE_URL}/characters/${encodeURIComponent(characterName)}/siblings`, {
    headers: {
      accept: "application/json",
      authorization: `bearer ${env.LOSTARK_API_KEY}`
    }
  });

  if (!response.ok) {
    throw new ApiError(response.status, "lostark_api_error", "Lost Ark API request failed");
  }

  const raw = (await response.json()) as LostArkArmoryCharacter[];
  const normalized = raw.map(normalizeLostArkCharacter);
  await env.CACHE.put(cacheKey, JSON.stringify(normalized), { expirationTtl: 60 * 30 });
  return normalized;
}
```

- [ ] **Step 4: Run normalization test**

Run:

```bash
pnpm test apps/api/src/lostark/normalize.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add character search route**

Create `apps/api/src/routes/characters.ts`:

```ts
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { searchRosterCharacters } from "../lostark/client";

export const characterRoutes = new Hono<{ Bindings: Env }>();

characterRoutes.get(
  "/characters/search",
  zValidator("query", z.object({ name: z.string().min(1).max(20) })),
  async (c) => {
    const { name } = c.req.valid("query");
    const characters = await searchRosterCharacters(c.env, name);
    return c.json({ characters });
  }
);
```

Modify `apps/api/src/index.ts` to import and route `characterRoutes`:

```ts
import { characterRoutes } from "./routes/characters";
```

Add route registration above health:

```ts
app.route("/", authRoutes);
app.route("/", characterRoutes);
app.route("/", healthRoutes);
```

- [ ] **Step 6: Run API checks**

Run:

```bash
pnpm --filter @riceark/api check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src
git commit -m "feat: add lost ark character search"
```

## Task 9: Character Import Persistence

**Files:**
- Create: `apps/api/src/db/characters.ts`
- Modify: `apps/api/src/routes/characters.ts`
- Test: `packages/core/test/characters.test.ts`

- [ ] **Step 1: Add character import dedupe test**

Create `packages/core/test/characters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeCharacterSelection } from "../src/characters";

describe("normalizeCharacterSelection", () => {
  it("deduplicates selected characters by server and name", () => {
    expect(
      normalizeCharacterSelection([
        { name: "바드쌀", serverName: "루페온", className: "바드", itemLevel: "1,640.00" },
        { name: "바드쌀", serverName: "루페온", className: "바드", itemLevel: "1,640.00" }
      ])
    ).toEqual([{ name: "바드쌀", serverName: "루페온", className: "바드", itemLevel: "1,640.00" }]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm test packages/core/test/characters.test.ts
```

Expected: FAIL because `packages/core/src/characters.ts` does not exist.

- [ ] **Step 3: Implement character selection normalization**

Create `packages/core/src/characters.ts`:

```ts
export interface CharacterSelection {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
}

export function normalizeCharacterSelection(characters: CharacterSelection[]): CharacterSelection[] {
  const byKey = new Map<string, CharacterSelection>();
  for (const character of characters) {
    byKey.set(`${character.serverName}:${character.name}`, character);
  }
  return [...byKey.values()].sort((a, b) => a.serverName.localeCompare(b.serverName) || a.name.localeCompare(b.name));
}
```

Modify `packages/core/src/index.ts`:

```ts
export * from "./characters";
export * from "./completions";
export * from "./reset";
export * from "./types";
```

- [ ] **Step 4: Add D1 import helper and route**

Create `apps/api/src/db/characters.ts`:

```ts
import type { CharacterSelection } from "@riceark/core";
import { normalizeCharacterSelection } from "@riceark/core";
import type { Env } from "../env";

export async function saveSelectedCharacters(env: Env, userId: string, selected: CharacterSelection[]): Promise<void> {
  const characters = normalizeCharacterSelection(selected);
  const statements = characters.map((character, index) =>
    env.DB.prepare(
      `INSERT INTO characters (id, user_id, name, server_name, class_name, item_level, sort_order, enabled, deleted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, name, server_name)
       DO UPDATE SET class_name = excluded.class_name,
                     item_level = excluded.item_level,
                     enabled = 1,
                     deleted_at = NULL,
                     updated_at = CURRENT_TIMESTAMP`
    ).bind(
      crypto.randomUUID(),
      userId,
      character.name,
      character.serverName,
      character.className,
      character.itemLevel,
      index * 10
    )
  );
  if (statements.length > 0) await env.DB.batch(statements);
}
```

Modify `apps/api/src/routes/characters.ts`:

```ts
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireUser } from "../auth/requireUser";
import { saveSelectedCharacters } from "../db/characters";
import { searchRosterCharacters } from "../lostark/client";

export const characterRoutes = new Hono<{ Bindings: Env }>();

characterRoutes.get(
  "/characters/search",
  zValidator("query", z.object({ name: z.string().min(1).max(20) })),
  async (c) => {
    await requireUser(c);
    const { name } = c.req.valid("query");
    const characters = await searchRosterCharacters(c.env, name);
    return c.json({ characters });
  }
);

characterRoutes.post(
  "/characters/import",
  zValidator(
    "json",
    z.object({
      characters: z.array(
        z.object({
          name: z.string().min(1).max(20),
          serverName: z.string().min(1).max(20),
          className: z.string().min(1).max(30),
          itemLevel: z.string().min(1).max(20)
        })
      ).min(1).max(30)
    })
  ),
  async (c) => {
    const user = await requireUser(c);
    const { characters } = c.req.valid("json");
    await saveSelectedCharacters(c.env, user.id, characters);
    return c.json({ ok: true });
  }
);
```

- [ ] **Step 5: Run tests and API checks**

Run:

```bash
pnpm test packages/core/test/characters.test.ts && pnpm --filter @riceark/api check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core apps/api/src
git commit -m "feat: save imported characters"
```

## Task 10: Dashboard Read Model And Completion Mutations

**Files:**
- Create: `apps/api/src/db/dashboard.ts`
- Create: `apps/api/src/db/completions.ts`
- Create: `apps/api/src/routes/dashboard.ts`
- Modify: `apps/api/src/index.ts`
- Test: `packages/core/test/completions.test.ts`

- [ ] **Step 1: Add core completion merge test**

Create `packages/core/test/completions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mergeCompletionPatches } from "../src/completions";

describe("mergeCompletionPatches", () => {
  it("keeps only the latest patch for the same task character and period", () => {
    expect(
      mergeCompletionPatches([
        { taskId: "a", characterId: "c1", periodKey: "daily:2026-05-29", completed: true },
        { taskId: "a", characterId: "c1", periodKey: "daily:2026-05-29", completed: false }
      ])
    ).toEqual([{ taskId: "a", characterId: "c1", periodKey: "daily:2026-05-29", completed: false }]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm test packages/core/test/completions.test.ts
```

Expected: FAIL because `packages/core/src/completions.ts` does not exist.

- [ ] **Step 3: Implement completion patch merge**

Create `packages/core/src/completions.ts`:

```ts
import type { CompletionPatch } from "./types";

function patchKey(patch: CompletionPatch): string {
  return [patch.taskId, patch.characterId ?? "roster", patch.periodKey].join(":");
}

export function mergeCompletionPatches(patches: CompletionPatch[]): CompletionPatch[] {
  const latest = new Map<string, CompletionPatch>();
  for (const patch of patches) {
    latest.set(patchKey(patch), patch);
  }
  return [...latest.values()];
}
```

Modify `packages/core/src/index.ts`:

```ts
export * from "./completions";
export * from "./reset";
export * from "./types";
```

- [ ] **Step 4: Run test to verify pass**

Run:

```bash
pnpm test packages/core/test/completions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add dashboard and completion routes**

Create `apps/api/src/db/dashboard.ts`:

```ts
import type { Env } from "../env";

export async function loadDashboard(env: Env, userId: string) {
  const [characters, tasks, completions, settings] = await Promise.all([
    env.DB.prepare("SELECT * FROM characters WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL ORDER BY sort_order, name")
      .bind(userId)
      .all(),
    env.DB.prepare("SELECT * FROM tasks WHERE (user_id = ? OR is_template = 1) AND enabled = 1 ORDER BY sort_order, name")
      .bind(userId)
      .all(),
    env.DB.prepare("SELECT task_id, character_id, period_key, completed FROM completions WHERE user_id = ?")
      .bind(userId)
      .all(),
    env.DB.prepare("SELECT * FROM user_settings WHERE user_id = ?")
      .bind(userId)
      .first()
  ]);

  return {
    characters: characters.results,
    tasks: tasks.results,
    completions: completions.results,
    settings: settings ?? { density: "default", row_height: 40, column_width: 132 }
  };
}
```

Create `apps/api/src/db/completions.ts`:

```ts
import type { CompletionPatch } from "@riceark/core";
import { mergeCompletionPatches } from "@riceark/core";
import type { Env } from "../env";

export async function saveCompletionPatches(env: Env, userId: string, patches: CompletionPatch[]): Promise<void> {
  const merged = mergeCompletionPatches(patches);
  const statements = merged.map((patch) =>
    env.DB.prepare(
      `INSERT INTO completions (id, user_id, task_id, character_id, period_key, completed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, task_id, character_id, period_key)
       DO UPDATE SET completed = excluded.completed, updated_at = CURRENT_TIMESTAMP`
    ).bind(
      crypto.randomUUID(),
      userId,
      patch.taskId,
      patch.characterId,
      patch.periodKey,
      patch.completed ? 1 : 0
    )
  );
  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
}
```

Create `apps/api/src/routes/dashboard.ts`:

```ts
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { CompletionPatch } from "@riceark/core";
import type { Env } from "../env";
import { requireUser } from "../auth/requireUser";
import { loadDashboard } from "../db/dashboard";
import { saveCompletionPatches } from "../db/completions";

const patchSchema = z.object({
  patches: z.array(
    z.object({
      taskId: z.string(),
      characterId: z.string().nullable(),
      periodKey: z.string(),
      completed: z.boolean()
    })
  ).max(200)
});

export const dashboardRoutes = new Hono<{ Bindings: Env }>();

dashboardRoutes.get("/dashboard", async (c) => {
  const user = await requireUser(c);
  const dashboard = await loadDashboard(c.env, user.id);
  return c.json(dashboard);
});

dashboardRoutes.patch("/completions", zValidator("json", patchSchema), async (c) => {
  const user = await requireUser(c);
  const { patches } = c.req.valid("json");
  await saveCompletionPatches(c.env, user.id, patches as CompletionPatch[]);
  return c.json({ ok: true });
});
```

Modify `apps/api/src/index.ts` to register `dashboardRoutes`.

- [ ] **Step 6: Run checks**

Run:

```bash
pnpm check && pnpm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core apps/api/src
git commit -m "feat: add dashboard and completion api"
```

## Task 11: Task And Settings API

**Files:**
- Create: `apps/api/src/db/tasks.ts`
- Create: `apps/api/src/db/settings.ts`
- Create: `apps/api/src/routes/tasks.ts`
- Create: `apps/api/src/routes/settings.ts`
- Modify: `apps/api/src/index.ts`
- Test: `packages/core/test/tasks.test.ts`

- [ ] **Step 1: Add task validation test**

Create `packages/core/test/tasks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTaskDefinition } from "../src/tasks";

describe("buildTaskDefinition", () => {
  it("creates a character daily task with the KST reset hour", () => {
    expect(buildTaskDefinition({ name: "쿠르잔 전선", scope: "character", resetType: "daily" })).toMatchObject({
      name: "쿠르잔 전선",
      scope: "character",
      resetRule: { type: "daily", hour: 6, timezone: "Asia/Seoul" }
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm test packages/core/test/tasks.test.ts
```

Expected: FAIL because `packages/core/src/tasks.ts` does not exist.

- [ ] **Step 3: Implement task builder**

Create `packages/core/src/tasks.ts`:

```ts
import type { ResetRule, ResetType, TaskScope } from "./types";

interface BuildTaskInput {
  name: string;
  scope: TaskScope;
  resetType: ResetType;
  anchorDate?: string;
  intervalDays?: number;
}

export function buildTaskDefinition(input: BuildTaskInput) {
  const resetRule: ResetRule =
    input.resetType === "daily"
      ? { type: "daily", hour: 6, timezone: "Asia/Seoul" }
      : input.resetType === "weekly"
        ? { type: "weekly", weekday: 3, hour: 6, timezone: "Asia/Seoul" }
        : input.resetType === "biweekly"
          ? { type: "biweekly", weekday: 3, hour: 6, timezone: "Asia/Seoul", anchorDate: input.anchorDate ?? "2026-05-27" }
          : { type: "custom", intervalDays: input.intervalDays ?? 1, hour: 6, timezone: "Asia/Seoul", anchorDate: input.anchorDate ?? "2026-05-29" };

  return {
    id: crypto.randomUUID(),
    name: input.name,
    scope: input.scope,
    resetRule,
    sortOrder: 0,
    enabled: true
  };
}
```

Modify `packages/core/src/index.ts`:

```ts
export * from "./characters";
export * from "./completions";
export * from "./reset";
export * from "./tasks";
export * from "./types";
```

- [ ] **Step 4: Add task and settings persistence**

Create `apps/api/src/db/tasks.ts`:

```ts
import type { ResetRule, TaskScope } from "@riceark/core";
import type { Env } from "../env";

export async function createUserTask(env: Env, userId: string, input: {
  name: string;
  scope: TaskScope;
  resetRule: ResetRule;
}): Promise<string> {
  const id = crypto.randomUUID();
  const maxSort = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM tasks WHERE user_id = ?")
    .bind(userId)
    .first<{ max_sort: number }>();
  await env.DB.prepare(
    `INSERT INTO tasks (id, user_id, name, scope, reset_type, reset_rule_json, sort_order, enabled, is_template)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`
  ).bind(id, userId, input.name, input.scope, input.resetRule.type, JSON.stringify(input.resetRule), (maxSort?.max_sort ?? 0) + 10).run();
  return id;
}
```

Create `apps/api/src/db/settings.ts`:

```ts
import type { Env } from "../env";

export async function saveUserSettings(env: Env, userId: string, input: {
  density: "comfortable" | "default" | "compact";
  rowHeight: number;
  columnWidth: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, density, row_height, column_width, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id)
     DO UPDATE SET density = excluded.density,
                   row_height = excluded.row_height,
                   column_width = excluded.column_width,
                   updated_at = CURRENT_TIMESTAMP`
  ).bind(userId, input.density, input.rowHeight, input.columnWidth).run();
}
```

- [ ] **Step 5: Add routes**

Create `apps/api/src/routes/tasks.ts`:

```ts
import { zValidator } from "@hono/zod-validator";
import { buildTaskDefinition } from "@riceark/core";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import { createUserTask } from "../db/tasks";
import type { Env } from "../env";

export const taskRoutes = new Hono<{ Bindings: Env }>();

taskRoutes.post(
  "/tasks",
  zValidator(
    "json",
    z.object({
      name: z.string().min(1).max(40),
      scope: z.enum(["character", "roster"]),
      resetType: z.enum(["daily", "weekly", "biweekly", "custom"]),
      anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      intervalDays: z.number().int().min(1).max(365).optional()
    })
  ),
  async (c) => {
    const user = await requireUser(c);
    const input = c.req.valid("json");
    const task = buildTaskDefinition(input);
    const id = await createUserTask(c.env, user.id, { name: task.name, scope: task.scope, resetRule: task.resetRule });
    return c.json({ id }, 201);
  }
);
```

Create `apps/api/src/routes/settings.ts`:

```ts
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import { saveUserSettings } from "../db/settings";
import type { Env } from "../env";

export const settingsRoutes = new Hono<{ Bindings: Env }>();

settingsRoutes.patch(
  "/settings",
  zValidator(
    "json",
    z.object({
      density: z.enum(["comfortable", "default", "compact"]),
      rowHeight: z.number().int().min(28).max(72),
      columnWidth: z.number().int().min(96).max(220)
    })
  ),
  async (c) => {
    const user = await requireUser(c);
    await saveUserSettings(c.env, user.id, c.req.valid("json"));
    return c.json({ ok: true });
  }
);
```

Modify `apps/api/src/index.ts` to register `taskRoutes` and `settingsRoutes`.

- [ ] **Step 6: Run tests and API checks**

Run:

```bash
pnpm test packages/core/test/tasks.test.ts && pnpm --filter @riceark/api check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core apps/api/src
git commit -m "feat: add task and settings api"
```

## Task 12: Vite React App Shell

**Files:**
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/styles.css`
- Create: `apps/web/vite.config.ts`

- [ ] **Step 1: Create web app files**

Create `apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]
}
```

Create `apps/web/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:8787"
    }
  }
});
```

Create `apps/web/index.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>RiceArk</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `apps/web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

Create `apps/web/src/App.tsx`:

```tsx
export function App() {
  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>RiceArk</h1>
        <div className="login-actions">
          <a className="button" href="/api/auth/discord/start">Discord</a>
          <a className="button" href="/api/auth/google/start">Google</a>
        </div>
      </header>
      <section className="workspace">
        <p>로스트아크 숙제 체크리스트를 불러오는 중입니다.</p>
      </section>
    </main>
  );
}
```

Create `apps/web/src/styles.css`:

```css
:root {
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #111827;
  background: #f4f6f8;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}

.app-shell {
  min-height: 100vh;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid #cfd6e0;
  background: #ffffff;
}

.topbar h1 {
  margin: 0;
  font-size: 20px;
  letter-spacing: 0;
}

.login-actions {
  display: flex;
  gap: 8px;
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid #8a96a8;
  border-radius: 6px;
  color: #111827;
  text-decoration: none;
  background: #ffffff;
}

.workspace {
  padding: 20px;
}
```

- [ ] **Step 2: Run web check**

Run:

```bash
pnpm --filter @riceark/web check
```

Expected: PASS.

- [ ] **Step 3: Build web app**

Run:

```bash
pnpm --filter @riceark/web build
```

Expected: Vite builds `apps/web/dist`.

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "feat: add web app shell"
```

## Task 13: Matrix Dashboard UI

**Files:**
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/features/dashboard/types.ts`
- Create: `apps/web/src/features/dashboard/ChecklistMatrix.tsx`
- Create: `apps/web/src/features/dashboard/useDashboard.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Add API client and dashboard types**

Create `apps/web/src/api/client.ts`:

```ts
export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include" });
  if (!response.ok) throw new Error(`GET ${path} failed`);
  return response.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`POST ${path} failed`);
  return response.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`PATCH ${path} failed`);
  return response.json() as Promise<T>;
}
```

Create `apps/web/src/features/dashboard/types.ts`:

```ts
export interface DashboardCharacter {
  id: string;
  name: string;
  server_name: string;
  class_name: string;
  item_level: string;
}

export interface DashboardTask {
  id: string;
  name: string;
  scope: "character" | "roster";
  reset_type: "daily" | "weekly" | "biweekly" | "custom";
  reset_rule_json: string;
}

export interface DashboardPayload {
  characters: DashboardCharacter[];
  tasks: DashboardTask[];
  completions: Array<{
    task_id: string;
    character_id: string | null;
    period_key: string;
    completed: number;
  }>;
  settings: {
    density: "comfortable" | "default" | "compact";
    row_height: number;
    column_width: number;
  };
}
```

- [ ] **Step 2: Add dashboard hook**

Create `apps/web/src/features/dashboard/useDashboard.ts`:

```ts
import { useEffect, useState } from "react";
import { apiGet } from "../../api/client";
import type { DashboardPayload } from "./types";

export function useDashboard() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<DashboardPayload>("/api/dashboard")
      .then((payload) => {
        if (active) setData(payload);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "대시보드를 불러오지 못했습니다.");
      });
    return () => {
      active = false;
    };
  }, []);

  return { data, error };
}
```

- [ ] **Step 3: Add matrix component**

Create `apps/web/src/features/dashboard/ChecklistMatrix.tsx`:

```tsx
import type { DashboardPayload } from "./types";

interface Props {
  dashboard: DashboardPayload;
}

export function ChecklistMatrix({ dashboard }: Props) {
  const columns = [{ id: "roster", name: "원정대" }, ...dashboard.characters.map((character) => ({
    id: character.id,
    name: character.name
  }))];

  return (
    <div
      className={`matrix density-${dashboard.settings.density}`}
      style={{
        "--row-height": `${dashboard.settings.row_height}px`,
        "--column-width": `${dashboard.settings.column_width}px`
      } as React.CSSProperties}
    >
      <div className="matrix-row matrix-header">
        <div className="matrix-task-cell">숙제</div>
        {columns.map((column) => (
          <div className="matrix-cell" key={column.id}>{column.name}</div>
        ))}
      </div>
      {dashboard.tasks.map((task) => (
        <div className="matrix-row" key={task.id}>
          <div className="matrix-task-cell">
            <span>{task.name}</span>
            <small>{task.reset_type}</small>
          </div>
          {columns.map((column) => {
            const disabled = task.scope === "character" && column.id === "roster";
            const rosterOnly = task.scope === "roster" && column.id !== "roster";
            return (
              <button
                className="matrix-cell matrix-check"
                disabled={disabled || rosterOnly}
                key={`${task.id}:${column.id}`}
                type="button"
              >
                {disabled || rosterOnly ? "" : ""}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Wire dashboard into app**

Modify `apps/web/src/App.tsx`:

```tsx
import { ChecklistMatrix } from "./features/dashboard/ChecklistMatrix";
import { useDashboard } from "./features/dashboard/useDashboard";

export function App() {
  const { data, error } = useDashboard();

  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>RiceArk</h1>
        <div className="login-actions">
          <a className="button" href="/api/auth/discord/start">Discord</a>
          <a className="button" href="/api/auth/google/start">Google</a>
        </div>
      </header>
      <section className="workspace">
        {error ? <p className="error-text">{error}</p> : null}
        {!data && !error ? <p>로스트아크 숙제 체크리스트를 불러오는 중입니다.</p> : null}
        {data ? <ChecklistMatrix dashboard={data} /> : null}
      </section>
    </main>
  );
}
```

Append to `apps/web/src/styles.css`:

```css
.matrix {
  overflow: auto;
  border: 1px solid #8f99aa;
  background: #ffffff;
}

.matrix-row {
  display: grid;
  grid-template-columns: 180px repeat(auto-fit, var(--column-width));
  min-height: var(--row-height);
  border-bottom: 1px solid #c8d0dc;
}

.matrix-header {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #e9eef5;
  font-weight: 700;
}

.matrix-task-cell,
.matrix-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: 6px 8px;
  border-right: 1px solid #c8d0dc;
  color: #111827;
}

.matrix-task-cell {
  align-items: flex-start;
  flex-direction: column;
  gap: 2px;
  font-weight: 650;
}

.matrix-task-cell small {
  color: #2f3a4b;
  font-size: 12px;
}

.matrix-check {
  border-top: 0;
  border-left: 0;
  border-bottom: 0;
  background: #ffffff;
  font: inherit;
  cursor: pointer;
}

.matrix-check:disabled {
  cursor: default;
  background: #f3f5f8;
}

.error-text {
  color: #b42318;
}
```

- [ ] **Step 5: Run checks and build**

Run:

```bash
pnpm --filter @riceark/web check && pnpm --filter @riceark/web build
```

Expected: PASS and Vite production build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat: add checklist matrix"
```

## Task 14: Batched Completion Updates

**Files:**
- Create: `apps/web/src/features/dashboard/useCompletionQueue.ts`
- Modify: `apps/web/src/features/dashboard/ChecklistMatrix.tsx`

- [ ] **Step 1: Add completion queue hook**

Create `apps/web/src/features/dashboard/useCompletionQueue.ts`:

```ts
import { useMemo, useRef } from "react";
import { apiPatch } from "../../api/client";

interface CompletionPatch {
  taskId: string;
  characterId: string | null;
  periodKey: string;
  completed: boolean;
}

export function useCompletionQueue() {
  const queue = useRef<CompletionPatch[]>([]);
  const timer = useRef<number | null>(null);

  return useMemo(() => {
    async function flush() {
      const patches = queue.current;
      queue.current = [];
      timer.current = null;
      if (patches.length > 0) {
        await apiPatch("/api/completions", { patches });
      }
    }

    function enqueue(patch: CompletionPatch) {
      queue.current.push(patch);
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
      timer.current = window.setTimeout(() => {
        void flush();
      }, 800);
    }

    return { enqueue };
  }, []);
}
```

- [ ] **Step 2: Wire queue into matrix**

Modify `apps/web/src/features/dashboard/ChecklistMatrix.tsx` so the component imports `useCompletionQueue` and calls it from enabled cells:

```tsx
import { getPeriodKey, type ResetRule } from "@riceark/core";
import { useState } from "react";
import { useCompletionQueue } from "./useCompletionQueue";
import type { DashboardPayload } from "./types";

interface Props {
  dashboard: DashboardPayload;
}

export function ChecklistMatrix({ dashboard }: Props) {
  const { enqueue } = useCompletionQueue();
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      dashboard.completions.map((completion) => [
        `${completion.task_id}:${completion.character_id ?? "roster"}:${completion.period_key}`,
        completion.completed === 1
      ])
    )
  );
  const columns = [{ id: "roster", name: "원정대" }, ...dashboard.characters.map((character) => ({
    id: character.id,
    name: character.name
  }))];

  return (
    <div
      className={`matrix density-${dashboard.settings.density}`}
      style={{
        "--row-height": `${dashboard.settings.row_height}px`,
        "--column-width": `${dashboard.settings.column_width}px`
      } as React.CSSProperties}
    >
      <div className="matrix-row matrix-header">
        <div className="matrix-task-cell">숙제</div>
        {columns.map((column) => (
          <div className="matrix-cell" key={column.id}>{column.name}</div>
        ))}
      </div>
      {dashboard.tasks.map((task) => {
        const resetRule = JSON.parse(task.reset_rule_json) as ResetRule;
        const periodKey = getPeriodKey(resetRule);
        return (
          <div className="matrix-row" key={task.id}>
            <div className="matrix-task-cell">
              <span>{task.name}</span>
              <small>{task.reset_type}</small>
            </div>
            {columns.map((column) => {
              const disabled = task.scope === "character" && column.id === "roster";
              const rosterOnly = task.scope === "roster" && column.id !== "roster";
              const characterId = column.id === "roster" ? null : column.id;
              const key = `${task.id}:${characterId ?? "roster"}:${periodKey}`;
              return (
                <button
                  className="matrix-cell matrix-check"
                  disabled={disabled || rosterOnly}
                  key={key}
                  type="button"
                  onClick={() => {
                    const next = !checked[key];
                    setChecked((current) => ({ ...current, [key]: next }));
                    enqueue({ taskId: task.id, characterId, periodKey, completed: next });
                  }}
                >
                  {disabled || rosterOnly ? "" : checked[key] ? "V" : ""}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Run checks and build**

Run:

```bash
pnpm --filter @riceark/web check && pnpm --filter @riceark/web build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/dashboard
git commit -m "feat: batch checklist updates"
```

## Task 15: Character Import, Task Form, And Density Controls

**Files:**
- Create: `apps/web/src/features/characters/CharacterImport.tsx`
- Create: `apps/web/src/features/tasks/TaskForm.tsx`
- Create: `apps/web/src/features/settings/DensityControls.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Add character import component**

Create `apps/web/src/features/characters/CharacterImport.tsx`:

```tsx
import { useState } from "react";
import { apiGet, apiPost } from "../../api/client";

interface Candidate {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
}

export function CharacterImport() {
  const [name, setName] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  async function search() {
    const result = await apiGet<{ characters: Candidate[] }>(`/api/characters/search?name=${encodeURIComponent(name)}`);
    setCandidates(result.characters);
    setSelected(Object.fromEntries(result.characters.map((character) => [`${character.serverName}:${character.name}`, true])));
  }

  async function save() {
    const characters = candidates.filter((character) => selected[`${character.serverName}:${character.name}`]);
    await apiPost("/api/characters/import", { characters });
    window.location.reload();
  }

  return (
    <section className="tool-panel">
      <h2>캐릭터 가져오기</h2>
      <div className="inline-form">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="대표 캐릭터명" />
        <button type="button" onClick={() => void search()}>검색</button>
      </div>
      <div className="candidate-list">
        {candidates.map((character) => {
          const key = `${character.serverName}:${character.name}`;
          return (
            <label className="candidate-row" key={key}>
              <input
                checked={Boolean(selected[key])}
                type="checkbox"
                onChange={(event) => setSelected((current) => ({ ...current, [key]: event.target.checked }))}
              />
              <span>{character.serverName}</span>
              <strong>{character.name}</strong>
              <span>{character.className}</span>
              <span>{character.itemLevel}</span>
            </label>
          );
        })}
      </div>
      {candidates.length > 0 ? <button type="button" onClick={() => void save()}>선택 캐릭터 등록</button> : null}
    </section>
  );
}
```

- [ ] **Step 2: Add task form**

Create `apps/web/src/features/tasks/TaskForm.tsx`:

```tsx
import { useState } from "react";
import { apiPost } from "../../api/client";

export function TaskForm() {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"character" | "roster">("character");
  const [resetType, setResetType] = useState<"daily" | "weekly" | "biweekly" | "custom">("daily");

  async function submit() {
    await apiPost("/api/tasks", { name, scope, resetType });
    window.location.reload();
  }

  return (
    <section className="tool-panel">
      <h2>숙제 추가</h2>
      <div className="inline-form">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="숙제 이름" />
        <select value={scope} onChange={(event) => setScope(event.target.value as "character" | "roster")}>
          <option value="character">캐릭터</option>
          <option value="roster">원정대</option>
        </select>
        <select value={resetType} onChange={(event) => setResetType(event.target.value as "daily" | "weekly" | "biweekly" | "custom")}>
          <option value="daily">일간</option>
          <option value="weekly">주간</option>
          <option value="biweekly">격주간</option>
          <option value="custom">커스텀</option>
        </select>
        <button type="button" onClick={() => void submit()}>추가</button>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Add density controls**

Create `apps/web/src/features/settings/DensityControls.tsx`:

```tsx
import { apiPatch } from "../../api/client";

interface Props {
  density: "comfortable" | "default" | "compact";
  rowHeight: number;
  columnWidth: number;
}

const presets = {
  comfortable: { rowHeight: 48, columnWidth: 156 },
  default: { rowHeight: 40, columnWidth: 132 },
  compact: { rowHeight: 32, columnWidth: 112 }
} as const;

export function DensityControls({ density }: Props) {
  async function save(nextDensity: keyof typeof presets) {
    const preset = presets[nextDensity];
    await apiPatch("/api/settings", {
      density: nextDensity,
      rowHeight: preset.rowHeight,
      columnWidth: preset.columnWidth
    });
    window.location.reload();
  }

  return (
    <section className="tool-panel">
      <h2>간격</h2>
      <div className="segmented">
        {Object.keys(presets).map((preset) => (
          <button
            className={preset === density ? "active" : ""}
            key={preset}
            type="button"
            onClick={() => void save(preset as keyof typeof presets)}
          >
            {preset === "comfortable" ? "편안하게" : preset === "default" ? "기본" : "조밀하게"}
          </button>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Wire controls into app**

Modify `apps/web/src/App.tsx`:

```tsx
import { CharacterImport } from "./features/characters/CharacterImport";
import { ChecklistMatrix } from "./features/dashboard/ChecklistMatrix";
import { useDashboard } from "./features/dashboard/useDashboard";
import { DensityControls } from "./features/settings/DensityControls";
import { TaskForm } from "./features/tasks/TaskForm";

export function App() {
  const { data, error } = useDashboard();

  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>RiceArk</h1>
        <div className="login-actions">
          <a className="button" href="/api/auth/discord/start">Discord</a>
          <a className="button" href="/api/auth/google/start">Google</a>
        </div>
      </header>
      <section className="workspace">
        {error ? <p className="error-text">{error}</p> : null}
        {!data && !error ? <p>로스트아크 숙제 체크리스트를 불러오는 중입니다.</p> : null}
        {data ? (
          <>
            <div className="tool-grid">
              <CharacterImport />
              <TaskForm />
              <DensityControls
                density={data.settings.density}
                rowHeight={data.settings.row_height}
                columnWidth={data.settings.column_width}
              />
            </div>
            <ChecklistMatrix dashboard={data} />
          </>
        ) : null}
      </section>
    </main>
  );
}
```

Append to `apps/web/src/styles.css`:

```css
.tool-grid {
  display: grid;
  grid-template-columns: minmax(280px, 1.4fr) minmax(260px, 1fr) minmax(220px, 0.8fr);
  gap: 12px;
  margin-bottom: 16px;
}

.tool-panel {
  border: 1px solid #b7c1cf;
  border-radius: 8px;
  background: #ffffff;
  padding: 12px;
}

.tool-panel h2 {
  margin: 0 0 10px;
  font-size: 15px;
}

.inline-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.inline-form input,
.inline-form select {
  min-height: 34px;
  border: 1px solid #8a96a8;
  border-radius: 6px;
  padding: 0 8px;
}

.candidate-list {
  display: grid;
  gap: 6px;
  margin: 10px 0;
}

.candidate-row {
  display: grid;
  grid-template-columns: 24px 80px 1fr 90px 80px;
  gap: 8px;
  align-items: center;
  min-height: 32px;
}

.segmented {
  display: flex;
  gap: 6px;
}

.segmented button.active {
  background: #111827;
  color: #ffffff;
}
```

- [ ] **Step 5: Run web checks and build**

Run:

```bash
pnpm --filter @riceark/web check && pnpm --filter @riceark/web build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat: add checklist management controls"
```

## Task 16: Deployment Documentation And Smoke Checks

**Files:**
- Create: `docs/deployment/cloudflare.md`
- Modify: `README.md`

- [ ] **Step 1: Add deployment document**

Create `docs/deployment/cloudflare.md`:

```md
# Cloudflare Deployment

## Required Cloudflare Resources

- Pages project: `riceark`
- Worker: `riceark-api`
- D1 database: `riceark`
- KV namespace: `riceark-cache`

## Required Worker Secrets

- `LOSTARK_API_KEY`
- `SESSION_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`

## Local Setup

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Apply local D1 migrations:

   ```bash
   pnpm db:migrate:local
   ```

3. Run the API:

   ```bash
   pnpm dev:api
   ```

4. Run the web app:

   ```bash
   pnpm dev:web
   ```

## Verification

Run:

```bash
pnpm check
pnpm test
pnpm build
```

Expected: all commands exit with code 0.

## Cost Guardrails

- Keep checklist updates batched.
- Keep Lost Ark roster search cached.
- Watch Workers requests and D1 writes after launch.
- Upgrade to Workers Paid when DAU approaches 100-300 or free-tier usage reaches about 50%.
```

Create `README.md`:

```md
# RiceArk

RiceArk is a Lost Ark checklist service for tracking daily, weekly, biweekly, and custom reset tasks across characters and roster-wide activities.

## Current Architecture

- Cloudflare Pages frontend
- Cloudflare Worker API
- Cloudflare D1 app database
- Cloudflare KV/Cache for Lost Ark API caching

## Development

```bash
pnpm install
pnpm db:migrate:local
pnpm dev:api
pnpm dev:web
```

## Verification

```bash
pnpm check
pnpm test
pnpm build
```

See `docs/deployment/cloudflare.md` for deployment setup.
```

- [ ] **Step 2: Run final verification**

Run:

```bash
pnpm check && pnpm test && pnpm build
```

Expected: all checks pass and both API and web builds complete.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/deployment/cloudflare.md
git commit -m "docs: add deployment guide"
```

## Implementation Checkpoints

After each task:

- Run the exact verification command listed in the task.
- Commit only the files for that task.
- Do not start the next task while the current task has failing tests.

After Task 4:

- Start the local Worker with `pnpm dev:api`.
- Visit `http://127.0.0.1:8787/api/health`.
- Confirm JSON response is `{"ok":true,"service":"riceark-api"}`.

After Task 15:

- Start the API and web app in separate terminals.
- Visit `http://127.0.0.1:5173`.
- Confirm the first viewport is the checklist tool, not a marketing page.
- Confirm the matrix remains readable at desktop width and scrolls horizontally on narrow width.

After Task 16:

- Review the Cloudflare dashboard for Workers, D1, and KV bindings before production deploy.
- Set production secrets through Wrangler or the Cloudflare dashboard.
- Apply D1 migrations to the production database.

## Spec Coverage Review

- Matrix checklist UI: Tasks 12-15.
- Daily, weekly, biweekly, custom reset logic: Task 2.
- KST reset boundaries: Task 2.
- Character and roster task scopes: Tasks 3, 10, 11, 13.
- Login with Google and Discord: Tasks 5-7.
- Lost Ark API character import: Tasks 8, 9, 15.
- Cloudflare Pages/Workers/D1 architecture: Tasks 1, 3, 4, 12, 16.
- Cost guardrails through batching and caching: Tasks 8, 10, 14, 16.
- User density and spacing preferences: Tasks 3, 11, 15.

## Completion Criteria

- `pnpm check`, `pnpm test`, and `pnpm build` pass.
- Local Worker responds to `/api/health`.
- A logged-in user can load the dashboard, search Lost Ark characters, import selected characters, add a task, change density, and check/uncheck cells.
- Checklist writes are batched through `/api/completions`.
- Deployment documentation lists all required Cloudflare resources and secrets.
