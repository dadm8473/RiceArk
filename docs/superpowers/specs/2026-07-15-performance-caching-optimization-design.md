# RiceArk Performance and Caching Optimization Design

## 1. Purpose

RiceArk의 체감 응답성과 데이터 정합성을 유지하면서 Pages Functions 호출, D1 행 읽기와 쓰기, 응답 전송량을 줄인다. 목표는 현재 무료 Cloudflare 호스팅을 유지한 채 사용자 증가에 더 오래 대응하는 것이다.

이 설계는 다음 원칙을 따른다.

- 체크와 메모 저장의 신뢰성을 호출 절감보다 우선한다.
- 사용자가 보고 있는 탭은 현재와 같은 속도로 갱신한다.
- 서버 비용을 D1에서 더 작은 무료 한도를 가진 KV로 단순 이전하지 않는다.
- 인증 데이터는 공개 CDN 캐시에 저장하지 않는다.
- 각 단계는 배포 전후 수치로 효과를 확인할 수 있어야 한다.

Cloudflare 공식 무료 한도 기준은 2026-07-15 현재 Workers 요청 100,000회/일과 CPU 10 ms/호출, D1 읽기 5,000,000행/일, D1 쓰기 100,000행/일, KV 읽기 100,000키/일, KV 쓰기 1,000키/일이다. 무료 D1은 Worker 호출당 쿼리 50개와 SQL당 바인딩 100개로 제한된다.

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/kv/platform/pricing/

## 2. Baseline

2026-07-15 운영 데이터와 D1 Insights를 기준선으로 사용한다.

| Metric | Observed value |
| --- | ---: |
| Registered users | 9 |
| Users with completion activity in 24h | 4 |
| Active sessions | 51 |
| Sheets | 14 |
| Tables | 23 |
| Axis items | 360 |
| Cell states | 212 |
| Stored completions | 2,244 |
| D1 rows read in 24h | 97,625 |
| D1 rows written in 24h | 1,956 |
| D1 read queries in 24h | 4,002 |
| D1 write queries in 24h | 1,225 |
| Database size | about 2.4 MB |

사용자별 보드 분포는 탭 평균 1.56개, 최대 3개, 축 항목 평균 40개, 최대 97개다. 현재 운영 현황의 보수적인 D1 기준 수용 추정은 약 204 DAU다. 표본이 4 DAU로 작고 관리자 집계 비용이 섞여 있으므로 이 값은 절대 용량이 아니라 전후 비교 기준으로만 사용한다.

### 2.1 Highest-cost paths

D1 Insights에서 확인된 주요 비용은 다음과 같다.

| Query path | 24h executions | 24h rows read |
| --- | ---: | ---: |
| Full-board axis item load | 147 | 23,112 |
| Full-board cell state load | 134 | 14,438 |
| Current completion load | 122 | 7,254 |
| Sheet version list | 534 | 3,210 |
| Session lookup | 1,282 | 2,564 |
| Admin user/activity aggregate | 4 | 36,036 |
| Admin data aggregate | 4 | 12,828 |

핵심 관찰 결과는 다음과 같다.

1. `GET /api/board` loads every sheet even though the UI renders one sheet.
2. A full-board load immediately starts a separate `GET /api/board/versions` request.
3. Every authenticated API request repeats the session lookup.
4. Board version polling is already visibility-aware and elects one browser-tab leader, but it still executes two version queries per check.
5. A direct shared-rice-bin view also enables the owner's full board and loads shares and favorites before they are needed.
6. Table settings and cross-size edits fan out into one API request per axis item.
7. Expected anonymous `401` responses are recorded as D1 error-counter writes.
8. The admin summary performs full aggregate scans and currently distorts the capacity estimate.
9. Workers request and CPU metrics show zero because the configured Worker name is not the Pages project's production script name.
10. Direct `?view=admin` navigation is redirected before session checking finishes.
11. Several array mutations create one D1 statement per row and can exceed the free plan's 50-query or 100-binding limit.
12. Refreshing N saved characters currently re-enriches the full roster N times, multiplying Lost Ark requests and KV writes toward N squared.

