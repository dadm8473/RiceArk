import { Hono } from "hono";
import { buildAuthorizationUrl, buildRedirectUri } from "../auth/oauth";
import { getOAuthProvider } from "../auth/providers";
import type { Env } from "../env";
import { ApiError } from "../http/errors";

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.get("/auth/:provider/start", (c) => {
  const providerName = c.req.param("provider");
  const provider = getOAuthProvider(c.env, providerName);
  if (!provider) throw new ApiError(404, "unknown_provider", "Unknown OAuth provider");

  const state = crypto.randomUUID();
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
