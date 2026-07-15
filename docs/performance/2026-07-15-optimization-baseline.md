# Performance Optimization Pre-Implementation Baseline

This report freezes the aggregate, non-sensitive baseline used by the phased
performance and caching rollout. It distinguishes measured evidence from source
observations and from values that are not yet instrumented. It contains no user
identities, session material, character names, note content, or share ids.

## Capture Metadata

| Field | Baseline |
| --- | --- |
| Captured at | `2026-07-15` (KST; exact collection time not supplied in the approved evidence) |
| Timezone | `Asia/Seoul` (`KST`, UTC+09:00) |
| Source commit tested | `96c1f6f` |
| Branch | `codex/performance-caching` |
| Production aggregate source | Approved optimization design, based on the 2026-07-15 production admin aggregate and D1 Insights |
| Production 24-hour boundaries | Not measured; the source snapshot records rolling 24-hour totals but not exact start and end timestamps |
| Local test fixture/source | Repository Vitest fixtures and mocks at the source commit above; no production row or identity data was used by the local gates |
| Browser viewport | Not measured; no browser capture was performed for this pre-implementation baseline |
| Initial JS | `421.46 kB` raw / `125.27 kB` gzip from the verified production build |
| Per-flow API requests | Not yet instrumented; current route behavior is recorded below |
| Per-flow D1 statements and rows | Not yet instrumented; production D1 Insights aggregates are recorded below |
| Per-flow cache hits and misses | Not measured; current cache policies and source behavior are recorded below |

## Local Baseline Gates

The following commands ran in the optimization worktree against the source
commit in the metadata table.

| Command | Result |
| --- | --- |
| `pnpm check` | PASS (verified evidence; exact checker count not reported) |
| `pnpm test` | PASS: 48 files, 456 tests, 0 failures (`456/456`) |
| `pnpm build` | PASS (verified evidence) |

Verified web initial bundle: `421.46 kB` raw and `125.27 kB` gzip. The emitted
asset filename was not retained in the approved evidence.

`pnpm test:d1-sql` and `pnpm measure:board-reads` do not exist before
implementation and were not run. `test:d1-sql` becomes a phase gate after the
reliable-writes phase creates it. `measure:board-reads` becomes a phase gate
after the sheet-aware-read phase creates it; both are then rerun at the later
phase checkpoints defined by the rollout plan.

## Production Aggregate

The following is the authoritative aggregate already approved for the rollout.

| Metric | Observed value |
| --- | ---: |
| Registered users | 9 |
| Completion-active users in 24h | 4 |
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
| Database size | About 2.4 MB |

Workers/Pages Functions requests and CPU percentiles are unavailable. The
configured script name does not resolve the Pages production script, so the
reported zero request value is invalid and is not used as a measurement. No
request or CPU value is inferred from D1 traffic. API error totals and cache
hit/miss totals were also not measured for this window. The unresolved Workers
script is the production-metrics warning attached to this baseline.

## Highest-Cost D1 Paths

| Query path | 24h executions | 24h rows read |
| --- | ---: | ---: |
| Full-board axis item load | 147 | 23,112 |
| Full-board cell-state load | 134 | 14,438 |
| Current completions | 122 | 7,254 |
| Sheet version list | 534 | 3,210 |
| Session lookup | 1,282 | 2,564 |
| Admin user/activity aggregate | 4 | 36,036 |
| Admin data aggregate | 4 | 12,828 |

The two fixed admin aggregates account for 48,864 rows read, or 50.05% of the
24-hour total. With four completion-active users, raw D1 reads are 24,406.25 per
active user; subtracting the observed fixed admin reads leaves 12,190.25 per
active user. D1 writes are 489 per active user. These are comparison aids, not
capacity claims.

A per-completion value is not calculated because the 24-hour completion-update
count was not captured. The 2,244 stored completions are a current-state total,
not a valid activity denominator.

## User Distribution And Capacity Caveat

Users average 1.56 sheets with a maximum of 3. They average 40 axis items with a
maximum of 97. The rough 204 DAU estimate is explicitly sample-limited: it uses
only four completion-active users and is materially distorted by fixed admin
scans. It is retained only as a before/after reference and is not a production
capacity guarantee.

## Flow Evidence