## 3. Scope

### 3.1 Included

- Complete and test the board manifest and sheet content-version rules.
- Load only the active owner sheet and cache previously opened sheets in memory.
- Include the initial version summary in the board bootstrap response.
- Revalidate with a lightweight version request before replacing cached data.
- Keep the current owner-board polling cadence: 120 seconds while active, 300 seconds while idle, no hidden-tab polling, and an immediate focus/visibility check.
- Batch completion and cell-state writes without weakening tab-switch/page-hide delivery.
- Collapse high-fan-out table and axis settings saves into server-side batches.
- Convert row-by-row D1 array mutations to bounded set-based SQL within free-plan invocation limits.
- Delay owner-board, sharing overview, and favorite reads until the shared view needs them.
- Add bounded browser caching to public low-risk data.
- Correct Workers metrics and remove expected authentication noise from error counters.
- Measure D1 query/row cost and browser request count before and after each phase.

### 3.2 Not included

- IndexedDB or a full offline-first board.
- KV-backed or module-memory authentication caches.
- Signed stateless sessions, Durable Objects, WebSockets, SSE, or service workers.
- CDN caching of private owner boards or long-lived caching of shared boards.
- Deleting historical completions or adding speculative indexes without query-plan evidence.
- Changing the visible owner-board freshness contract.

These exclusions avoid stale cross-account data, session revocation delays, retry ordering conflicts, and a large operational surface that the current traffic does not justify.

### 3.3 Decision rationale

Keeping the full-board response and adding only `ETag` would reduce some transfer but would still execute the expensive D1 reads needed to build that response. Moving private boards or sessions to KV would consume a smaller free read allowance and add invalidation/revocation risk. Persisting a browser outbox would improve hard-close recovery but requires cross-tab/device conflict rules before stale writes can be replayed safely. Active-sheet reads plus explicit versions are selected because they remove D1 work while preserving a simple server-authoritative model.

## 4. Target Architecture

The owner board is split into a small manifest and one active-sheet payload. `useBoard` owns the manifest, active sheet id, per-sheet memory cache, version snapshot, polling, and pending optimistic patches. `BoardOverview` renders the supplied active sheet and emits user actions; it no longer owns URL parsing or data loading.

```text
session check
    |
    v
board bootstrap -------------------------+
  manifest + requested/default sheet     |
    |                                    |
    +--> useBoard manifest               |
    +--> sheet cache[activeSheetId]       |
                                           v
tab click --> cache valid? -- yes --> render immediately
                    |
                    no
                    v
              fetch one sheet

version poll/focus --> one lightweight summary query
    | unchanged: keep cache
    | active changed: fetch active sheet only
    | inactive changed: mark that cache entry stale
```

No background prefetch is performed. Loading an unopened sheet to make a future click faster would increase server traffic without evidence that the sheet will be used.

브라우저 탭 리더만 버전 요약을 폴링하고 `BroadcastChannel`로 결과를 전달한다. v2 리더 키와 메시지는 authenticated `userId`와 protocol version을 포함하며, 수신 탭은 둘 중 하나라도 다르면 무시한다. 각 탭은 전달받은 manifest와 sheet summary/version만 갱신하며, 현재 보이는 탭의 활성 sheet가 실제로 바뀐 경우에만 해당 sheet를 읽는다. 숨겨진 탭은 payload를 읽지 않고 stale 표시만 남긴 뒤 포커스를 받을 때 재검증한다.

## 5. Server Contracts

### 5.1 Board bootstrap

`GET /api/board/bootstrap?sheetId=<optional-owned-sheet-id>` returns one payload:

```ts
interface BoardSheetManifestItem {
  id: string;
  name: string;
  sort_order: number;
  is_default: number;
  version: number;
}

interface BoardBootstrapPayload {
  userId: string;
  settings: BoardDisplaySettings;
  manifest: {
    version: number;
    sheets: BoardSheetManifestItem[];
  };
  activeSheet: BoardSheetPayload;
}
```

