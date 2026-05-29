export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  APP_ORIGIN: string;
  COOKIE_DOMAIN: string;
  ENVIRONMENT: "local" | "test" | "production";
  LOSTARK_API_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
}
