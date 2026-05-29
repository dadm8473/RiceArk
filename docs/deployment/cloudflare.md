# Cloudflare Deployment

## Required Cloudflare Resources

- Pages project: `riceark`
- Worker: `riceark-api`
- D1 database: `riceark`
- KV namespace: `riceark-cache`

## Required Worker Secrets

- `LOSTARK_API_KEY`
- `SESSION_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`

## Local Setup

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Apply local D1 migrations:

   ```bash
   pnpm db:migrate:local
   ```

3. Run the API:

   ```bash
   pnpm dev:api
   ```

4. Run the web app:

   ```bash
   pnpm dev:web
   ```

## Verification

Run:

```bash
pnpm check
pnpm test
pnpm build
```

Expected: all commands exit with code 0.

## Cost Guardrails

- Keep checklist updates batched.
- Keep Lost Ark roster search cached.
- Watch Workers requests and D1 writes after launch.
- Upgrade to Workers Paid when DAU approaches 100-300 or free-tier usage reaches about 50%.
