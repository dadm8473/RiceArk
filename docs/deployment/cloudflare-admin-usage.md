# Cloudflare Admin Usage Setup

RiceArk admin usage metrics are shown only to accounts allowed by `ADMIN_OAUTH_ALLOWLIST`.
The Cloudflare token is never sent to the browser; the browser receives only aggregate usage numbers.

## What Is Implemented

- `/api/admin/summary` includes a `cloudflare` block.
- D1 database size is read from the Cloudflare D1 REST API.
- D1 24-hour rows read/written are displayed when Cloudflare returns those fields.
- Workers/Pages Functions requests are read from the Cloudflare GraphQL Analytics API.
- The result is cached in Worker memory for 5 minutes.
- If Cloudflare is not configured or temporarily fails, the admin dashboard still renders with a warning.

## Required Cloudflare Values

Already configured in `apps/web/wrangler.jsonc`:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_D1_DATABASE_ID`
- `CLOUDFLARE_PAGES_PROJECT_NAME` (`riceark`)
- `CLOUDFLARE_WORKER_SCRIPT_NAME`

Required as a Pages secret:

- `CLOUDFLARE_API_TOKEN`

## Token Permissions

Create a custom Cloudflare API token with the narrowest practical read permissions:

- Account: `Account Analytics` / `Read`
- Account: `D1` / `Read`
- Account: `Cloudflare Pages` / `Read` (API permission: `Pages Read`)

Scope the token to the RiceArk Cloudflare account only.

Before rolling out Pages script resolution, update the currently deployed token
to include `Pages Read`, or create a replacement token with all three permissions.
Then overwrite the existing `CLOUDFLARE_API_TOKEN` Pages secret before deploying.
Changing `wrangler.jsonc` does not update token permissions or the deployed secret.
Never place a token value in this guide, `wrangler.jsonc`, source control, command
arguments, shell history, logs, screenshots, or rollout records.

## Add The Secret

Run this from the repository root and paste the updated or replacement token only
at Wrangler's interactive prompt:

```sh
pnpm wrangler pages secret put CLOUDFLARE_API_TOKEN --project-name riceark
```

Redeploy after adding or changing the secret:

```sh
pnpm --filter @riceark/web run deploy
```

## Comparable 24-Hour Rollout Procedure

Use this procedure for the first post-instrumentation qualified rolling capture
and every post-deployment comparison. Keep the record aggregate-only. Do not include
names, email addresses, OAuth ids, session values, character names, note content,
share ids, API tokens, or other secrets.

### 1. Freeze The Deployment And Window

1. Record the source commit SHA, Pages deployment id and URL, and deployment
   completion timestamp.
2. Define the scheduled comparison target as `windowStart = windowEnd - 24h`,
   then record both as ISO 8601 UTC timestamps and their exact Asia/Seoul (KST,
   UTC+09:00) equivalents. Use `windowStart <= event < windowEnd` for exact
   local flow tests and event attribution.
3. The authenticated admin endpoints independently return rolling now-24h
   values; their captures do not create this fixed target window. Record each
   source's effective boundary when exposed (such as `generatedAt`), the
   request timestamp, and boundary skew from the scheduled target and the
   other route. Label these endpoint captures `qualified rolling captures`.
   A genuinely fixed baseline requires provider-side fixed-boundary export or
   future explicit boundary support. Until then, aggregate comparisons remain
   `qualified`; do not align endpoint values by inference.
4. Record the operator timezone separately. Use the same weekday and UTC/KST
   start time for the baseline and post-deployment windows where possible.
5. Create only a redacted aggregate artifact outside git for audit. Retain
   numeric aggregates and timestamps only; drop admin, id, and displayName
   fields, cookies and headers, raw warning strings, URLs, ids, and tokens.
   Map warnings to the allowlisted local categories before retaining them.
6. Do not place a deployment or migration inside either comparison window. The
   post-deployment window starts only after the candidate deployment completes.
7. Do not compare two rolling "last 24 hours" screenshots taken at unrelated
   times. Use the scheduled capture pattern and record each provider-reported
   effective boundary and skew; aggregate comparisons remain qualified.

Record these fields for each window:

| Field | Required value |
| --- | --- |
| Window label | Baseline or phase/deployment name |
| Commit | Full source commit SHA |
| Deployment | Pages deployment id and public deployment URL |
| Deployment completed | ISO 8601 timestamp |
| Scheduled comparison target boundaries | Operator-scheduled 24-hour UTC start/end and corresponding Asia/Seoul (KST, UTC+09:00) start/end |
| Provider effective boundary | Exact provider-reported start/end, or `unavailable` |
| Metrics collected | ISO 8601 timestamp and operator timezone |
| Traffic note | Same-day comparison, known incident, promotion, or other aggregate traffic-mix difference |

Mark a field `unavailable` when it cannot be retrieved. Never substitute zero
for an unavailable value.

### 2. Hold Admin Scan Cost Constant

For this rollout, make exactly four total authenticated captures of both
`/api/admin/summary` and `/api/admin/health` at offsets `+00:05`, `+08:05`,
`+16:05`, and `windowEnd` from `windowStart`. The `windowEnd` capture occurs at
or just outside the half-open boundary and is attributed according to the
provider timestamps. If that call cannot be separated from the preceding
rolling interval, mark the capture `qualified`. Do not make additional
deliberate admin-dashboard visits during the window. Record accidental or
automated visits and flag the comparison as `qualified` if the pattern cannot
be matched.

For each summary visit, record whether D1 Insights shows the user/activity and
data aggregates executing. For each health visit, record the route's observed
D1 work and cleanup behavior. Treat those observations as the cache-status
evidence; do not infer a cache hit from elapsed time alone because module memory
is best-effort and isolate-local.

Record scheduled admin capture cost separately:

| Route | Requests | D1 read/write queries | Rows read/written | Cleanup writes |
| --- | --- | --- | --- | --- |
| `/api/admin/summary` | 4 captures at the scheduled offsets | Count each, or `unavailable` | Read and written counts, or `unavailable` | Count, or `unavailable` |
| `/api/admin/health` | 4 captures at the scheduled offsets | Count each, or `unavailable` | Read and written counts, or `unavailable` | Count, or `unavailable` |
| Total scheduled admin capture cost | Sum only when route attribution is complete | Sum only when route attribution is complete | Sum only when route attribution is complete | Sum only when route attribution is complete |

Record summary and health warnings only as sanitized allowlisted local
categories described below.

The 2026-07-15 rolling reference has four executions and 36,036 rows for the
user/activity aggregate, plus four executions and 12,828 rows for the data
aggregate. Route-level query, write, and cleanup attribution is unavailable for
that reference.

### 3. Capture The Same Metrics

Capture all values against the scheduled comparison target, record each
provider-reported effective boundary and skew where exposed, and record the
source used. Treat aggregate values as qualified unless fixed-boundary provider
data is available:

- completion-active users in 24 hours;
- completion updates in 24 hours and stored completion count, kept as separate
  fields;
- active sessions as a point-in-time context value;
- Workers/Pages Functions requests, errors, subrequests, p50 CPU, p99 CPU, and
  CPU-limit errors;
- D1 rows read, rows written, read queries, write queries, database size in
  bytes, and table count when available;
- API 4xx and 5xx totals grouped by route template and status class;
- application, cache, Lost Ark, Cloudflare, and metrics warnings counted only
  by the allowlisted local category;
- scheduled admin captures and D1 cost from the preceding section.

Store and count warnings only as one of these allowlisted local categories:
`pages_project_unavailable`, `d1_usage_unavailable`,
`workers_usage_unavailable`, `workers_zero_with_d1`, `external_timeout`, or
`other`. Never copy upstream response bodies, URLs, ids, tokens, or text after
a colon into the report.

If Workers requests are zero while D1 queries are nonzero, first verify that the
configured script resolves the Pages production script. Until it does, mark
Workers requests and CPU values `unavailable`; do not report the zero as real
traffic.

### 4. Normalize Before Comparing

Keep raw totals, then calculate normalized values only when both numerator and
denominator are available and the denominator is greater than zero.

```text
adminAdjustedRequests = workersRequests - fullyAttributedAdminRequests
adminAdjustedRowsRead = d1RowsRead - fullyAttributedAdminRowsRead
adminAdjustedRowsWritten = d1RowsWritten - fullyAttributedAdminRowsWritten
adminAdjustedReadQueries = d1ReadQueries - fullyAttributedAdminReadQueries
adminAdjustedWriteQueries = d1WriteQueries - fullyAttributedAdminWriteQueries

