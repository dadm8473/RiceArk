export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  APP_ORIGIN: string;
  COOKIE_DOMAIN: string;
  ENVIRONMENT: "local" | "test" | "production";
  LOSTARK_API_KEY?: string;
  ADMIN_OAUTH_ALLOWLIST?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_D1_DATABASE_ID?: string;
  CLOUDFLARE_PAGES_PROJECT_NAME?: string;
  CLOUDFLARE_WORKER_SCRIPT_NAME?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
}
