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

## Notes

- Pages Functions requests count toward Workers request limits.
- Static asset requests are free/unlimited from the Workers pricing perspective.
- D1 row counters are used only if the Cloudflare response includes them. If Cloudflare changes or hides those fields, the dashboard falls back to DB size and Workers request metrics.