This table records current source behavior where it is directly observable.
Numeric flow measurements remain open until the rollout adds deterministic
request and D1 metadata instrumentation.

| Flow | Current source behavior | API request evidence | D1 rows/statements and cache status |
| --- | --- | --- | --- |
| Authenticated three-sheet initial load | The app checks `/api/session` while the legacy owner path loads `/api/board`. That loader reads every owned sheet and its tables, notes, axis items, cell states, settings, and current completions. Polling-enabled load then starts `/api/board/versions`. | Route sequence observed in source; exact browser total not measured. | Per-load statements and rows are not yet instrumented. Full-board production aggregates are listed above. There is no sheet-level client cache; the full payload remains in component memory. |
| First visit and return across three tabs | All three sheets arrive in the legacy full-board payload. Sheet selection and return use that in-memory payload rather than a single-sheet endpoint; a remote-change reload replaces the full board. | First-visit and return counts are not yet instrumented. | Per-sheet rows are not yet instrumented. No bounded per-sheet cache exists before the sheet-aware-read phase. |
| Version checks | A visible leader calls `/api/board/versions`; hidden tabs stop polling and followers receive a broadcast. The current helper reads manifest and sheet versions separately. A changed key reloads the full `/api/board`. | Paths are observed in source; no-change and changed active/inactive request counts are not yet instrumented. | The sheet-version-list aggregate is 534 executions and 3,210 rows in 24h. Exact per-check metadata is not measured. The version response is `private, no-store`. |
| Ten rapid completions | Completion changes coalesce in an 800 ms client queue before `/api/board/completions`. | Source behavior observed; browser request count is not yet instrumented. | The server path currently builds row-mapped D1 statements and a version update. Exact statement and row counts are not yet instrumented. |
| Ten rapid cell-state paints | Cell-state paints currently call `/api/board/cell-states` immediately with one patch per paint. | Source behavior observed; browser request count is not yet instrumented. | The server path currently builds row-mapped D1 statements and a version update. Exact statement and row counts are not yet instrumented. Optimistic state is memory-only. |
| 200-row writes | Completion and cell-state schemas accept at most 200 patches. Current bulk mutation paths include row-mapped SQL, while cross-size table settings fan out client requests across matching axis items. Ordering, import, and settings budgets are not yet measured. | Not yet instrumented; no 200-row request fixture was run. | Not yet instrumented. The set-based D1 compatibility gate does not exist until the reliable-writes phase. |
| Direct shared detail | Anonymous detail loads the shared payload. For an authenticated detail view, the app also enables the owner's full board and loads share and favorite lists before they are needed. | Paths observed in source; anonymous/authenticated totals are not yet instrumented. | Shared detail is `no-store`. Owner-board and sharing-list D1 rows are not separated for this flow. |
| Patch-note and events cold/hot | Patch notes issue `/api/patch-notes` when the modal mounts and currently read D1 without an explicit public cache policy. Events issue `/api/lostark/events/today`; raw calendar data has a 15-minute KV cache, but the normalized response has no browser or Cache API policy yet. | Cold/hot request counts are not yet instrumented. | Patch-note D1 rows and cache hits are not measured. Event raw-KV hit/miss counts are not measured. |
| Roster search cold/hot | Each explicit search calls `/api/characters/search`. A server hit can use the 30-minute enriched-roster KV entry. A miss calls the siblings API, enriches missing combat power through profile requests and per-character KV entries, then writes the roster KV entry. | RiceArk and Lost Ark cold/hot request counts are not yet instrumented and depend on roster size and cache state. | D1/auth cost and KV hit/write counts are not measured. There is no bounded client result cache or in-flight dedupe yet. |
| Admin summary cold/hot | Admin mount requests `/api/admin/summary` and `/api/admin/health`. Every summary currently runs the user/activity and data aggregates after authorization; only the Cloudflare usage subresult has a five-minute module cache. | Source paths observed; cold/hot browser totals are not yet instrumented. | Fixed aggregate evidence is 36,036 plus 12,828 rows over four executions each. Overall summary D1 scans are not cached before the observability phase. |

## Baseline Decision

The repository gates are green, the current bundle is recorded, and the
production aggregate is sufficient to begin phased implementation. This report
does not claim that any target flow budget already passes. Those decisions
require the phase-created SQL and board-read measurement gates plus browser
request evidence.
