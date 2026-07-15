# Shared And Public Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop shared views from loading unrelated private board data and add bounded browser/server caches only where the accepted staleness and account-isolation rules permit them.

**Architecture:** Shared lookup uses a small authenticated overview while direct public detail loads independently and revalidates on focus. Public patch-note and event responses use canonical credential-free Cache API keys; Lost Ark roster search uses one bounded KV object and in-flight deduplication rather than per-character cache writes.

**Tech Stack:** Cloudflare Cache API, KV, Hono, React 19, Lost Ark Open API, TypeScript, Vitest.

**Prerequisite:** Complete the foundation, reliable-writes, and sheet-aware-read plans first.

---

### Task 1: Add A Sharing Overview And Favorite Detail Contract

**Files:**
- Modify: `apps/api/src/db/boardReads.ts`
- Modify: `apps/api/src/db/boardReads.test.ts`
- Modify: `apps/api/src/routes/board.ts`
- Modify: `apps/api/src/routes/board.test.ts`

- [ ] **Step 1: Write failing route and DB tests**

Cover authenticated overview, anonymous rejection, no tables/notes/axis/cells/completions in the payload, per-share favorite status, stopped-share false/404 behavior, and private response headers.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/api/src/db/boardReads.test.ts apps/api/src/routes/board.test.ts`

Expected: FAIL because the new endpoints do not exist.

- [ ] **Step 3: Implement the overview read**

Use this exact response shape:

```ts
export interface BoardSharingOverview {
  sheets: BoardSheetManifestItem[];
  shares: BoardShareSummary[];
  favorites: BoardShareFavoriteSummary[];
}
```

Load sheet summaries, active owner shares, and valid favorites concurrently after one `requireUser`. Do not call `loadBoard`, `loadBoardBootstrap`, or `loadBoardSheet`.

- [ ] **Step 4: Add routes**

```ts
boardRoutes.get("/board/sharing-overview", async (c) => {
  const user = await requireUser(c);
  const overview = await loadBoardSharingOverview(c.env, user.id);
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie");
  return c.json(overview);
});

boardRoutes.get("/board/share-favorites/:shareId", zValidator("param", boardShareIdParamSchema), async (c) => {
  const user = await requireUser(c);
  const { shareId } = c.req.valid("param");
  const favorite = await isBoardShareFavorite(c.env, user.id, shareId);
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie");
  return c.json({ favorite });
});
```

Keep legacy list endpoints during the compatibility window.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm test apps/api/src/db/boardReads.test.ts apps/api/src/routes/board.test.ts`

```bash
git add apps/api/src/db/boardReads.ts apps/api/src/db/boardReads.test.ts apps/api/src/routes/board.ts apps/api/src/routes/board.test.ts
git commit -m "Add lightweight board sharing overview"
```

### Task 2: Make Shared Detail And Hub Reads Lazy

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.ts`
- Modify: `apps/web/src/features/shared-rice-bin/SharedRiceBinPanel.tsx`
- Modify: `apps/web/src/features/shared-rice-bin/SharedRiceBinPanel.test.ts`

- [ ] **Step 1: Write failing request-order tests**

Use an injected or mocked API boundary and assert:

```ts
expect(calls[0]).toBe(`/api/shared-rice-bins/${shareId}`);
expect(calls).not.toContain("/api/board/bootstrap");
expect(calls).not.toContain("/api/board/sharing-overview");
```

For authenticated direct detail, the favorite-detail request occurs only after the public board resolves. Opening the hub issues one overview request. Anonymous detail issues no favorite request. Starting/stopping shares and toggling favorites update local overview state without reloading owner board.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/web/src/App.test.ts apps/web/src/features/shared-rice-bin/SharedRiceBinPanel.test.ts`

Expected: FAIL because authenticated shared views currently enable `useBoard` and eagerly load two list endpoints.

- [ ] **Step 3: Stop owner-board work outside the board view**

In `App.tsx` use:

```ts
const isBoardEnabled = session.status === "authenticated" && activeView === "board";
const isBoardPollingEnabled = isBoardEnabled;
```

Remove `ownerBoard` and `onOwnerBoardChanged` props from `SharedRiceBinPanel`. The sheet summaries required for share management come from its overview.

- [ ] **Step 4: Split direct detail and hub effects**

When `initialShareId` is present, fetch the public board immediately and render it. After success, authenticated users fetch only `/api/board/share-favorites/:shareId`. When no direct id is present, authenticated users fetch `/api/board/sharing-overview`; anonymous users render lookup without it.

- [ ] **Step 5: Update mutations locally**

