import type { OAuthProvider, OAuthProviderConfig } from "./providers";

const encoder = new TextEncoder();
const OAUTH_STATE_VERSION = "v1";
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const OAUTH_STATE_CLOCK_SKEW_MS = 60 * 1000;

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

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function createRandomStateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function signOAuthStatePayload(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

export async function createOAuthState(provider: OAuthProvider, secret: string, now = new Date()): Promise<string> {
  const payload = [
    OAUTH_STATE_VERSION,
    provider,
    now.getTime().toString(36),
    createRandomStateNonce()
  ].join(".");
  const signature = await signOAuthStatePayload(payload, secret);
  return `${payload}.${signature}`;
}

export async function verifyOAuthState(
  state: string,
  provider: OAuthProvider,
  secret: string,
  now = new Date()
): Promise<boolean> {
  const parts = state.split(".");
  if (parts.length !== 5) return false;
  const [version, stateProvider, issuedAt, nonce, signature] = parts;
  if (version !== OAUTH_STATE_VERSION || stateProvider !== provider || !issuedAt || !nonce || !signature) return false;

  const issuedAtMs = Number.parseInt(issuedAt, 36);
  if (!Number.isFinite(issuedAtMs)) return false;
  const ageMs = now.getTime() - issuedAtMs;
  if (ageMs > OAUTH_STATE_MAX_AGE_MS || ageMs < -OAUTH_STATE_CLOCK_SKEW_MS) return false;

  const payload = [version, stateProvider, issuedAt, nonce].join(".");
  const expectedSignature = await signOAuthStatePayload(payload, secret);
  return timingSafeEqual(signature, expectedSignature);
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
