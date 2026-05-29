# Pages Functions Deployment Design

## Background

RiceArk will launch on the free Cloudflare Pages subdomain `riceark.pages.dev`.
The first public deployment should let the frontend, API routes, OAuth callbacks,
session cookies, D1, and KV all live under the same origin.

The current API is already implemented as a Hono Worker app under `/api/*`.
This design keeps that app intact and adds a Cloudflare Pages Functions adapter
inside the web package.

## Goals

- Serve the React app from `https://riceark.pages.dev`.
- Serve API routes from `https://riceark.pages.dev/api/*`.
- Keep OAuth callback URLs same-origin:
  - `https://riceark.pages.dev/api/auth/google/callback`
  - `https://riceark.pages.dev/api/auth/discord/callback`
- Keep existing API route handlers, tests, and D1 migrations.
- Keep static assets outside the Pages Function runtime for cost control.
- Document the exact Cloudflare, Google, Discord, and Lost Ark setup steps the
  user must perform.

## Architecture

The web package owns the Pages deployment:

- `apps/web/dist` is the Pages static output.
- `apps/web/functions/api/[[path]].ts` forwards all `/api/*` requests to the
  existing `@riceark/api` Hono app.
- `apps/web/public/_routes.json` limits Function invocation to `/api/*`, so
  normal static assets continue to be served as static Pages assets.
- The Pages project receives D1, KV, environment variables, and secrets through
  Cloudflare Pages settings.

The existing standalone Worker configuration stays in place for local API
development and dry-run API builds. Production launch uses Pages Functions first
because it avoids cross-domain OAuth and cookie complexity on the free
`pages.dev` domain.

## Deployment Resources

Required Cloudflare resources:

- Pages project: `riceark`
- D1 database: `riceark`
- KV namespace: `riceark-cache`

Required Pages Function bindings:

- `DB` -> D1 database `riceark`
- `CACHE` -> KV namespace `riceark-cache`

Required Pages environment variables:

- `APP_ORIGIN=https://riceark.pages.dev`
- `COOKIE_DOMAIN=riceark.pages.dev`
- `ENVIRONMENT=production`

Required Pages secrets:

- `LOSTARK_API_KEY`
- `SESSION_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`

## User Setup Points

The user must create or provide values for external services:

- Google OAuth Web Client with the production redirect URI.
- Discord OAuth application with the production redirect URI.
- Lost Ark Open API key.
- Cloudflare D1 and KV resources, plus Pages bindings and secrets.

Secrets must never be committed to git or pasted into chat. Local secrets belong
in `.dev.vars`; production secrets belong in Cloudflare Pages settings or
Wrangler secret commands.

## Testing

- Add a Pages Function unit test that calls `/api/health` through the adapter.
- Run the full Vitest suite.
- Run TypeScript checks for all workspaces.
- Build the API Worker dry run and the web app.
- Build the Pages Functions bundle with Wrangler to catch adapter bundling
  errors before deployment.
