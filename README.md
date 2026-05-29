# RiceArk

RiceArk is a Lost Ark checklist service for tracking daily, weekly, biweekly, and custom reset tasks across characters and roster-wide activities.

## Current Architecture

- Cloudflare Pages frontend
- Cloudflare Worker API
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