The server selects the requested owned sheet. If it is missing or invalid, it selects the default sheet and then the first sorted sheet. The response contains the version snapshot used by the client, so the client does not issue an immediate version request.

Default-board creation changes from an unconditional preliminary `hasAnyBoardTable` query to a fallback: read the manifest first, initialize only when no sheet exists, then retry the bootstrap read.

### 5.2 Single-sheet load

`GET /api/board/sheets/:id` returns only data owned by that sheet:

```ts
interface BoardSheetPayload {
  sheet: BoardSheet & { content_version: number };
  tables: BoardTable[];
  notes: BoardNote[];
  axisItems: BoardAxisItem[];
  cellStates: BoardCellState[];
  completions: BoardCellCompletion[];
  periodFingerprint: string;
}
```

All SQL selects list required columns explicitly. Existing user/sheet/table indexes are used. New indexes are added only when `EXPLAIN QUERY PLAN` and D1 query metadata show a scan that the index removes.

The server builds `periodFingerprint` from the sorted, deduplicated current period keys at the same time it selects current completions. The client independently calculates the current fingerprint from the cached reset rules when deciding whether the payload is still reusable.

### 5.3 Lightweight version summary

`GET /api/board/versions` returns the following lightweight summary, loaded with one SQL statement using a CTE or join:

```ts
interface BoardVersionSummary {
  manifestVersion: number;
  sheets: BoardSheetManifestItem[];
  periodFingerprint: "";
}
```

Including the small sheet summaries lets another tab apply create, delete, rename, order, and default-sheet changes without a second manifest request. `version` remains compatible with the existing id/version entries. The deprecated, empty `periodFingerprint` field remains during the legacy-client window and is ignored by the new client; reset freshness is sheet-local. The bootstrap response initializes this same version snapshot.

The client computes the active sheet's current period fingerprint from cached reset rules. Existing reset-boundary scheduling remains in place. At a period boundary, the client invalidates the active completion view and fetches that sheet; it does not wait for a content-version change.

### 5.4 Application-managed revalidation

Owner board responses use:

```text
Cache-Control: private, no-store
Vary: Cookie
```

The application cache is memory-only and keyed by authenticated `userId` plus `sheetId`. A cache entry is reusable only when both conditions are true:

1. Its `sheet.content_version` equals the corresponding manifest item's `version`.
2. Its stored period fingerprint equals the fingerprint calculated for the current time.

This avoids cross-account browser-cache reuse and stale reset periods. A full page reload starts from the server; IndexedDB/sessionStorage persistence can be considered only after this design proves stable.

Sheet payloads use a least-recently-used limit of eight entries per user. The active sheet is never evicted, and pending write overlays live outside payload entries. Eviction therefore affects only future read traffic, not unsaved state.

Changing from the owner board to another app view stops polling but does not discard an already loaded cache for the same user. Logout or account identity change clears manifest, sheet cache, pending overlays, and version snapshots. A mutation `401` first pauses writes and shows the unsaved-state warning; if session resolution confirms that authentication is gone, the user-scoped state is cleared and is never transferred to a later account. If a remotely deleted sheet is active, the client removes its cache entry, selects the default or first sheet from the new manifest, and replaces the URL instead of adding a dead history entry.

Returning to the owner-board view renders a version-valid cached sheet immediately and starts a version check even when no browser focus event fires. A changed active sheet is replaced after its payload arrives; a changed inactive sheet remains stale until selected. This preserves the current focus-freshness behavior without making navigation wait on the network.

### 5.5 Sharing overview

`GET /api/board/sharing-overview` returns the authenticated user's sheet summaries, active shares, and favorites in one request. It does not load tables, axis items, cell states, notes, or completions.

