# Pages Functions Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RiceArk deployable on `https://riceark.pages.dev` with same-origin `/api/*` Pages Functions, D1, KV, OAuth callbacks, and clear setup docs.

**Architecture:** Keep the existing Hono Worker API in `apps/api` and add a thin Pages Function adapter in `apps/web/functions/api/[[path]].ts`. The web package becomes the Pages deployment owner, with `_routes.json` limiting Function invocation to `/api/*` and docs explaining the Cloudflare/Google/Discord setup.

**Tech Stack:** TypeScript, React/Vite, Hono, Cloudflare Pages Functions, Cloudflare D1, Cloudflare KV, Wrangler, Vitest, pnpm workspaces.

---

## File Structure

- `apps/web/functions/api/[[path]].ts`: Pages Function adapter that forwards `/api/*` requests to the existing API app.
- `apps/web/functions/api/[[path]].test.ts`: Unit test proving the adapter can serve `/api/health`.
- `apps/web/public/_routes.json`: Pages routing config that invokes Functions only for `/api/*`.
- `apps/web/package.json`: Add the API workspace dependency, Wrangler dependency, and Pages Function build/preview scripts.
- `apps/web/tsconfig.json`: Include `functions/**/*.ts` and Cloudflare Worker types.
- `docs/deployment/cloudflare.md`: Expand into a step-by-step user deployment guide.
- `README.md`: Mention same-origin Pages Functions deployment.

---

### Task 1: Add Pages Function Adapter

**Files:**
- Create: `apps/web/functions/api/[[path]].test.ts`
- Create: `apps/web/functions/api/[[path]].ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/tsconfig.json`

- [ ] **Step 1: Write the failing adapter test**

Create `apps/web/functions/api/[[path]].test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import type { Env } from "@riceark/api/src/env";
import { onRequest } from "./[[path]]";

function testEnv(): Env {
  return {
    APP_ORIGIN: "https://riceark.pages.dev",
    COOKIE_DOMAIN: "riceark.pages.dev",
    ENVIRONMENT: "production",
    DB: {} as D1Database,
    CACHE: {} as KVNamespace
  };
}

describe("Pages API function", () => {
  it("forwards /api requests to the Hono API app", async () => {
    const response = await onRequest({
      request: new Request("https://riceark.pages.dev/api/health"),
      env: testEnv(),
      params: { path: ["health"] },
      waitUntil() {},
      passThroughOnException() {},
      next: async () => new Response("not found", { status: 404 }),
      data: {}
    } as EventContext<Env, "api/[[path]]", { path: string[] }>);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "riceark-api" });
  });
});
```

- [ ] **Step 2: Run the adapter test to verify RED**

Run: `pnpm test apps/web/functions/api/[[path]].test.ts`

Expected: FAIL because `./[[path]]` does not exist.

- [ ] **Step 3: Add the adapter implementation**

Create `apps/web/functions/api/[[path]].ts` with:

```ts
import apiApp from "@riceark/api/src/index";
import type { Env } from "@riceark/api/src/env";

export const onRequest: PagesFunction<Env> = (context) => {
  return apiApp.fetch(context.request, context.env, context);
};
```

Modify `apps/web/package.json` dependencies:

```json
"@riceark/api": "workspace:*"
```

Modify `apps/web/package.json` devDependencies:

```json
"wrangler": "^4.18.0"
```

Modify `apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "types": ["vite/client", "@cloudflare/workers-types"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "functions/**/*.ts", "vite.config.ts"]
}
```

- [ ] **Step 4: Run the adapter test to verify GREEN**

Run: `pnpm test apps/web/functions/api/[[path]].test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/web/functions/api/[[path]].ts apps/web/functions/api/[[path]].test.ts apps/web/package.json apps/web/tsconfig.json pnpm-lock.yaml
git commit -m "feat: add pages function api adapter"
```

---

### Task 2: Limit Pages Function Routing and Add Scripts

**Files:**
- Create: `apps/web/public/_routes.json`
- Modify: `apps/web/package.json`

- [ ] **Step 1: Write the failing route config test**

Create `apps/web/functions/routes-config.test.ts` with:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Pages routing config", () => {
  it("invokes Pages Functions only for API routes", async () => {
    const raw = await readFile(new URL("../public/_routes.json", import.meta.url), "utf8");
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      include: ["/api/*"],
      exclude: []
    });
  });
});
```

- [ ] **Step 2: Run the route config test to verify RED**

Run: `pnpm test apps/web/functions/routes-config.test.ts`

Expected: FAIL because `_routes.json` does not exist.

- [ ] **Step 3: Add route config and scripts**

Create `apps/web/public/_routes.json` with:

```json
{
  "version": 1,
  "include": ["/api/*"],
  "exclude": []
}
```

Update `apps/web/package.json` scripts:

```json
"build": "vite build",
"build:functions": "wrangler pages functions build functions --outdir ../../.wrangler/pages-functions-build --output-routes-path ../../.wrangler/pages-functions-build/_routes.json",
"check": "tsc -p tsconfig.json --noEmit",
"dev": "vite --host 127.0.0.1",
"deploy": "wrangler pages deploy dist --project-name riceark",
"preview:pages": "vite build && wrangler pages functions build functions --outdir ../../.wrangler/pages-functions-build --output-routes-path ../../.wrangler/pages-functions-build/_routes.json && wrangler pages dev dist --compatibility-date=2026-05-29 --compatibility-flag=nodejs_compat"
```

- [ ] **Step 4: Run route config and function build checks**

Run:

```bash
pnpm test apps/web/functions/routes-config.test.ts
pnpm --filter @riceark/web build:functions
```

Expected: both commands exit with code 0.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/web/public/_routes.json apps/web/functions/routes-config.test.ts apps/web/package.json
git commit -m "chore: configure pages function routing"
```

---

### Task 3: Expand Deployment Documentation

**Files:**
- Modify: `docs/deployment/cloudflare.md`
- Modify: `README.md`

- [ ] **Step 1: Update docs**

Update `docs/deployment/cloudflare.md` to include:

- Cloudflare Pages project settings for `riceark`.
- Build command `pnpm --filter @riceark/web build`.
- Build output `apps/web/dist`.
- Production URL `https://riceark.pages.dev`.
- D1/KV bindings named `DB` and `CACHE`.
- Environment variables and secrets.
- OAuth redirect URIs for Google and Discord.
- Lost Ark test character `냠수나이스1`.
- Post-deploy verification checklist.

Update `README.md` to mention Pages Functions same-origin API deployment and the deployment guide.

- [ ] **Step 2: Run docs sanity checks**

Run:

```bash
rg -n "riceark.pages.dev|/api/auth/google/callback|/api/auth/discord/callback|냠수나이스1" docs/deployment/cloudflare.md README.md
```

Expected: all key deployment strings are present.

- [ ] **Step 3: Commit**

Run:

```bash
git add docs/deployment/cloudflare.md README.md
git commit -m "docs: expand cloudflare deployment steps"
```

---

### Task 4: Final Verification

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run TypeScript checks**

Run: `pnpm check`

Expected: exit code 0.

- [ ] **Step 2: Run all tests**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 3: Run production builds**

Run:

```bash
pnpm build
pnpm --filter @riceark/web build:functions
```

Expected: all commands exit with code 0.

- [ ] **Step 4: Confirm clean status**

Run: `git status --short --branch`

Expected: clean `pages-functions-deploy` branch.
