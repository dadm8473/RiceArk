import type { OAuthProviderConfig } from "./providers";

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
