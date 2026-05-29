# Cloudflare Deployment

RiceArk launches on the free Cloudflare Pages domain:

```text
https://riceark.pages.dev
```

The production deployment uses one Cloudflare Pages project. Static frontend
assets are served by Pages, and `/api/*` is served by Pages Functions using the
same Hono API app from `apps/api`.

## Repository Settings

Use the `dadm8473/RiceArk` GitHub repository.

Cloudflare Pages settings:

```text
Project name: riceark
Production branch: main
Root directory: apps/web
Build command: pnpm build
Build output directory: dist
```

The committed Pages Wrangler config lives at:

```text
apps/web/wrangler.jsonc
```

It defines the production `riceark.pages.dev` variables, compatibility flags,
D1 binding, and KV binding used by Pages Functions.

Pages Functions are stored in:

```text
apps/web/functions
```

The Vite public asset `apps/web/public/_routes.json` limits Pages Functions to
`/api/*`, so static assets do not use Function invocations.

## Required Cloudflare Resources

Create these resources before the first production login test:

```bash
wrangler d1 create riceark
wrangler kv namespace create riceark-cache
```

Current created resource IDs:

```text
D1 riceark: c93687c6-a34f-474a-a096-08b78c4fadd3
KV riceark-cache: edf3d42b486a46bb8a18da43359a118e
```

Then bind them to the Pages project:

```text
DB    -> D1 database riceark
CACHE -> KV namespace riceark-cache
```

If you configure bindings in the Cloudflare dashboard, use:

```text
Workers & Pages -> riceark -> Settings -> Functions -> D1 database bindings
Workers & Pages -> riceark -> Settings -> Functions -> KV namespace bindings
```

## Required Pages Variables

Set these as production environment variables for the Pages project:

```text
APP_ORIGIN=https://riceark.pages.dev
COOKIE_DOMAIN=riceark.pages.dev
ENVIRONMENT=production
```

## Required Pages Secrets

Set these as Pages production secrets. Do not commit them and do not paste them
into chat.

```text
LOSTARK_API_KEY
SESSION_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
```

Generate `SESSION_SECRET` locally with:

```bash
openssl rand -hex 32
```

## OAuth Redirect URIs

Google OAuth Web Client:

```text
https://riceark.pages.dev/api/auth/google/callback
```

Discord OAuth2 Redirect:

```text
https://riceark.pages.dev/api/auth/discord/callback
```

Local development redirect URIs, if you want to test OAuth locally through the
Vite proxy:

```text
http://127.0.0.1:5173/api/auth/google/callback
http://127.0.0.1:5173/api/auth/discord/callback
```

## D1 Migrations

Apply migrations to the production D1 database after creating it:

```bash
cd apps/api
wrangler d1 migrations apply riceark --remote
cd ../..
```

Apply local migrations for local Worker development:

```bash
pnpm db:migrate:local
```

## Local Development

Install dependencies:

```bash
pnpm install
```

Run local D1 migrations:

```bash
pnpm db:migrate:local
```

Run API and web dev servers:

```bash
pnpm dev:api
pnpm dev:web
```

The web server proxies `/api/*` to the local Worker API.

## Deployment Commands

Build and validate locally:

```bash
pnpm check
pnpm test
pnpm build
pnpm --filter @riceark/web build:functions
```

Manual Pages deploy:

```bash
pnpm --filter @riceark/web deploy
```

If Cloudflare Pages is connected to GitHub, pushing `main` will trigger the
configured production build instead.

## Post-Deploy Verification

After deployment, open:

```text
https://riceark.pages.dev
```

Verify:

- The page loads and shows the RiceArk header.
- Google login redirects to Google and returns to RiceArk.
- Discord login redirects to Discord and returns to RiceArk.
- After login, the dashboard request to `/api/dashboard` succeeds.
- Character search with `냠수나이스1` returns Lost Ark roster data.
- Selecting imported characters saves them and shows checklist columns.
- Checking a cell persists after refresh.

## Cost Guardrails

- Keep checklist updates batched.
- Keep Lost Ark roster search cached.
- Keep Pages Functions limited to `/api/*`.
- Watch Workers/Pages Function requests and D1 writes after launch.
- Start on the free tier; upgrade to Workers Paid when DAU approaches 100-300
  or free-tier usage reaches about 50%.
