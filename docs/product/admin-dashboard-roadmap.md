# RiceArk Admin Dashboard Roadmap

Last reviewed: 2026-06-11

This document defines how the admin dashboard should evolve from the current read-only summary into a practical operations tool. The guiding principle is simple: the dashboard should help the operator answer "is the service healthy, affordable, and supportable?" without querying D1 manually.

## Current State

Implemented:

- Admin access is gated by `ADMIN_OAUTH_ALLOWLIST` using `provider:provider_user_id`, for example `discord:<id>`.
- Non-admin users do not see the `운영 현황` entry.
- `/api/admin/summary` is read-only.
- The current dashboard shows:
  - total users
  - active logged-in users by unexpired session
  - active sessions
  - new users in 24h / 7d
  - completion users in 24h / 7d
  - completion updates in 24h / 7d
  - counts for sheets, tables, axis items, cell states, completions, notes, shares, share favorites, characters, and tasks
  - Cloudflare usage status when `CLOUDFLARE_API_TOKEN` is configured
  - D1 database size
  - D1 24h rows read/written when returned by Cloudflare
  - Workers/Pages Functions requests via GraphQL Analytics when `CLOUDFLARE_WORKER_SCRIPT_NAME` is configured
  - estimated DAU capacity from current 24h active users and available usage metrics
- The dashboard intentionally does not expose provider ids, emails, tokens, session hashes, or OAuth access tokens.
- The dashboard UI is organized into four tabs: 개요 (status strip, key metrics, compact usage bars), 사용량·비용 (Cloudflare detail table, capacity estimate, free-limit reference), 헬스·에러 (health checks, Lost Ark cache status, error aggregates, deployment/secret booleans), and 데이터 (user flow, check usage, data scale tables). Tab switching does not refetch; manual refresh reloads both admin endpoints in parallel.
- `/api/admin/health` (Priority 2) reports D1/KV checks with latency, Lost Ark API configuration and calendar cache age (tracked via a small KV status key written only on origin fetches), environment plus secret-configured booleans, and aggregated error counters.
- Error aggregation (Priority 2) uses the `admin_error_counters(day, status, code, route_group, count)` D1 table. The global error handler upserts one row per error response via `waitUntil`; successful requests never write. Raw URLs are never stored — only a fixed route-group label. Rows older than 14 days are cleaned up opportunistically by the admin health handler.

Not implemented yet:

- KV read/write usage, build/deploy usage, and alerting.
- Support lookup for a user's board.
- Admin action logging.
- Feature flags, notices, or cache invalidation controls.

## External Limits To Track

The dashboard should show current values and percentages against these limits. These values must be kept as configuration or periodically re-verified against Cloudflare documentation, not treated as permanent business logic.

- D1 Free:
  - rows read: 5,000,000 / day
  - rows written: 100,000 / day
  - storage: 5 GB total
- Workers Free:
  - requests: 100,000 / day
  - CPU: 10 ms per invocation
- Workers Paid:
  - minimum $5/month
  - 10,000,000 requests/month included
  - 30,000,000 CPU ms/month included
  - overage pricing applies after included usage
- Pages:
  - Pages Functions count against Workers usage
  - static asset requests are free/unlimited from Workers pricing perspective

References:

- Cloudflare D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Pages limits: https://developers.cloudflare.com/pages/platform/limits/

## Design Principles

- Read-only first. Any control that changes production state must wait until audit logging exists.
- No secrets or stable third-party ids in the UI. Provider ids can be used for authorization but must not be displayed.
- Prefer aggregate metrics over user-level inspection.
- Avoid turning monitoring into a source of cost. Do not write one analytics row per request.
- Show uncertainty. If a metric is estimated from app data rather than Cloudflare billing data, label it as estimated.
- Use manual refresh by default. Auto-refresh should be opt-in and no faster than a cautious interval.
- Keep support access consent-based. Admin should not silently browse private boards unless the user has explicitly shared or provided a support code.

## Priority 1: Cost And Capacity Visibility

Purpose: know whether the free plan is safe without opening the Cloudflare dashboard.

Features:

- Cloudflare usage card:
  - D1 rows read 24h
  - D1 rows written 24h
  - D1 database size
  - Workers/Pages Function requests 24h
  - Workers CPU time if available
  - KV reads/writes/lists if available
- Percentage bars:
  - green below 50%
  - yellow from 50% to 80%
  - red above 80%
- Estimated DAU capacity:
  - based on current 24h active users and D1 rows read/write
  - clearly labeled as an estimate
- A "last updated" timestamp and a manual refresh button.

Implementation notes:

- Prefer Cloudflare GraphQL Analytics API or REST endpoints over storing metrics ourselves.
- Required secrets should be narrow-scoped:
  - `CLOUDFLARE_ACCOUNT_ID`
  - `CLOUDFLARE_API_TOKEN`
  - optional resource ids if discovery is too broad
- Cache fetched usage for a short time, for example 5 minutes, to avoid expensive dashboard refresh spam.
- If Cloudflare API is unavailable, show the last successful value and a warning instead of breaking the whole dashboard.

Acceptance criteria:

- The admin can see D1 and Worker usage without asking Codex or opening Wrangler.
- The UI clearly says whether the app is below 50%, between 50-80%, or above 80% of free daily limits.
- No Cloudflare token or account secret can be read from the client.