- Direct shared detail: load the shared board first. For an authenticated user, read `GET /api/board/share-favorites/:shareId` afterward to obtain only `{ favorite: boolean }`; reuse an already loaded overview instead when possible. Favorite state never blocks shared-board rendering, and anonymous users do not issue this request.
- Shared lookup hub: load one sharing overview request.
- Share/favorite mutations update the local overview from their response instead of reloading the owner's full board.
- The owner's `useBoard` performs no fetch or polling while a direct shared detail is open. It may retain already-loaded memory for a later return by the same user.
- A loaded sharing overview is reused in memory and revalidated only when the shared hub regains focus; it has no background timer.

Shared payloads remain `no-store`. On focus or return to a visible tab, the existing shared version endpoint is checked. A stopped share returns `404` on that check and the loaded board is cleared; an already visible shared board can remain on screen only until its next focus/version check.

### 5.6 Deployment compatibility

The server endpoints and additive mutation metadata deploy before the new client. The existing `GET /api/board` continues returning the legacy full-board shape during the transition; only the new client calls `/api/board/bootstrap` and `/api/board/sheets/:id`. Existing create/update responses keep their current top-level fields, delete routes may change from `204` to a `200` JSON result that old clients safely ignore, and the old single-character refresh route remains available.

The sheet-aware client uses versioned v2 `localStorage` leader keys and `BroadcastChannel` names. It never consumes a v1 summary from an already-open legacy tab. At most one v1 and one v2 leader may poll during the transition; this temporary extra lightweight request is preferable to cross-version cache corruption.

Legacy full-board traffic is observed through Cloudflare request analytics rather than a new D1 counter. The endpoint is removed only in a later deployment after at least 30 days and negligible traffic, preventing an already-open old tab from receiving an incompatible payload.

## 6. Version Invariants

Versions are correctness controls, not approximate cache hints.

### 6.1 Manifest version

Increment `board_manifest_versions.version` exactly once for a successful request that changes the sheet list or sheet metadata used by navigation:

- create sheet
- delete sheet
- rename sheet
- reorder/default-sheet changes if introduced

Sharing state is returned by the sharing overview and does not require a manifest bump unless the manifest starts carrying that state.

### 6.2 Sheet content version

Increment `sheets.content_version` exactly once for each affected sheet in a successful mutation request:

- sheet rename or other sheet metadata rendered in a shared payload
- table create, update, layout, transpose, or delete
- note create, update, layout, lock, or delete
- axis item create, update, resize, reorder, hide, import, or delete
- character data changes reflected in an axis item
- completion batch
- cell-state batch

Batching 30 rows is one logical request and one sheet-version increment, not 30 increments. The data mutation and all required version increments execute in the same transactional D1 batch. Sheet statements use `UPDATE ... RETURNING id, content_version`; manifest statements use `INSERT ... ON CONFLICT DO UPDATE ... RETURNING user_id, version`. The route builds its response from those `D1Result` rows without a follow-up version query. Failed or rejected requests do not increment a version; D1 rolls back the entire batch when any statement fails.

- https://developers.cloudflare.com/d1/worker-api/d1-database/#batch

All version-affecting database helpers return affected sheet ids and resulting versions. Board-content mutation responses preserve their existing top-level domain fields, such as a newly created `id` or refreshed profile, and add version metadata:

```ts
type BoardMutationResult<T extends object = { ok: true }> = T & {
  versions: {
    sheets: Array<{ id: string; version: number }>;
    manifestVersion?: number;
  };
};
```

This lets the initiating tab adopt its own server version and prevents the next poll from interpreting its successful local write as an unknown remote change.

## 7. Write Path And Failure Handling

### 7.1 Completion and cell-state queues

Completion and cell-state changes use the same queue behavior while retaining separate endpoints and schemas.

