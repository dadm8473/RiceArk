import { Hono } from "hono";
import { buildSessionCookie, clearSessionCookie, readSessionCookie } from "../auth/cookies";
import {
  buildAuthorizationUrl,
  buildRedirectUri,
  clearOAuthStateCookie,
  createOAuthState,
  extractOAuthState,
  normalizeProviderProfile,
  verifyOAuthState
} from "../auth/oauth";
import { getOAuthProvider, isSupportedOAuthProvider } from "../auth/providers";
import { requireUser } from "../auth/requireUser";
import { createSession, createSessionToken, deleteSession } from "../auth/sessions";
import { isAdminUser } from "../auth/admin";
import type { Env } from "../env";
import { ApiError } from "../http/errors";

export const authRoutes = new Hono<{ Bindings: Env }>();

function buildAuthErrorRedirect(appOrigin: string, providerName: string): string {
  const url = new URL(appOrigin);
  url.searchParams.set("authError", "oauth_unavailable");
  url.searchParams.set("provider", providerName);
  return url.toString();
}

function requireSessionSecret(env: Env): string {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");
  return env.SESSION_SECRET;
}

authRoutes.get("/auth/:provider/start", async (c) => {
  const providerName = c.req.param("provider");
  const provider = getOAuthProvider(c.env, providerName);
  if (!provider) {
    if (isSupportedOAuthProvider(providerName)) {
      return new Response(null, {
        status: 302,
        headers: { location: buildAuthErrorRedirect(c.env.APP_ORIGIN, providerName) }
      });
    }
    throw new ApiError(404, "unknown_provider", "Unknown OAuth provider");
  }

  const state = await createOAuthState(provider.id, requireSessionSecret(c.env));
  const redirectUri = buildRedirectUri(c.env.APP_ORIGIN, provider.id);
  const location = buildAuthorizationUrl(provider, redirectUri, state);
  const stateCookie = [
    `riceark_oauth_state=${state}`,
    "Path=/",
    "Max-Age=600",
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");

  return new Response(null, {
    status: 302,
    headers: {
      location,
      "set-cookie": stateCookie
    }
  });
});

authRoutes.get("/auth/:provider/callback", async (c) => {
  const providerName = c.req.param("provider");
  const provider = getOAuthProvider(c.env, providerName);
  if (!provider) {
    if (isSupportedOAuthProvider(providerName)) {
      return new Response(null, {
        status: 302,
        headers: { location: buildAuthErrorRedirect(c.env.APP_ORIGIN, providerName) }
      });
    }
    throw new ApiError(404, "unknown_provider", "Unknown OAuth provider");
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  const hasValidSignedState = state ? await verifyOAuthState(state, provider.id, requireSessionSecret(c.env)) : false;
  const hasValidLegacyCookieState = state ? extractOAuthState(c.req.header("cookie") ?? null) === state : false;
  if (!code || !state || (!hasValidSignedState && !hasValidLegacyCookieState)) {
    throw new ApiError(400, "invalid_oauth_state", "Invalid OAuth state");
  }

  const redirectUri = buildRedirectUri(c.env.APP_ORIGIN, provider.id);
  const tokenResponse = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri
    })
  });
  if (!tokenResponse.ok) throw new ApiError(502, "oauth_token_failed", "OAuth token exchange failed");

  const tokenJson = (await tokenResponse.json()) as { access_token: string };
  const profileResponse = await fetch(provider.userInfoUrl, {
    headers: { authorization: `Bearer ${tokenJson.access_token}`, accept: "application/json" }
  });
  if (!profileResponse.ok) throw new ApiError(502, "oauth_profile_failed", "OAuth profile request failed");

  const profile = normalizeProviderProfile(provider.id, (await profileResponse.json()) as Record<string, unknown>);
  const existing = await c.env.DB.prepare(
    "SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?"
  )
    .bind(profile.provider, profile.providerUserId)
    .first<{ user_id: string }>();

  const userId = existing?.user_id ?? crypto.randomUUID();
  if (!existing) {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users (id, display_name, avatar_url) VALUES (?, ?, ?)").bind(
        userId,
        profile.displayName,
        profile.avatarUrl
      ),
      c.env.DB.prepare(
        "INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, email) VALUES (?, ?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), userId, profile.provider, profile.providerUserId, profile.email),
      c.env.DB.prepare("INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)").bind(userId)
    ]);
  }

  const sessionToken = createSessionToken();
  await createSession(c.env, userId, sessionToken);

  return new Response(null, {
    status: 302,
    headers: [
      ["location", c.env.APP_ORIGIN],
      ["set-cookie", clearOAuthStateCookie()],
      ["set-cookie", buildSessionCookie(sessionToken, c.env.COOKIE_DOMAIN, 30 * 24 * 60 * 60)]
    ]
  });
});

authRoutes.get("/session", async (c) => {
  const user = await requireUser(c);
  const isAdmin = await isAdminUser(c.env, user.id);
  return c.json({ user: { ...user, isAdmin } });
});

authRoutes.post("/auth/logout", async (c) => {
  const token = readSessionCookie(c.req.header("cookie") ?? null);
  if (token) await deleteSession(c.env, token);
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": clearSessionCookie(c.env.COOKIE_DOMAIN) }
  });
});
