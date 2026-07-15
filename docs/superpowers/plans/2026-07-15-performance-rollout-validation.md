# Performance Rollout And Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the optimization phases against explicit RiceArk flow budgets, prepare a reversible production candidate, and compare real Pages Functions and D1 usage after equivalent traffic.

**Architecture:** Deterministic local scripts and route tests provide per-flow evidence before deployment. Production remains a single Cloudflare Pages project whose Functions bundle the Hono API; each compatible phase is deployed behind an explicit user approval, then focused browser smoke tests and a final comparable 24-hour metrics window determine acceptance or rollback.

**Tech Stack:** pnpm, Vitest, Wrangler Pages, Wrangler D1, Cloudflare admin metrics, browser network inspection.

**Prerequisite:** The approved optimization design. Run Task 1 before implementation, then repeat Tasks 2-4 after foundation, reliable writes, sheet-aware reads, and shared/public caching respectively. Run Task 5 after the final phase.

**Execution Order:** Rollout Task 1 -> foundation plan -> rollout Tasks 2-4 -> reliable-writes plan -> rollout Tasks 2-4 -> sheet-aware-read plan -> rollout Tasks 2-4 -> shared/public-cache plan -> rollout Tasks 2-5.

---

### Task 1: Record A Reproducible Pre-Deployment Baseline

**Files:**
- Create: `docs/performance/2026-07-15-optimization-baseline.md`
- Modify: `docs/deployment/cloudflare-admin-usage.md`

- [ ] **Step 1: Define the report fields before measuring**

Record exact timestamp, commit SHA, test fixture, browser viewport, initial JS gzip bytes, API request count, D1 statement count, D1 rows read/written when available, and cache status for these flows before phase implementation:

1. authenticated three-sheet initial load;
2. first visit and unchanged return across three sheet tabs;
3. no-change version check and changed active/inactive sheet checks;
4. ten rapid completions and ten rapid cell-state paints;
5. 200-row completion, cell-state, ordering, import, and settings writes;
6. direct anonymous and authenticated shared detail;
7. patch-note and Lost Ark event cold/hot reads;
8. Lost Ark roster search cold/hot reads;
9. admin summary cold/hot reads.

The report contains aggregate counts only. Do not record session cookies, OAuth identities, character names, note content, or shared-rice-bin ids.

- [ ] **Step 2: Run the available pre-implementation baseline gates**

Run:

```bash
pnpm check
pnpm test
pnpm build
pnpm --filter @riceark/web build
```

Record total test counts and copy the emitted bundle sizes into the baseline report, including the prior initial bundle reference of `421.46 kB` raw and `125.27 kB` gzip for comparison. If the build output format changes, record the emitted asset filename and measured gzip bytes instead of estimating. `test:d1-sql` and `measure:board-reads` do not exist before implementation; add their numeric results after the reliable-writes and sheet-aware-read phases create them.

- [ ] **Step 3: Capture the current production aggregate**

Open the authenticated admin summary before deployment and record the one-day Workers/Pages requests, CPU percentile when available, D1 rows read/written, DB size, completion activity, and every warning. Label fixed admin-query cost separately from end-user traffic and mark unavailable counters as unavailable.

- [ ] **Step 4: Document the repeat procedure and commit**

Update `cloudflare-admin-usage.md` with the exact baseline and post-deploy comparison procedure, including the requirement to use comparable 24-hour windows.

```bash
git add docs/performance/2026-07-15-optimization-baseline.md docs/deployment/cloudflare-admin-usage.md
git commit -m "Record performance rollout baseline"
```

### Task 2: Run The Complete Release Candidate Gates

**Files:**
- Modify: `docs/performance/2026-07-15-optimization-baseline.md`

- [ ] **Step 1: Verify repository and generated artifacts**

Run from the optimization worktree:

```bash
git status --short
git diff --check main...HEAD
pnpm check
pnpm test
pnpm build
pnpm --filter @riceark/web build:functions
```

Expected: only intentionally uncommitted measurement updates before the report commit; all commands exit zero; the Pages Functions bundle resolves `@riceark/api/src/index` successfully.

After reliable writes, additionally run:

```bash
pnpm test:d1-sql
```

After sheet-aware reads and again after shared/public caching, additionally run:

```bash
pnpm test:d1-sql
pnpm measure:board-reads
```

- [ ] **Step 2: Enforce acceptance budgets**

Fail the release candidate unless all measured flows meet these limits:

- established owner bootstrap: one RiceArk board request and at most 10 D1 statements including auth;
- first-ever board initialization: at most 30 D1 statements;
- unchanged cached tab return: zero sheet-detail requests;
- version check: one API request and one D1 version statement;
- active remote change: version request plus one sheet-detail request;
- inactive remote change: no sheet-detail request until selection;
- each queued write body: at most 200 patches and 24 KiB, with both queues below 64 KiB aggregate;
- each 200-row array route: at most 20 D1 statements and fewer than 100 bindings per statement;
- table settings save: one API request and at most 10 D1 statements;
- direct shared detail: no owner-board bootstrap;
- public cache hit: no D1/KV origin loader execution;
- initial gzip JS does not grow; retain optional splitting only when it saves at least 20 KiB gzip.

- [ ] **Step 3: Commit the gate evidence**

Append the phase name, pass/fail values, and release candidate SHA to the report.