- Apply the change optimistically.
- Coalesce by table, row item, column item, and period where applicable.
- Keep each queue at authenticated-user scope in `useBoard`, outside the active sheet component, so sheet and app-view transitions cannot discard it.
- Allow only one in-flight request per queue. A newer value for the same cell supersedes a failed older value before retry, preserving the user's latest intent.
- Flush after 800 ms during normal interaction.
- Send every queue request with `fetch(..., { keepalive: true })`, not only unload-time requests.
- Flush as soon as the UTF-8 serialized body approaches 24 KiB, and split at the lower of that byte budget or the endpoint's 200-patch limit. Two simultaneous queues then remain below the Fetch standard's 64 KiB in-flight keepalive budget.
- Flush immediately on `visibilitychange` to hidden and `pagehide`.
- Keep both queued and in-flight patches over a failed request.
- Retry network failures, `408`, `429`, and `5xx` responses with bounded exponential delays of 1, 2, 5, 10, and 30 seconds, then remain capped at 30 seconds; honor `Retry-After` when it is longer and also retry immediately on focus/online.
- Do not retry permanent validation, stale-period, locked-resource, or deleted-resource errors. Reconcile the owning sheet/manifest, remove only the rejected keys when the server supplies them, and surface the save failure.
- Pause the queue on `401`/`403` and hand control to session handling; never replay its patches under a different authenticated user.
- Never call `window.location.reload()` as an error-recovery mechanism.
- Overlay pending patches again if a remote sheet refresh completes before the queue is acknowledged.
- Show the existing error surface when retries are pending; clear it after acknowledgement.
- Before logout, await an immediate bounded flush while the session cookie is still valid. If a retryable failure remains, keep the session active and offer an explicit discard-and-logout action; never discard pending changes silently.

Completion and cell-state writes are absolute upserts, so retrying the latest coalesced value is idempotent. The queue stays in memory. Persisting memos or stale cell updates across browser sessions is deliberately excluded because a late replay could overwrite a newer edit from another tab or device.

`keepalive` protects ordinary navigation and unload delivery but cannot guarantee recovery after abrupt browser or operating-system termination. Hard-close recovery remains outside this phase's acceptance contract.

- https://fetch.spec.whatwg.org/#http-network-or-cache-fetch

### 7.2 Notes

Inline note title/body saves remain immediate on blur. Note layout is written once at pointer completion. A failure marks the note's owning sheet stale; it refetches that sheet only if it is still active and otherwise waits until that sheet is selected. Unrelated pending completion or cell-state overlays remain intact.

### 7.3 Set-based bulk mutations and settings

Zod validates every array body before it reaches SQL. The server then binds the normalized array once as JSON and uses D1's supported `json_each(?)` table function for ownership validation, set-based insert/upsert/delete, ordering, and affected-sheet version updates. It never maps an accepted array into one D1 statement per row.

Preflight validation does not replace write-time authorization. Every set-based mutation repeats user ownership, axis membership, current-period, and unlocked-table predicates in the SQL that changes rows. `RETURNING` keys are compared with the normalized request keys; a resource deleted or locked between validation and the transaction is reported as a structured rejection instead of a false success. Version statements select affected sheets through the same validated target joins.

This pattern applies to completion batches, cell-state batches, axis ordering, character/task ordering, character import/upsert, default-board seeding, and legacy completion synchronization. Each route has a test-enforced budget of at most 20 D1 statements including authorization and version reads, leaving headroom below the free-plan limit of 50. Bound parameters stay below 100 because the array is one JSON value.

Table settings become one server request. The route accepts table fields plus `applyRowSize`, `applyColumnSize`, and optional character display/separator changes, validates ownership and lock state once, and uses set-based `UPDATE` statements selected by table id and axis. Axis-item detail and size fields are saved through one route; cross-size propagation is one server-selected `UPDATE`, not a client list of item requests. Both flows target at most 10 D1 statements including their version response.

- https://developers.cloudflare.com/d1/sql-api/query-json/

### 7.4 Lost Ark character search and refresh

Roster search keeps the siblings request and enriches candidates through profile requests with concurrency limited to four, below the Worker connection limit. A successful miss writes one complete enriched-roster KV value for the normalized query, not one KV value per character plus another roster value. Client and server in-flight dedupe share identical normalized keys.