Share-start returns `{ shareId }`; insert the returned share beside the matching overview sheet. Share-stop removes it. Favorite add/remove updates the detail boolean and overview favorite list from mutation responses; do not call a blanket refresh after each mutation.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm test apps/web/src/App.test.ts apps/web/src/features/shared-rice-bin/SharedRiceBinPanel.test.ts`

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.ts apps/web/src/features/shared-rice-bin/SharedRiceBinPanel.tsx apps/web/src/features/shared-rice-bin/SharedRiceBinPanel.test.ts
git commit -m "Lazy-load shared board data"
```

### Task 3: Revalidate Shared State On Focus Without Polling

**Files:**
- Modify: `apps/api/src/db/board.ts`
- Modify: `apps/api/src/db/board.test.ts`
- Modify: `apps/api/src/routes/board.ts`
- Modify: `apps/api/src/routes/board.test.ts`
- Modify: `apps/web/src/features/shared-rice-bin/SharedRiceBinPanel.tsx`
- Modify: `apps/web/src/features/shared-rice-bin/SharedRiceBinPanel.test.ts`

- [ ] **Step 1: Write failing focus tests**

Cover additive `version` metadata on shared detail, `no-store` headers on detail/version responses, unchanged version -> no detail reload, changed version -> one detail reload, stopped share -> clear loaded board and show lookup error, hidden tab -> no request, and hub focus -> one overview refresh. Assert no interval/timer is created.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/web/src/features/shared-rice-bin/SharedRiceBinPanel.test.ts`

Expected: FAIL because shared state has no revalidation lifecycle.

- [ ] **Step 3: Store the loaded shared version**

Extend `SharedBoardPayload` and the public detail response with a top-level additive `version` copied from the shared sheet's `content_version`; do not leak the database field into the generic `BoardSheet` client contract. Initialize the loaded version from `payload.version`. On `window.focus` or visibility becoming visible, request `/api/shared-rice-bins/:shareId/version`. Reload detail only when `version` differs. Treat 404 as revoked and clear it.

- [ ] **Step 4: Revalidate overview only on hub return/focus**

Reuse the in-memory overview while navigating inside the shared hub. Refresh it on visible focus and when returning from detail to the hub; do not add a background interval.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm test apps/web/src/features/shared-rice-bin/SharedRiceBinPanel.test.ts`

```bash
git add apps/api/src/db/board.ts apps/api/src/db/board.test.ts apps/api/src/routes/board.ts apps/api/src/routes/board.test.ts apps/web/src/features/shared-rice-bin/SharedRiceBinPanel.tsx apps/web/src/features/shared-rice-bin/SharedRiceBinPanel.test.ts
git commit -m "Revalidate shared boards on focus"
```

### Task 4: Add A Canonical Public JSON Cache Helper

**Files:**
- Create: `apps/api/src/cache/publicJsonCache.ts`
- Create: `apps/api/src/cache/publicJsonCache.test.ts`
- Create: `apps/api/src/cache/boundedInFlight.ts`
- Create: `apps/api/src/cache/boundedInFlight.test.ts`

- [ ] **Step 1: Write failing cache-safety tests**