## Priority 2: Service Health And Error Visibility

Purpose: know whether the app is broken, degraded, or only lightly used.

Features:

- Health card:
  - `/api/health` status
  - D1 basic query status
  - KV/cache availability status
  - Lost Ark API availability status
- Lost Ark event/cache card:
  - calendar cache age
  - last successful refresh time
  - last failure time and safe error code
- Error summary:
  - last 24h errors by code
  - last 24h 4xx vs 5xx count
  - top failing endpoint families, not full URLs with sensitive params
- Deployment card:
  - current deployed build id or timestamp
  - environment
  - whether required secrets are configured, shown as boolean only

Implementation notes:

- Add an internal health summary endpoint under `/api/admin/health`.
- Avoid logging every successful request.
- For errors, start with aggregate counters. A compact table like `admin_error_counters(day, code, route_group, count)` is safer than raw request logs.
- Increment counters only for errors or important operational events.
- Never store request bodies, cookies, tokens, OAuth codes, or raw headers.

Acceptance criteria:

- Admin can tell whether a user report is likely service-wide or user-specific.
- Admin can see if Lost Ark event data is stale.
- Error metrics do not leak user content or identifiers.

## Priority 3: User Support Tools

Purpose: help a user who says "it is broken" while preserving privacy and minimizing operator mistakes.

Features:

- Support lookup by safe handle:
  - display name search can exist, but results should be minimal and ambiguous results should stay ambiguous
  - no email/provider id display
- User summary:
  - joined date
  - last activity estimate
  - number of sheets/tables/characters/tasks/notes
  - active shares count
  - recent error codes associated with that user's session if safely tracked
- Consent-based read-only board access:
  - user generates a support code or shares a temporary read-only support link
  - admin can open the board exactly as read-only
  - support access expires automatically
- Data diagnostics:
  - missing active sheet
  - table with only rows or only columns
  - orphaned axis item references
  - unusually large note body
  - excessive character/task count

Implementation notes:

- Do not add "admin can edit user data" in this phase.
- Support code table can be short-lived:
  - `support_access_tokens(id, user_id, token_hash, expires_at, created_at, used_at)`
- Board access must reuse existing read-only rendering paths to avoid accidental writes.

Acceptance criteria:

- Admin can inspect enough to help without gaining hidden write capabilities.
- User can revoke or wait out support access.
- Clicking checkboxes or controls in support mode cannot mutate data.

## Priority 4: Operator Alerts

Purpose: avoid needing to watch the dashboard all day.

Features:

- Discord webhook notifications for:
  - D1 read/write usage above 70%
  - D1 read/write usage above 90%
  - Workers request usage above 70% / 90%
  - Lost Ark API failure streak
  - repeated 5xx errors
- Optional daily summary:
  - DAU estimate
  - D1 usage
  - Worker requests
  - new users
  - top error code

Implementation notes:

- Use Cloudflare Cron Triggers only after the read-only dashboard is stable.
- Store alert cooldowns so the same condition does not spam Discord.
- Alert payloads must avoid user identifiers.

Acceptance criteria:

- Admin receives a warning before free limits are exhausted.
- Alerts are deduplicated and actionable.

## Priority 5: Safe Operational Controls

Purpose: allow controlled intervention only after visibility and audit logs exist.

Prerequisite:

- Admin action logging must exist first:
  - `admin_action_logs(id, admin_user_id, action, target_type, target_id, metadata_json, created_at)`
  - metadata must not include secrets or private content

Candidate controls:

- Refresh Lost Ark calendar/event cache.
- Clear one safe cache key family.
- Enable/disable a maintenance notice.
- Enable/disable a feature flag.
- Pause Lost Ark API refresh temporarily.

Controls to avoid until much later:

- Delete user.
- Edit user board data.
- Force logout all sessions.
- Raw SQL console.
- Exposing OAuth account identifiers.

Acceptance criteria:

- Every admin mutation creates an audit log.
- Dangerous controls require confirmation and clear scope.
- Read-only support remains separate from mutation controls.

## Suggested Implementation Order

1. Add `docs/product/admin-dashboard-roadmap.md`.
2. Add admin usage API integration with Cloudflare metrics.
3. Add usage bars and estimated DAU capacity to the UI.
4. Add admin health endpoint and health cards.
5. Add compact error counters.
6. Add consent-based support codes and read-only support lookup.
7. Add Discord webhook alerts.
8. Add admin action logs.
9. Add safe operational controls.

## Open Questions

- Should the first Cloudflare usage integration use GraphQL Analytics API or the D1 REST/database info endpoint plus Workers analytics?
- Should a user support code be generated from the profile menu or from a future help modal?
- Should admin dashboard auto-refresh be allowed, and if so should it be 1 minute, 5 minutes, or manual only?
- Should daily summaries be stored in D1 snapshots for trend history, or should the first version avoid long-term analytics storage?

## Current Recommendation

Priority 1 and Priority 2 are implemented. Implement Priority 3 (consent-based user support tools) next so a "it is broken" report can be diagnosed without privacy risk, or Priority 4 (Discord webhook alerts) if unattended limit warnings matter more than support tooling.