Existing-character refresh reads `GET /armories/characters/:name/profiles` directly because that response contains the basic profile and combat-power fields needed by RiceArk. It no longer calls siblings and enriches every roster member for each saved character.

`POST /api/characters/refresh-batch` accepts at most 40 owned character ids. It loads and validates them with one set query, preserves the per-character cooldown, fetches eligible profiles with concurrency four while honoring Lost Ark rate-limit headers, and performs one JSON-backed set update plus affected-sheet version updates. It returns a result for every id so the UI retains partial-failure reporting. Explicit refreshes do not write KV; their purpose is authoritative fresh data.

Every Lost Ark and Cloudflare analytics fetch has an explicit eight-second deadline. A timeout becomes the endpoint's existing structured external-service error or partial admin warning, and the same RiceArk request does not automatically retry it. `429` responses preserve `Retry-After` for the caller. In-flight dedupe entries always clear in `finally`, including timeout and abort paths. A failed origin request may reuse only a still-valid cache entry from the table below; it does not extend stale data past the accepted freshness window.

- https://developer-lostark.game.onstove.com/usage-guide
- https://developer-lostark.game.onstove.com/changelog

## 8. Public And Low-Risk Caches

| Endpoint/data | Browser policy | Server policy | Maximum accepted staleness |
| --- | --- | --- | ---: |
| Owner board/session/version | `private, no-store` | memory cache in `useBoard` only | version/focus contract |
| Shared board | `no-store` | version check on focus | until the next focus/version check |
| Patch notes GET | `public, max-age=300` | Cloudflare Cache API for 5 minutes plus module in-flight dedupe | 5 minutes |
| Lost Ark events GET | `public, max-age=60` | Cache API for normalized responses for 1 minute, existing raw KV cache for 15 minutes, plus in-flight dedupe | 1 minute for normalized response |
| Character search | client memory and in-flight dedupe for 5 minutes | one enriched-roster KV value per normalized query for 30 minutes plus in-flight dedupe | 30 minutes |
| Admin summary | `private, no-store` | best-effort module-memory metrics for 5 minutes after authorization | 5 minutes |

Public Cache API keys are synthetic same-origin `GET` requests built from canonical URLs without cookies or authorization headers. Only successful `200` JSON responses are stored. For event rewards, sort and deduplicate the reward list so equivalent requests share one entry. Concurrent server cache misses for the same external Lost Ark key share one in-isolate promise to reduce origin stampedes, and failed promises are never cached.

Client character-search results use a 20-entry LRU. Module in-flight maps contain promises only, are capped at 50 distinct keys per isolate, and delete every settled promise in `finally`; they are deduplication controls, not unbounded result caches.

The Cache API is available to Pages Functions but is best-effort and data-center-local. Its hits still count as Workers invocations; browser freshness and avoided/lazy requests reduce invocation count, while server caches primarily reduce D1 and external API work.

- https://developers.cloudflare.com/workers/runtime-apis/cache/
- https://developers.cloudflare.com/pages/functions/pricing/

Patch-note mutations can tolerate a five-minute public read delay. Shared-board access cannot, so shared payloads never receive a positive CDN TTL.

## 9. Authentication And Anonymous Traffic

The board request is enabled only after `session.status === "authenticated"`. An anonymous page load performs the session check but does not issue an owner-board request.

Expected `401 unauthorized` responses from `/api/session` are excluded from `admin_error_counters`. Other 4xx signals and all 5xx responses remain recorded. This removes one D1 write from each normal anonymous session check without hiding server failures.

Sessions remain D1-backed. A KV session cache would exchange a 5,000,000-row daily D1 read allowance for a 100,000-key KV read allowance and would weaken immediate logout revocation.

## 10. Admin Metrics And Routing

