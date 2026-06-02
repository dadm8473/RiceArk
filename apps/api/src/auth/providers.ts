import type { Env } from "../env";

export type OAuthProvider = "google" | "discord";

export interface OAuthProviderConfig {
  id: OAuthProvider;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
}

export function isSupportedOAuthProvider(provider: string): provider is OAuthProvider {
  return provider === "google" || provider === "discord";
}

export function getOAuthProvider(env: Env, provider: string): OAuthProviderConfig | null {
  if (provider === "google" && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return {
      id: "google",
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scope: "openid email profile"
    };
  }

  if (provider === "discord" && env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    return {
      id: "discord",
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      authorizationUrl: "https://discord.com/oauth2/authorize",
      tokenUrl: "https://discord.com/api/oauth2/token",
      userInfoUrl: "https://discord.com/api/users/@me",
      scope: "identify email"
    };
  }

  return null;
}