Test canonical query ordering, no cookies/authorization in cache keys, 200-only storage, TTL header, cache miss/hit, failed-loader non-storage, in-flight dedupe, 50-key cap, and `finally` cleanup after resolve/reject/abort.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/api/src/cache/publicJsonCache.test.ts apps/api/src/cache/boundedInFlight.test.ts`

Expected: FAIL because the helpers do not exist.

- [ ] **Step 3: Implement canonical keys**

```ts
export function buildPublicCacheKey(requestUrl: string, namespace: string): Request {
  const source = new URL(requestUrl);
  const canonical = new URL(`/__riceark-cache/${namespace}`, source.origin);
  [...source.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .forEach(([key, value]) => canonical.searchParams.append(key, value));
  return new Request(canonical.toString(), { method: "GET" });
}
```

No request headers are copied.

- [ ] **Step 4: Implement cache read/write and bounded in-flight reuse**

`getPublicJson` reads `caches.default` only when present, returns a cloned hit, otherwise calls the loader through `withBoundedInFlight`. Store only `response.ok && response.status === 200` responses. Set `Cache-Control: public, max-age=<ttl>` on both hit and miss responses.

`withBoundedInFlight` stores promises only, refuses to retain a 51st distinct key, and deletes the exact settled promise in `finally`.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm test apps/api/src/cache/publicJsonCache.test.ts apps/api/src/cache/boundedInFlight.test.ts && pnpm --filter @riceark/api check`

```bash
git add apps/api/src/cache/publicJsonCache.ts apps/api/src/cache/publicJsonCache.test.ts apps/api/src/cache/boundedInFlight.ts apps/api/src/cache/boundedInFlight.test.ts
git commit -m "Add safe bounded public response cache"
```

### Task 5: Cache Patch Notes For Five Minutes

**Files:**
- Modify: `apps/api/src/routes/patchNotes.ts`
- Modify: `apps/api/src/routes/patchNotes.test.ts`

- [ ] **Step 1: Write failing cache-policy tests**

Assert public GET has `public, max-age=300`, repeated GET calls D1 once on a cache hit, admin mutations delete the server cache key, private cookies do not alter the key, and failed D1 responses are not cached.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/api/src/routes/patchNotes.test.ts`

Expected: FAIL because patch notes always read D1 and lack public cache headers.

- [ ] **Step 3: Wrap only the public GET**

Use namespace `patch-notes:v1`, TTL 300, and a loader returning `Response.json({ notes: await listPatchNotes(c.env) })`. POST/PATCH/DELETE remain authenticated and `private, no-store`; after a successful mutation, call `deletePublicCacheKey` through `executionCtx.waitUntil` without delaying the response.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm test apps/api/src/routes/patchNotes.test.ts`

```bash
git add apps/api/src/routes/patchNotes.ts apps/api/src/routes/patchNotes.test.ts
git commit -m "Cache public patch notes"
```

### Task 6: Cache Normalized Lost Ark Events For One Minute

**Files:**
- Modify: `apps/api/src/lostark/events.ts`
- Modify: `apps/api/src/lostark/events.test.ts`
- Modify: `apps/api/src/routes/lostarkEvents.ts`
- Modify: `apps/api/src/routes/lostarkEvents.test.ts`

- [ ] **Step 1: Write failing cache, timeout, and canonicalization tests**

Cover reward filter sort/dedupe, one normalized Cache API entry for equivalent queries, `public, max-age=60`, one raw KV read/fetch/write on a miss, 15-minute raw KV reuse, concurrent miss dedupe, eight-second external signal, no same-request retry, no cache on error, and calendar status writes only on origin attempts.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/api/src/lostark/events.test.ts apps/api/src/routes/lostarkEvents.test.ts`

Expected: FAIL because normalized responses are not publicly cached and origin fetch has no deadline.

- [ ] **Step 3: Canonicalize reward filters**

`parseLostArkRewardFilters` returns unique values in fixed order `gold,card,coin,silver,cardXp`. The route rebuilds the canonical query from that order before creating its Cache API key.

- [ ] **Step 4: Deduplicate raw origin fetches**

Use `withBoundedInFlight("lostark-calendar", loader)`. The loader checks raw KV, then calls `fetchExternal` once on miss, writes raw KV with 15-minute TTL, and updates status best-effort. Cache neither failed promises nor a normalized error response.

- [ ] **Step 5: Cache the normalized response**

Use namespace `lostark-events:v1`, TTL 60, and normalize with the request time only inside the miss loader. A Cache API hit returns the stored `generatedAt`; after 60 seconds it is regenerated from the still-valid raw KV without another Lost Ark call.

- [ ] **Step 6: Preserve upstream rate limits**

When Lost Ark returns `429`, parse `Retry-After`, construct an `ApiError` with response header metadata, and have `jsonError` apply that header. Do not retry inside the same RiceArk request.

- [ ] **Step 7: Run tests and commit**

Run: `pnpm test apps/api/src/lostark/events.test.ts apps/api/src/routes/lostarkEvents.test.ts`

```bash
git add apps/api/src/lostark/events.ts apps/api/src/lostark/events.test.ts apps/api/src/routes/lostarkEvents.ts apps/api/src/routes/lostarkEvents.test.ts apps/api/src/http/errors.ts apps/api/src/index.ts
git commit -m "Cache normalized Lost Ark events"
```

### Task 7: Replace Per-Character Search Caches With One Enriched Roster

**Files:**
- Modify: `apps/api/src/lostark/client.ts`
- Modify: `apps/api/src/lostark/client.test.ts`
- Create: `apps/web/src/features/characters/characterSearchCache.ts`
- Create: `apps/web/src/features/characters/characterSearchCache.test.ts`
- Modify: `apps/web/src/features/characters/CharacterImport.tsx`
- Modify: `apps/web/src/features/characters/CharacterImport.test.ts`

- [ ] **Step 1: Write failing request and cache-budget tests**

For N sibling candidates on a cold miss, assert one siblings request, at most N profile requests, max concurrency four, exactly one KV put, no `lostark:combat-power` keys, one shared in-flight promise for duplicate queries, and cleanup after failure. On the client, assert five-minute hits, query normalization, duplicate in-flight reuse, and eviction to 20 entries.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm test apps/api/src/lostark/client.test.ts apps/web/src/features/characters/characterSearchCache.test.ts apps/web/src/features/characters/CharacterImport.test.ts`

Expected: FAIL because the server writes one combat-power key per character and the client has no search cache.

- [ ] **Step 3: Build one server roster cache value**

Use normalized lower-case trimmed query key `lostark:roster:v3:<name>`. On miss, fetch siblings through `fetchExternal`, enrich profiles with `mapWithConcurrency(..., 4, ...)`, sort once, and perform one KV put with 30-minute TTL. Profile failures leave only that candidate's combat power null; a siblings failure rejects the request and writes nothing.

- [ ] **Step 4: Add server in-flight dedupe**

Wrap the full miss path with a 50-key bounded promise map keyed exactly like KV. Delete settled promises in `finally`. Cache bypass for explicit refresh remains isolated to direct profile refresh and never calls roster search.

- [ ] **Step 5: Add the client LRU**

```ts
export const CHARACTER_SEARCH_CACHE_TTL_MS = 5 * 60_000;
export const CHARACTER_SEARCH_CACHE_MAX_ENTRIES = 20;

export interface CharacterSearchCacheEntry {
  expiresAt: number;
  characters: CharacterCandidate[];
}
```

Expose `searchCharactersCached(name, fetcher, now = Date.now())`. Normalize keys with `trim().toLowerCase()`, return cloned arrays, share one in-flight promise per key, and evict the least recently used settled entry.

- [ ] **Step 6: Integrate without changing selection UX**

`CharacterImport.search()` calls the cache helper. Each successful result still selects all candidates initially and preserves the existing bulk-selection UI and messages.

- [ ] **Step 7: Run tests and commit**

Run: `pnpm test apps/api/src/lostark/client.test.ts apps/web/src/features/characters/characterSearchCache.test.ts apps/web/src/features/characters/CharacterImport.test.ts`

```bash
git add apps/api/src/lostark/client.ts apps/api/src/lostark/client.test.ts apps/web/src/features/characters/characterSearchCache.ts apps/web/src/features/characters/characterSearchCache.test.ts apps/web/src/features/characters/CharacterImport.tsx apps/web/src/features/characters/CharacterImport.test.ts
git commit -m "Bound Lost Ark roster search caching"
```

### Task 8: Measure Initial Bundle Splitting Without Regressing UX

**Files:**
- Modify: `apps/web/src/App.tsx` only when the measured threshold is met.
- Modify: `apps/web/src/App.test.ts` only when code splitting is retained.

- [ ] **Step 1: Record the current initial gzip bundle**

Run: `pnpm --filter @riceark/web build | tee /tmp/riceark-bundle-before.txt`

Expected baseline from 2026-07-15: approximately 125 KB gzip for the initial JS asset. Use the fresh command output as authoritative.

- [ ] **Step 2: Trial lazy boundaries**

Use `React.lazy` for `AdminDashboard`, `AuctionCalculatorModal`, `PatchNotesModal`, and `SharedRiceBinPanel`; keep `BoardOverview` eager because it is the first authenticated experience. Wrap each conditional surface in `Suspense` with the existing loader text; modal fallbacks render the current visually-hidden loading label inside the fixed overlay shell so the top bar does not shift.

- [ ] **Step 3: Build and compare**

Run: `pnpm --filter @riceark/web build | tee /tmp/riceark-bundle-after.txt`

Retain the code only when initial gzip decreases by at least 20 KB and tests show no eager chunk fetch before the feature opens. When the threshold is missed, remove the trial edits with an explicit reverse patch and leave no bundle-related commit.

- [ ] **Step 4: Test and commit only an accepted split**

Run: `pnpm test apps/web/src/App.test.ts && pnpm --filter @riceark/web check`

If retained:

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.ts
git commit -m "Split secondary application views"
```

### Task 9: Verify Cache Isolation And Full Quality Gates

**Files:**
- Modify only when verification reveals a defect in files from this plan.

- [ ] **Step 1: Run targeted cache and shared tests**

Run:

```bash
pnpm test \
  apps/api/src/cache/publicJsonCache.test.ts \
  apps/api/src/cache/boundedInFlight.test.ts \
  apps/api/src/routes/patchNotes.test.ts \
  apps/api/src/routes/lostarkEvents.test.ts \
  apps/api/src/lostark/client.test.ts \
  apps/web/src/features/shared-rice-bin/SharedRiceBinPanel.test.ts \
  apps/web/src/features/characters/CharacterImport.test.ts
```

Expected: PASS.

- [ ] **Step 2: Scan cache policies**

Run:

```bash
rg -n "Cache-Control|caches\.default|CACHE\.put|inFlight" apps/api/src
```

Expected: positive public TTLs appear only on patch notes and Lost Ark events; owner boards, shared boards, session, and admin responses remain `no-store` or `private, no-store`.

- [ ] **Step 3: Run all gates**

Run: `git diff --check && pnpm check && pnpm test && pnpm test:d1-sql && pnpm measure:board-reads && pnpm build`

Expected: every command passes.

- [ ] **Step 4: Perform local Pages smoke tests**

Run: `pnpm --filter @riceark/web preview:pages`

Verify direct shared detail, lookup return, owner board, patch notes, events, character search, and admin direct link in the browser. Stop the server after the smoke pass.