The Pages project API exposes `production_script_name`. Workers analytics resolves the script name from the configured Pages project (`riceark`) and uses that value in `workersInvocationsAdaptive`; a manually configured Worker script name is only a fallback.

- https://developers.cloudflare.com/api/resources/pages/
- https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
- https://developers.cloudflare.com/pages/functions/metrics/

Zero Workers requests with nonzero D1 queries is reported as a metrics warning, not as a valid zero-usage result.

The four completion-activity subqueries are rewritten as one conditional-aggregation scan of `board_cell_completions`, without adding a write-amplifying index. After `requireAdmin` succeeds, user-independent D1 aggregates and Cloudflare usage are cached together for five minutes in module memory. The current admin identity is injected per response and is never stored in the shared module cache. The response uses `private, no-store` and `Vary: Cookie`, so every request still enforces current admin authorization.

The capacity estimate labels its small-sample uncertainty and separates fixed admin-query cost from per-active-user cost where the available metrics permit it.

The admin-route guard waits until session checking finishes. `?view=admin` remains selected for an authenticated admin and redirects only after a resolved anonymous, non-admin, or error session state.

## 11. Client Rendering

The sheet split naturally limits React state to the active sheet. Within that sheet, table-to-axis, table-to-cell-state, and table-to-completion indexes are created once with `useMemo` and passed as table-local arrays. No broad component memoization or new state library is added without profiler evidence.

Admin, patch-note, calculator, and shared-view code splitting is measured after the data work. Static asset requests are free, but code splitting is accepted only when it reduces the initial gzip bundle by at least 20 KB without introducing a visible loading regression.

## 12. Rollout

### Phase 1: correctness and observability

- Add missing version bumps and mutation version responses.
- Fix anonymous board gating, expected-401 accounting, admin direct routing, and Pages script-name metrics.
- Collapse repeated admin completion-activity scans into one conditional aggregate.
- Add per-flow measurement helpers/tests before changing payload shape.

### Phase 2: write consolidation

- Add keepalive/retry behavior for completion and cell-state queues.
- Add cell-state coalescing.
- Replace row-by-row D1 array mutations with JSON-backed set operations.
- Replace table/axis settings request fan-out with set-based server updates.
- Add direct-profile character refresh and the bounded refresh-batch route.

### Phase 3: sheet-aware reads

- Add `/api/board/bootstrap` and single-sheet contracts while retaining the legacy full-board route.
- Move active-sheet routing and cache ownership into `useBoard`.
- Cache opened sheets in memory and invalidate by version and period fingerprint.
- Load only the changed active sheet after polling.
- Keep `GET /api/board` for at least 30 days and until legacy-route telemetry is negligible; then remove it in a separate deployment.

### Phase 4: shared and public caching

- Add sharing overview and direct-detail lazy loading.
- Add shared focus revalidation.
- Add bounded patch-note/event/search/admin caches and in-flight dedupe.

Each phase is independently deployable. A failed phase is rolled back without changing schema semantics established by earlier version migrations.

## 13. Verification

### 13.1 Automated tests

- DB tests prove every mutation's exact manifest/sheet version delta, including both deltas for sheet rename, and no bump on failure.
- Route tests prove bootstrap ownership, active-sheet fallback, one-sheet payload boundaries, `Cache-Control`, mutation metadata, and shared revocation.
- Hook tests prove initial request count, tab-cache hits, active/inactive invalidation, period-boundary invalidation, leader polling, hidden follower behavior, focus refresh, pending overlays, retry classification/order, `Retry-After`, keepalive use, and user/logout cache clearing.
- UI tests prove browser back/forward tab changes load at most the required sheet and direct shared links do not load the owner board.
- Admin tests prove session-check routing, Pages production script resolution, one-scan completion aggregation, and separation of cached metrics from admin identity.
- Cache tests prove TTLs, canonical credential-free keys, successful-response-only storage, in-flight dedupe, and no private response receives a public policy.
- External-fetch tests prove the eight-second abort signal, no same-request retry, `Retry-After` propagation, and in-flight cleanup after timeout.
- Bulk-route tests prove query and binding budgets, whole-array validation, set-based writes, version deltas, and partial character-refresh results.
- A Wrangler local-D1 integration test executes representative `json_each` upsert/delete/order and `UPDATE ... RETURNING` statements; mocked DB tests alone do not prove D1 SQL compatibility.

