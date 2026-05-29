import type { OAuthProvider, OAuthProviderConfig } from "./providers";

export interface ProviderProfile {
  provider: OAuthProvider;
  providerUserId: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export function buildRedirectUri(origin: string, provider: string): string {
  return `${origin}/api/auth/${provider}/callback`;
}

export function buildAuthorizationUrl(config: OAuthProviderConfig, redirectUri: string, state: string): string {
  const url = new URL(config.authorizationUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  return url.toString();
}

export function extractOAuthState(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((part) => part.trim());
  const match = cookies.find((part) => part.startsWith("riceark_oauth_state="));
  return match ? decodeURIComponent(match.slice("riceark_oauth_state=".length)) : null;
}

export function clearOAuthStateCookie(): string {
  return "riceark_oauth_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
}

export function normalizeProviderProfile(provider: OAuthProvider, raw: Record<string, unknown>): ProviderProfile {
  if (provider === "google") {
    return {
      provider,
      providerUserId: String(raw.sub),
      displayName: String(raw.name ?? raw.email ?? "Google User"),
      email: raw.email ? String(raw.email) : null,
      avatarUrl: raw.picture ? String(raw.picture) : null
    };
  }

  const avatarHash = raw.avatar ? String(raw.avatar) : null;
  const providerUserId = String(raw.id);
  return {
    provider,
    providerUserId,
    displayName: String(raw.global_name ?? raw.username ?? "Discord User"),
    email: raw.email ? String(raw.email) : null,
    avatarUrl: avatarHash ? `https://cdn.discordapp.com/avatars/${providerUserId}/${avatarHash}.png` : null
  };
}