adminAdjustedRequestsPerActiveUser = adminAdjustedRequests / completionActiveUsers24h
adminAdjustedRowsReadPerActiveUser = adminAdjustedRowsRead / completionActiveUsers24h
adminAdjustedRowsWrittenPerActiveUser = adminAdjustedRowsWritten / completionActiveUsers24h
adminAdjustedReadQueriesPerActiveUser = adminAdjustedReadQueries / completionActiveUsers24h
adminAdjustedWriteQueriesPerActiveUser = adminAdjustedWriteQueries / completionActiveUsers24h

totalRequestsPerActiveUser = workersRequests / completionActiveUsers24h
totalRowsReadPerActiveUser = d1RowsRead / completionActiveUsers24h
totalRowsWrittenPerActiveUser = d1RowsWritten / completionActiveUsers24h
totalReadQueriesPerActiveUser = d1ReadQueries / completionActiveUsers24h
totalWriteQueriesPerActiveUser = d1WriteQueries / completionActiveUsers24h

adminAdjustedRequestsPerCompletion = adminAdjustedRequests / completionUpdates24h
adminAdjustedRowsReadPerCompletion = adminAdjustedRowsRead / completionUpdates24h
adminAdjustedRowsWrittenPerCompletion = adminAdjustedRowsWritten / completionUpdates24h
```

Compute admin-adjusted requests, reads, writes, and query metrics only when
both admin routes have complete request, query, row, and cleanup attribution.
Otherwise report the `total*` normalization values and mark all
`adminAdjusted*` metrics `unavailable`. If any adjusted total is negative, the
attribution is inconsistent; mark adjusted metrics unavailable and investigate.
Do not use the stored-completion total as the completion-activity denominator.

### 5. Record Comparability And Decision

For every raw and normalized metric, record baseline, post-deployment value,
absolute delta, percentage delta when the baseline is nonzero, and one of:
`comparable`, `qualified`, or `unavailable`. Explain qualifications such as a
different active-user count, completion volume, admin visit pattern, cache
temperature, incident, or external-service failure.

Do not infer a capacity multiplier from a small sample. Use the normalized
values together with functional gates, flow budgets, CPU-limit errors, API
errors, and cache/account-isolation checks to make the rollout decision.

## Notes

- Pages Functions requests count toward Workers request limits.
- Static asset requests are free/unlimited from the Workers pricing perspective.
- D1 row counters are used only if the Cloudflare response includes them. If Cloudflare changes or hides those fields, the dashboard falls back to DB size and Workers request metrics.