```bash
git add docs/performance/2026-07-15-optimization-baseline.md
git commit -m "Verify performance release candidate"
```

### Task 3: Prepare A Reversible Pages Deployment

**Files:**
- Create: `docs/performance/2026-07-15-optimization-rollout.md`

- [ ] **Step 1: Inspect production migrations without applying them**

Run:

```bash
pnpm --filter @riceark/api exec wrangler d1 migrations list riceark --remote
pnpm --filter @riceark/web exec wrangler pages deployment list --project-name riceark
```

Record pending migrations and the current known-good Pages deployment id for each phase. The planned optimization uses the existing version schema; any unexpected pending migration blocks deployment until reviewed.

- [ ] **Step 2: Record the production path**

Document that `apps/web/functions/api/[[path]].ts` imports the Hono API into Pages Functions. Production deployment therefore uses `pnpm deploy:web`; do not deploy the standalone `riceark-api` Worker unless routing is intentionally changed in a separate task.

- [ ] **Step 3: Stop for explicit production approval**

Present the phase name, gate report, pending-migration result, candidate SHA, and known-good deployment id to the user. Do not run a remote migration or deployment command until the user explicitly approves that phase's production deployment in that execution turn.

- [ ] **Step 4: Deploy the approved candidate**

When approved, apply only reviewed pending migrations, then deploy Pages:

```bash
pnpm --filter @riceark/api exec wrangler d1 migrations apply riceark --remote
pnpm deploy:web
```

If migration listing reports none pending, omit the apply command. Record the emitted deployment URL/id and timestamp in the rollout report.

- [ ] **Step 5: Define immediate rollback conditions**

Rollback to the recorded known-good Pages deployment through Cloudflare Pages if any smoke test exposes cross-account data, lost acknowledged writes, repeatable 5xx responses, authentication failure, or a private response with public cache headers. Stop the rollout rather than attempting a live data repair. The optimization adds no destructive schema migration, so application rollback remains compatible with the existing version columns.

### Task 4: Smoke-Test The Production User Flows

**Files:**
- Modify: `docs/performance/2026-07-15-optimization-rollout.md`

- [ ] **Step 1: Verify anonymous and authentication boundaries**

In a clean browser context, open `https://riceark.pages.dev`, confirm the session request completes, and confirm no owner-board request occurs while anonymous. Sign in, open `?view=admin` as an admin, and verify the route remains selected after session resolution.

- [ ] **Step 2: Verify the three-sheet board flow**

Open three sheets, use browser back and forward, then revisit each sheet. Check and uncheck cells, paint a custom cell state, edit a multiline note, switch tabs immediately, hide/show the page, and reload after acknowledgements. Confirm the latest intent persists, pending overlays never flash backward, and network requests match the measured flow budget.

- [ ] **Step 3: Verify sharing and public data**

Open a direct shared link while anonymous and authenticated; confirm neither path loads the owner's board. Change the owner sheet, refocus the shared view, and verify one version check followed by detail reload only when changed. Stop the share and confirm the next visible revalidation clears the detail. Open patch notes and Lost Ark events twice and confirm cache headers never appear on session, owner-board, shared-board, or admin responses.

- [ ] **Step 4: Verify external-service degradation**

Confirm Lost Ark and Cloudflare metric failures remain bounded by the eight-second deadline, preserve `Retry-After` on rate limits, and surface the existing structured warning/error without a same-request retry. Do not deliberately exhaust a production API quota; use the tested failure injection locally and inspect only naturally occurring production warnings.

- [ ] **Step 5: Record evidence and decision**

Write the deployment id, browser/network observations, pass/fail state for every smoke item, and any rollback action into the rollout report. Commit only non-sensitive aggregate evidence.

```bash
git add docs/performance/2026-07-15-optimization-rollout.md
git commit -m "Record production optimization smoke test"
```

### Task 5: Compare A Comparable 24-Hour Window

**Files:**
- Modify: `docs/performance/2026-07-15-optimization-rollout.md`
- Modify: `docs/superpowers/specs/2026-07-15-performance-caching-optimization-design.md`

- [ ] **Step 1: Collect post-deploy aggregates**

After a comparable 24-hour traffic window, record Workers/Pages requests, p50/p99 CPU when available, CPU-limit errors, D1 rows read/written, DB size, API 4xx/5xx groups, cache warnings, active users, and fixed admin-query cost. Keep raw user data out of the report.

- [ ] **Step 2: Compare normalized flows, not totals alone**

Calculate per-active-user and per-completion-update D1 reads/writes where the sample permits it. Explicitly list changes in traffic mix, admin visits, or Lost Ark failures that make a direct comparison uncertain. Do not claim a capacity multiplier from a small or distorted sample.

- [ ] **Step 3: Apply the acceptance decision**

Accept the rollout only when functional tests and flow budgets remain green, Workers requests/CPU are nonzero under real traffic, p99 CPU remains below the free-plan limit, no CPU-limit errors or new 5xx cluster appears, and no cache/account-isolation regression is observed. Otherwise document the failed criterion and roll back or schedule the smallest corrective phase.

- [ ] **Step 4: Record the observed rollout date and commit**

Update the design document only with measured outcomes and the actual production observation date.

```bash
git add docs/performance/2026-07-15-optimization-rollout.md docs/superpowers/specs/2026-07-15-performance-caching-optimization-design.md
git commit -m "Document optimization rollout results"
```
