# RiceArk

RiceArk is a Lost Ark checklist service for tracking daily, weekly, biweekly, and custom reset tasks across characters and roster-wide activities.

## Current Architecture

- Cloudflare Pages frontend on `riceark.pages.dev`
- Cloudflare Pages Functions API on same-origin `/api/*`
- Cloudflare D1 app database
- Cloudflare KV/Cache for Lost Ark API caching

## Development

```bash
pnpm install
pnpm db:migrate:local
pnpm dev:api
pnpm dev:web
```

## Verification

```bash
pnpm check
pnpm test
pnpm build
```

See `docs/deployment/cloudflare.md` for deployment setup.

## Deployment

Production starts on the free Cloudflare Pages domain:

```text
https://riceark.pages.dev
```

Use `docs/deployment/cloudflare.md` for the required Pages, D1, KV, Google,
Discord, and Lost Ark API setup steps.
