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
- `CLOUDFLARE_WORKER_SCRIPT_NAME`

Required as a Pages secret:

- `CLOUDFLARE_API_TOKEN`

## Token Permissions

Create a custom Cloudflare API token with the narrowest practical read permissions:

- Account: `Account Analytics` / `Read`
- Account: `D1` / `Read`

Scope the token to the RiceArk Cloudflare account only.

## Add The Secret

Run this from the repository root and paste the token when prompted:

```sh
pnpm wrangler pages secret put CLOUDFLARE_API_TOKEN --project-name riceark
```

Redeploy after adding or changing the secret:

```sh
pnpm --filter @riceark/web run deploy
```

## Comparable 24-Hour Rollout Procedure

Use this procedure for the baseline and every post-deployment comparison. Keep
the record aggregate-only. Do not include names, email addresses, OAuth ids,
session values, character names, note content, share ids, API tokens, or other
secrets.

### 1. Freeze The Deployment And Window

1. Record the source commit SHA, Pages deployment id and URL, deployment
   completion timestamp, and the timestamp at which metrics are collected.
2. Record `windowStart` and `windowEnd` as ISO 8601 UTC timestamps, plus their
   exact Asia/Seoul (KST, UTC+09:00) equivalents. Use
   `windowStart <= event < windowEnd`, and make `windowEnd` exactly 24 hours
   after `windowStart`.
3. Record the operator timezone separately. Use the same weekday and UTC/KST
   start time for the baseline and post-deployment windows where possible.
4. Do not place a deployment or migration inside either comparison window. The
   post-deployment window starts only after the candidate deployment completes.
5. Do not compare two rolling "last 24 hours" screenshots taken at unrelated
   times. Query or capture both windows with their fixed boundaries.

Record these fields for each window:

| Field | Required value |
| --- | --- |
| Window label | Baseline or phase/deployment name |
| Commit | Full source commit SHA |
| Deployment | Pages deployment id and public deployment URL |
| Deployment completed | ISO 8601 timestamp |
| Window start/end | Exact 24-hour UTC boundaries |
| KST boundary equivalents | Exact Asia/Seoul boundaries for the same window |
| Metrics collected | ISO 8601 timestamp and operator timezone |
| Traffic note | Same-day comparison, known incident, promotion, or other aggregate traffic-mix difference |

Mark a field `unavailable` when it cannot be retrieved. Never substitute zero
for an unavailable value.

### 2. Hold Admin Scan Cost Constant

For this rollout, make exactly four deliberate `/api/admin/summary` visits in
each 24-hour window, at offsets `+00:05`, `+06:05`, `+12:05`, and `+18:05` from
`windowStart`. Do not make additional deliberate admin-dashboard visits during
the window. Record accidental or automated visits and flag the window as
non-comparable if the visit pattern cannot be matched.

For every visit, record whether D1 Insights shows the user/activity aggregate
and data aggregate executing. Treat that observed execution as the cache-status
evidence; do not infer a cache hit from elapsed time alone because module memory
is best-effort and isolate-local.

Record fixed admin cost separately:

| Admin field | Value to record |
| --- | --- |
| Deliberate summary visits | Count and scheduled offsets |
| Additional summary visits | Count and reason, or zero |
| User/activity aggregate | Executions and rows read |
| Data aggregate | Executions and rows read |
| Total fixed admin rows | Sum of the two aggregate row counts |
| Summary warnings | Aggregate warning codes/messages with identifiers removed |

The 2026-07-15 reference has four executions and 36,036 rows for the
user/activity aggregate, plus four executions and 12,828 rows for the data
aggregate.

### 3. Capture The Same Metrics

Capture all values against the fixed boundaries and record the source used:

- completion-active users in 24 hours;
- completion updates in 24 hours and stored completion count, kept as separate
  fields;
- active sessions as a point-in-time context value;
- Workers/Pages Functions requests, errors, subrequests, p50 CPU, p99 CPU, and
  CPU-limit errors;
- D1 rows read, rows written, read queries, write queries, database size in
  bytes, and table count when available;
- API 4xx and 5xx totals grouped by route template and status class;
- application, cache, Lost Ark, Cloudflare, and metrics warnings grouped by
  code or sanitized message;
- fixed admin visits and D1 cost from the preceding section.

If Workers requests are zero while D1 queries are nonzero, first verify that the
configured script resolves the Pages production script. Until it does, mark
Workers requests and CPU values `unavailable`; do not report the zero as real
traffic.

### 4. Normalize Before Comparing

Keep raw totals, then calculate normalized values only when both numerator and
denominator are available and the denominator is greater than zero.

```text
endUserRowsRead = d1RowsRead - fixedAdminRowsRead

requestsPerActiveUser = workersRequests / completionActiveUsers24h
rowsReadPerActiveUser = endUserRowsRead / completionActiveUsers24h
rowsWrittenPerActiveUser = d1RowsWritten / completionActiveUsers24h
readQueriesPerActiveUser = d1ReadQueries / completionActiveUsers24h
writeQueriesPerActiveUser = d1WriteQueries / completionActiveUsers24h

requestsPerCompletion = workersRequests / completionUpdates24h
rowsReadPerCompletion = endUserRowsRead / completionUpdates24h
rowsWrittenPerCompletion = d1RowsWritten / completionUpdates24h
```

If `endUserRowsRead` is negative, the admin attribution is inconsistent; mark
the adjusted read metrics unavailable and investigate the window. Do not use
the stored-completion total as the completion-activity denominator.

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