Run the existing full gates after every phase:

```bash
pnpm check
pnpm test
pnpm build
```

### 13.2 Flow budgets

The following budgets are acceptance requirements, measured with mocked fetch counts and D1 query metadata where available.

| Flow | Required result |
| --- | --- |
| Anonymous initial load | one session API request, zero owner-board requests, zero expected-401 counter writes |
| Authenticated initial board load | session plus one `/api/board/bootstrap` request, at most 10 total D1 queries including auth, and no immediate version request |
| First-ever board initialization | one bootstrap API request and at most 30 total D1 queries including default seeding and auth |
| Three-sheet first navigation | one bootstrap plus at most one request for each newly opened sheet |
| Return to unchanged opened sheet | zero sheet-data requests |
| Poll with no changes | one version API request, one auth lookup, and one version SQL statement |
| Inactive-sheet remote change | invalidate cache only; do not fetch it until selected |
| Ten completion changes inside 800 ms | at most one completion mutation request |
| Ten cell-state paints inside 800 ms | at most one cell-state mutation request |
| Table settings apply-to-all | one API request regardless of axis-item count |
| Any accepted array mutation | at most 20 D1 queries and fewer than 100 bindings per SQL statement |
| Twenty-character refresh | one RiceArk API request, at most 20 Lost Ark profile requests, zero KV writes |
| Character-search cache miss with N candidates | one siblings request, at most N profile requests, and one KV write |
| Direct shared detail | no owner-board bootstrap and no sharing overview before needed |
| Admin completion activity | one scan of `board_cell_completions` per uncached summary |

For the current three-sheet heavy board, the fresh active-sheet path must read at least 40% fewer board rows than the existing full-board path. A single-sheet user may see a smaller row reduction but still removes the immediate version request and the default-board existence query.

### 13.3 Production checks

Before deployment, record `wrangler d1 info` and one-day D1 Insights. After deployment:

1. Smoke-test login, three-tab navigation, back/forward, checks, cell marks, notes, reset-boundary behavior, shared lookup/revocation, patch notes, and admin direct links.
2. Confirm Workers requests and CPU are nonzero when production traffic exists, p99 CPU remains below the free-plan limit, and no CPU-limit errors appear.
3. Re-run D1 Insights after comparable traffic, separating fixed admin scans from user flows.
4. Compare API counts and D1 rows for the defined flows, not only total daily traffic.

The optimization is accepted when all functional tests pass, flow budgets pass, the heavy three-sheet read target passes, no pending-write loss is observed in page-hide/focus tests, and production metrics contain no new 5xx or cache/account-isolation regression.

## 14. Expected Outcome

The primary capacity gain comes from avoiding work, not from moving it to a different Cloudflare product:

- initial authenticated requests decrease from session + full board + versions to session + active-sheet bootstrap;
- loaded board rows become proportional to the active sheet instead of the user's entire board;
- unchanged tab returns are served from validated memory;
- inactive remote changes do not trigger payload reads;
- settings and cell-mark bursts use one authenticated request instead of N requests;
- bulk writes stay below free D1 invocation limits and use set operations instead of per-row statements;
- saved-character refresh drops from repeated roster-wide enrichment to one profile request per character and no KV writes;
- anonymous and direct-shared routes stop loading unrelated private data;
- administrator completion activity uses one scan instead of four and is separated from per-user capacity estimates.

The current sample is too small and too distorted by fixed admin scans to support a guaranteed capacity multiplier. Roughly doubling practical D1-based capacity remains an upside scenario if the observed traffic mix persists, but the implementation is accepted only by the explicit flow budgets and comparable post-deploy measurements.
